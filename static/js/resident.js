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
const RADIUS_M = 2000;
const POLL_MS = 4000;                     // ask the server for updates every 4 seconds

// ---------- MAP SETUP ----------
//two separate maps: one for the map tab, one for the report tab
let mainMap = null;
let reportMap = null;

let zoneLayer, blockedLayer, routeLayer, reportLayer;
let reportMarker = null;
let startMarker = null;

// ---------- STATE ----------
let lastVersion = null;     // the server's version number the last time we looked
let lastClick = null;       // where the resident last tapped, as {lat, lng}
let lockedZoneId = null;
let lastRouteKey = null;    // "zoneId|distance" of the route currently shown
let requestCounter = 0;     // used to ignore slow, out-of-date answers
let currentZones = []; // store zones for the home list
let isMapViewOnly = false;
let userGpsCoords = null;
let isPickingLocation = false;

// Report State
let reportLatLng = null;
let sending = false;
let chosenPhoto = null;

// ---------- SMALL HELPERS ----------
const $ = (id) => document.getElementById(id);

// Prevents text from the server being treated as HTML
function esc(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}

function zoneStatusText(z) {
  if (z.is_full) return "Marked full";
  if (!z.is_open) return "No space left";
  return `${z.remaining} of ${z.capacity} spaces left`;
}

function setStatus(online) {
  $("status").className = "status " + (online ? "online" : "offline");
  $("status-text").textContent = online ? "live" : "offline, retrying...";
}

// Update the bottom panel. kind = "idle" | "ok" | "error"
function setPanel(kind, title, detail, note) {
  if (isMapViewOnly) return;
  $("panel").className = kind;
  $("panel").hidden = false;
  $("panel-title").textContent = title;
  $("panel-detail").textContent = detail;
  $("panel-note").hidden = !note;
  $("panel-note").textContent = note || "";
  $("clear-btn").hidden = kind === "idle";
}

function hidePanel() {
  $("panel").hidden = true;
}

function showToast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.style.background = isError ? "#ff4147" : "#56da3b";
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------- GEOLOCATION & NAVIGATION ----------
function getCurrentLocation(callback) {
  if (!navigator.geolocation) {
    showToast("geoloc is not supported", true);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userGpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      callback(userGpsCoords);
    },
    (err) => {
      showToast("could not get location, using map center", true);
      callback({ lat: CENTER[0], lng: CENTER[1] });
    },
    { enableHighAccuracy: true, timeout: 5000 }
  );
}

function goToMapView(startLocation, zoneIdToLock = null, isViewOnly = false) {
  isMapViewOnly = isViewOnly;
  lockedZoneId = zoneIdToLock;
  isPickingLocation = false;
  
  // update nav ui
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const mapTabBtn = document.querySelector('[data-target="view-map"]');
  if (mapTabBtn && !isViewOnly) mapTabBtn.classList.add('active');
  
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-map').classList.add('active');

  if (mainMap) {
    setTimeout(() => mainMap.invalidateSize(), 50);
  }

  if (isViewOnly) {
    hidePanel();
    $("map-top-bar").style.display = "none";
    if (routeLayer) routeLayer.clearLayers();
    if (startMarker) mainMap.removeLayer(startMarker);
    startMarker = null;
  } else {
    $("map-top-bar").style.display = "flex";
    if (startLocation) {
      lastClick = startLocation;
      $("location-text").textContent = "Current Location";
      updateStartMarker(startLocation);
      setPanel("idle", "Finding your route...", "Wait.");
      requestRoute(startLocation, false);
    }
  }
}

function updateStartMarker(latlng) {
  if (!mainMap) return;
  if (startMarker) mainMap.removeLayer(startMarker);
  startMarker = L.circleMarker([latlng.lat, latlng.lng], {
    radius: 8, color: "#fff", weight: 3, fillColor: "#0B5CAD", fillOpacity: 1,
  }).addTo(mainMap);
}

$("btn-pick-location").addEventListener("click", () => {
  if (isMapViewOnly) return;
  isPickingLocation = !isPickingLocation;
  if (isPickingLocation) {
    showToast("Tap the map to set your starting location", false);
    $("btn-pick-location").style.background = "var(--app-accent)";
    $("btn-pick-location").querySelector("img").style.filter = "invert(1)";
  } else {
    $("btn-pick-location").style.background = "var(--white)";
    $("btn-pick-location").querySelector("img").style.filter = "none";
  }
});

