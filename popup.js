// ============================================
// Maps Lead Scraper Pro v5.0 — Snapshot Architecture
// Popup Controller: Setup → Capture → Extract
// ============================================

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// Fields
const ALL_FIELDS = ["title", "phone", "email", "website", "address", "category",
  "rating", "reviewCount", "hours", "domain", "latitude", "url",
  "facebook", "instagram", "twitter", "linkedin", "youtube", "whatsapp"];

function setStatus(msg) { statusEl.textContent = msg; }

function setStatusBadge(state) {
  const badge = $("statusBadge");
  badge.className = "status-pill " + state;
  badge.textContent = state === "running" ? "Running" : state === "paused" ? "Paused" : "Ready";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== Step Navigation =====
let currentStep = 1;

function showStep(step) {
  currentStep = step;
  $("stepSetup").style.display = step === 1 ? "block" : "none";
  $("stepCapture").style.display = step === 2 ? "block" : "none";
  $("stepExtract").style.display = step === 3 ? "block" : "none";

  document.querySelectorAll(".step-indicator .step").forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove("active", "completed");
    if (s === step) el.classList.add("active");
    else if (s < step) el.classList.add("completed");
  });
  document.querySelectorAll(".step-line").forEach((line, i) => {
    line.classList.toggle("active", i < step - 1);
  });

  refreshStats();
}

$("goToCapture").addEventListener("click", () => {
  const keywords = $("searchInput").value.trim();
  if (!keywords) { setStatus("Enter at least one keyword."); $("searchInput").focus(); return; }
  showStep(2);
  setStatus("Ready to capture.");
});
$("backToSetup").addEventListener("click", () => showStep(1));
$("goToExtract").addEventListener("click", () => showStep(3));
$("backToCapture").addEventListener("click", () => showStep(2));

// ===== Stats =====
async function refreshStats() {
  const res = await chrome.runtime.sendMessage({ type: "GET_STATS" });
  if (!res || !res.ok) return;

  $("totalLeadsHeader").textContent = res.totalLeads;
  $("totalSnapsHeader").textContent = res.snapshots.total;

  // Capture step
  $("snapTotal").textContent = res.snapshots.total;
  $("snapUnextracted").textContent = res.snapshots.unextracted;
  $("captureCount").textContent = res.snapshots.total;

  // Extract step
  $("extractPending").textContent = res.snapshots.unextracted;
  $("extractLeads").textContent = res.totalLeads;
  $("extractToday").textContent = res.todayLeads;
  $("leadsCount").textContent = res.totalLeads;

  // Render recent captures
  renderCaptureList(res.snapshots.names || []);
}

function renderCaptureList(names) {
  const list = $("captureList");
  if (!names.length) { list.innerHTML = '<div class="empty-msg">No captures yet.</div>'; return; }
  list.innerHTML = names.reverse().map(n =>
    `<div class="capture-item ${n.extracted ? 'extracted' : ''}">
      <span class="capture-name">${(n.name || "?").slice(0, 28)}</span>
      <span class="capture-badge">${n.extracted ? '✓' : '●'}</span>
    </div>`
  ).join("");
}

// ===== Preview Table =====
async function renderPreviewTable() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const tbody = $("previewBody");
  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">Extract from cache to see leads here.</td></tr>';
    return;
  }
  const last10 = leads.slice(-10).reverse();
  tbody.innerHTML = last10.map((l, i) => {
    const name = (l.title || "—").slice(0, 20);
    const phone = (l.phone || "—").slice(0, 14);
    const email = (l.email || "—").slice(0, 22);
    return `<tr><td>${i+1}</td><td title="${l.title || ''}">${name}</td><td>${phone}</td><td title="${l.email || ''}">${email}</td></tr>`;
  }).join("");
}

// ===== CAPTURE =====
$("captureBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const onMaps = tab && /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(tab.url || "");

  const keywords = $("searchInput").value.trim().split("\n").map(k => k.trim()).filter(Boolean);
  const locations = $("locationInput").value.trim().split("\n").map(l => l.trim()).filter(Boolean);

  if (!onMaps) {
    if (!keywords.length) { setStatus("Enter keywords in Setup first."); showStep(1); return; }
    const query = keywords[0] + (locations.length ? " " + locations[0] : "");
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    if (tab) chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });
    setStatus(`Opening Maps: "${query}"... Click Capture again once loaded.`);
    return;
  }

  // Start capture
  setStatus("Capturing...");
  setStatusBadge("running");
  showCaptureRunning(true);

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_START" });
    if (res && res.ok) {
      setStatus(`Captured ${res.captured} places! Total: ${res.total}`);
    } else if (res && res.captcha) {
      setStatus("CAPTCHA detected. Cooldown started.");
      setStatusBadge("paused");
    } else {
      setStatus(res?.error || "Capture failed. Reload Maps.");
    }
  } catch (e) {
    setStatus("Cannot reach Maps tab. Reload the page.");
  }
  showCaptureRunning(false);
  setStatusBadge("ready");
  refreshStats();
});

