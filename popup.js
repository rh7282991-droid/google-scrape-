// ============================================
// Maps Lead Scraper Pro v4.0 — 3-Step Flow Controller
// ============================================

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// Fields config
const ALL_FIELDS = ["title", "phone", "email", "website", "address", "category",
  "rating", "reviewCount", "hours", "domain", "latitude", "url"];
const DEFAULT_FIELDS = {
  title: true, phone: true, email: true, website: true,
  address: true, category: true, rating: true, reviewCount: true,
  hours: false, domain: false, latitude: false, url: false
};

// Location DB
const LOCATION_NEIGHBORHOODS = {
  "dhaka": ["Dhanmondi", "Gulshan", "Mirpur", "Uttara", "Banani", "Mohammadpur", "Bashundhara", "Tejgaon", "Motijheel"],
  "chittagong": ["Agrabad", "Nasirabad", "Halishahar", "Patenga", "Kotwali", "GEC Circle"],
  "sylhet": ["Zindabazar", "Amberkhana", "Uposhahar", "Shibganj"],
  "rajshahi": ["Shaheb Bazar", "Sapura", "Kazla", "Uposhahar"],
  "khulna": ["Sonadanga", "Boyra", "Khalishpur", "Daulatpur"],
  "new york": ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Harlem"],
  "london": ["Westminster", "Camden", "Shoreditch", "Soho", "Brixton", "Hackney"],
  "dubai": ["Downtown", "Deira", "Bur Dubai", "Jumeirah", "Marina", "Al Barsha"],
  "mumbai": ["Andheri", "Bandra", "Colaba", "Dadar", "Juhu", "Powai"],
  "delhi": ["Connaught Place", "Karol Bagh", "Lajpat Nagar", "Hauz Khas", "Dwarka"],
  "kolkata": ["Salt Lake", "Park Street", "New Town", "Ballygunge", "Howrah"],
  "karachi": ["Clifton", "DHA", "Gulshan-e-Iqbal", "Saddar", "Korangi"],
  "lahore": ["Gulberg", "DHA", "Model Town", "Johar Town", "Liberty"],
  "singapore": ["Orchard", "Marina Bay", "Bugis", "Chinatown", "Little India"],
  "bangkok": ["Sukhumvit", "Silom", "Chatuchak", "Thonglor", "Pratunam"],
  "toronto": ["Downtown", "Scarborough", "North York", "Etobicoke"],
  "los angeles": ["Hollywood", "Santa Monica", "Beverly Hills", "Downtown LA"],
  "chicago": ["Loop", "Lincoln Park", "Wicker Park", "Hyde Park"],
  "sydney": ["CBD", "Bondi", "Surry Hills", "Parramatta", "Manly"],
  "melbourne": ["CBD", "Fitzroy", "St Kilda", "South Yarra", "Richmond"]
};

// ===== Utilities =====
function setStatus(msg) { statusEl.textContent = msg; }

function setStatusBadge(state) {
  const badge = $("statusBadge");
  badge.className = "status-pill " + state;
  badge.textContent = state === "running" ? "Running" :
                      state === "paused" ? "Paused" :
                      state === "error" ? "Error" : "Ready";
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
  $("stepCollect").style.display = step === 2 ? "block" : "none";
  $("stepExport").style.display = step === 3 ? "block" : "none";

  // Update step indicator
  document.querySelectorAll(".step-indicator .step").forEach(el => {
    const s = parseInt(el.dataset.step);
    el.classList.remove("active", "completed");
    if (s === step) el.classList.add("active");
    else if (s < step) el.classList.add("completed");
  });

  // Update step lines
  const lines = document.querySelectorAll(".step-line");
  lines.forEach((line, i) => {
    line.classList.toggle("active", i < step - 1);
  });

  // Update counts when switching to collect/export
  if (step === 2 || step === 3) refreshCounts();
}

// Step navigation buttons
$("goToCollect").addEventListener("click", () => {
  const keywords = $("searchInput").value.trim();
  if (!keywords) {
    setStatus("Please enter at least one keyword.");
    $("searchInput").focus();
    return;
  }
  showStep(2);
  setStatus("Ready to collect.");
});

$("backToSetup").addEventListener("click", () => showStep(1));
$("goToExport").addEventListener("click", () => showStep(3));
$("backToCollect").addEventListener("click", () => showStep(2));

// ===== Counts & Stats =====
async function refreshCounts() {
  const { leads = [], todayLeadCount = 0 } =
    await chrome.storage.local.get(["leads", "todayLeadCount"]);
  const total = leads.length;
  const target = parseInt($("targetLeads").value) || 100;

  $("totalLeadsHeader").textContent = total;
  $("collectTotal").textContent = total;
  $("collectTarget").textContent = target;
  $("collectToday").textContent = todayLeadCount;
  $("previewCount").textContent = total;
  $("exportTotal").textContent = total;
}