window.promptChangeLocation = () => {
  if (!lastClick) {
    showToast("no current location to modify", true);
    return;
  }
  const newLoc = prompt("Enter starting location or leave blank to tap the map:", `${lastClick.lat.toFixed(5)}, ${lastClick.lng.toFixed(5)}`);
  if (!newLoc) return;
  const parts = newLoc.split(",");
  if (parts.length === 2) {
    const lat = parseFloat(parts[0].trim());
    const lng = parseFloat(parts[1].trim());
    if (!isNaN(lat) && !isNaN(lng)) {
      lastClick = { lat, lng };
      $("location-text").textContent = "Custom Location";
      updateStartMarker(lastClick);
      requestRoute(lastClick, false);
      mainMap.setView([lat, lng], 16);
    } else {
      showToast("Invalid format. Please use 'Lat, Lon'.", true);
    }
  }
};

$("btn-evacuate").addEventListener("click", () => {
  getCurrentLocation((coords) => {
    goToMapView(coords, null, false);
  });
});

$("btn-back-home").addEventListener("click", () => {
  document.querySelector('[data-target="view-home"]').click();
});

// ---------- NAVIGATION ----------
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const target = btn.dataset.target;
    if (!target) return;
    
    //upd ui
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const targetView = document.getElementById(target);
    if(targetView) targetView.classList.add('active');

    if (target === 'view-map') {
      // opened via navbar
      goToMapView(null, null, true); 
    } else if (target === 'view-report') {
      setTimeout(() => reportMap.invalidateSize(), 50);
      hidePanel();
      startReport();
    } else if (target === 'view-home') {
      isMapViewOnly = true; // disable routing if they go back
      hidePanel();
      if (mainMap) mainMap.invalidateSize();
    }
  });
});

