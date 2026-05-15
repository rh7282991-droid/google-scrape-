// popup.js — UI controller

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

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function refreshCount() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  $("count").textContent = `${leads.length} leads`;
}

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "autoNext", "autoMaxPages", "fields"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("autoNext").checked = !!s.autoNext;
  $("autoMaxPages").value = s.autoMaxPages || 5;

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
    const name = (lead.title || "—").slice(0, 30);
    const phone = (lead.phones && lead.phones.length) ? lead.phones[0] : "—";
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
  const query = e.target.value.trim();
  if (query.length < 2) {
    hideSuggest("suggestList");
    return;
  }
  suggestTimeout = setTimeout(() => fetchSuggestions(query), 300);
});

$("searchInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    hideSuggest("suggestList");
    applySearchToGoogle();
  }
});

async function fetchSuggestions(query) {
  try {
    // Use Google's autocomplete suggestion API (JSONP-style, we'll use background fetch)
    const res = await chrome.runtime.sendMessage({ type: "FETCH_SUGGESTIONS", query });
    if (res && res.suggestions && res.suggestions.length) {
      showSuggest("suggestList", res.suggestions, (val) => {
        $("searchInput").value = val;
        hideSuggest("suggestList");
      });
    } else {
      hideSuggest("suggestList");
    }
  } catch (e) {
    hideSuggest("suggestList");
  }
}

function showSuggest(listId, items, onClick) {
  const list = $(listId);
  list.innerHTML = items.map(item => `<li>${item}</li>`).join("");
  list.classList.add("active");
  list.querySelectorAll("li").forEach((li, i) => {
    li.addEventListener("click", () => onClick(items[i]));
  });
}

function hideSuggest(listId) {
  const list = $(listId);
  list.innerHTML = "";
  list.classList.remove("active");
}

// Close suggestions when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".suggest-wrap")) {
    hideSuggest("suggestList");
    hideSuggest("locationSuggestList");
  }
});

async function applySearchToGoogle() {
  const query = $("searchInput").value.trim();
  const location = $("locationInput").value.trim();
  if (!query) return;

  const fullQuery = location ? `${query} ${location}` : query;
  const tab = await getActiveTab();
  const url = `https://www.google.com/search?q=${encodeURIComponent(fullQuery)}`;

  if (tab && /^https?:\/\/(www\.)?google\.com/.test(tab.url || "")) {
    chrome.tabs.update(tab.id, { url });
  } else {
    chrome.tabs.create({ url });
  }
  setStatus(`Searching: "${fullQuery}"`);
}

// ===== Feature 16: Location Auto-Expand =====
let locationTimeout = null;

$("locationInput").addEventListener("input", (e) => {
  clearTimeout(locationTimeout);
  const query = e.target.value.trim().toLowerCase();
  if (query.length < 2) {
    hideSuggest("locationSuggestList");
    $("locationChips").innerHTML = "";
    return;
  }
  locationTimeout = setTimeout(() => expandLocation(query), 200);
});

function expandLocation(query) {
  // Check local DB first
  const neighborhoods = findNeighborhoods(query);
  if (neighborhoods.length) {
    showLocationChips(neighborhoods, query);
    // Also show as dropdown
    const cityMatches = Object.keys(LOCATION_NEIGHBORHOODS).filter(k => k.includes(query));
    if (cityMatches.length > 1) {
      showSuggest("locationSuggestList", cityMatches.map(c => c.charAt(0).toUpperCase() + c.slice(1)), (val) => {
        $("locationInput").value = val;
        hideSuggest("locationSuggestList");
        expandLocation(val.toLowerCase());
      });
    } else {
      hideSuggest("locationSuggestList");
    }
  } else {
    $("locationChips").innerHTML = "";
    // Try Google suggestions for location
    chrome.runtime.sendMessage({ type: "FETCH_SUGGESTIONS", query: query + " area" }).then(res => {
      if (res && res.suggestions && res.suggestions.length) {
        showSuggest("locationSuggestList", res.suggestions, (val) => {
          $("locationInput").value = val;
          hideSuggest("locationSuggestList");
        });
      }
    }).catch(() => {});
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

function showLocationChips(neighborhoods, city) {
  const container = $("locationChips");
  container.innerHTML = neighborhoods.map(n =>
    `<span class="loc-chip" data-area="${n}" data-city="${city}">${n} <span class="remove">×</span></span>`
  ).join("");

  container.querySelectorAll(".loc-chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove")) {
        chip.remove();
      } else {
        $("locationInput").value = chip.dataset.area + ", " + chip.dataset.city;
      }
    });
  });
}

