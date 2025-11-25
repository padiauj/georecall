
# %% 

import json
from pathlib import Path


main_buildings = [
    "N10 High Voltage Research Lab",
    "N16 Cooling Tower",
    "N16A",
    "N16C",
    "N20 Ragon Institute",
    "N4 Albany Garage",
    "N51",
    "N52",
    "N9 Superconducting Test Facility",
    "10",
    "100 Memorial Drive Apartments",
    "11 Homberg Building",
    "12 Su Building",
    "13 Bush Building",
    "14",
    "16 Dorrance Building",
    "17 Wright Brothers Wind Tunnel",
    "18 Dreyfus Building",
    "2 Simons Building",
    "24",
    "26 Compton Labs",
    "3",
    "31 Sloan Labs",
    "32 Stata Center",
    "33 Guggenheim Lab",
    "34 EG&G Education Center",
    "35 Sloan Lab",
    "36 Fairchild Building",
    "37 McNair Building",
    "38",
    "39 Brown Building",
    "4",
    "41",
    "42 Dickson Cogeneration Plant",
    "42C",
    "43 Plant Annex",
    "45 Schwarzman Building",
    "46 Brain and Cognitive Sciences",
    "48 Parsons Lab",
    "5",
    "50 Walker Memorial",
    "54 Green Building",
    "55",
    "56 Whitaker Building",
    "57 Alumni Pool",
    "6 Eastman Labs",
    "62",
    "64",
    "66 Landau Building",
    "68 Koch Biology Building",
    "6B",
    "6C",
    "7 Rogers Building",
    "76 Koch Institute",
    "7A Rotch Library",
    "8",
    "9 Samuel Tak Lee Building",
    "No. 6",
]

west_buildings = [
    "NW10 Edgerton House",
    "NW12 Nuclear Reactor Lab",
    "NW13",
    "NW14 Bitter Magnet Lab",
    "NW16",
    "NW17",
    "NW21 Plasma Science & Fusion Center",
    "NW22",
    "NW23",
    "NW30 The Warehouse",
    "NW32",
    "NW35 Ashdown House",
    "NW36",
    "NW86 Sidney Pacific",

    # West: W + WW
    "W1 Maseeh Hall",
    "W11 Religious Activities Center",
    "W15 MIT Chapel",
    "W16 Kresge Auditorium",
    "W18 Linde Music Building",
    "W2",
    "W20 Stratton Student Center",
    "W31 du Pont Athletic Gymnasium",
    "W32 du Pont Athletic Center",
    "W33 Rockwell Cage",
    "W34 Johnson Athletic Center",
    "W35 Zesiger Sports & Fitness Center",
    "W4 McCormick Hall",
    "W41 Metropolitan Storage Warehouse",
    "W46 New Vassar",
    "W5 Green Hall",
    "W51 Burton Conner House",
    "W53 Carr Indoor Tennis",
    "W59 Heinz Building",
    "W61 MacGregor House",
    "W64 Koch Childcare Center",
    "W7 Baker House",
    "W70 New House",
    "W71 Next House",
    "W79 Simmons Hall",
    "W83",
    "W84 Tang Hall",
    "W85 Westgate",
    "W85ABC",
    "W85DE",
    "W85FG",
    "W85HJK",
    "W87 Grad Junction",
    "W88 Grad Junction",
    "W91",
    "W92 Information Technology",
    "W98",
    "WW25"
]

east_buildings = [
    "E1 Gray House",
    "E14 Media Lab",
    "E15 Wiesner Building",
    "E17 Mudd Building",
    "E18 Ford Building",
    "E19",
    "E2 70 Amherst",
    "E23",
    "E25 Whitaker College",
    "E28",
    "E37",
    "E38",
    "E40 Muckley Building",
    "E48",
    "E51 Tang Center",
    "E52 Morris & Sophie Chang Building",
    "E53 Hermann Building",
    "E60 Arthur D. Little Building",
    "E62"
]

# %% 
def extract_name(feature):
    props = feature.get("properties") or {}
    # common places for a name in GeoJSON produced from OSM
    for key in ("name", "Name", "NAME", "display_name", "alt_name", "short_name"):
        val = props.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    # sometimes tags are nested
    tags = props.get("tags") or {}
    if isinstance(tags, dict):
        for key in ("name", "Name", "NAME"):
            val = tags.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
    return None

def main():
    base = Path(__file__).resolve().parent
    geojson_path = base /  "mit-all.geojson"
    if not geojson_path.exists():
        print(f"File not found: {geojson_path}")
        return

    with geojson_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    features = data.get("features", []) if isinstance(data, dict) else []
    names = set()
    for feat in features:
        name = extract_name(feat)
        if name:
            names.add(name)

    names_list = sorted(names)
    print(f"Found {len(names_list)} unique names:")
    for n in names_list:
        print(n)
    
    # Filter and write grouped GeoJSONs
    groups = {
        "main": set(main_buildings),
        "west": set(west_buildings),
        "east": set(east_buildings),
    }

    out_dir = geojson_path.parent
    name_to_features = {}

    # Pre-index features by extracted name
    for feat in features:
        n = extract_name(feat)
        if not n:
            continue
        name_to_features.setdefault(n, []).append(feat)

    for group_name, wanted_names in groups.items():
        out_features = []
        for n in wanted_names:
            out_features.extend(name_to_features.get(n, []))

        out_fc = {"type": "FeatureCollection", "features": out_features}
        out_path = out_dir / f"mit-{group_name}.geojson"
        with out_path.open("w", encoding="utf-8") as f:
            json.dump(out_fc, f, ensure_ascii=False, indent=2)
        print(f"Wrote {len(out_features)} features to {out_path}")

if __name__ == "__main__":
    main()


# %%
