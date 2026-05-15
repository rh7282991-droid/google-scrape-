// popup.js — UI controller (MapLeadly-style)

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

const ALL_FIELDS = ["title", "url", "description", "domain", "emails", "phones", "position", "query"];
const DEFAULT_FIELDS = {
  title: true, url: true, description: true, domain: true,
  emails: true, phones: true, position: false, query: false
};

// ===== Feature 16: Location neighborhoods DB =====
const LOCATION_NEIGHBORHOODS = {
  "dhaka": ["Dhanmondi", "Gulshan", "Mirpur", "Uttara", "Banani", "Mohammadpur", "Bashundhara", "Tejgaon", "Motijheel", "Wari", "Badda", "Rampura", "Khilgaon"],
  "chittagong": ["Agrabad", "Nasirabad", "Halishahar", "Patenga", "Kotwali", "Double Mooring", "GEC Circle", "Oxygen", "Khulshi"],
  "sylhet": ["Zindabazar", "Amberkhana", "Uposhahar", "Shibganj", "Tilagarh", "Shahjalal Uposhahar"],
  "rajshahi": ["Shaheb Bazar", "Sapura", "Kazla", "Uposhahar", "Talaimari", "Binodpur"],
  "khulna": ["Sonadanga", "Boyra", "Khalishpur", "Daulatpur", "Gollamari"],
  "new york": ["Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island", "Harlem", "Williamsburg", "SoHo"],
  "london": ["Westminster", "Camden", "Shoreditch", "Soho", "Brixton", "Hackney", "Kensington", "Notting Hill"],
  "dubai": ["Downtown", "Deira", "Bur Dubai", "Jumeirah", "Marina", "Al Barsha", "Business Bay"],
  "mumbai": ["Andheri", "Bandra", "Colaba", "Dadar", "Juhu", "Powai", "Worli", "Malad"],
  "delhi": ["Connaught Place", "Karol Bagh", "Lajpat Nagar", "Hauz Khas", "Dwarka", "Rohini", "Saket"],
  "kolkata": ["Salt Lake", "Park Street", "New Town", "Ballygunge", "Howrah", "Jadavpur"],
  "karachi": ["Clifton", "DHA", "Gulshan-e-Iqbal", "Saddar", "Korangi", "North Nazimabad"],
  "lahore": ["Gulberg", "DHA", "Model Town", "Johar Town", "Liberty", "Anarkali"],
  "singapore": ["Orchard", "Marina Bay", "Bugis", "Chinatown", "Little India", "Sentosa", "Jurong"],
  "bangkok": ["Sukhumvit", "Silom", "Chatuchak", "Thonglor", "Pratunam", "Siam"],
  "toronto": ["Downtown", "Scarborough", "North York", "Etobicoke", "Mississauga", "Brampton"],
  "los angeles": ["Hollywood", "Santa Monica", "Beverly Hills", "Downtown LA", "Venice", "Pasadena"],
  "chicago": ["Loop", "Lincoln Park", "Wicker Park", "Hyde Park", "River North"],
  "sydney": ["CBD", "Bondi", "Surry Hills", "Parramatta", "Manly", "Newtown"],
  "melbourne": ["CBD", "Fitzroy", "St Kilda", "South Yarra", "Richmond", "Carlton"]
};

// ===== Helpers =====
function setStatus(msg) {
  statusEl.textContent = msg;
}

function setStatusBadge(state) {
  const badge = $("statusBadge");
  badge.className = "status-badge " + state;
  if (state === "running") badge.textContent = "Running";
  else if (state === "paused") badge.textContent = "Paused";
  else badge.textContent = "Ready";
}

async function refreshCount() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  $("count").textContent = leads.length;
}

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "autoNext", "autoMaxPages", "fields", "profileWait", "targetLeads", "searchScroll"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("autoNext").checked = !!s.autoNext;
  $("autoMaxPages").value = s.autoMaxPages || 50;
  $("profileWait").value = s.profileWait || 7;
  $("targetLeads").value = s.targetLeads || 100;
  $("searchScroll").value = s.searchScroll || 25;

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
  for (const f of ALL_FIELDS) {
    fields[f] = !!$(`f_${f}`).checked;
  }
  await chrome.storage.local.set({ fields });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== Paste Buttons =====
