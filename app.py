"""
app.py  -  Safe V-Way backend (Step 2)

What this file does, in plain language:
  1. Loads the saved street map (graph) from data/gen_t_deleon_walk.graphml
  2. Loads the safe zones and the list of blocked street pieces
  3. Answers requests like "what is the nearest OPEN safe zone to this spot,
     and what is the walking route?"

COORDINATE ORDER REMINDER
  - Leaflet, our JSON files, and the API use  (lat, lon)
  - OSMnx nearest_nodes uses                  X = lon, Y = lat   (reversed!)
  - Graph nodes store their position as       node["y"] = lat, node["x"] = lon
"""

import hmac
import json
import math
import os
import threading
import uuid
from datetime import datetime, timezone
from functools import wraps

import networkx as nx
import osmnx as ox
from flask import Flask, jsonify, render_template, request, send_from_directory, session

# ---------- FILE LOCATIONS (built from this file's folder, so it works from anywhere) ----------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
GRAPH_PATH = os.path.join(DATA_DIR, "gen_t_deleon_walk.graphml")
ZONES_PATH = os.path.join(DATA_DIR, "safe_zones.json")
BLOCKED_PATH = os.path.join(DATA_DIR, "blocked.json")
REPORTS_PATH = os.path.join(DATA_DIR, "reports.json")
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------- SETTINGS ----------
WALK_SPEED_M_PER_S = 1.2      # assumed evacuation walking speed (about 72 m/min); an assumption, not measured
MAX_SNAP_DISTANCE_M = 150     # if a click is farther than this from any mapped street, reject it
CENTER_LAT, CENTER_LON = 14.684443, 120.990409   # (lat, lon) center of the demo area
REPORT_AREA_M = 700            # reports farther than this from the center are rejected
MAX_UPLOAD_BYTES = 10 * 1024 * 1024   # 10 MB hard limit per request
MAX_DESCRIPTION_CHARS = 300

app = Flask(__name__)
lock = threading.Lock()       # Flask handles several requests at once; this keeps shared data safe
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES   # Flask refuses bigger uploads automatically
ADMIN_PASSWORD = os.environ.get("SAFEVWAY_ADMIN_PASSWORD", "safevway2026")   # demo default
app.secret_key = os.environ.get("SAFEVWAY_SECRET_KEY", "safe-v-way-demo-secret")

