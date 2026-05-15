// ============================================
// Maps Lead Scraper Pro — popup controller
// ============================================

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

// Maps-specific fields
const ALL_FIELDS = ["title", "phone", "email", "website", "address", "category",
  "rating", "reviewCount", "facebook", "instagram", "twitter", "youtube", "linkedin",
  "hours", "domain", "latitude", "url"];
const DEFAULT_FIELDS = {
  title: true, phone: true, email: true, website: true,
  address: true, category: true, rating: true, reviewCount: true,
  facebook: true, instagram: true, twitter: true, youtube: true, linkedin: false,
  hours: false, domain: false, latitude: false, url: false
};

// ===== Location DB =====
const LOCATION_NEIGHBORHOODS = {
  "dhaka": ["Dhanmondi", "Gulshan", "Mirpur", "Uttara", "Banani", "Mohammadpur", "Bashundhara", "Tejgaon", "Motijheel", "Wari", "Badda", "Rampura", "Khilgaon"],
  "chittagong": ["Agrabad", "Nasirabad", "Halishahar", "Patenga", "Kotwali", "GEC Circle", "Oxygen", "Khulshi"],
  "sylhet": ["Zindabazar", "Amberkhana", "Uposhahar", "Shibganj", "Tilagarh"],
  "rajshahi": ["Shaheb Bazar", "Sapura", "Kazla", "Uposhahar", "Talaimari"],
  "khulna": ["Sonadanga", "Boyra", "Khalishpur", "Daulatpur", "Gollamari"],
  "new york": ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Harlem", "Williamsburg", "SoHo"],
  "london": ["Westminster", "Camden", "Shoreditch", "Soho", "Brixton", "Hackney", "Kensington"],
  "dubai": ["Downtown", "Deira", "Bur Dubai", "Jumeirah", "Marina", "Al Barsha", "Business Bay"],
  "mumbai": ["Andheri", "Bandra", "Colaba", "Dadar", "Juhu", "Powai", "Worli", "Malad"],
  "delhi": ["Connaught Place", "Karol Bagh", "Lajpat Nagar", "Hauz Khas", "Dwarka", "Rohini", "Saket"],
  "kolkata": ["Salt Lake", "Park Street", "New Town", "Ballygunge", "Howrah", "Jadavpur"],
  "karachi": ["Clifton", "DHA", "Gulshan-e-Iqbal", "Saddar", "Korangi"],
  "lahore": ["Gulberg", "DHA", "Model Town", "Johar Town", "Liberty"],
  "singapore": ["Orchard", "Marina Bay", "Bugis", "Chinatown", "Little India", "Sentosa"],
  "bangkok": ["Sukhumvit", "Silom", "Chatuchak", "Thonglor", "Pratunam", "Siam"],
  "toronto": ["Downtown", "Scarborough", "North York", "Etobicoke", "Mississauga"],
  "los angeles": ["Hollywood", "Santa Monica", "Beverly Hills", "Downtown LA", "Venice"],
  "chicago": ["Loop", "Lincoln Park", "Wicker Park", "Hyde Park", "River North"],
  "sydney": ["CBD", "Bondi", "Surry Hills", "Parramatta", "Manly"],
  "melbourne": ["CBD", "Fitzroy", "St Kilda", "South Yarra", "Richmond"]
};

// ===== Utilities =====
function setStatus(msg) { statusEl.textContent = msg; }

function setStatusBadge(state) {
  const badge = $("statusBadge");
  badge.className = "status-pill " + state;
  if (state === "running") badge.textContent = "Running";
  else if (state === "paused") badge.textContent = "Paused";
  else if (state === "error") badge.textContent = "Error";
  else badge.textContent = "Ready";
}