$("pasteKeywords").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $("searchInput").value = text;
  } catch (e) {
    setStatus("Clipboard access denied.");
  }
});

$("pasteLocations").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      $("locationInput").value = text;
      expandLocationFromTextarea();
    }
  } catch (e) {
    setStatus("Clipboard access denied.");
  }
});

// ===== Feature 14: Live Preview Panel =====
async function renderPreviewTable() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const tbody = $("previewBody");

  if (!leads.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-msg">No leads yet</td></tr>';
    return;
  }

  const last10 = leads.slice(-10).reverse();
  tbody.innerHTML = last10.map((lead, i) => {
    const name = (lead.title || "\u2014").slice(0, 30);
    const phone = (lead.phones && lead.phones.length) ? lead.phones[0] : "\u2014";
    return `<tr><td>${i + 1}</td><td title="${lead.title || ''}">${name}</td><td>${phone}</td></tr>`;
  }).join("");
}

$("togglePreview").addEventListener("click", () => {
  const wrap = $("previewTableWrap");
  const btn = $("togglePreview");
  if (wrap.style.display === "none") {
    wrap.style.display = "block";
    btn.textContent = "Hide";
  } else {
    wrap.style.display = "none";
    btn.textContent = "Show";
  }
});

// ===== Feature 15: Smart Search Suggestions =====
let suggestTimeout = null;

$("searchInput").addEventListener("input", (e) => {
  clearTimeout(suggestTimeout);
  const lines = e.target.value.trim().split("\n");
  const lastLine = lines[lines.length - 1].trim();
  if (lastLine.length < 2) {
    hideSuggest("suggestList");
    return;
  }
  suggestTimeout = setTimeout(() => fetchSuggestions(lastLine), 300);
});

async function fetchSuggestions(query) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "FETCH_SUGGESTIONS", query });
    if (res && res.suggestions && res.suggestions.length) {
      showSuggest("suggestList", "suggestWrap", res.suggestions, (val) => {
        const textarea = $("searchInput");
        const lines = textarea.value.split("\n");
        lines[lines.length - 1] = val;
        textarea.value = lines.join("\n");
        hideSuggest("suggestList");
      });
    } else {
      hideSuggest("suggestList");
    }
  } catch (e) {
    hideSuggest("suggestList");
  }
}

function showSuggest(listId, wrapId, items, onClick) {
  const wrap = $(wrapId);
  const list = $(listId);
  wrap.style.display = "block";
  list.innerHTML = items.map(item => `<li>${item}</li>`).join("");
  list.classList.add("active");
  list.querySelectorAll("li").forEach((li, i) => {
    li.addEventListener("click", () => onClick(items[i]));
  });
}

function hideSuggest(listId) {
  const list = $(listId);
  if (list) {
    list.innerHTML = "";
    list.classList.remove("active");
  }
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".suggest-wrap") && !e.target.closest("textarea")) {
    hideSuggest("suggestList");
    hideSuggest("locationSuggestList");
  }
});

// ===== Feature 16: Location Auto-Expand =====
let locationTimeout = null;

$("locationInput").addEventListener("input", (e) => {
  clearTimeout(locationTimeout);
  locationTimeout = setTimeout(() => expandLocationFromTextarea(), 300);
});

function expandLocationFromTextarea() {
  const text = $("locationInput").value.trim().toLowerCase();
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const allNeighborhoods = [];

  for (const line of lines) {
    const neighborhoods = findNeighborhoods(line);
    if (neighborhoods.length) {
      allNeighborhoods.push(...neighborhoods.map(n => ({ area: n, city: line })));
    }
  }

  if (allNeighborhoods.length) {
    showLocationChips(allNeighborhoods);
  } else {
    $("locationChips").innerHTML = "";
  }
}