$("stopCaptureBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_STOP" }); } catch (_) {} }
  setStatus("Stopping...");
  showCaptureRunning(false);
  setStatusBadge("ready");
});

function showCaptureRunning(running) {
  $("captureBtn").style.display = running ? "none" : "flex";
  $("stopCaptureBtn").style.display = running ? "flex" : "none";
  $("progressBox").style.display = running ? "block" : "none";
}

// ===== EXTRACT =====
$("extractBtn").addEventListener("click", async () => {
  setStatus("Extracting from cache (offline)...");
  setStatusBadge("running");
  $("extractProgressBox").style.display = "block";

  const res = await chrome.runtime.sendMessage({ type: "EXTRACT_ALL" });
  if (res && res.ok) {
    setStatus(`Extracted ${res.extracted} leads! Total: ${res.totalLeads}`);
  } else {
    setStatus(res?.msg || res?.error || "Nothing to extract.");
  }
  $("extractProgressBox").style.display = "none";
  setStatusBadge("ready");
  refreshStats();
  renderPreviewTable();
});

// ===== ENRICH =====
$("enrichBtn").addEventListener("click", async () => {
  setStatus("Enriching websites for emails + socials...");
  setStatusBadge("running");
  $("extractProgressBox").style.display = "block";

  const res = await chrome.runtime.sendMessage({ type: "ENRICH_LEADS" });
  if (res && res.ok) {
    setStatus(`Enriched ${res.updated} leads!`);
  } else {
    setStatus("Nothing to enrich or all done.");
  }
  $("extractProgressBox").style.display = "none";
  setStatusBadge("ready");
  refreshStats();
  renderPreviewTable();
});

// ===== EXPORT =====
$("exportCsv").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_CSV" });
  setStatus(res && res.ok ? "CSV downloaded!" : "No leads to export.");
});
$("exportJson").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_JSON" });
  setStatus(res && res.ok ? "JSON downloaded!" : "No leads to export.");
});

// ===== CACHE MANAGER =====
$("clearExtracted").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "CLEAR_EXTRACTED_SNAPSHOTS" });
  setStatus(res.ok ? `Cleared ${res.removed} extracted snapshots.` : "Failed.");
  refreshStats();
});
$("clearAllSnaps").addEventListener("click", async () => {
  if (!confirm("Delete ALL cached HTML snapshots?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_SNAPSHOTS" });
  setStatus("All snapshots cleared.");
  refreshStats();
});
$("clearLeads").addEventListener("click", async () => {
  if (!confirm("Delete ALL extracted leads?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_LEADS" });
  setStatus("All leads cleared.");
  refreshStats();
  renderPreviewTable();
});

// ===== PASSIVE CAPTURE TOGGLE =====
$("passiveCapture").addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  await chrome.storage.local.set({ passiveCapture: enabled });

  const tab = await getActiveTab();
  if (tab && /maps/.test(tab.url || "")) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: enabled ? "PASSIVE_START" : "PASSIVE_STOP" });
    } catch (_) {}
  }
  $("passiveStatus").style.display = enabled ? "flex" : "none";
  setStatus(enabled ? "Passive capture ON — browse Maps normally." : "Passive capture OFF.");
});

// ===== FIELDS TOGGLE =====
$("fieldsToggle").addEventListener("click", () => {
  const body = $("fieldsBody");
  const open = body.style.display !== "none";
  body.style.display = open ? "none" : "block";
  $("fieldsToggle").classList.toggle("open", !open);
});

