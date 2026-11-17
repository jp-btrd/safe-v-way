/* resident.js - the resident map (Step 3)
 *
 * What it does, in plain language:
 *   1. Draws the map and the demo-area boundary
 *   2. Every few seconds asks the server "anything new?" (polling)
 *   3. Shows the safe zones (green = open, red = full) and blocked streets (red X)
 *   4. When the resident taps the map, asks the server for the best route and draws it
 *   5. If something changes (a street is blocked, a zone fills up), it
 *      automatically asks for the route again and tells the resident
 *
 * COORDINATES: Leaflet uses [lat, lon]. Our API uses ?lat=..&lon=..
 * Leaflet gives us e.latlng.lat and e.latlng.lng (lng = longitude).
 */

// ---------- SETTINGS ----------
const CENTER = [14.684443, 120.990409];   // [lat, lon] center of the demo area
const RADIUS_M = 500;
const POLL_MS = 4000;                     // ask the server for updates every 4 seconds

// ---------- MAP SETUP ----------
const map = L.map("map").setView(CENTER, 17);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

// Dashed circle = the pilot area covered by the demo
L.circle(CENTER, { radius: RADIUS_M, color: "#555", weight: 1, dashArray: "6 6", fill: false }).addTo(map);

// Separate layer groups so we can wipe and redraw each kind of thing independently
const zoneLayer = L.layerGroup().addTo(map);
const blockedLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const reportLayer = L.layerGroup().addTo(map);   // the orange pin while reporting

// ---------- STATE ----------
let lastVersion = null;     // the server's version number the last time we looked
let lastClick = null;       // where the resident last tapped, as {lat, lng}
let lastRouteKey = null;    // "zoneId|distance" of the route currently shown
let requestCounter = 0;     // used to ignore slow, out-of-date answers

// ---------- SMALL HELPERS ----------
const $ = (id) => document.getElementById(id);

// Prevents text from the server being treated as HTML
function esc(text) {
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML;
}

function zoneStatusText(z) {
  if (z.is_full) return "MARKED FULL";
  if (!z.is_open) return "NO SPACE LEFT";
  return `${z.remaining} of ${z.capacity} spaces left`;
}

function setStatus(online) {
  $("status").className = "status " + (online ? "online" : "offline");
  $("status-text").textContent = online ? "live" : "offline, retrying...";
}

// Update the bottom panel. kind = "idle" | "ok" | "error"
function setPanel(kind, title, detail, note) {
  $("panel").className = kind;
  $("panel-title").textContent = title;
  $("panel-detail").textContent = detail;
  $("panel-note").hidden = !note;
  $("panel-note").textContent = note || "";
  $("clear-btn").hidden = kind === "idle";
}