// ===== Settings Load/Save =====
async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "deepEnrich", "autoMaxPages", "fields",
    "profileWait", "targetLeads", "searchScroll",
    "randomDelay", "captchaDetect", "autoResume",
    "savedKeywords", "savedLocations", "webhookUrl", "webhookEnabled"
  ]);

  $("autoScrape").checked = !!s.autoScrape;
  $("deepEnrich").checked = !!s.deepEnrich;
  $("autoMaxPages").value = s.autoMaxPages || 50;
  $("profileWait").value = s.profileWait || 7;
  $("targetLeads").value = s.targetLeads || 100;
  $("searchScroll").value = s.searchScroll || 25;
  $("randomDelay").checked = s.randomDelay !== false;
  $("captchaDetect").checked = s.captchaDetect !== false;
  $("autoResume").checked = s.autoResume !== false;
  $("webhookEnabled").checked = !!s.webhookEnabled;
  if (s.webhookUrl) $("webhookUrl").value = s.webhookUrl;

  if (s.savedKeywords) $("searchInput").value = s.savedKeywords;
  if (s.savedLocations) $("locationInput").value = s.savedLocations;
  updateInputCounts();

  // Webhook body visibility
  $("webhookBody").style.display = s.webhookEnabled ? "block" : "none";

  // Fields
  const fields = s.fields || DEFAULT_FIELDS;
  for (const f of ALL_FIELDS) {
    const el = $(`f_${f}`);
    if (el) el.checked = !!fields[f];
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
  const kw = $("searchInput").value.trim().split("\n").filter(Boolean);
  const lc = $("locationInput").value.trim().split("\n").filter(Boolean);
  $("keywordCount").textContent = `${kw.length} keyword${kw.length !== 1 ? "s" : ""}`;
  $("locationCount").textContent = `${lc.length} location${lc.length !== 1 ? "s" : ""}`;
}

// ===== Input Listeners =====
$("searchInput").addEventListener("input", () => {
  updateInputCounts();
  saveSetting("savedKeywords", $("searchInput").value);
});

$("locationInput").addEventListener("input", () => {
  updateInputCounts();
  saveSetting("savedLocations", $("locationInput").value);
  clearTimeout(locationTimeout);
  locationTimeout = setTimeout(expandLocationFromTextarea, 350);
});

// ===== Fields Toggle =====
$("fieldsToggle").addEventListener("click", () => {
  const body = $("fieldsBody");
  const isOpen = body.style.display !== "none";
  body.style.display = isOpen ? "none" : "block";
  $("fieldsToggle").classList.toggle("open", !isOpen);
});

// ===== Webhook Toggle =====
$("webhookEnabled").addEventListener("change", (e) => {
  const enabled = e.target.checked;
  $("webhookBody").style.display = enabled ? "block" : "none";
  saveSetting("webhookEnabled", enabled);
});

$("webhookUrl").addEventListener("change", (e) => {
  saveSetting("webhookUrl", e.target.value.trim());
});

$("testWebhook").addEventListener("click", async () => {
  const url = $("webhookUrl").value.trim();
  if (!url) { setStatus("Enter a webhook URL first."); return; }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true, source: "Maps Scraper Pro", timestamp: Date.now() })
    });
    setStatus(res.ok ? "Webhook test successful!" : `Webhook failed: ${res.status}`);
  } catch (e) {
    setStatus("Webhook error: " + e.message);
  }
});

// ===== Advanced Toggle =====
$("advancedToggle").addEventListener("click", () => {
  const body = $("advancedBody");
  const isOpen = body.style.display !== "none";
  body.style.display = isOpen ? "none" : "block";
  $("advancedToggle").textContent = isOpen ? "\u2699 Advanced Settings" : "\u2699 Hide Advanced";
});

// ===== Location Auto-Expand =====
let locationTimeout = null;

function expandLocationFromTextarea() {
  const lines = $("locationInput").value.trim().toLowerCase().split("\n").map(l => l.trim()).filter(Boolean);
  const allChips = [];
  for (const line of lines) {
    const neighborhoods = findNeighborhoods(line);
    if (neighborhoods.length) {
      allChips.push(...neighborhoods.map(n => ({ area: n, city: line })));
    }
  }
  if (allChips.length) showLocationChips(allChips);
  else $("locationChips").innerHTML = "";
}

function findNeighborhoods(query) {
  for (const [city, areas] of Object.entries(LOCATION_NEIGHBORHOODS)) {
    if (city.includes(query) || query.includes(city)) return areas;
  }
  return [];
}

