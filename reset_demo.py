"""
reset_demo.py - puts everything back to the starting state for the demo.
Run with Flask STOPPED:   python reset_demo.py
"""
import json
import os

import seed_reports      # reuses the seed reports (importing it does not run anything)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")

# 1) Safe zones: starting occupancy, nothing marked full
ZONES_PATH = os.path.join(DATA_DIR, "safe_zones.json")
START_OCCUPANCY = {1: 40, 2: 120}
with open(ZONES_PATH, encoding="utf-8") as f:
    zones = json.load(f)
for z in zones:
    z["occupancy"] = START_OCCUPANCY.get(z["id"], 0)
    z["is_full"] = False
with open(ZONES_PATH, "w", encoding="utf-8") as f:
    json.dump(zones, f, indent=2, ensure_ascii=False)

# 2) No blocked streets
with open(os.path.join(DATA_DIR, "blocked.json"), "w", encoding="utf-8") as f:
    json.dump([], f)

# 3) Three fresh pending reports
seed_reports.main()

print("Demo reset: zones back to 40/150 and 120/300, no blocked streets, 3 pending reports.")