# ---------- SMALL HELPERS ----------
def haversine_m(lat1, lon1, lat2, lon2):
    """Straight-line distance in meters between two (lat, lon) points."""
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def load_json(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:       # utf-8 matters on Windows (for "ñ")
        return json.load(f)


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ---------- LOAD EVERYTHING AT STARTUP ----------
if not os.path.exists(GRAPH_PATH):
    raise SystemExit("Graph file not found. Run  python download_graph.py  first.")

G = ox.load_graphml(GRAPH_PATH)     # the street network, loaded from disk (no internet needed)
print(f"Loaded street graph: {len(G.nodes)} nodes, {len(G.edges)} edges")

zones = load_json(ZONES_PATH, None)
if zones is None:
    raise SystemExit("data/safe_zones.json not found. Create it from the Step 2 instructions.")

# Each safe zone gets "snapped" to its nearest street node. This is where routes END.
# Kept in a separate dict so we don't write it into safe_zones.json.
ZONE_NODES = {}
for z in zones:
    ZONE_NODES[z["id"]] = int(ox.distance.nearest_nodes(G, X=z["lon"], Y=z["lat"]))  # X=lon, Y=lat
    print(f"  Safe zone {z['id']} '{z['name']}' -> street node {ZONE_NODES[z['id']]}")

# Blocked street pieces. Each entry is {"u": node_id, "v": node_id} meaning
# "the street piece between intersection u and intersection v is blocked".
blocked_list = load_json(BLOCKED_PATH, [])
blocked_set = set()      # fast lookup of (u, v) pairs, both directions


def rebuild_blocked_set():
    blocked_set.clear()
    for b in blocked_list:
        blocked_set.add((b["u"], b["v"]))
        blocked_set.add((b["v"], b["u"]))     # people can't walk it either direction


rebuild_blocked_set()

# Version number goes up on every change. The phone map will poll this in Step 6.
state = {"version": 1}


def bump_version():
    state["version"] += 1

# Resident reports. Each one looks like:
# {"id": 1, "lat": .., "lon": .., "description": "..", "photo": "abc123.jpg" or None,
#  "status": "pending", "created_at": "2026-11-17T09:30:00+00:00"}
# Status will become "approved" or "rejected" when the admin reviews it (Step 5).
reports = load_json(REPORTS_PATH, [])

# ---------- ROUTING LOGIC ----------
def zone_is_open(z):
    """A zone can receive evacuees if it's not marked full AND still has room."""
    return (not z["is_full"]) and z["occupancy"] < z["capacity"]


def edge_cost(u, v, edge_dict):
    """
    Tells NetworkX how 'expensive' it is to walk from u to v.
      - blocked street piece -> None, which means 'pretend this street doesn't exist'
      - otherwise            -> its length in meters
    (OSMnx graphs can have several parallel edges between two nodes, so edge_dict
     holds all of them; we take the shortest.)
    """
    if (u, v) in blocked_set:
        return None
    return min(d.get("length", 1) for d in edge_dict.values())


def find_best_route(start_node):
    """Try every OPEN safe zone; return the one with the shortest walk (or None)."""
    best = None
    for z in zones:
        if not zone_is_open(z):
            continue                                   # full zones are skipped
        try:
            # Dijkstra's algorithm: the standard shortest-path method
            length, path = nx.single_source_dijkstra(
                G, start_node, target=ZONE_NODES[z["id"]], weight=edge_cost
            )
        except nx.NetworkXNoPath:
            continue                                   # blocked off from this zone
        if best is None or length < best["length"]:
            best = {"zone": z, "length": length, "path": path}
    return best


def path_to_latlon(path):
    """
    Turn a list of node ids into [[lat, lon], ...] for Leaflet.
    We use each street piece's real curve shape (geometry) when OSMnx has it,
    so the line follows bends instead of cutting corners.
    """
    if len(path) == 1:
        n = G.nodes[path[0]]
        return [[round(n["y"], 6), round(n["x"], 6)]]

    coords = []
    for u, v in zip(path[:-1], path[1:]):
        data = min(G[u][v].values(), key=lambda d: d.get("length", 0))
        geom = data.get("geometry")
        if geom is not None:
            pts = [(lat, lon) for lon, lat in geom.coords]      # shapely is (x=lon, y=lat) -> flip
            nu = G.nodes[u]
            # geometry may be stored in either direction; make sure it starts at u
            if haversine_m(pts[0][0], pts[0][1], nu["y"], nu["x"]) > \
               haversine_m(pts[-1][0], pts[-1][1], nu["y"], nu["x"]):
                pts.reverse()
        else:
            pts = [(G.nodes[u]["y"], G.nodes[u]["x"]), (G.nodes[v]["y"], G.nodes[v]["x"])]
        coords.extend(pts)
    return [[round(lat, 6), round(lon, 6)] for lat, lon in coords]


def zone_public(z):
    """What the browser is allowed to see about a zone."""
    return {**z, "remaining": max(z["capacity"] - z["occupancy"], 0), "is_open": zone_is_open(z)}


def compute_route(lat, lon):
    """Snap the click to the street network, then find the best open safe zone."""
    start_node = int(ox.distance.nearest_nodes(G, X=lon, Y=lat))     # X=lon, Y=lat
    n = G.nodes[start_node]
    snap = haversine_m(lat, lon, n["y"], n["x"])

    if snap > MAX_SNAP_DISTANCE_M:
        return {"ok": False, "error": "outside_area",
                "message": "That spot is too far from any mapped street. Tap closer to a street inside the demo area."}, 422

    best = find_best_route(start_node)
    if best is None:
        return {"ok": False, "error": "no_route",
                "message": "No open safe zone can be reached from here right now."}, 404

    return {
        "ok": True,
        "zone": zone_public(best["zone"]),
        "distance_m": round(best["length"]),
        "walk_minutes": max(1, math.ceil(best["length"] / WALK_SPEED_M_PER_S / 60)),
        "path": path_to_latlon(best["path"]),                   # [[lat, lon], ...] for Leaflet
        "start_snap": [round(n["y"], 6), round(n["x"], 6)],     # where the click landed on a street
        "snap_distance_m": round(snap),
    }, 200


def add_blocked(u, v, report_id=None, name=""):
    """Mark the street piece u-v as blocked. Returns False if it already was."""
    if (u, v) in blocked_set:
        return False
    blocked_list.append({"u": int(u), "v": int(v), "name": name, "report_id": report_id})
    rebuild_blocked_set()
    save_json(BLOCKED_PATH, blocked_list)
    bump_version()
    return True


def read_lat_lon():
    """Read ?lat=..&lon=.. from the URL. Raises ValueError if missing or bad."""
    lat = float(request.args["lat"])      # KeyError if missing -> caught by callers as ValueError below
    lon = float(request.args["lon"])
    if not (math.isfinite(lat) and math.isfinite(lon)):
        raise ValueError
    return lat, lon


BAD_REQUEST = ({"ok": False, "error": "bad_request",
                "message": "Give numeric lat and lon, e.g. ?lat=14.684&lon=120.990"}, 400)


# ---------- API ENDPOINTS ----------
@app.route("/")
def home():
    """The resident map page (templates/index.html)."""
    return render_template("index.html")

@app.route("/dev")
def dev_home():
    return """
    <h2>Safe V-Way backend is running</h2>
    <p>Test links (open them in the browser):</p>
    <ul>
      <li><a href="/api/zones">/api/zones</a></li>
      <li><a href="/api/route?lat=14.6840&lon=120.9890">/api/route?lat=14.6840&amp;lon=120.9890</a></li>
      <li><a href="/api/state">/api/state</a></li>
    </ul>
    <p>Temporary test tools (replaced by the admin page later):</p>
    <ul>
      <li><a href="/api/dev/block-middle?lat=14.6840&lon=120.9890">block the middle of that route</a></li>
      <li><a href="/api/dev/clear-blocks">clear all blocks</a></li>
      <li><a href="/api/dev/toggle-full/1">toggle zone 1 full / not full</a></li>
      <li><a href="/api/dev/toggle-full/2">toggle zone 2 full / not full</a></li>
    </ul>
    """


@app.route("/api/zones")
def api_zones():
    with lock:
        return jsonify([zone_public(z) for z in zones])


@app.route("/api/route")
def api_route():
    try:
        lat, lon = read_lat_lon()
    except (KeyError, ValueError):
        return jsonify(BAD_REQUEST[0]), BAD_REQUEST[1]
    with lock:
        result, status = compute_route(lat, lon)
    return jsonify(result), status


@app.route("/api/state")
def api_state():
    """Everything the resident map needs in one call (used for polling in Step 6)."""
    with lock:
        return jsonify({
            "version": state["version"],
            "zones": [zone_public(z) for z in zones],
            "blocked": [{"u": b["u"], "v": b["v"], "name": b.get("name", ""),
                        "path": path_to_latlon([b["u"], b["v"]])}
                       for b in blocked_list],
        })


# ---------- TEMPORARY DEV TOOLS (no password; Steps 4 and 5 replace them with the real admin tools) ----------
@app.route("/api/dev/block-middle")
def dev_block_middle():
    """Blocks the street piece in the middle of the current best route, to test rerouting."""
    try:
        lat, lon = read_lat_lon()
    except (KeyError, ValueError):
        return jsonify(BAD_REQUEST[0]), BAD_REQUEST[1]
    with lock:
        start_node = int(ox.distance.nearest_nodes(G, X=lon, Y=lat))
        best = find_best_route(start_node)
        if best is None or len(best["path"]) < 2:
            return jsonify(ok=False, message="No route to block."), 404
        i = (len(best["path"]) - 1) // 2
        u, v = best["path"][i], best["path"][i + 1]
        add_blocked(u, v)
    return jsonify(ok=True, message="Blocked one street piece. Now reload /api/route with the same lat/lon.",
                   blocked_count=len(blocked_list))


@app.route("/api/dev/clear-blocks")
def dev_clear_blocks():
    with lock:
        blocked_list.clear()
        rebuild_blocked_set()
        save_json(BLOCKED_PATH, blocked_list)
        bump_version()
    return jsonify(ok=True, message="All blocks cleared.")


@app.route("/api/dev/toggle-full/<int:zone_id>")
def dev_toggle_full(zone_id):
    with lock:
        for z in zones:
            if z["id"] == zone_id:
                z["is_full"] = not z["is_full"]
                save_json(ZONES_PATH, zones)
                bump_version()
                return jsonify(ok=True, zone=zone_public(z))
    return jsonify(ok=False, message="No such zone."), 404

# ---------- RESIDENT REPORTS ----------
def detect_image_type(head):
    """
    Look at the first bytes of the uploaded file to see what it REALLY is.
    We never trust the file name, because anyone can rename a file to .jpg.
    Returns "jpg", "png", "webp", or None if it isn't an allowed image.
    """
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


@app.errorhandler(413)
def too_large(_e):
    return jsonify(ok=False, error="too_large", message="That photo is too large. Please choose a smaller one."), 413


@app.route("/api/reports", methods=["POST"])
def api_submit_report():
    """Resident sends: lat, lon, description, and (optionally) a photo, as a multipart form."""
    # 1) Read and check the location
    try:
        lat = float(request.form["lat"])
        lon = float(request.form["lon"])
        if not (math.isfinite(lat) and math.isfinite(lon)):
            raise ValueError
    except (KeyError, ValueError):
        return jsonify(ok=False, error="bad_request", message="Please tap the map to choose the spot first."), 400

    if haversine_m(lat, lon, CENTER_LAT, CENTER_LON) > REPORT_AREA_M:
        return jsonify(ok=False, error="outside_area",
                       message="That spot is outside the demo area. Please choose a spot inside the dashed circle."), 422

    # 2) Check the description
    description = request.form.get("description", "").strip()
    if not description:
        return jsonify(ok=False, error="bad_request", message="Please write a short description."), 400
    description = description[:MAX_DESCRIPTION_CHARS]

    # 3) Save the photo (if there is one) under a random name we choose ourselves
    photo_name = None
    photo = request.files.get("photo")
    if photo and photo.filename:
        head = photo.stream.read(12)
        photo.stream.seek(0)
        ext = detect_image_type(head)
        if ext is None:
            return jsonify(ok=False, error="bad_photo",
                           message="Only JPG, PNG, or WEBP photos are allowed."), 400
        photo_name = f"{uuid.uuid4().hex}.{ext}"
        photo.save(os.path.join(UPLOAD_DIR, photo_name))

    # 4) Add the report, status "pending"
    with lock:
        report = {
            "id": max((r["id"] for r in reports), default=0) + 1,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "description": description,
            "photo": photo_name,
            "status": "pending",
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        reports.append(report)
        save_json(REPORTS_PATH, reports)

    return jsonify(ok=True, id=report["id"], message="Report received. An admin will review it."), 201


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    """Lets the admin page show report photos. send_from_directory blocks '../' tricks."""
    return send_from_directory(UPLOAD_DIR, filename)


# TEMPORARY: lets you see all reports as JSON while testing. Step 5 replaces it with the password-protected admin list.
@app.route("/api/dev/reports")
def dev_reports():
    with lock:
        return jsonify(reports)

# ---------- ADMIN (hard-coded password; NOT real security) ----------
def admin_required(fn):
    """Put this above any route that only the admin may use."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not session.get("admin"):
            return jsonify(ok=False, error="unauthorized", message="Please log in."), 401
        return fn(*args, **kwargs)
    return wrapper


def find_zone(zone_id):
    return next((z for z in zones if z["id"] == zone_id), None)


@app.route("/admin")
def admin_page():
    """The page itself is public, but every bit of data on it needs the login."""
    return render_template("admin.html")


@app.route("/api/admin/login", methods=["POST"])
def admin_login():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password", ""))
    # compare_digest compares in constant time (good habit even for a demo)
    if hmac.compare_digest(password.encode(), ADMIN_PASSWORD.encode()):
        session["admin"] = True
        return jsonify(ok=True)
    return jsonify(ok=False, error="wrong_password", message="Wrong password."), 401


@app.route("/api/admin/logout", methods=["POST"])
def admin_logout():
    session.pop("admin", None)
    return jsonify(ok=True)


@app.route("/api/admin/me")
def admin_me():
    return jsonify(ok=bool(session.get("admin")))


@app.route("/api/admin/reports")
@admin_required
def admin_reports():
    """All reports: pending first (newest on top), then approved, then rejected."""
    order = {"pending": 0, "approved": 1, "rejected": 2}
    with lock:
        items = sorted(reports, key=lambda r: (order.get(r["status"], 3), -r["id"]))
        return jsonify(items)


@app.route("/api/admin/reports/<int:report_id>/<action>", methods=["POST"])
@admin_required
def admin_review_report(report_id, action):
    """action is 'approve' or 'reject'. Only pending reports can be reviewed."""
    if action not in ("approve", "reject"):
        return jsonify(ok=False, message="Unknown action."), 404
    with lock:
        for r in reports:
            if r["id"] == report_id:
                if r["status"] != "pending":
                    return jsonify(ok=False, error="already_reviewed",
                                   message="This report was already reviewed."), 409
                r["status"] = "approved" if action == "approve" else "rejected"
                r["reviewed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                save_json(REPORTS_PATH, reports)
                return jsonify(ok=True, report=r)
    return jsonify(ok=False, message="No such report."), 404


@app.route("/api/admin/zones/<int:zone_id>/occupancy", methods=["POST"])
@admin_required
def admin_zone_occupancy(zone_id):
    """Body: {"delta": 10} or {"delta": -1}. Occupancy stays between 0 and capacity."""
    data = request.get_json(silent=True) or {}
    try:
        delta = int(data["delta"])
    except (KeyError, TypeError, ValueError):
        return jsonify(ok=False, message="Give a whole number 'delta'."), 400
    with lock:
        z = find_zone(zone_id)
        if z is None:
            return jsonify(ok=False, message="No such zone."), 404
        new_value = max(0, min(z["capacity"], z["occupancy"] + delta))
        if new_value != z["occupancy"]:
            z["occupancy"] = new_value
            save_json(ZONES_PATH, zones)
            bump_version()                      # tells every resident phone "something changed"
        return jsonify(ok=True, zone=zone_public(z))


@app.route("/api/admin/zones/<int:zone_id>/full", methods=["POST"])
@admin_required
def admin_zone_full(zone_id):
    """Body: {"is_full": true} marks the zone full; false reopens it."""
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("is_full"), bool):
        return jsonify(ok=False, message="Give is_full as true or false."), 400
    with lock:
        z = find_zone(zone_id)
        if z is None:
            return jsonify(ok=False, message="No such zone."), 404
        if z["is_full"] != data["is_full"]:
            z["is_full"] = data["is_full"]
            save_json(ZONES_PATH, zones)
            bump_version()
        return jsonify(ok=True, zone=zone_public(z))

# ---------- ADMIN: BLOCK / UNBLOCK STREETS ----------
MAX_BLOCK_SNAP_M = 40      # the admin's click must be within 40 m of a mapped street piece

# Every street piece (edge) with its shape, built once at startup.
# Key = (smaller node id, larger node id) so both walking directions count as ONE piece.
EDGE_SHAPES = {}


def build_edge_shapes():
    for u, v in G.edges():
        if u == v:
            continue
        key = (min(u, v), max(u, v))
        if key not in EDGE_SHAPES:
            EDGE_SHAPES[key] = (u, v, path_to_latlon([u, v]))     # [[lat, lon], ...]


build_edge_shapes()


def dist_to_polyline_m(lat, lon, pts):
    """
    Shortest distance in meters from a point to a line made of [lat, lon] points.
    Uses a flat-map approximation, which is accurate enough over a 1 km area.
    """
    kx = 111320 * math.cos(math.radians(lat))     # meters per degree of longitude here
    ky = 110540                                   # meters per degree of latitude
    best = float("inf")
    for (la1, lo1), (la2, lo2) in zip(pts[:-1], pts[1:]):
        x1, y1 = (lo1 - lon) * kx, (la1 - lat) * ky      # segment start, relative to the click
        x2, y2 = (lo2 - lon) * kx, (la2 - lat) * ky      # segment end
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        t = 0 if seg2 == 0 else max(0, min(1, -(x1 * dx + y1 * dy) / seg2))
        best = min(best, math.hypot(x1 + t * dx, y1 + t * dy))
    return best


def snap_to_street(lat, lon):
    """Find the street piece closest to (lat, lon). Returns (distance_m, u, v, pts) or None."""
    best = None
    for u, v, pts in EDGE_SHAPES.values():
        if len(pts) < 2:
            continue
        d = dist_to_polyline_m(lat, lon, pts)
        if best is None or d < best[0]:
            best = (d, u, v, pts)
    return best


def street_name(u, v):
    data = min(G[u][v].values(), key=lambda d: d.get("length", 0))
    name = data.get("name", "")
    return " / ".join(name) if isinstance(name, list) else str(name or "")


@app.route("/api/admin/snap")
@admin_required
def admin_snap():
    """PREVIEW only: which street piece would a click at ?lat=..&lon=.. block? Changes nothing."""
    try:
        lat, lon = read_lat_lon()
    except (KeyError, ValueError):
        return jsonify(BAD_REQUEST[0]), BAD_REQUEST[1]
    with lock:
        best = snap_to_street(lat, lon)
        if best is None or best[0] > MAX_BLOCK_SNAP_M:
            return jsonify(ok=False, message=f"No mapped street within {MAX_BLOCK_SNAP_M} m of that spot. Tap closer to the alley."), 422
        d, u, v, pts = best
        length = min(x.get("length", 0) for x in (G[u][v] if G.has_edge(u, v) else G[v][u]).values())
        return jsonify(ok=True, u=u, v=v, name=street_name(u, v) if G.has_edge(u, v) else street_name(v, u),
                       length_m=round(length), distance_m=round(d), path=pts,
                       already_blocked=(u, v) in blocked_set)


@app.route("/api/admin/blocks", methods=["POST"])
@admin_required
def admin_add_block():
    """Body: {"u": .., "v": .., "report_id": 1 (optional)}. Blocks the piece AND approves the report."""
    data = request.get_json(silent=True) or {}
    try:
        u, v = int(data["u"]), int(data["v"])
        report_id = int(data["report_id"]) if data.get("report_id") is not None else None
    except (KeyError, TypeError, ValueError):
        return jsonify(ok=False, message="Give u, v (and optionally report_id) as numbers."), 400
    with lock:
        if not G.has_edge(u, v):
            if G.has_edge(v, u):
                u, v = v, u
            else:
                return jsonify(ok=False, message="That street piece does not exist."), 404
        if not add_blocked(u, v, report_id, street_name(u, v)):
            return jsonify(ok=False, error="already_blocked", message="That street piece is already blocked."), 409
        if report_id is not None:
            for r in reports:
                if r["id"] == report_id and r["status"] == "pending":
                    r["status"] = "approved"
                    r["blocked_edge"] = [u, v]
                    r["reviewed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                    save_json(REPORTS_PATH, reports)
        return jsonify(ok=True, blocked_count=len(blocked_list))


@app.route("/api/admin/blocks/remove", methods=["POST"])
@admin_required
def admin_remove_block():
    data = request.get_json(silent=True) or {}
    try:
        u, v = int(data["u"]), int(data["v"])
    except (KeyError, TypeError, ValueError):
        return jsonify(ok=False, message="Give u and v as numbers."), 400
    with lock:
        before = len(blocked_list)
        blocked_list[:] = [b for b in blocked_list if {b["u"], b["v"]} != {u, v}]
        if len(blocked_list) == before:
            return jsonify(ok=False, message="That street piece was not blocked."), 404
        rebuild_blocked_set()
        save_json(BLOCKED_PATH, blocked_list)
        bump_version()
        return jsonify(ok=True)

if __name__ == "__main__":
    # host="0.0.0.0" lets phones on the same Wi-Fi reach the laptop.
    # debug is OFF on purpose: Flask's debug mode lets anyone on the network run code on your laptop.
    # That means you must stop (Ctrl+C) and re-run after editing app.py.
    app.run(host="0.0.0.0", port=5000, debug=False)