// ===== Feature 17: Resume from Failure =====
async function checkResumeCampaign() {
  const { campaignState } = await chrome.storage.local.get(["campaignState"]);
  if (campaignState && campaignState.isActive && !campaignState.completed) {
    // Show resume banner
    const banner = $("resumeBanner");
    banner.style.display = "block";
    $("resumeInfo").textContent = `${campaignState.leadsCollected || 0} leads collected, page ${campaignState.currentPage || 0}/${campaignState.totalPages || 0}`;
  }
}

$("resumeYes").addEventListener("click", async () => {
  const { campaignState } = await chrome.storage.local.get(["campaignState"]);
  if (campaignState) {
    // Restore settings
    await chrome.storage.local.set({
      autoScrape: true,
      autoNext: true,
      autoMaxPages: campaignState.totalPages || 5
    });

    // Navigate to last known page
    const tab = await getActiveTab();
    const url = campaignState.lastUrl || `https://www.google.com/search?q=${encodeURIComponent(campaignState.query || "")}&start=${((campaignState.currentPage || 1) - 1) * 10}`;

    if (tab) {
      chrome.tabs.update(tab.id, { url });
    } else {
      chrome.tabs.create({ url });
    }

    setStatus("Resuming campaign...");
    $("resumeBanner").style.display = "none";
    loadSettings();
  }
});

$("resumeNo").addEventListener("click", async () => {
  $("resumeBanner").style.display = "none";
  await chrome.storage.local.remove(["campaignState"]);
  setStatus("Campaign dismissed.");
});

// ----- Progress UI -----
function renderProgress(p) {
  const box = $("progressBox");
  if (!p || !p.isRunning) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
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

// React to live updates from content/background scripts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.progress) renderProgress(changes.progress.newValue);
  if (changes.leads) {
    refreshCount();
    renderPreviewTable(); // Feature 14: live update preview
  }
});

// ----- Buttons -----
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !/^https?:\/\/(www\.)?google\.com\/search/.test(tab.url || "")) {
    setStatus("Please open google.com/search first.");
    return;
  }
  setStatus("Scraping current page...");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (res) {
      setStatus(`Found ${res.found} result(s), ${res.added} new saved.`);
    } else {
      setStatus("No response from page. Try reloading the search page.");
    }
  } catch (e) {
    setStatus("Could not reach page. Reload the Google search tab.");
  }
  refreshCount();
  renderPreviewTable();
});

$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("autoNext").addEventListener("change", (e) => saveSetting("autoNext", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) =>
  saveSetting("autoMaxPages", Number(e.target.value) || 5)
);
ALL_FIELDS.forEach(f => {
  const el = $(`f_${f}`);
  if (el) el.addEventListener("change", saveFields);
});

$("runDeep").addEventListener("click", async () => {
  setStatus("Starting deep-scrape... (this may take a while)");
  const res = await chrome.runtime.sendMessage({ type: "DEEP_SCRAPE_ALL" });
  if (res && res.ok) {
    setStatus(`Deep-scrape done. Updated ${res.updated} leads.`);
  } else {
    setStatus(`Deep-scrape failed: ${res ? res.error : "unknown error"}`);
  }
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

// init
loadSettings();
refreshCount();
pollProgress();
renderPreviewTable();
checkResumeCampaign();