function findNeighborhoods(query) {
  for (const [city, areas] of Object.entries(LOCATION_NEIGHBORHOODS)) {
    if (city.includes(query) || query.includes(city)) {
      return areas;
    }
  }
  return [];
}

function showLocationChips(items) {
  const container = $("locationChips");
  container.innerHTML = items.map(item =>
    `<span class="loc-chip" data-area="${item.area}" data-city="${item.city}">${item.area} <span class="remove">\u00d7</span></span>`
  ).join("");

  container.querySelectorAll(".loc-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        chip.remove();
      } else {
        const textarea = $("locationInput");
        const current = textarea.value.trim();
        const newLoc = chip.dataset.area + ", " + chip.dataset.city;
        if (!current.includes(newLoc)) {
          textarea.value = current ? current + "\n" + newLoc : newLoc;
        }
      }
    });
  });
}

// ===== Feature 17: Resume from Failure =====
async function checkResumeCampaign() {
  const { campaignState } = await chrome.storage.local.get(["campaignState"]);
  if (campaignState && campaignState.isActive && !campaignState.completed) {
    $("resumeBanner").style.display = "block";
    $("resumeInfo").textContent = `${campaignState.leadsCollected || 0} leads collected, page ${campaignState.currentPage || 0}/${campaignState.totalPages || 0}`;
  }
}

$("resumeYes").addEventListener("click", async () => {
  const { campaignState } = await chrome.storage.local.get(["campaignState"]);
  if (campaignState) {
    await chrome.storage.local.set({
      autoScrape: true,
      autoNext: true,
      autoMaxPages: campaignState.totalPages || 5
    });
    const tab = await getActiveTab();
    const url = campaignState.lastUrl || `https://www.google.com/search?q=${encodeURIComponent(campaignState.query || "")}&start=${((campaignState.currentPage || 1) - 1) * 10}`;
    if (tab) chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });
    setStatus("Resuming campaign...");
    setStatusBadge("running");
    $("resumeBanner").style.display = "none";
    loadSettings();
  }
});

$("resumeNo").addEventListener("click", async () => {
  $("resumeBanner").style.display = "none";
  await chrome.storage.local.remove(["campaignState"]);
  setStatus("Campaign dismissed.");
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
  refreshCount();
}

// React to live updates
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.progress) renderProgress(changes.progress.newValue);
  if (changes.leads) {
    refreshCount();
    renderPreviewTable();
  }
  if (changes.accounts || changes.activeAccountIndex) renderAccounts();
  if (changes.captchaDetected) {
    const cd = changes.captchaDetected.newValue;
    if (cd && cd.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((cd.cooldownUntil - Date.now()) / 60000);
      setStatus(`CAPTCHA cooldown: ${minsLeft} min remaining`);
      setStatusBadge("paused");
    } else {
      setStatus("Ready.");
      setStatusBadge("ready");
    }
  }
});

// ===== Main Buttons =====
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !/^https?:\/\/(www\.)?google\.com\/search/.test(tab.url || "")) {
    // Build search URL from keywords + location
    const keywords = $("searchInput").value.trim().split("\n").filter(Boolean);
    const locations = $("locationInput").value.trim().split("\n").filter(Boolean);

    if (!keywords.length) {
      setStatus("Please enter at least one keyword.");
      return;
    }

    const query = keywords[0] + (locations.length ? " " + locations[0] : "");
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

    if (tab) chrome.tabs.update(tab.id, { url });
    else chrome.tabs.create({ url });

    setStatus(`Navigating to Google: "${query}"...`);
    setStatusBadge("running");
    return;
  }

  setStatus("Scraping current page...");
  setStatusBadge("running");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (res) {
      setStatus(`Found ${res.found} result(s), ${res.added} new saved.`);
    } else {
      setStatus("No response. Try reloading the search page.");
    }
  } catch (e) {
    setStatus("Could not reach page. Reload the Google tab.");
  }
  setStatusBadge("ready");
  refreshCount();
  renderPreviewTable();
});