// ===== SETTINGS =====
async function loadSettings() {
  const s = await chrome.storage.local.get([
    "passiveCapture", "targetLeads", "captureWait", "searchScroll",
    "savedKeywords", "savedLocations", "fields"
  ]);

  $("passiveCapture").checked = !!s.passiveCapture;
  $("passiveStatus").style.display = s.passiveCapture ? "flex" : "none";
  $("targetLeads").value = s.targetLeads || 100;
  $("captureWait").value = s.captureWait || 2;
  if (s.savedKeywords) $("searchInput").value = s.savedKeywords;
  if (s.savedLocations) $("locationInput").value = s.savedLocations;
  updateInputCounts();

  const fields = s.fields || {};
  for (const f of ALL_FIELDS) {
    const el = $(`f_${f}`);
    if (el && fields[f] !== undefined) el.checked = !!fields[f];
  }
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function saveFields() {
  const fields = {};
  for (const f of ALL_FIELDS) fields[f] = !!$(`f_${f}`).checked;
  await chrome.storage.local.set({ fields });
}

function updateInputCounts() {
  const kw = $("searchInput").value.trim().split("\n").filter(Boolean).length;
  const lc = $("locationInput").value.trim().split("\n").filter(Boolean).length;
  $("keywordCount").textContent = kw;
  $("locationCount").textContent = lc;
}

// Input listeners
$("searchInput").addEventListener("input", () => { updateInputCounts(); saveSetting("savedKeywords", $("searchInput").value); });
$("locationInput").addEventListener("input", () => { updateInputCounts(); saveSetting("savedLocations", $("locationInput").value); });
$("targetLeads").addEventListener("change", (e) => saveSetting("targetLeads", Number(e.target.value) || 100));
$("captureWait").addEventListener("change", (e) => saveSetting("captureWait", Number(e.target.value) || 2));
ALL_FIELDS.forEach(f => { const el = $(`f_${f}`); if (el) el.addEventListener("change", saveFields); });

// ===== Progress Rendering =====
function renderProgress(p) {
  if (!p || !p.isRunning) {
    $("progressBox").style.display = "none";
    $("extractProgressBox").style.display = "none";
    showCaptureRunning(false);
    setStatusBadge("ready");
    return;
  }

  // Determine which progress box
  const isExtract = (p.title || "").toLowerCase().includes("extract") || (p.title || "").toLowerCase().includes("enrich");
  const box = isExtract ? "extractProgressBox" : "progressBox";
  $(box).style.display = "block";

  const prefix = isExtract ? "extractProg" : "prog";
  const titleEl = isExtract ? "extractProgressTitle" : "progressTitle";
  const fillEl = isExtract ? "extractProgressFill" : "progressFill";

  $(titleEl).textContent = p.title || "Working...";
  $(`${prefix}Page`).textContent = p.currentPage || 0;
  $(`${prefix}Total` === "progTotal" ? "progPageTotal" : `${prefix}Total`).textContent = p.totalPages || "?";

  // Fix element IDs
  if (!isExtract) {
    $("progPage").textContent = p.currentPage || 0;
    $("progPageTotal").textContent = p.totalPages || "?";
    $("progFound").textContent = p.totalFound || 0;
    $("progCurrent").textContent = p.currentItem || "";
  } else {
    $("extractProgPage").textContent = p.currentPage || 0;
    $("extractProgTotal").textContent = p.totalPages || "?";
    $("extractProgFound").textContent = p.totalFound || 0;
    $("extractProgCurrent").textContent = p.currentItem || "";
  }

  const pct = p.totalPages > 0 ? Math.min(100, Math.round((p.currentPage / p.totalPages) * 100)) : 0;
  $(fillEl).style.width = pct + "%";
  setStatusBadge("running");
}

// ===== CAPTCHA Timer =====
let captchaTimer = null;
async function checkCaptchaCooldown() {
  const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
  if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
    $("captchaBanner").style.display = "flex";
    setStatusBadge("paused");
    if (captchaTimer) clearInterval(captchaTimer);
    const update = () => {
      const rem = captchaDetected.cooldownUntil - Date.now();
      if (rem <= 0) { $("captchaBanner").style.display = "none"; setStatusBadge("ready"); clearInterval(captchaTimer); return; }
      const min = Math.floor(rem / 60000);
      const sec = Math.floor((rem % 60000) / 1000);
      $("captchaTimer").textContent = `${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}`;
    };
    update();
    captchaTimer = setInterval(update, 1000);
  } else {
    $("captchaBanner").style.display = "none";
  }
}

// ===== Storage listener =====
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.progress) renderProgress(changes.progress.newValue);
  if (changes.snapshots || changes.leads) refreshStats();
  if (changes.captchaDetected) checkCaptchaCooldown();
});

// ===== Init =====
loadSettings();
refreshStats();
renderPreviewTable();
checkCaptchaCooldown();

// Auto-show step 2 if capture is running
(async () => {
  const { progress } = await chrome.storage.local.get(["progress"]);
  if (progress && progress.isRunning) {
    showStep(2);
    renderProgress(progress);
  }
})();
