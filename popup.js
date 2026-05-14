// popup.js — UI controller

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

const ALL_FIELDS = ["title", "url", "description", "domain", "emails", "phones", "position", "query"];
const DEFAULT_FIELDS = {
  title: true, url: true, description: true, domain: true,
  emails: true, phones: true, position: false, query: false
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
    "autoScrape", "autoNext", "autoMaxPages", "fields", "autoEnrich"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("autoNext").checked = !!s.autoNext;
  $("autoMaxPages").value = s.autoMaxPages || 5;
  $("autoEnrich").checked = s.autoEnrich !== false; // default true

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

// Check if the URL is any Google search page (any TLD)
function isGoogleSearchUrl(url) {
  if (!url) return false;
  return /^https?:\/\/(www\.)?google\.[a-z.]+\/search/i.test(url);
}

// Try to inject content script if it's not already there
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  } catch (e) {
    console.warn("Inject failed:", e);
    return false;
  }
}

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
  if (changes.leads) refreshCount();
});

// ----- Buttons -----
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !isGoogleSearchUrl(tab.url)) {
    setStatus("Please open a Google search page first (any country).");
    return;
  }
  setStatus("Scraping current page...");

  // First try: send message to existing content script
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
  } catch (e) {
    // Content script not present — inject it and retry
    setStatus("Injecting scraper into page...");
    const injected = await ensureContentScript(tab.id);
    if (!injected) {
      setStatus("Cannot inject scraper. Try reloading the Google tab.");
      return;
    }
    // Wait a moment for it to initialize
    await new Promise(r => setTimeout(r, 500));
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    } catch (e2) {
      setStatus("Still cannot reach page. Please reload the Google search tab.");
      return;
    }
  }

  if (res) {
    setStatus(`Found ${res.found} result(s), ${res.added} new saved.`);
  } else {
    setStatus("No results found. Try scrolling the page first.");
  }
  refreshCount();
});

$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("autoNext").addEventListener("change", (e) => saveSetting("autoNext", e.target.checked));
$("autoEnrich").addEventListener("change", (e) => saveSetting("autoEnrich", e.target.checked));
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
  setStatus("All leads cleared.");
  refreshCount();
});

// init
loadSettings();
refreshCount();
pollProgress();
