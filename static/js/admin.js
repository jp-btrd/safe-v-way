/* admin.js - the admin page (Step 5A)
 *
 * Plain-language summary:
 *   1. On load, ask the server "am I logged in?" and show either the login form or the dashboard.
 *   2. Every 4 seconds, re-fetch the safe zones and reports and redraw them if they changed.
 *   3. Buttons send small requests to the server (+/- occupancy, full/reopen, approve/reject).
 *   Report text comes from residents, so we ALWAYS pass it through esc() before showing it.
 */

const $ = (id) => document.getElementById(id);
const POLL_MS = 4000;

let pollTimer = null;
let lastZonesJson = "";      // remember what we drew last time, so we only redraw on real changes
let lastReportsJson = "";
let lastBlockedJson = "";
let currentReports = [];   // newest list from the server, used by the map screen

// Turns text into safe HTML (so a report saying "<script>..." is shown as text, not run)
function esc(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}

function showToast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.style.background = isError ? "#C4161C" : "#0A7A4A";
  t.style.top = "56px";
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 3500);
}

// One helper for every request to the server. A 401 means "not logged in".
async function api(path, method = "GET", body = null) {
  const opts = { method, cache: "no-store", headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401 && path !== "/api/admin/login") {
    showLogin();
    throw new Error("unauthorized");
  }
  return res.json();
}

// ---------- Which screen to show ----------
function showLogin() {
  clearInterval(pollTimer);
  $("login-view").hidden = false;
  $("dash-view").hidden = true;
  $("logout-btn").hidden = true;
  $("conn").textContent = "";
  lastZonesJson = lastReportsJson = "";
}

function showDashboard() {
  $("login-view").hidden = true;
  $("dash-view").hidden = false;
  $("logout-btn").hidden = false;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

// ---------- Login / logout ----------
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("login-error").hidden = true;
  try {
    const data = await api("/api/admin/login", "POST", { password: $("pw").value });
    if (data.ok) {
      $("pw").value = "";
      showDashboard();
    } else {
      $("login-error").textContent = data.message || "Login failed.";
      $("login-error").hidden = false;
    }
  } catch (err) {
    $("login-error").textContent = "Could not reach the server.";
    $("login-error").hidden = false;
  }
});

$("logout-btn").addEventListener("click", async () => {
  await api("/api/admin/logout", "POST").catch(() => {});
  showLogin();
});

// ---------- Draw safe zones ----------
function zoneStateText(z) {
  if (z.is_full) return "Marked full";
  if (!z.is_open) return "No space left";
  return "Open";
}

function renderZones(zones) {
  $("zones").innerHTML = zones.map((z) => {
    const pct = Math.min(100, Math.round((z.occupancy / z.capacity) * 100));
    return `
      <div class="card ${z.is_open ? "open" : "closed"}">
        <h3>${esc(z.name)}</h3>
        <div class="meta">${esc(zoneStateText(z))}. ${z.occupancy} of ${z.capacity} occupied, ${z.remaining} spaces left.</div>
        <div class="bar"><div style="width:${pct}%"></div></div>
        <div class="btn-row">
          <button data-zone="${z.id}" data-delta="-10">-10</button>
          <button data-zone="${z.id}" data-delta="-1">-1</button>
          <button data-zone="${z.id}" data-delta="1">+1</button>
          <button data-zone="${z.id}" data-delta="10">+10</button>
          <button data-zone="${z.id}" data-full="${!z.is_full}" class="${z.is_full ? "primary" : "danger"}">
            ${z.is_full ? "Reopen zone" : "Mark as full"}
          </button>
        </div>
      </div>`;
  }).join("");
}

// One click listener for ALL zone buttons ("event delegation"): we read which button was
// pressed from its data-... attributes.
$("zones").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.disabled = true;
  try {
    if (b.dataset.delta !== undefined) {
      await api(`/api/admin/zones/${b.dataset.zone}/occupancy`, "POST", { delta: Number(b.dataset.delta) });
    } else if (b.dataset.full !== undefined) {
      await api(`/api/admin/zones/${b.dataset.zone}/full`, "POST", { is_full: b.dataset.full === "true" });
    }
    await refresh();
  } catch (err) {
    if (err.message !== "unauthorized") showToast("Could not update the zone.", true);
  }
});