function showLocationChips(items) {
  const container = $("locationChips");
  container.innerHTML = items.slice(0, 10).map(item =>
    `<span class="loc-chip" data-area="${item.area}" data-city="${item.city}">${item.area} <span class="remove">\u00d7</span></span>`
  ).join("");
  container.querySelectorAll(".loc-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        chip.remove();
      } else {
        const ta = $("locationInput");
        const newLoc = chip.dataset.area + ", " + chip.dataset.city;
        if (!ta.value.includes(newLoc)) {
          ta.value = ta.value.trim() ? ta.value.trim() + "\n" + newLoc : newLoc;
          updateInputCounts();
          saveSetting("savedLocations", ta.value);
        }
      }
    });
  });
}

// ===== MAIN: Start Button (does everything) =====
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const onMaps = tab && /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(tab.url || "");

  const keywords = $("searchInput").value.trim().split("\n").map(k => k.trim()).filter(Boolean);
  const locations = $("locationInput").value.trim().split("\n").map(l => l.trim()).filter(Boolean);

  if (!keywords.length) {
    setStatus("Add keywords in Setup first.");
    showStep(1);
    $("searchInput").focus();
    return;
  }

  if (!onMaps) {
    // Navigate to Maps with first keyword + location
    const query = keywords[0] + (locations.length ? " " + locations[0] : "");
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

    await chrome.storage.local.set({ autoScrape: true });
    $("autoScrape").checked = true;

    if (tab) chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });

    setStatus(`Opening Maps: "${query}"...`);
    setStatusBadge("running");
    showRunningUI();
    return;
  }

  // Already on Maps — scrape current page
  setStatus("Capturing leads...");
  setStatusBadge("running");
  showRunningUI();

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (res && res.ok) {
      setStatus(`Captured ${res.saved || 0} new leads!`);
      refreshCounts();
      renderPreviewTable();
    } else if (res && res.captcha) {
      setStatus("CAPTCHA detected! Cooldown started.");
      setStatusBadge("paused");
    } else {
      setStatus(res?.error || "Failed. Reload Maps page.");
      setStatusBadge("error");
    }
  } catch (e) {
    setStatus("Cannot reach page. Reload Maps tab.");
    setStatusBadge("error");
  }
  hideRunningUI();
  refreshCounts();
  renderPreviewTable();
});

function showRunningUI() {
  $("scrapeNow").style.display = "none";
  $("stopBtn").style.display = "flex";
  $("progressBox").style.display = "block";
}

function hideRunningUI() {
  $("scrapeNow").style.display = "flex";
  $("stopBtn").style.display = "none";
}

// ===== Stop Button =====
$("stopBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPE" }); } catch (_) {}
  }
  await chrome.storage.local.set({ autoScrape: false, progress: { isRunning: false } });
  $("autoScrape").checked = false;
  $("progressBox").style.display = "none";
  hideRunningUI();
  setStatusBadge("ready");
  setStatus("Stopped.");
});

// ===== Progress Rendering =====
function renderProgress(p) {
  if (!p || !p.isRunning) {
    $("progressBox").style.display = "none";
    hideRunningUI();
    setStatusBadge("ready");
    return;
  }
  $("progressBox").style.display = "block";
  showRunningUI();
  setStatusBadge("running");
  $("progressTitle").textContent = p.title || "Capturing leads...";
  $("progPage").textContent = p.currentPage || 0;
  $("progPageTotal").textContent = p.totalPages || "?";
  $("progFound").textContent = p.totalFound || 0;
  $("progCurrent").textContent = p.currentItem || "";
  const pct = p.totalPages > 0
    ? Math.min(100, Math.round((p.currentPage / p.totalPages) * 100))
    : (p.percent || 0);
  $("progressFill").style.width = pct + "%";
}

// ===== CAPTCHA Timer =====
let captchaTimer = null;

async function checkCaptchaCooldown() {
  const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
  if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
    $("captchaBanner").style.display = "flex";
    setStatusBadge("paused");
    startCaptchaTimer(captchaDetected.cooldownUntil);
  } else {
    $("captchaBanner").style.display = "none";
  }
}

function startCaptchaTimer(until) {
  if (captchaTimer) clearInterval(captchaTimer);
  const update = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      $("captchaBanner").style.display = "none";
      setStatusBadge("ready");
      clearInterval(captchaTimer);
      return;
    }
    const min = Math.floor(remaining / 60000);
    const sec = Math.floor((remaining % 60000) / 1000);
    $("captchaTimer").textContent = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };
  update();
  captchaTimer = setInterval(update, 1000);
}

// ===== Live Preview Table =====
async function renderPreviewTable() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const tbody = $("previewBody");
  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-msg">No leads yet. Click "Start" above.</td></tr>';
    return;
  }
  const last10 = leads.slice(-10).reverse();
  tbody.innerHTML = last10.map((lead, i) => {
    const name = (lead.title || "\u2014").slice(0, 20);
    const phone = (lead.phone || "\u2014").slice(0, 14);
    const addr = (lead.address || "\u2014").slice(0, 18);
    return `<tr><td>${i + 1}</td><td title="${(lead.title || '').replace(/"/g, '')}">${name}</td><td>${phone}</td><td title="${(lead.address || '').replace(/"/g, '')}">${addr}</td></tr>`;
  }).join("");
}