// Settings listeners
$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("autoNext").addEventListener("change", (e) => saveSetting("autoNext", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) => saveSetting("autoMaxPages", Number(e.target.value) || 50));
$("profileWait").addEventListener("change", (e) => saveSetting("profileWait", Number(e.target.value)));
$("targetLeads").addEventListener("change", (e) => saveSetting("targetLeads", Number(e.target.value) || 100));
$("searchScroll").addEventListener("change", (e) => saveSetting("searchScroll", Number(e.target.value) || 25));

ALL_FIELDS.forEach(f => {
  const el = $(`f_${f}`);
  if (el) el.addEventListener("change", saveFields);
});

$("runDeep").addEventListener("click", async () => {
  setStatus("Starting deep-scrape...");
  setStatusBadge("running");
  const res = await chrome.runtime.sendMessage({ type: "DEEP_SCRAPE_ALL" });
  if (res && res.ok) {
    setStatus(`Deep-scrape done. Updated ${res.updated} leads.`);
  } else {
    setStatus(`Deep-scrape failed: ${res ? res.error : "unknown error"}`);
  }
  setStatusBadge("ready");
  refreshCount();
  renderPreviewTable();
});

$("exportCsv").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_CSV" });
  setStatus(res && res.ok ? "CSV exported to Downloads." : "Nothing to export.");
});

$("exportJson").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_JSON" });
  setStatus(res && res.ok ? "JSON exported to Downloads." : "Nothing to export.");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved leads?")) return;
  await chrome.storage.local.set({ leads: [] });
  await chrome.storage.local.remove(["campaignState"]);
  setStatus("All leads cleared.");
  refreshCount();
  renderPreviewTable();
});

// ===== Feature 5: Account Management =====
async function renderAccounts() {
  const { accounts = [], activeAccountIndex = 0, accountRotationThreshold = 50 } =
    await chrome.storage.local.get(["accounts", "activeAccountIndex", "accountRotationThreshold"]);

  const list = $("accountList");
  const thresholdInput = $("rotationThreshold");
  thresholdInput.value = accountRotationThreshold;

  if (!accounts.length) {
    list.innerHTML = '<div style="font-size:11px;color:#9ca3af;margin:4px 0;">No accounts added yet.</div>';
    $("accountInfo").innerHTML = '<small>Add Google accounts to rotate every ' + accountRotationThreshold + ' leads.</small>';
    return;
  }

  $("accountInfo").innerHTML = `<small>Active: <b>${accounts[activeAccountIndex]?.label || "\u2014"}</b> (${accounts[activeAccountIndex]?.leadsCollected || 0}/${accountRotationThreshold} leads)</small>`;

  list.innerHTML = accounts.map((acc, i) => {
    const isActive = i === activeAccountIndex;
    return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${isActive ? '#22c55e' : '#d1d5db'};flex-shrink:0;"></span>
      <span style="flex:1;${isActive ? 'font-weight:600;' : ''}">${acc.label}</span>
      <span style="color:#6b7280;">${acc.leadsCollected || 0}</span>
      <button class="btn-sm btn-danger remove-acc-btn" data-id="${acc.id}">\u00d7</button>
    </div>`;
  }).join("");

  list.querySelectorAll(".remove-acc-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
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

$("rotationThreshold").addEventListener("change", async (e) => {
  const val = Math.max(10, Math.min(200, Number(e.target.value) || 50));
  await chrome.storage.local.set({ accountRotationThreshold: val });
  renderAccounts();
});

// ===== Feature 4: CAPTCHA check on popup open =====
async function checkCaptchaCooldown() {
  const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
  if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
    const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
    setStatus(`CAPTCHA cooldown active: ${minsLeft} min remaining`);
    setStatusBadge("paused");
  }
}

// ===== Init =====
loadSettings();
refreshCount();
pollProgress();
renderPreviewTable();
checkResumeCampaign();
renderAccounts();
checkCaptchaCooldown();