// ---------- DRAW SAFE ZONES ----------
function renderZones(zones) {
  zoneLayer.clearLayers();
  zones.forEach((z) => {
    const icon = L.divIcon({
      className: "",                                   // no default Leaflet icon styling
      html: `<div class="zone-pin ${z.is_open ? "open" : "full"}">S</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    const label = `<b>${esc(z.name)}</b><br>${esc(zoneStatusText(z))}`;
    L.marker([z.lat, z.lon], { icon })
      .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -16], className: "zone-tip" })
      .addTo(zoneLayer);
  });
}

// ---------- DRAW BLOCKED STREETS ----------
function renderBlocked(blocked) {
  blockedLayer.clearLayers();
  blocked.forEach((b) => {
    if (!b.path || b.path.length < 2) return;
    L.polyline(b.path, { color: "#d93025", weight: 7, opacity: 0.9 })
      .bindPopup("Blocked street. Not passable.")
      .addTo(blockedLayer);
    // Put a red X at the middle of the blocked piece
    const mid = b.path[Math.floor(b.path.length / 2)];
    L.marker(mid, {
      icon: L.divIcon({ className: "", html: '<div class="block-x">X</div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      interactive: false,
    }).addTo(blockedLayer);
  });
}

// ---------- ROUTING ----------
// isUpdate = true when we are re-checking because the server data changed
async function requestRoute(latlng, isUpdate) {
  const myId = ++requestCounter;       // if the resident taps again, older answers are ignored
  try {
    const res = await fetch(`/api/route?lat=${latlng.lat}&lon=${latlng.lng}`, { cache: "no-store" });
    const data = await res.json();
    if (myId !== requestCounter) return;

    routeLayer.clearLayers();

    // "You are here" marker
    L.circleMarker([latlng.lat, latlng.lng], {
      radius: 8, color: "#fff", weight: 3, fillColor: "#1a73e8", fillOpacity: 1,
    }).addTo(routeLayer);

    if (!data.ok) {                       // no route / tapped too far from a street
      lastRouteKey = null;
      setPanel("error", "No route found", data.message || "Something went wrong.");
      return;
    }

    // The blue walking route
    const line = L.polyline(data.path, { color: "#1a73e8", weight: 6, opacity: 0.9 }).addTo(routeLayer);

    // Dashed grey bits: from the tap to the street, and from the street end to the building
    L.polyline([[latlng.lat, latlng.lng], data.start_snap], { color: "#6b7280", weight: 3, dashArray: "4 6" }).addTo(routeLayer);
    const last = data.path[data.path.length - 1];
    L.polyline([last, [data.zone.lat, data.zone.lon]], { color: "#6b7280", weight: 3, dashArray: "4 6" }).addTo(routeLayer);

    // Did the route change because of an update? Tell the resident.
    const key = `${data.zone.id}|${data.distance_m}`;
    let note = "";
    if (isUpdate && lastRouteKey && key !== lastRouteKey) {
      note = "Route updated because street or safe zone conditions changed.";
    }
    lastRouteKey = key;

    setPanel(
      "ok",
      `Go to ${data.zone.name}`,
      `${data.distance_m} m walk, about ${data.walk_minutes} min. ${zoneStatusText(data.zone)}.`,
      note
    );

    // Zoom to fit the route only when the resident taps (not during background updates,
    // which would make the map jump around while they are looking at it)
    if (!isUpdate) {
      map.fitBounds(line.getBounds().extend([data.zone.lat, data.zone.lon]).extend([latlng.lat, latlng.lng]), {
        paddingTopLeft: [20, 20],
        paddingBottomRight: [20, 190],     // leave room for the bottom panel
        maxZoom: 18,
      });
    }
  } catch (err) {
    if (myId !== requestCounter) return;
    setPanel("error", "Cannot reach the server", "Check your Wi-Fi connection. We will keep trying.");
  }
}

// When the resident taps the map.
// Two modes: normal (find a route) or reporting (choose the hazard's location).
let reportMode = false;

map.on("click", (e) => {
  if (reportMode) {
    setReportSpot(e.latlng);
    return;
  }
  lastClick = e.latlng;
  setPanel("idle", "Finding your route...", "One moment.");
  $("clear-btn").hidden = false;
  requestRoute(e.latlng, false);
});

$("clear-btn").addEventListener("click", () => {
  requestCounter++;                 // ignore any answer still on its way
  lastClick = null;
  lastRouteKey = null;
  routeLayer.clearLayers();
  setPanel("idle", "Tap the map where you are", "We will show the shortest walking route to the nearest safe zone that still has space.");
});

// ---------- POLLING ----------
// Every POLL_MS we ask /api/state for the current version number.
// Only if the version changed do we redraw and recalculate the route.
async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const s = await res.json();
    setStatus(true);

    if (s.version !== lastVersion) {
      const firstLoad = lastVersion === null;
      lastVersion = s.version;
      renderZones(s.zones);
      renderBlocked(s.blocked);
      // If the resident already has a route on screen, recalculate it
      if (!firstLoad && lastClick) requestRoute(lastClick, true);
    }
  } catch (err) {
    setStatus(false);               // server unreachable; we just try again next time
  }
}

poll();                              // once right away
setInterval(poll, POLL_MS);          // then every few seconds
// =====================================================================
// REPORT A HAZARD (Step 4)
// =====================================================================
let reportLatLng = null;       // the spot the resident chose, as {lat, lng}
let sending = false;           // blocks double-taps on "Send"
let chosenPhoto = null;        // the photo file the resident picked (camera or gallery)

function onPhotoPicked(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  chosenPhoto = f;
  $("photo-name").textContent = "Photo selected: " + f.name;
}

function showToast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.style.background = isError ? "#d93025" : "#1e8e3e";
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 4000);
}

function startReport() {
  reportMode = true;
  reportLatLng = null;
  reportLayer.clearLayers();
  $("report-form").reset();
    chosenPhoto = null;
  $("photo-name").textContent = "No photo selected";
  $("report-form").hidden = true;          // form appears after the spot is chosen
  $("report-cancel-1").hidden = false;
  $("report-error").hidden = true;
  $("report-hint").textContent =
    "Step 1: Tap the map to mark where the hazard is (for example, a blocked alley or a fire).";
  $("panel").hidden = true;                // hide the routing panel
  $("report-btn").hidden = true;
  $("report-sheet").hidden = false;
}

function endReport() {
  reportMode = false;
  reportLatLng = null;
  reportLayer.clearLayers();
  $("report-sheet").hidden = true;
  $("panel").hidden = false;
  $("report-btn").hidden = false;
}

// Called when the resident taps the map in reporting mode
function setReportSpot(latlng) {
  reportLatLng = latlng;
  reportLayer.clearLayers();
  L.marker([latlng.lat, latlng.lng], {
    icon: L.divIcon({ className: "", html: '<div class="report-pin">!</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
    interactive: false,
  }).addTo(reportLayer);

  $("report-hint").textContent = "Step 2: Describe the hazard. Tap the map again to move the pin.";
  $("report-form").hidden = false;
  $("report-cancel-1").hidden = true;      // the form has its own Cancel button
}

// Shrink a phone photo before uploading (saves mobile data and makes the demo faster).
// If anything goes wrong we just send the original file.
async function shrinkImage(file, maxSide = 1280, quality = 0.8) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return blob || file;
  } catch (err) {
    return file;
  }
}

function showReportError(msg) {
  $("report-error").textContent = msg;
  $("report-error").hidden = false;
}

async function submitReport(ev) {
  ev.preventDefault();                     // stop the browser from reloading the page
  if (sending) return;
  $("report-error").hidden = true;

  const desc = $("report-desc").value.trim();
  if (!reportLatLng) return showReportError("Please tap the map to choose the spot first.");
  if (!desc) return showReportError("Please write a short description.");

  sending = true;
  $("report-send").disabled = true;
  $("report-send").textContent = "Sending...";

  try {
    const fd = new FormData();             // a "package" of fields + file, like a paper form
    fd.append("lat", reportLatLng.lat);
    fd.append("lon", reportLatLng.lng);    // Leaflet calls longitude "lng"; our API calls it "lon"
    fd.append("description", desc);

    if (chosenPhoto) fd.append("photo", await shrinkImage(chosenPhoto), "photo.jpg");

    const res = await fetch("/api/reports", { method: "POST", body: fd });
    const data = await res.json();

    if (data.ok) {
      endReport();
      showToast("Report sent. An admin will review it.", false);
    } else {
      showReportError(data.message || "Could not send the report.");
    }
  } catch (err) {
    showReportError("Could not reach the server. Check your Wi-Fi and try again.");
  } finally {
    sending = false;
    $("report-send").disabled = false;
    $("report-send").textContent = "Send report";
  }
}

$("report-btn").addEventListener("click", startReport);
$("report-cancel-1").addEventListener("click", endReport);
$("report-cancel-2").addEventListener("click", endReport);
$("report-form").addEventListener("submit", submitReport);

// Photo buttons: each one opens its hidden file input
$("photo-cam-btn").addEventListener("click", () => $("report-photo-cam").click());
$("photo-gal-btn").addEventListener("click", () => $("report-photo").click());
$("report-photo-cam").addEventListener("change", onPhotoPicked);
$("report-photo").addEventListener("change", onPhotoPicked);