async function refreshCounts() {
  const { leads = [], todayLeadCount = 0, lifetimeQuota = 300 } =
    await chrome.storage.local.get(["leads", "todayLeadCount", "lifetimeQuota"]);
  $("totalCount").textContent = leads.length;
  $("totalLeadsHeader").textContent = leads.length;
  $("previewCount").textContent = leads.length;
  $("todayCount").textContent = todayLeadCount;
  $("quotaLeft").textContent = Math.max(0, lifetimeQuota - leads.length);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== Settings =====
async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "deepEnrich", "autoMaxPages", "fields",
    "profileWait", "targetLeads", "searchScroll",
    "randomDelay", "captchaDetect", "autoResume",
    "savedKeywords", "savedLocations"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("deepEnrich").checked = s.deepEnrich !== false;
  $("autoMaxPages").value = s.autoMaxPages || 50;
  $("profileWait").value = s.profileWait || 7;
  $("targetLeads").value = s.targetLeads || 100;
  $("searchScroll").value = s.searchScroll || 25;
  $("randomDelay").checked = s.randomDelay !== false;
  $("captchaDetect").checked = s.captchaDetect !== false;
  $("autoResume").checked = s.autoResume !== false;

  if (s.savedKeywords) $("searchInput").value = s.savedKeywords;
  if (s.savedLocations) $("locationInput").value = s.savedLocations;
  updateInputCounts();

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

// ===== Paste Buttons =====
$("pasteKeywords").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("searchInput").value = text;
      updateInputCounts();
      saveSetting("savedKeywords", text);
      setStatus("Keywords pasted from clipboard.");
    }
  } catch (e) { setStatus("Clipboard access denied."); }
});

$("pasteLocations").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("locationInput").value = text;
      updateInputCounts();
      saveSetting("savedLocations", text);
      expandLocationFromTextarea();
      setStatus("Locations pasted from clipboard.");
    }
  } catch (e) { setStatus("Clipboard access denied."); }
});

$("searchInput").addEventListener("input", () => {
  updateInputCounts();
  saveSetting("savedKeywords", $("searchInput").value);
});
$("locationInput").addEventListener("input", () => {
  updateInputCounts();
  saveSetting("savedLocations", $("locationInput").value);
});

$("clearCampaign").addEventListener("click", async () => {
  if (!confirm("Clear keywords and locations?")) return;
  $("searchInput").value = "";
  $("locationInput").value = "";
  $("locationChips").innerHTML = "";
  updateInputCounts();
  await chrome.storage.local.remove(["savedKeywords", "savedLocations"]);
  setStatus("Campaign inputs cleared.");
});

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
    const name = (lead.title || "\u2014").slice(0, 22);
    const phone = (lead.phone || "\u2014").slice(0, 14);
    const addr = (lead.address || "\u2014").slice(0, 20);
    return `<tr><td>${i + 1}</td><td title="${(lead.title || '').replace(/"/g, '')}">${name}</td><td>${phone}</td><td title="${(lead.address || '').replace(/"/g, '')}">${addr}</td></tr>`;
  }).join("");
}

// ===== Collapsible Cards =====
function setupCollapsibles() {
  document.querySelectorAll(".card.collapsible .card-header").forEach(header => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("collapsed");
    });
  });
}

// ===== Search Suggestions =====
let suggestTimeout = null;
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(suggestTimeout);
  const lines = e.target.value.split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine.length < 2) { hideSuggest(); return; }
  suggestTimeout = setTimeout(() => fetchSuggestions(lastLine), 350);
});

async function fetchSuggestions(query) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "FETCH_SUGGESTIONS", query });
    if (res && res.suggestions && res.suggestions.length) {
      showSuggest(res.suggestions, (val) => {
        const ta = $("searchInput");
        const lines = ta.value.split("\n");
        lines[lines.length - 1] = val;
        ta.value = lines.join("\n");
        updateInputCounts();
        saveSetting("savedKeywords", ta.value);
        hideSuggest();
      });
    } else hideSuggest();
  } catch (e) { hideSuggest(); }
}

function showSuggest(items, onClick) {
  const wrap = $("suggestWrap");
  const list = $("suggestList");
  wrap.style.display = "block";
  list.innerHTML = items.map(item => `<li>${item}</li>`).join("");
  list.querySelectorAll("li").forEach((li, i) => {
    li.addEventListener("click", () => onClick(items[i]));
  });
}
function hideSuggest() {
  $("suggestWrap").style.display = "none";
  $("suggestList").innerHTML = "";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".suggest-overlay") && !e.target.matches("textarea")) hideSuggest();
});

