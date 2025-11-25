# GeoRecall

A tiny, client‑side map recall game. The app prompts you with a feature name and you click the matching polygon on the map. Data comes from OpenStreetMap via the Overpass API, converted to GeoJSON in the browser. No backend, no build step.

Quick start
- Serve this folder with any static server (examples: VS Code Live Server, or `python3 -m http.server`), then open `index.html` in your browser.
- On the configuration panel, either:
	- Pick a preset (MIT Campus Buildings), or
	- Open Advanced options and enter an OSM Relation ID plus a subtype key (e.g., `building`). Click “Start Game.”

Notes
- Tech: Leaflet for map UI, MapLibre GL for the base style (via leaflet-maplibre bridge), osmtogeojson for conversion.
- URL params supported for deep links: `?preset=mit`, `?geojson=URL`, or `?relationId=123456&subtypeKey=building&centerLat=..&centerLng=..&zoom=..`.
- Map style and tiles attribution: Style & tiles © OpenFreeMap; Data © OpenStreetMap contributors.


