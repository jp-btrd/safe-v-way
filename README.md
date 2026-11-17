# Safe V-Way

A web-based fire hazard mapping and evacuation routing prototype for one pilot
barangay: **Gen. T. De Leon, Valenzuela City, Metro Manila**
(500 m radius around 14.684443, 120.990409).

> Capstone prototype. Safe zone capacities and occupancy are **sample values, not official data**.

## What it does
- Shows safe zones and their remaining capacity on a mobile-friendly Leaflet map.
- Residents tap their location and get the shortest walking route to the nearest safe zone that is not full (OSMnx + NetworkX / Dijkstra).
- Residents report hazards with a location, description, and photo. Reports start as "pending".
- An admin (hard-coded password) approves or rejects reports, taps the alley to block (snapped to the nearest street piece), and updates safe zone occupancy or marks a zone full.
- Resident phones poll the server every 4 seconds, so blocked streets and new routes appear without refreshing.

## What it does not do (future work)
Real GPS, official data, real authentication, database (Supabase), real-time sockets (Socket.IO),
cloud deployment, push notifications / SMS. Everything is stored in local files and memory.
Routes are only as accurate as OpenStreetMap, which may be missing narrow alleys.

## Tech stack
Python, Flask, OSMnx, NetworkX, plain HTML/CSS/JavaScript, Leaflet.js

## Run it
```bash
python -m venv venv
venv\Scripts\activate            # Windows   (macOS/Linux: source venv/bin/activate)
pip install -r requirements.txt

# The street graph is already included in data/. To re-download it (needs internet):
# python download_graph.py

python reset_demo.py             # creates sample reports and resets zones
python app.py
```
- Resident map: http://127.0.0.1:5000/
- Admin page: http://127.0.0.1:5000/admin (demo password: `safevway2026`)
- On a phone on the same Wi-Fi: `http://<laptop-IP>:5000/`

## Folder structure
```
app.py              Flask server and routing logic
download_graph.py   Downloads the street graph (run once)
seed_reports.py     Creates sample pending reports
reset_demo.py       Resets everything to the demo starting state
data/               Graph file, safe zones, runtime JSON
templates/          index.html (resident), admin.html
static/             CSS and JavaScript
uploads/            Report photos (not committed)
```

## Security note
The admin password is hard-coded and the app runs on plain HTTP with no rate limiting.
This is acceptable only for a classroom prototype.

## Map data
Street data and map tiles © OpenStreetMap contributors (ODbL).