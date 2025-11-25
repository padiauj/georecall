/*
  Building Guessr - Configurable GeoJSON
  Pure frontend game using Leaflet + OSM tiles.

  How it works (high-level):
  - User enters an OSM relation ID and subtype tag key.
  - We query Overpass API, convert response to GeoJSON (osmtogeojson),
    then create a Leaflet map + layer and run the quiz.
  - Game iterates buildings in random order; player clicks the correct polygon.
  - Scoring rewards fewer misses; colors persist as a learning heatmap.
*/

(function () {
  // DOM elements
  const mapEl = document.getElementById('map');
  const configPanel = document.getElementById('config-panel');
  const configForm = document.getElementById('config-form');
  const configError = document.getElementById('config-error');
  const startBtn = document.getElementById('startBtn');
  const configToggleBtn = document.getElementById('config-toggle');

  const promptEl = document.getElementById('prompt');
  const statusEl = document.getElementById('status');
  const scoreEl = document.getElementById('score');
  const uiEl = document.getElementById('ui');
  const skipBtn = document.getElementById('skip');
  const restartBtn = document.getElementById('restart');
  const changeConfigBtn = document.getElementById('changeConfig');

  const input = {
    relationId: document.getElementById('relationId'),
    subtypeKey: document.getElementById('subtypeKey'),
    overpassEndpoint: document.getElementById('overpassEndpoint'),
    lat: document.getElementById('centerLat'),
    lng: document.getElementById('centerLng'),
    zoom: document.getElementById('zoom'),
  };

  // Leaflet map references
  let map = null;
  let baseLayer = null;
  let geoLayer = null;

  // Game state
  const state = {
    config: null,
    features: [], // raw GeoJSON features
    idToLayer: new Map(), // id -> Leaflet layer
    order: [],
    targetIndex: 0, // index into order
    attemptsForCurrent: 0,
    score: 0,
    maxScore: 0,
    // resultsById: id -> { attempts: number, skipped: boolean, points: number }
    resultsById: new Map(),
    isRevealing: false,
    labels: [], // { id, marker, rect: {x,y,w,h} }
    labeledIds: new Set(),
    revealIntervalId: null,
    revealTargetId: null,
  };

  // Defaults
  const DEFAULTS = {
    subtypeKey: 'building',
    zoom: 16,
    overpassEndpoint: 'https://overpass-api.de/api/interpreter',
    styleEndpoint: 'mapstyle.json',
  };

  // Styling choices
  const styleDefaults = {
    weight: 1,
    color: '#666666',
    fillColor: '#cccccc',
    fillOpacity: 0.1,
  };
  const styleFlashWrong = { fillColor: '#ff0000', fillOpacity: 0.6 };
  const styleCorrect0 = { fillColor: '#ffffff', fillOpacity: 0.7 };
  const styleCorrect1 = { fillColor: '#ffd800', fillOpacity: 0.7 }; // 1 miss → yellow
  const styleWorst = { fillColor: '#ff0000', fillOpacity: 0.7 };    // 2+ misses → red
  const styleSkipped = { fillColor: '#cccccc', fillOpacity: 0.5 };

  // Timing constants (ms)
  const WRONG_FLASH_MS = 300;      // duration of red flash on wrong click
  const REVEAL_FLASH_MS = 2000;    // duration of red flash when revealing correct polygon
  const ADVANCE_DELAY_MS = 900;    // delay before moving to next after a correct click

  // Label placement config
  const LABEL_PAD_PX = 4;
  const LABEL_LINE_HEIGHT_PX = 14;
  const AVG_CHAR_W_PX = 7; // rough width per character for collision boxes
  const REVEAL_BLINK_PERIOD_MS = 500; // blink cadence for revealed target

  // Util: shuffle array in-place
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function parseNumber(value) {
    if (value === undefined || value === null) return undefined;
    if (value === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }

  function getFeatureId(feature, index) {
    const props = feature && feature.properties ? feature.properties : {};
    let id = props['@id']; // e.g., "way/123" or "relation/456"
    if (!id && feature.id !== undefined && feature.id !== null && feature.id !== '') {
      id = feature.id; // sometimes osmtogeojson sets feature.id
    }
    if (!id && props.id !== undefined && props.id !== null && props.type) {
      id = `${props.type}/${props.id}`; // construct like way/123
    }
    if (!id && props.osm_id !== undefined) {
      id = props.osm_id;
    }
    if (!id) id = index; // final fallback
    return String(id);
  }

  function getPromptLabel(feature, fallbackId) {
    const props = feature && feature.properties ? feature.properties : {};
    const name = props.name;
    if (name !== undefined && name !== null && String(name).trim() !== '') return String(name);
    return '';
  }

  function saveConfigToLocalStorage(cfg) {
    try {
      localStorage.setItem('building-guessr:lastConfig', JSON.stringify(cfg));
    } catch (_) { /* ignore */ }
  }
  function loadConfigFromLocalStorage() {
    try {
      const raw = localStorage.getItem('building-guessr:lastConfig');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function setInputsFromConfig(cfg) {
    if (!cfg) return;
    input.relationId.value = cfg.relationId ?? '';
    input.subtypeKey.value = cfg.subtypeKey || DEFAULTS.subtypeKey;
    input.overpassEndpoint.value = cfg.overpassEndpoint || DEFAULTS.overpassEndpoint;
    input.lat.value = cfg.center && cfg.center.lat !== undefined ? cfg.center.lat : '';
    input.lng.value = cfg.center && cfg.center.lng !== undefined ? cfg.center.lng : '';
    input.zoom.value = cfg.zoom !== undefined ? cfg.zoom : '';
  }

  function gatherConfigFromInputs() {
    const relationId = parseNumber(input.relationId.value);
    const subtypeKey = (input.subtypeKey.value || DEFAULTS.subtypeKey).trim();
    const overpassEndpoint = (input.overpassEndpoint.value || DEFAULTS.overpassEndpoint).trim();
    const centerLat = parseNumber(input.lat.value);
    const centerLng = parseNumber(input.lng.value);
    const zoom = parseNumber(input.zoom.value);

    const cfg = {
      relationId,
      subtypeKey,
      overpassEndpoint,
      center: (centerLat !== undefined && centerLng !== undefined) ? { lat: centerLat, lng: centerLng } : undefined,
      zoom: zoom !== undefined ? zoom : DEFAULTS.zoom,
    };
    return cfg;
  }

  // Map initialization
  function ensureMapInitialized() {
    if (map) return;
    map = L.map(mapEl, { zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    // Vector tiles via MapLibre GL (Leaflet integration)
    try {
      if (L.maplibreGL) {
        baseLayer = L.maplibreGL({
          style: DEFAULTS.styleEndpoint,
        }).addTo(map);
        if (map.attributionControl) {
          map.attributionControl.addAttribution('Style & tiles © OpenFreeMap; Data © OpenStreetMap contributors');
        }
      } else {
        throw new Error('L.maplibreGL not available');
      }
    } catch (e) {
      console.warn('MapLibre GL layer failed, falling back to raster OSM tiles', e);
      baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 22,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
    }
  }

  function clearExistingLayer() {
    if (geoLayer) {
      geoLayer.remove();
      geoLayer = null;
    }
    state.features = [];
    state.idToLayer.clear();
  }

  // Style helpers
  function persistentStyleForId(id) {
    const res = state.resultsById.get(id);
    if (!res) return styleDefaults;
    if (res.skipped) return { ...styleDefaults, ...styleSkipped };
    if (res.attempts === 0) return { ...styleDefaults, ...styleCorrect0 };
    if (res.attempts === 1) return { ...styleDefaults, ...styleCorrect1 };
    return { ...styleDefaults, ...styleWorst };
  }

  // UI helpers
  function showUI() { uiEl.hidden = false; }
  function hideUI() { uiEl.hidden = true; }

  function showConfigPanel() {
    configPanel.hidden = false;
    configToggleBtn.hidden = true;
  }
  function hideConfigPanel() {
    configPanel.hidden = true;
    configToggleBtn.hidden = false;
  }

  function setStatus(msg) { statusEl.textContent = msg || ''; }
  function setPrompt(msg) { promptEl.textContent = `Find: ${msg || '—'}`; }
  function updateScoreDisplay() {
    scoreEl.textContent = `Score: ${state.score} / ${state.maxScore}`;
  }

  function setLoading(isLoading) {
    startBtn.disabled = isLoading;
    startBtn.textContent = isLoading ? 'Loading…' : 'Start Game';
  }

  function buildOverpassQuery(relationId, subtypeKey) {
    return `[
out:json][timeout:25];
rel(${relationId});
map_to_area->.area;
(
  way["${subtypeKey}"](area.area);
  relation["${subtypeKey}"](area.area);
);
out geom;`;
  }

  function validateGeoJSON(fc) {
    return fc && fc.type === 'FeatureCollection' && Array.isArray(fc.features);
  }

  // Attempt to resolve the osmtogeojson function from various globals/exports
  function resolveOsmtogeojsonFunction() {
    const g = (typeof window !== 'undefined') ? window : globalThis;
    const lib = g.osmtogeojson;
    if (!lib) return null;
    if (typeof lib === 'function') return lib;
    if (lib && typeof lib.default === 'function') return lib.default;
    return null;
  }

  // Dynamically load osmtogeojson if not present; tries multiple CDN URLs
  function ensureOsmtogeojsonLoaded() {
    return new Promise((resolve, reject) => {
      const existing = resolveOsmtogeojsonFunction();
      if (existing) return resolve(existing);

      const candidates = [
        'https://unpkg.com/osmtogeojson@3.0.0/dist/osmtogeojson.umd.js',
        'https://unpkg.com/osmtogeojson@3.0.0/dist/osmtogeojson.js',
        'https://cdn.jsdelivr.net/npm/osmtogeojson@3.0.0/dist/osmtogeojson.umd.js',
        'https://cdn.jsdelivr.net/npm/osmtogeojson@3.0.0/dist/osmtogeojson.js',
      ];
      let idx = 0;

      function tryNext() {
        if (idx >= candidates.length) {
          return reject(new Error('osmtogeojson library not loaded'));
        }
        const src = candidates[idx++];
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = () => {
          const fn = resolveOsmtogeojsonFunction();
          if (fn) resolve(fn); else tryNext();
        };
        s.onerror = () => tryNext();
        document.head.appendChild(s);
      }
      tryNext();
    });
  }

  async function loadOverpassAndStartGame(cfg) {
    setLoading(true);
    configError.textContent = '';
    try {
      if (!cfg.relationId || !Number.isFinite(cfg.relationId)) {
        throw new Error('Please provide a valid numeric relation ID');
      }
      const query = buildOverpassQuery(cfg.relationId, cfg.subtypeKey || DEFAULTS.subtypeKey);
      const body = new URLSearchParams({ data: query });
      const resp = await fetch(cfg.overpassEndpoint || DEFAULTS.overpassEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: body.toString(),
      });
      if (!resp.ok) throw new Error(`Overpass HTTP ${resp.status}`);
      const overpassJson = await resp.json();
      const osm2geo = await ensureOsmtogeojsonLoaded();
      const gj = osm2geo(overpassJson, { flatProperties: true });
      if (!validateGeoJSON(gj)) throw new Error('Converted Overpass result is not valid GeoJSON');
      await initializeGame(gj.features, cfg);
      hideConfigPanel();
      showUI();
    } catch (err) {
      console.error(err);
      configError.textContent = `Failed to load Overpass data: ${err.message || err}`;
    } finally {
      setLoading(false);
    }
  }

  async function initializeGame(features, cfg) {
    ensureMapInitialized();
    clearExistingLayer();

    state.config = cfg;
    state.resultsById.clear();
    state.labels = [];
    state.labeledIds.clear();
    state.attemptsForCurrent = 0;
    state.score = 0;

    // Filter to Polygon/MultiPolygon only and with a non-empty name
    const polys = features.filter(f => {
      if (!f || !f.geometry) return false;
      const gt = f.geometry.type;
      if (!(gt === 'Polygon' || gt === 'MultiPolygon')) return false;
      const props = f.properties || {};
      const n = props.name;
      if (n === undefined || n === null || String(n).trim() === '') return false;
      return true;
    });
    state.features = polys;

    // Build order and max score
    state.order = shuffle([...polys.keys()]);
    state.targetIndex = 0;
    state.maxScore = polys.length * 3;
    updateScoreDisplay();

    // Create the GeoJSON layer
    geoLayer = L.geoJSON(polys, {
      style: function (feature) {
        // Default style; if we already have a result, use it
        const idx = polys.indexOf(feature);
        const id = getFeatureId(feature, idx);
        return persistentStyleForId(id);
      },
      onEachFeature: function (feature, layer) {
        const idx = polys.indexOf(feature);
        const id = getFeatureId(feature, idx);
        state.idToLayer.set(id, layer);
        layer.on('click', () => handleBuildingClick(feature, layer, id));
      }
    }).addTo(map);

    // View
    if (cfg.center && Number.isFinite(cfg.center.lat) && Number.isFinite(cfg.center.lng)) {
      map.setView([cfg.center.lat, cfg.center.lng], cfg.zoom || DEFAULTS.zoom);
    } else {
      try {
        map.fitBounds(geoLayer.getBounds(), { padding: [20, 20] });
      } catch (_) {
        map.setView([0, 0], cfg.zoom || DEFAULTS.zoom);
      }
    }

    // Round 1
    startRound();
  }

  function startRound() {
    if (state.targetIndex >= state.order.length) {
      return endGame();
    }
    stopRevealBlink();
    state.attemptsForCurrent = 0;
    state.isRevealing = false;
    state.hasRevealedForCurrent = false;
    const idx = state.order[state.targetIndex];
    const feature = state.features[idx];
    const id = getFeatureId(feature, idx);
    const label = getPromptLabel(feature, id);

    setPrompt(label);
    setStatus('');
    skipBtn.disabled = false;
    restartBtn.hidden = true;
    changeConfigBtn.hidden = true;
  }

  // --- Geometry helpers for label placement ---
  function polygonArea(coords) { // coords: [[x,y], ...] projected in lon/lat
    let area = 0;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const [xi, yi] = coords[i];
      const [xj, yj] = coords[j];
      area += (xj + xi) * (yj - yi); // shoelace variant (twice area)
    }
    return area / 2;
  }
  function polygonCentroid(coords) {
    let area = 0, cx = 0, cy = 0;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const [xi, yi] = coords[i];
      const [xj, yj] = coords[j];
      const a = xi * yj - xj * yi;
      area += a;
      cx += (xi + xj) * a;
      cy += (yi + yj) * a;
    }
    area *= 0.5;
    if (area === 0) {
      // fallback: average of points
      let sx = 0, sy = 0;
      for (const [x, y] of coords) { sx += x; sy += y; }
      const n = coords.length || 1;
      return [sx / n, sy / n];
    }
    return [cx / (6 * area), cy / (6 * area)];
  }
  function featureCentroid(feature) {
    const g = feature.geometry;
    if (!g) return null;
    if (g.type === 'Polygon') {
      const outer = g.coordinates[0];
      if (!outer || outer.length < 3) return null;
      const c = polygonCentroid(outer);
      return L.latLng(c[1], c[0]);
    }
    if (g.type === 'MultiPolygon') {
      let best = null, bestAbsArea = -Infinity;
      for (const poly of g.coordinates) {
        const outer = poly && poly[0];
        if (!outer || outer.length < 3) continue;
        const a = Math.abs(polygonArea(outer));
        if (a > bestAbsArea) {
          bestAbsArea = a;
          const c = polygonCentroid(outer);
          best = L.latLng(c[1], c[0]);
        }
      }
      return best;
    }
    return null;
  }

  function rectsOverlap(a, b) {
    return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function addLabelForId(id) {
    if (state.labeledIds.has(id)) return;
    const layer = state.idToLayer.get(id);
    const idx = state.features.findIndex(f => getFeatureId(f, -1) === id);
    const feature = idx >= 0 ? state.features[idx] : null;
    if (!feature) return;
    const name = getPromptLabel(feature, id);
    if (!name) return;
    const center = featureCentroid(feature) || (layer ? layer.getBounds().getCenter() : null);
    if (!center) return;

    // Estimate label size
    const w = Math.max(24, name.length * AVG_CHAR_W_PX) + LABEL_PAD_PX * 2;
    const h = LABEL_LINE_HEIGHT_PX + LABEL_PAD_PX * 2;

    // Find non-overlapping pixel position by vertical shifting
    const basePt = map.latLngToLayerPoint(center);
    let offsetY = 0;
    let labelRect = null;
    const maxShifts = 10;
    for (let i = 0; i <= maxShifts; i++) {
      const px = { x: basePt.x, y: basePt.y + offsetY };
      const rect = { x: px.x - w / 2, y: px.y - h / 2, w, h };
      const collides = state.labels.some(l => rectsOverlap(rect, l.rect));
      if (!collides) { labelRect = rect; break; }
      offsetY += h + 4;
    }
    if (!labelRect) labelRect = { x: basePt.x - w / 2, y: basePt.y - h / 2, w, h };

    const finalLatLng = map.layerPointToLatLng(L.point(labelRect.x + w / 2, labelRect.y + h / 2));
    const marker = L.marker(finalLatLng, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'map-label',
        html: escapeHtml(name),
      })
    }).addTo(map);

    state.labels.push({ id, marker, rect: labelRect });
    state.labeledIds.add(id);
  }

  function stopRevealBlink() {
    if (state.revealIntervalId) {
      clearInterval(state.revealIntervalId);
      state.revealIntervalId = null;
    }
    if (state.revealTargetId) {
      const lid = state.revealTargetId;
      const lay = state.idToLayer.get(lid);
      if (lay) lay.setStyle(persistentStyleForId(lid));
      state.revealTargetId = null;
    }
  }

  function startRevealBlink(targetId) {
    stopRevealBlink();
    const layer = state.idToLayer.get(targetId);
    if (!layer) return;
    state.revealTargetId = targetId;
    let on = false;
    state.revealIntervalId = setInterval(() => {
      on = !on;
      if (on) layer.setStyle({ ...styleDefaults, ...styleFlashWrong });
      else layer.setStyle(persistentStyleForId(targetId));
    }, REVEAL_BLINK_PERIOD_MS);
  }

  function handleBuildingClick(feature, layer, clickedId) {
    if (state.targetIndex >= state.order.length) return; // game over
    if (state.isRevealing) return; // ignore clicks while revealing

    const idx = state.order[state.targetIndex];
    const targetFeature = state.features[idx];
    const targetId = getFeatureId(targetFeature, idx);

    if (clickedId === targetId) {
      // Stop any ongoing reveal blink
      stopRevealBlink();
      // Correct
      const attempts = state.attemptsForCurrent;
      const points = Math.max(0, 3 - attempts);
      state.resultsById.set(targetId, { attempts, skipped: false, points });

      // Persist color
      layer.setStyle(persistentStyleForId(targetId));

      // Status message
      if (attempts === 0) setStatus('Nice! Correct on the first try.');
      else if (attempts === 1) setStatus('Correct after 1 wrong guess.');
      else setStatus(`Correct after ${attempts} wrong guesses.`);

      state.score += points;
      updateScoreDisplay();

      // Add non-overlapping label for this feature
      addLabelForId(targetId);

      // Advance after short delay
      setTimeout(() => {
        state.targetIndex += 1;
        startRound();
      }, ADVANCE_DELAY_MS);
    } else {
      // Incorrect
      state.attemptsForCurrent += 1;
      const prev = persistentStyleForId(clickedId);
      layer.setStyle({ ...styleDefaults, ...styleFlashWrong });
      if (state.attemptsForCurrent >= 3 && !state.hasRevealedForCurrent) {
        // Reveal the correct polygon by flashing it red for a few seconds
        const tLayer = state.idToLayer.get(targetId);
        if (tLayer) {
          state.hasRevealedForCurrent = true;
          setStatus('Out of tries — click the flashing building to continue.');
          // Start continuous blink on the correct polygon
          startRevealBlink(targetId);
        }
      } else {
        setStatus('Nope, try again.');
      }
      // Always revert the wrongly clicked polygon after a short flash
      setTimeout(() => {
        layer.setStyle(prev);
      }, WRONG_FLASH_MS);
    }
  }

  function skipCurrent() {
    if (state.targetIndex >= state.order.length) return;
    stopRevealBlink();

    const idx = state.order[state.targetIndex];
    const feature = state.features[idx];
    const id = getFeatureId(feature, idx);

    state.resultsById.set(id, { attempts: 0, skipped: true, points: 0 });

    const layer = state.idToLayer.get(id);
    if (layer) layer.setStyle(persistentStyleForId(id));

    state.targetIndex += 1;
    startRound();
  }

  function endGame() {
    // Summaries
    let zero = 0, one = 0, twoPlus = 0, skipped = 0;
    for (const [_, res] of state.resultsById) {
      if (res.skipped) skipped += 1;
      else if (res.attempts === 0) zero += 1;
      else if (res.attempts === 1) one += 1;
      else twoPlus += 1;
    }

    const total = state.features.length;
    const msg = `Done! You’ve answered all buildings 🎉\n` +
      `Total: ${total}. Score: ${state.score} / ${state.maxScore}.\n` +
      `0 misses: ${zero}, 1 miss: ${one}, 2+ misses: ${twoPlus}, skipped: ${skipped}.`;
    setPrompt('All done');
    setStatus(msg);

    // Show controls
    skipBtn.disabled = true;
    restartBtn.hidden = false;
    changeConfigBtn.hidden = false;
  }

  function restartSameConfig() {
    // Clear persistent results and styles
    for (const [id, layer] of state.idToLayer) {
      layer.setStyle(styleDefaults);
    }
    state.resultsById.clear();

    // Reshuffle and reset
    state.order = shuffle([...state.features.keys()]);
    state.targetIndex = 0;
    state.attemptsForCurrent = 0;
    state.score = 0;
    state.maxScore = state.features.length * 3;
    updateScoreDisplay();

    startRound();
  }

  // Events
  configForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const cfg = gatherConfigFromInputs();
    if (!cfg.relationId) {
      configError.textContent = 'Please enter a valid relation ID.';
      return;
    }
    saveConfigToLocalStorage(cfg);
    loadOverpassAndStartGame(cfg);
  });

  configToggleBtn.addEventListener('click', () => {
    showConfigPanel();
  });

  skipBtn.addEventListener('click', skipCurrent);
  restartBtn.addEventListener('click', restartSameConfig);
  changeConfigBtn.addEventListener('click', () => {
    showConfigPanel();
  });

  // Prefill from localStorage if available
  const last = loadConfigFromLocalStorage();
  if (last) setInputsFromConfig(last);
})();