// ===== Location Auto-Expand =====
let locationTimeout = null;
$("locationInput").addEventListener("input", () => {
  clearTimeout(locationTimeout);
  locationTimeout = setTimeout(expandLocationFromTextarea, 350);
});

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
  container.innerHTML = items.slice(0, 12).map(item =>
    `<span class="loc-chip" data-area="${item.area}" data-city="${item.city}">${item.area} <span class="remove">\u00d7</span></span>`
  ).join("");
  container.querySelectorAll(".loc-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        chip.remove();
      } else {
        const ta = $("locationInput");
        const newLoc = chip.dataset.area + ", " + chip.dataset.city;
        const current = ta.value.trim();
        if (!current.includes(newLoc)) {
          ta.value = current ? current + "\n" + newLoc : newLoc;
          updateInputCounts();
          saveSetting("savedLocations", ta.value);
        }
      }
    });
  });
}

// ===== Resume Banner =====
async function checkResumeCampaign() {
  const { campaignState, autoResume } = await chrome.storage.local.get(["campaignState", "autoResume"]);
  if (autoResume === false) return;
  if (campaignState && campaignState.isActive && !campaignState.completed) {
    $("resumeBanner").style.display = "flex";
    $("resumeInfo").textContent = `${campaignState.leadsCollected || 0} leads, query: "${(campaignState.query || '').slice(0, 30)}"`;
  }
}

$("resumeYes").addEventListener("click", async () => {
  const { campaignState } = await chrome.storage.local.get(["campaignState"]);
  if (!campaignState) return;
  await chrome.storage.local.set({ autoScrape: true });
  const tab = await getActiveTab();
  const url = campaignState.lastUrl || `https://www.google.com/maps/search/${encodeURIComponent(campaignState.query || "")}`;
  if (tab) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
  setStatus("Resuming campaign...");
  setStatusBadge("running");
  $("resumeBanner").style.display = "none";
  loadSettings();
});

$("resumeNo").addEventListener("click", async () => {
  $("resumeBanner").style.display = "none";
  await chrome.storage.local.remove(["campaignState"]);
  setStatus("Campaign dismissed.");
});

// ===== CAPTCHA Banner =====
let captchaTimer = null;
async function checkCaptchaCooldown() {
  const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
  if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
    $("captchaBanner").style.display = "flex";
    setStatusBadge("paused");
    startCaptchaTimer(captchaDetected.cooldownUntil);
  } else {
    $("captchaBanner").style.display = "none";
    if (captchaTimer) clearInterval(captchaTimer);
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

$("dismissCaptcha").addEventListener("click", async () => {
  await chrome.storage.local.remove(["captchaDetected"]);
  $("captchaBanner").style.display = "none";
  setStatusBadge("ready");
  if (captchaTimer) clearInterval(captchaTimer);
});

// ===== Progress UI =====
function renderProgress(p) {
  const box = $("progressBox");
  if (!p || !p.isRunning) {
    box.style.display = "none";
    setStatusBadge("ready");
    return;
  }
  box.style.display = "block";
  setStatusBadge("running");
  $("progressTitle").textContent = p.title || "Working...";
  $("progPage").textContent = p.currentPage || 0;
  $("progPageTotal").textContent = p.totalPages || "?";
  $("progFound").textContent = p.totalFound || 0;
  $("progCurrent").textContent = p.currentItem || "";
  const pct = p.totalPages > 0
    ? Math.min(100, Math.round((p.currentPage / p.totalPages) * 100))
    : (p.percent || 0);
  $("progressFill").style.width = pct + "%";
}

async function pollProgress() {
  const { progress } = await chrome.storage.local.get(["progress"]);
  renderProgress(progress);
  refreshCounts();
}

$("stopBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) {
    try { await chrome.tabs.sendMessage(tab.id, { type: "STOP_SCRAPE" }); } catch (_) {}
  }
  await chrome.storage.local.set({ autoScrape: false, progress: { isRunning: false } });
  $("autoScrape").checked = false;
  $("progressBox").style.display = "none";
  setStatusBadge("ready");
  setStatus("Stopped by user.");
});

// ===== Storage change listener =====
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