// ---------- Draw reports ----------
function reportCard(r) {
  const when = new Date(r.created_at).toLocaleString();
  const photo = r.photo
    ? `<img class="report-photo" src="/uploads/${esc(r.photo)}" alt="Report photo">`
    : `<div class="meta">(no photo)</div>`;
  const typeStr = r.type === "fire" ? "FIRE" : "OBSTRUCTION";

  if (r.status === "pending") {
    let buttons = "";
    if (r.type === "fire") {
      buttons = `
        <button class="primary" data-report="${r.id}" data-action="verify-fire">Verify Fire</button>
        <button class="danger" data-report="${r.id}" data-action="reject">Reject</button>`;
    } else {
      buttons = `
        <button class="primary" data-report="${r.id}" data-action="block">Verify &amp; Block Street</button>
        <button class="danger" data-report="${r.id}" data-action="reject">Reject</button>`;
    }
    
    return `
      <div class="card pending">
        <h3>Report #${r.id} <span class="status-pill pending" style="background:#F4B000;color:#fff;">${typeStr}</span></h3>
        <div class="meta">${esc(when)}. ${r.lat}, ${r.lon}</div>
        ${photo}
        <p>${esc(r.description)}</p>
        <div class="btn-row">${buttons}</div>
      </div>`;
  }
  
  let resolveBtn = "";
  if (r.status === "active") {
    const label = r.type === "fire" ? "Mark Extinguished" : "Mark Cleared";
    resolveBtn = `<div class="btn-row" style="margin-top: 10px;">
      <button class="primary" data-report="${r.id}" data-action="resolve">${label}</button>
    </div>`;
  }

  let badgeText = r.status;
  if (r.status === "rejected") badgeText = "Rejected";
  if (r.status === "resolved") badgeText = r.type === "fire" ? "Extinguished" : "Cleared";

  return `
    <div class="card">
      <h3>Report #${r.id} <span class="status-pill ${esc(r.status)}">${typeStr} - ${badgeText}</span></h3>
      <div class="meta">${esc(when)}. ${r.lat}, ${r.lon}</div>
      <p>${esc(r.description)}</p>
      ${resolveBtn}
    </div>`;
}

function renderReports(reports) {
  const pendingFires = reports.filter((r) => r.status === "pending" && r.type === "fire");
  const pendingObs = reports.filter((r) => r.status === "pending" && r.type !== "fire");
  const activeFires = reports.filter((r) => r.status === "active" && r.type === "fire");
  const activeObs = reports.filter((r) => r.status === "active" && r.type === "obstruction");
  const past = reports.filter((r) => r.status === "resolved" || r.status === "rejected");
  
  $("pending-fire-count").textContent = pendingFires.length;
  $("pending-obs-count").textContent = pendingObs.length;
  
  $("pending-fires").innerHTML = pendingFires.length ? pendingFires.map(reportCard).join("") : '<p class="empty">No pending fires.</p>';
  $("pending-obstructions").innerHTML = pendingObs.length ? pendingObs.map(reportCard).join("") : '<p class="empty">No pending obstructions.</p>';
  $("active-fires").innerHTML = activeFires.length ? activeFires.map(reportCard).join("") : '<p class="empty">No active fires.</p>';
  $("active-obstructions").innerHTML = activeObs.length ? activeObs.map(reportCard).join("") : '<p class="empty">No active obstructions.</p>';
  $("reviewed").innerHTML = past.length ? past.map(reportCard).join("") : '<p class="empty">Nothing reviewed yet.</p>';
}

