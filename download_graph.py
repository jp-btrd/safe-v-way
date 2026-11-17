"""
download_graph.py
Run this ONCE (with internet) to download the walking street network
around Gen. T. De Leon, Valenzuela and save it as a .graphml file.
Flask will load the saved file later, so the demo does not need internet.

COORDINATE ORDER (the #1 source of bugs):
  - Humans, Leaflet, and OSMnx graph_from_point use (latitude, longitude)
  - OSMnx nearest_nodes uses X=longitude, Y=latitude  <-- reversed!
"""

import os
import math
import osmnx as ox
import networkx as nx

# ---------- SETTINGS ----------
CENTER_LAT, CENTER_LON = 14.684443, 120.990409   # (lat, lon)
RADIUS_M = 500                                   # meters

OUTPUT_DIR = "data"
GRAPH_PATH = os.path.join(OUTPUT_DIR, "gen_t_deleon_walk.graphml")
PREVIEW_PATH = os.path.join(OUTPUT_DIR, "graph_preview.png")

# Sample safe zones, (lat, lon). Capacities are demo values, not official.
SAFE_ZONES = [
    {"name": "Tañada Covered Court", "lat": 14.682806, "lon": 120.988062},
    {"name": "Gen. T. De Leon Elementary School", "lat": 14.686080, "lon": 120.992756},
]

# Tell OSMnx to remember downloads, so re-running is fast and kinder to the server
ox.settings.use_cache = True
ox.settings.log_console = True


def distance_m(lat1, lon1, lat2, lon2):
    """Straight-line distance in meters between two lat/lon points (haversine)."""
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 1) DOWNLOAD the walking network from OpenStreetMap.
    #    center_point is (lat, lon). dist_type="bbox" means the area is a square
    #    that extends 500 m from the center in each direction (about 1 km x 1 km).
    print("Downloading street network from OpenStreetMap...")
    G = ox.graph_from_point(
        center_point=(CENTER_LAT, CENTER_LON),
        dist=RADIUS_M,
        dist_type="bbox",
        network_type="walk",   # includes footpaths and alleys, not just roads
        simplify=True,
    )
    print(f"Done: {len(G.nodes)} nodes (intersections), {len(G.edges)} edges (street pieces)")

    # 2) SAVE it so Flask can load it without internet
    ox.save_graphml(G, GRAPH_PATH)
    print(f"Saved graph to {GRAPH_PATH}")

    # 3) CHECK that each safe zone sits near a street and is reachable
    print("\n--- Safe zone check ---")
    center_node = ox.distance.nearest_nodes(G, X=CENTER_LON, Y=CENTER_LAT)  # X=lon, Y=lat!
    for z in SAFE_ZONES:
        node = ox.distance.nearest_nodes(G, X=z["lon"], Y=z["lat"])         # X=lon, Y=lat!
        n = G.nodes[node]                       # OSMnx stores node coords as y=lat, x=lon
        snap = distance_m(z["lat"], z["lon"], n["y"], n["x"])
        try:
            walk = nx.shortest_path_length(G, center_node, node, weight="length")
            reach = f"reachable, {walk:.0f} m walk from map center"
        except nx.NetworkXNoPath:
            reach = "NOT REACHABLE from map center!"
        flag = "" if snap < 50 else "   <-- WARNING: far from any street"
        print(f"{z['name']}: nearest street node is {snap:.0f} m away; {reach}{flag}")

    # 4) SAVE A PREVIEW IMAGE so you can eyeball the map for missing alleys
    ox.plot_graph(G, node_size=0, edge_linewidth=0.8, show=False, close=True,
                  save=True, filepath=PREVIEW_PATH)
    print(f"\nSaved preview image to {PREVIEW_PATH}. Open it and check that the streets look right.")


if __name__ == "__main__":
    main()