// ===== Export =====
$("exportCsv").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_CSV" });
  setStatus(res && res.ok ? "CSV downloaded!" : "Nothing to export.");
});

$("exportJson").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_JSON" });
  setStatus(res && res.ok ? "JSON downloaded!" : "Nothing to export.");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all leads? This cannot be undone.")) return;
  await chrome.storage.local.set({ leads: [], todayLeadCount: 0 });
  await chrome.storage.local.remove(["campaignState"]);
  setStatus("All leads cleared.");
  refreshCounts();
  renderPreviewTable();
});

// ===== Account Management =====
async function renderAccounts() {
  const { accounts = [], activeAccountIndex = 0, accountRotationThreshold = 50 } =
    await chrome.storage.local.get(["accounts", "activeAccountIndex", "accountRotationThreshold"]);
  $("rotationThreshold").value = accountRotationThreshold;

  const list = $("accountList");
  if (!accounts.length) {
    list.innerHTML = '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:6px;">No accounts added.</div>';
    return;
  }

  list.innerHTML = accounts.map((acc, i) => {
    const isActive = i === activeAccountIndex;
    return `<div class="account-row ${isActive ? 'active' : ''}">
      <span class="ind"></span>
      <span class="label">${acc.label}</span>
      <span class="count">${acc.leadsCollected || 0}</span>
      <button class="btn-mini btn-danger remove-acc-btn" data-id="${acc.id}">\u00d7</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".remove-acc-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ type: "REMOVE_ACCOUNT", id: btn.dataset.id });
      renderAccounts();
    });
  });
}

$("addAccountBtn").addEventListener("click", async () => {
  const label = $("newAccountLabel").value.trim();
  if (!label) return;
  const res = await chrome.runtime.sendMessage({ type: "ADD_ACCOUNT", label });
  if (res && res.ok) {
    $("newAccountLabel").value = "";
    renderAccounts();
    setStatus(`Account "${label}" added.`);
  }
});

$("newAccountLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addAccountBtn").click();
});

$("rotationThreshold").addEventListener("change", async (e) => {
  const val = Math.max(10, Math.min(500, Number(e.target.value) || 50));
  await chrome.storage.local.set({ accountRotationThreshold: val });
});

// ===== Settings Listeners =====
$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("deepEnrich").addEventListener("change", (e) => saveSetting("deepEnrich", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) => saveSetting("autoMaxPages", Number(e.target.value) || 50));
$("profileWait").addEventListener("change", (e) => saveSetting("profileWait", Number(e.target.value)));
$("targetLeads").addEventListener("change", (e) => {
  saveSetting("targetLeads", Number(e.target.value) || 100);
  refreshCounts();
});
$("searchScroll").addEventListener("change", (e) => saveSetting("searchScroll", Number(e.target.value) || 25));
$("randomDelay").addEventListener("change", (e) => saveSetting("randomDelay", e.target.checked));
$("captchaDetect").addEventListener("change", (e) => saveSetting("captchaDetect", e.target.checked));
$("autoResume").addEventListener("change", (e) => saveSetting("autoResume", e.target.checked));

ALL_FIELDS.forEach(f => {
  const el = $(`f_${f}`);
  if (el) el.addEventListener("change", saveFields);
});

// ===== Storage Change Listener =====
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.progress) renderProgress(changes.progress.newValue);
  if (changes.leads) {
    refreshCounts();
    renderPreviewTable();
  }
  if (changes.accounts || changes.activeAccountIndex) renderAccounts();
  if (changes.captchaDetected) checkCaptchaCooldown();
});

// ===== Auto-send to Webhook =====
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.leads) return;
  const { webhookEnabled, webhookUrl } = await chrome.storage.local.get(["webhookEnabled", "webhookUrl"]);
  if (!webhookEnabled || !webhookUrl) return;

  const newLeads = changes.leads.newValue || [];
  const oldLeads = changes.leads.oldValue || [];
  if (newLeads.length <= oldLeads.length) return;

  const fresh = newLeads.slice(oldLeads.length);
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leads: fresh, total: newLeads.length, timestamp: Date.now() })
    });
  } catch (_) {}
});

// ===== Init =====
loadSettings();
refreshCounts();
renderPreviewTable();
renderAccounts();
checkCaptchaCooldown();

// Check if scraping is already running
(async () => {
  const { progress } = await chrome.storage.local.get(["progress"]);
  if (progress && progress.isRunning) {
    showStep(2);
    renderProgress(progress);
  }
})();