function renderReports(reports) {
  const pendingFires = reports.filter((r) => r.status === "pending" && r.type === "fire");
  const pendingObs = reports.filter((r) => r.status === "pending" && r.type !== "fire");
  const activeFires = reports.filter((r) => r.status === "active" && r.type === "fire");
  const activeObs = reports.filter((r) => r.status === "active" && r.type !== "fire");
  const past = reports.filter((r) => r.status === "resolved" || r.status === "rejected");
  
  if ($("pending-fire-count")) $("pending-fire-count").textContent = pendingFires.length;
  if ($("pending-obs-count")) $("pending-obs-count").textContent = pendingObs.length;
  
  if ($("pending-fires")) $("pending-fires").innerHTML = pendingFires.length ? pendingFires.map(reportCard).join("") : '<p class="empty">No pending fires.</p>';
  if ($("pending-obstructions")) $("pending-obstructions").innerHTML = pendingObs.length ? pendingObs.map(reportCard).join("") : '<p class="empty">No pending obstructions.</p>';
  
  if ($("active-fires")) $("active-fires").innerHTML = activeFires.length ? activeFires.map(reportCard).join("") : '<p class="empty">No active fires.</p>';
  if ($("active-obstructions")) $("active-obstructions").innerHTML = activeObs.length ? activeObs.map(reportCard).join("") : '<p class="empty">No active obstructions.</p>';
  
  if ($("reviewed")) $("reviewed").innerHTML = past.length ? past.map(reportCard).join("") : '<p class="empty">Nothing reviewed yet.</p>';
}

document.querySelectorAll("#pending-fires, #pending-obstructions, #active-fires, #active-obstructions, #reviewed").forEach(container => {
  container.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b || !b.dataset.report) return;
    if (b.dataset.action === "block") { 
      openBlockModal(Number(b.dataset.report)); 
      return; 
    }
    if (b.dataset.action === "verify-fire") {
      openVerifyFireModal(Number(b.dataset.report));
      return;
    }
    
    b.disabled = true;
    try {
      let endpoint = `/api/admin/reports/${b.dataset.report}/${b.dataset.action}`;
      if (b.dataset.action === "resolve") endpoint = `/api/admin/reports/${b.dataset.report}/resolve`;
      
      const data = await api(endpoint, "POST");
      if (data.ok) {
        showToast("Report updated.", false);
      } else {
        showToast(data.message || "Could not update.", true);
      }
      await refresh();
    } catch (err) {
      if (err.message !== "unauthorized") showToast("Could not reach the server.", true);
    }
  });
});

// ---------- Fetch + redraw (runs every POLL_MS) ----------
async function refresh() {
  try {
    const [zones, reports, state] = await Promise.all([
      fetch("/api/zones", { cache: "no-store" }).then((r) => r.json()),
      api("/api/admin/reports"),
      fetch("/api/state", { cache: "no-store" }).then((r) => r.json()),
    ]);
    $("conn").textContent = "";

    const zj = JSON.stringify(zones);
    if (zj !== lastZonesJson) { lastZonesJson = zj; renderZones(zones); }

    if (Array.isArray(reports)) {
      currentReports = reports;
      const rj = JSON.stringify(reports);
      if (rj !== lastReportsJson) { lastReportsJson = rj; renderReports(reports); }
    }

    const bj = JSON.stringify(state.blocked);
    if (bj !== lastBlockedJson) { lastBlockedJson = bj; renderBlocked(state.blocked); }
  
    renderHazardList(state.hazard_zones);
    renderHazBldgList(state.haz_bldgs);
  } catch (err) {
    if (err.message !== "unauthorized") $("conn").textContent = "Server unreachable, retrying...";
  }
}

// ---------- Start ----------
(async function init() {
  try {
    const me = await api("/api/admin/me");
    if (me.ok) showDashboard(); else showLogin();
  } catch (err) {
    showLogin();
  }
})();

// =====================================================================
// BLOCKED STREETS LIST + "CLICK THE ALLEY" MAP (Step 5B)
// =====================================================================
function renderBlocked(list) {
  $("blocked").innerHTML = list.length
    ? list.map((b) => `
        <div class="card closed">
          <h3>${esc(b.name || "Unnamed alley / path")}</h3>
          <div class="meta">Street piece ${b.u} to ${b.v}</div>
          <div class="btn-row"><button data-u="${b.u}" data-v="${b.v}">Unblock</button></div>
        </div>`).join("")
    : '<p class="empty">No blocked streets.</p>';
}

$("blocked").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.disabled = true;
  try {
    const data = await api("/api/admin/blocks/remove", "POST", { u: Number(b.dataset.u), v: Number(b.dataset.v) });
    showToast(data.ok ? "Street unblocked. Residents' routes will update." : (data.message || "Could not unblock."), !data.ok);
    await refresh();
  } catch (err) {
    if (err.message !== "unauthorized") showToast("Could not reach the server.", true);
  }
});