// ---------- DRAW SAFE ZONES ----------
function renderZones(zones) {
  currentZones = zones;
  
  // updating map
  if (zoneLayer) {
    zoneLayer.clearLayers();
    zones.forEach((z) => {
      const icon = L.divIcon({
        className: "",
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
// upd the list in home
  const list = $('zone-list');
  if (list) {
    $('zone-count').textContent = zones.length;
    list.innerHTML = zones.map(z => `
      <div class="zone-card">
        <div class="info">
          <h3>${esc(z.name)}</h3>
          <p>${esc(zoneStatusText(z))}</p>
        </div>
        <button class="btn-route" onclick="routeToZone(${z.id})">Route</button>
      </div>
    `).join('');
  }
}
// used when clicking "route" on a zone card
window.routeToZone = (zoneId) => {
  const z = currentZones.find(z => z.id === zoneId);
  if (!z) return;
  getCurrentLocation((coords) => {
    goToMapView(coords, zoneId, false);
  });
};

// ---------- DRAW BLOCKED STREETS ----------
function renderBlocked(blocked) {
  if (!blockedLayer) return;
  blockedLayer.clearLayers();
  blocked.forEach((b) => {
    if (!b.path || b.path.length < 2) return;
    L.polyline(b.path, { color: "#C4161C", weight: 7, opacity: 0.9 })
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
  if (isMapViewOnly) return;
  const myId = ++requestCounter;       // if the resident taps again, older answers are ignored
  try {
    let url = `/api/route?lat=${latlng.lat}&lon=${latlng.lng}`;
    if (lockedZoneId) url += `&target_zone=${lockedZoneId}`;
    
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();
    if (myId !== requestCounter) return;
    if (!mainMap) return;
    routeLayer.clearLayers();
    updateStartMarker(latlng);

    if (!data.ok) {                       // no route / tapped too far from a street
      lastRouteKey = null;
      setPanel("error", "No route found", data.message || "Something went wrong.");
      return;
    }

    // The blue walking route
    const line = L.polyline(data.path, { color: "#0B5CAD", weight: 6, opacity: 0.9 }).addTo(routeLayer);

    // Dashed grey bits: from the tap to the street, and from the street end to the building
    L.polyline([[latlng.lat, latlng.lng], data.start_snap], { color: "#4A5866", weight: 3, dashArray: "4 6" }).addTo(routeLayer);
    const last = data.path[data.path.length - 1];
    L.polyline([last, [data.zone.lat, data.zone.lon]], { color: "#4A5866", weight: 3, dashArray: "4 6" }).addTo(routeLayer);

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
      mainMap.fitBounds(line.getBounds().extend([data.zone.lat, data.zone.lon]).extend([latlng.lat, latlng.lng]), {
        paddingTopLeft: [20, 80],
        paddingBottomRight: [20, 190],     // leave room for the bottom panel
        maxZoom: 18,
      });
    }
  } catch (err) {
    if (myId !== requestCounter) return;
    setPanel("error", "Cannot reach the server", "Check your Wi-Fi connection. We will keep trying.");
  }
}

$("clear-btn").addEventListener("click", () => {
  requestCounter++;                 // ignore any answer still on its way
  lastClick = null;
  lastRouteKey = null;
  if (routeLayer) routeLayer.clearLayers();
  if (startMarker) mainMap.removeLayer(startMarker);
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
      if (!firstLoad && lastClick && !isMapViewOnly) requestRoute(lastClick, true);
    }
  } catch (err) {
    setStatus(false);               // server unreachable; we just try again next time
  }
}

// poll();                              // once right away
// setInterval(poll, POLL_MS);          // then every few seconds
// =====================================================================
// REPORT A HAZARD (Step 4)
// =====================================================================
function onPhotoPicked(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  chosenPhoto = f;
  $("photo-name").textContent = "Photo selected: " + f.name;
}

function startReport() {
  // reportMode = true;
  reportLatLng = null;

  if (reportLayer) reportLayer.clearLayers();
  if (reportMarker && reportMap) {
    reportMap.removeLayer(reportMarker);
    reportMarker = null;
  }
  
  $("report-form").reset();
    chosenPhoto = null;
  $("photo-name").textContent = "No photo selected";
  $("report-form").hidden = true;          // form appears after the spot is chosen
  $("report-cancel-1").hidden = false;
  $("report-error").hidden = true;
  $("report-hint").textContent = "Getting your current location...";
  getCurrentLocation((coords) => {
    userGpsCoords = coords;
    if (reportMap) reportMap.setView([coords.lat, coords.lng], 17);
    $("report-hint").textContent = "Step 1: Tap the map to mark where the hazard is (fire or obstruction).";
    if (reportMap) {
      L.circle(CENTER, { radius: RADIUS_M, color: "#4A5866", weight: 1.5, dashArray: "6 6", fill: false }).addTo(reportMap);
    }
  });
}

function endReport() {
  // switch back to home
  document.querySelector('[data-target="view-home"]').click();
  startReport(); // reset form
}

// Called when the resident taps the map in reporting mode
function setReportSpot(latlng) {
  reportLatLng = latlng;
  if (reportMarker && reportMap) reportMap.removeLayer(reportMarker);
  
  if (reportMap) {
    reportMarker = L.marker([latlng.lat, latlng.lng], {
      icon: L.divIcon({ className: "", html: '<div class="report-pin">!</div>', iconSize: [28, 28], iconAnchor: [14, 14] }),
      interactive: false,
    }).addTo(reportMap);
  }

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
    if (userGpsCoords) {
      fd.append("user_lat", userGpsCoords.lat);
      fd.append("user_lon", userGpsCoords.lng);
    }

    const type = document.querySelector('input[name="report-type"]:checked').value;
    fd.append("type", type);

    if (chosenPhoto) fd.append("photo", await shrinkImage(chosenPhoto), "photo.jpg");

    const res = await fetch("/api/reports", { method: "POST", body: fd });
    const data = await res.json();

    if (data.ok) {
      showToast("Report sent. Routing to nearest safe zone...", false);
      goToMapView(userGpsCoords, null, false);
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

// ---------- INITIALIZATION ----------
function initMaps() {
  // main map
  mainMap = L.map("map", { zoomControl: false }).setView(CENTER, 17);
  L.control.zoom({ position: 'bottomright' }).addTo(mainMap);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mainMap);
  L.circle(CENTER, { radius: RADIUS_M, color: "#4A5866", weight: 1.5, dashArray: "6 6", fill: false }).addTo(mainMap);
  
  zoneLayer = L.layerGroup().addTo(mainMap);
  blockedLayer = L.layerGroup().addTo(mainMap);
  routeLayer = L.layerGroup().addTo(mainMap);

  mainMap.on("click", (e) => {
    if (isMapViewOnly) return;
    if (!isPickingLocation) return; 
        
    isPickingLocation = false;
    $("btn-pick-location").style.background = "var(--white)";
    $("btn-pick-location").querySelector("img").style.filter = "none";

    lastClick = e.latlng;
    $("location-text").textContent = "Custom Location";
    updateStartMarker(e.latlng);
    setPanel("idle", "Finding your route...", "One moment.");
    requestRoute(e.latlng, false);
  });

  // report map
  reportMap = L.map("report-map").setView(CENTER, 18);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(reportMap);
  reportLayer = L.layerGroup().addTo(reportMap);

  reportMap.on("click", (e) => {
    setReportSpot(e.latlng);
  });
}

// $("report-btn").addEventListener("click", startReport);
$("report-cancel-1").addEventListener("click", endReport);
$("report-cancel-2").addEventListener("click", endReport);
$("report-form").addEventListener("submit", submitReport);

// Photo buttons: each one opens its hidden file input
$("photo-cam-btn").addEventListener("click", () => $("report-photo-cam").click());
$("report-photo-cam").addEventListener("change", onPhotoPicked);
// $("report-photo").addEventListener("change", onPhotoPicked);

// Start everything up
initMaps();
poll(); // once right away
setInterval(poll, POLL_MS); // then every few seconds