// ===== MAIN: Start Profile Collection =====
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  const onMaps = tab && /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(tab.url || "");

  const keywords = $("searchInput").value.trim().split("\n").map(k => k.trim()).filter(Boolean);
  const locations = $("locationInput").value.trim().split("\n").map(l => l.trim()).filter(Boolean);

  if (!onMaps) {
    // Build Maps search URL and navigate
    if (!keywords.length) {
      setStatus("Please enter at least one keyword.");
      $("searchInput").focus();
      return;
    }
    const query = keywords[0] + (locations.length ? " " + locations[0] : "");
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

    // Auto-enable auto-scrape so it kicks in after Maps loads
    await chrome.storage.local.set({ autoScrape: true });
    $("autoScrape").checked = true;

    if (tab) chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });

    setStatus(`Opening Google Maps: "${query}"...`);
    setStatusBadge("running");
    return;
  }

  // Already on Maps — start scraping the visible results
  setStatus("Starting Maps scrape on current page...");
  setStatusBadge("running");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (res && res.ok) {
      setStatus(`Saved ${res.saved || 0} new leads.`);
    } else if (res && res.captcha) {
      setStatus("CAPTCHA detected! Cooldown started.");
      setStatusBadge("paused");
    } else {
      setStatus(res?.error || "Failed to scrape. Reload Maps.");
      setStatusBadge("error");
    }
  } catch (e) {
    setStatus("Could not reach page. Reload the Maps tab.");
    setStatusBadge("error");
  }
  refreshCounts();
  renderPreviewTable();
});

// ===== Settings listeners =====
$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("deepEnrich").addEventListener("change", (e) => saveSetting("deepEnrich", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) => saveSetting("autoMaxPages", Number(e.target.value) || 50));
$("profileWait").addEventListener("change", (e) => saveSetting("profileWait", Number(e.target.value)));
$("targetLeads").addEventListener("change", (e) => saveSetting("targetLeads", Number(e.target.value) || 100));
$("searchScroll").addEventListener("change", (e) => saveSetting("searchScroll", Number(e.target.value) || 25));
$("randomDelay").addEventListener("change", (e) => saveSetting("randomDelay", e.target.checked));
$("captchaDetect").addEventListener("change", (e) => saveSetting("captchaDetect", e.target.checked));
$("autoResume").addEventListener("change", (e) => saveSetting("autoResume", e.target.checked));

ALL_FIELDS.forEach(f => {
  const el = $(`f_${f}`);
  if (el) el.addEventListener("change", saveFields);
});

// ===== Deep Enrich =====
$("runDeep").addEventListener("click", async () => {
  setStatus("Starting deep enrichment...");
  setStatusBadge("running");
  const res = await chrome.runtime.sendMessage({ type: "DEEP_SCRAPE_ALL" });
  if (res && res.ok) {
    setStatus(`Done. Updated ${res.updated} leads.`);
  } else {
    setStatus(`Failed: ${res?.error || "unknown"}`);
  }
  setStatusBadge("ready");
  refreshCounts();
  renderPreviewTable();
});

// ===== Export =====
$("exportCsv").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_CSV" });
  setStatus(res && res.ok ? "CSV exported to Downloads." : "Nothing to export.");
});

$("exportJson").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_JSON" });
  setStatus(res && res.ok ? "JSON exported to Downloads." : "Nothing to export.");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved leads? This cannot be undone.")) return;
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
  const badge = $("activeAccountBadge");

  if (!accounts.length) {
    list.innerHTML = '<div style="font-size:11px;color:#94a3b8;text-align:center;padding:8px;">No accounts added.</div>';
    $("accountInfo").innerHTML = `<small>Add Google accounts to auto-rotate every ${accountRotationThreshold} leads.</small>`;
    badge.textContent = "None";
    return;
  }

  const active = accounts[activeAccountIndex];
  badge.textContent = active ? active.label.split("@")[0].slice(0, 12) : "None";
  $("accountInfo").innerHTML = `<small>Active: <b>${active?.label || "\u2014"}</b> &middot; ${active?.leadsCollected || 0}/${accountRotationThreshold} leads</small>`;

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
  } else {
    setStatus(`Failed: ${res?.error || "unknown"}`);
  }
});

$("newAccountLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("addAccountBtn").click();
});

$("rotationThreshold").addEventListener("change", async (e) => {
  const val = Math.max(10, Math.min(500, Number(e.target.value) || 50));
  await chrome.storage.local.set({ accountRotationThreshold: val });
  renderAccounts();
});

// ===== Init =====
loadSettings();
refreshCounts();
pollProgress();
renderPreviewTable();
checkResumeCampaign();
renderAccounts();
checkCaptchaCooldown();
setupCollapsibles();