// ----- the map screen -----
let bMap = null, bLayers = null, bReport = null, bSnap = null;

function openBlockModal(reportId) {
  bReport = currentReports.find((r) => r.id === reportId);
  if (!bReport) return;
  bSnap = null;
  $("block-desc").textContent = `Report #${bReport.id}: ${bReport.description}`;
  $("block-photo").hidden = !bReport.photo;
  if (bReport.photo) $("block-photo").src = "/uploads/" + bReport.photo;
  $("block-info").textContent = "Tap the map on the alley or street you want to block. The yellow dot is where the resident reported it.";
  $("block-confirm").disabled = true;
  $("block-modal").hidden = false;

  if (!bMap) {                      // create the map the first time only
    bMap = L.map("block-map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: "&copy; OpenStreetMap contributors",
    }).addTo(bMap);
    bLayers = L.layerGroup().addTo(bMap);
    bMap.on("click", onBlockMapClick);
  }
  bMap.setView([bReport.lat, bReport.lon], 18);
  setTimeout(() => bMap.invalidateSize(), 50);   // the map was hidden, so tell Leaflet its real size
  drawBlockMap();
}

// ----- Fire Verification Map -----
let vfMap = null, vfLayers = null, vfReport = null, vfMarker = null;

function openVerifyFireModal(reportId) {
  vfReport = currentReports.find((r) => r.id === reportId);
  if (!vfReport) return;
  
  $("verify-fire-modal").hidden = false;

  if (!vfMap) {
    vfMap = L.map("verify-fire-map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(vfMap);
    vfLayers = L.layerGroup().addTo(vfMap);
    
    vfMap.on("click", (e) => {
      if (vfMarker) vfMap.removeLayer(vfMarker);
      vfMarker = L.marker(e.latlng).addTo(vfMap);
      vfMarker.latlng = e.latlng;
    });
  }
  
  vfMap.setView([vfReport.lat, vfReport.lon], 18);
  setTimeout(() => vfMap.invalidateSize(), 50);
  
  vfLayers.clearLayers();
  vfMarker = L.marker([vfReport.lat, vfReport.lon]).addTo(vfMap);
  vfMarker.latlng = { lat: vfReport.lat, lng: vfReport.lon };
}

$("verify-fire-cancel").addEventListener("click", () => {
  $("verify-fire-modal").hidden = true;
});

$("verify-fire-confirm").addEventListener("click", async () => {
  if (!vfMarker || !vfMarker.latlng) return;
  const lat = vfMarker.latlng.lat;
  const lon = vfMarker.latlng.lng;
  
  try {
    const data = await api(`/api/admin/reports/${vfReport.id}/verify-fire`, "POST", { lat, lon });
    if (data.ok) {
      $("verify-fire-modal").hidden = true;
      showToast("fire verified and marked active", false);
      await refresh();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert("Could not verify fire.");
  }
});

async function drawBlockMap() {
  bLayers.clearLayers();
  // already blocked streets (red)
  try {
    const s = await fetch("/api/state", { cache: "no-store" }).then((r) => r.json());
    s.blocked.forEach((b) => L.polyline(b.path, { color: "#C4161C", weight: 7, opacity: 0.8 }).addTo(bLayers));
  } catch (err) { /* map still works without this layer */ }
  // where the resident reported it
  L.circleMarker([bReport.lat, bReport.lon], { radius: 9, color: "#fff", weight: 3, fillColor: "#F4B000", fillOpacity: 1 }).addTo(bLayers);
  // the street piece the admin's click snapped to (orange, thick)
  if (bSnap) L.polyline(bSnap.path, { color: "#F4B000", weight: 10, opacity: 0.9 }).addTo(bLayers);
}

async function onBlockMapClick(e) {
  try {
    // lat/lon order: Leaflet gives e.latlng.lat and e.latlng.lng
    const data = await api(`/api/admin/snap?lat=${e.latlng.lat}&lon=${e.latlng.lng}`);
    if (!data.ok) {
      bSnap = null;
      $("block-info").textContent = data.message;
      $("block-confirm").disabled = true;
    } else {
      bSnap = data;
      const label = data.name || "an unnamed alley / path";
      $("block-info").textContent = data.already_blocked
        ? `${label} is already blocked.`
        : `Will block ${label} (${data.length_m} m piece). Tap elsewhere to choose a different one.`;
      $("block-confirm").disabled = data.already_blocked;
    }
    drawBlockMap();
  } catch (err) {
    if (err.message !== "unauthorized") $("block-info").textContent = "Could not reach the server.";
  }
}

$("block-confirm").addEventListener("click", async () => {
  if (!bSnap) return;
  $("block-confirm").disabled = true;
  try {
    const data = await api("/api/admin/blocks", "POST", { u: bSnap.u, v: bSnap.v, report_id: bReport.id });
    if (data.ok) {
      $("block-modal").hidden = true;
      showToast("Report approved and street blocked. Residents' routes update within seconds.", false);
      await refresh();
    } else {
      $("block-info").textContent = data.message || "Could not block the street.";
    }
  } catch (err) {
    if (err.message !== "unauthorized") $("block-info").textContent = "Could not reach the server.";
  }
});

$("block-cancel").addEventListener("click", () => { $("block-modal").hidden = true; });

// HAZARD ZONES & HAZARDOUS BUILDINGS
let drawMap = null;
let drawLayers = null;
let pendingLatLng = null;
let hazardMode = null; 
let editingZoneId = null;

function renderHazardList(zones) {
  const list = $("hazard-list");
  if (!list) return;
  if (!zones || zones.length === 0) {
    list.innerHTML = '<p class="empty">No hazard zones defined.</p>';
    return;
  }
  
  list.innerHTML = zones.map(z => {
    let color = "#0A7A4A";
    if (z.level === "Moderate") color = "#F4B000";
    if (z.level === "High") color = "#C4161C";
    
    return `
      <div class="card">
        <h3><span style="display:inline-block;width:12px;height:12px;background:${color};border-radius:50%;margin-right:8px;"></span>${esc(z.name)}</h3>
        <div class="meta">Level: <b>${z.level}</b> (Score: ${z.score}) | Radius: ${z.radius}m</div>
        <div class="meta">Materials: ${z.materials} | Access: ${z.accessibility} | Density: ${z.density}</div>
        <div class="meta" style="margin-top:4px;">Historical Fires: ${z.fire_count} | Haz. Buildings: ${z.hazbldg_count}</div>
        <div class="btn-row" style="margin-top: 8px;">
          <button class="primary" onclick="editZone(${z.id})">Edit</button>
          <button class="danger" onclick="deleteZone(${z.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderHazBldgList(bldgs) {
  const list = $("hazbldg-list");
  if (!list) return;
  if (!bldgs || bldgs.length === 0) {
    list.innerHTML = '<p class="empty">No hazardous buildings marked.</p>';
    return;
  }
  
  list.innerHTML = bldgs.map(b => `
    <div class="card closed">
      <h3>Hazardous Building #${b.id}</h3>
      <div class="meta">${b.lat}, ${b.lon}</div>
      <div class="btn-row"><button class="danger" onclick="deleteHazBldg(${b.id})">Remove Building</button></div>
    </div>
  `).join('');
}

window.deleteZone = async (id) => {
  if (!confirm("Delete this hazard zone?")) return;
  await api(`/api/admin/hazards/${id}`, "DELETE");
  await refresh();
};

window.editZone = async (id) => {
  fetch("/api/state").then(r => r.json()).then(s => {
    const z = s.hazard_zones.find(x => x.id === id);
    if (!z) return;
    
    editingZoneId = z.id;
    pendingLatLng = { lat: z.lat, lng: z.lon };
    
    $("sidebar-title").textContent = "Edit Hazard Zone";
    $("z-name").value = z.name;
    $("z-radius").value = z.radius;
    $("z-density").value = z.density;
    $("z-materials").value = z.materials;
    $("z-access").value = z.accessibility;
    
    $("draw-zone-modal").hidden = false;
    
    setTimeout(() => {
      initDrawMap();
      drawMap.invalidateSize();
      drawMap.setView([z.lat, z.lon], 17);
      drawLayers.clearLayers();
      L.circle([z.lat, z.lon], { radius: z.radius, color: "#0B5CAD", fillOpacity: 0.2 }).addTo(drawLayers);
      L.marker([z.lat, z.lon]).addTo(drawLayers);
      
      $("hazard-sidebar").hidden = false;
    }, 50);
  });
};

window.deleteHazBldg = async (id) => {
  if (!confirm("Remove this hazardous building marker?")) return;
  await api(`/api/admin/hazbldgs/${id}`, "DELETE");
  await refresh();
};

function initDrawMap() {
  if (drawMap) return;
  drawMap = L.map("draw-map").setView([14.684443, 120.990409], 16);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  }).addTo(drawMap);
  drawLayers = L.layerGroup().addTo(drawMap);

  drawMap.on("click", async (e) => {
    if (hazardMode === 'bldg') {
      const res = await api("/api/admin/hazbldgs", "POST", { lat: e.latlng.lat, lon: e.latlng.lng });
      if (res.ok) {
        showToast("Hazardous building marked.", false);
        $("draw-zone-modal").hidden = true;
        await refresh();
      }
      return;
    }

    pendingLatLng = e.latlng;
    drawLayers.clearLayers();
    
    const radius = parseInt($("z-radius").value) || 100;
    L.circle(pendingLatLng, { radius: radius, color: "#0B5CAD", fillOpacity: 0.2 }).addTo(drawLayers);
    L.marker(pendingLatLng).addTo(drawLayers);
    
    $("hazard-sidebar").hidden = false;
    $("sidebar-title").textContent = editingZoneId ? "Edit Hazard Zone" : "New Hazard Zone";
  });
}

$("btn-add-zone").addEventListener("click", () => {
  hazardMode = 'zone';
  pendingLatLng = null;
  editingZoneId = null;
  
  // Reset form
  $("zone-form").reset();
  $("edit-zone-id").value = "";
  
  $("draw-map-title").textContent = "Draw Hazard Zone";
  $("draw-zone-modal").hidden = false;
  $("hazard-sidebar").hidden = true;
  
  setTimeout(() => {
    initDrawMap();
    drawMap.invalidateSize();
    drawLayers.clearLayers();
  }, 50);
});

$("btn-add-hazbldg").addEventListener("click", () => {
  hazardMode = 'bldg';
  $("draw-map-title").textContent = "Mark Hazardous Building";
  $("draw-zone-modal").hidden = false;
  
  setTimeout(() => {
    initDrawMap();
    drawMap.invalidateSize();
    drawLayers.clearLayers();
  }, 50);
});

$("draw-map-cancel").addEventListener("click", () => {
  $("draw-zone-modal").hidden = true;
});

$("sidebar-close").addEventListener("click", () => {
  $("hazard-sidebar").hidden = true;
});

$("z-radius").addEventListener("input", (e) => {
  if (!pendingLatLng || !drawLayers) return;
  drawLayers.clearLayers();
  const radius = parseInt(e.target.value) || 100;
  L.circle(pendingLatLng, { radius: radius, color: "#0B5CAD", fillOpacity: 0.2 }).addTo(drawLayers);
  L.marker(pendingLatLng).addTo(drawLayers);
});

$("zone-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!pendingLatLng) return alert("click the map to set the center first");

  const payload = {
    lat: pendingLatLng.lat,
    lon: pendingLatLng.lng,
    name: $("z-name").value,
    radius: $("z-radius").value,
    density: $("z-density").value,
    materials: $("z-materials").value,
    accessibility: $("z-access").value
  };

  try {
    let res;
    if (editingZoneId) {
      res = await api(`/api/admin/hazards/${editingZoneId}`, "PUT", payload);
    } else {
      res = await api("/api/admin/hazards", "POST", payload);
    }

    if (res.ok) {
      $("draw-zone-modal").hidden = true;
      $("hazard-sidebar").hidden = true;
      showToast(editingZoneId ? "zone updated" : "zone added", false);
      await refresh();
    } else {
      alert(res.message);
    }
  } catch (err) {
    alert("failed to save zone");
  }
});

$("z-cancel").addEventListener("click", () => {
  $("draw-zone-modal").hidden = true;
});