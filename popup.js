// popup.js — UI controller

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function refreshCount() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  $("count").textContent = `${leads.length} leads`;
}

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "autoNext", "autoMaxPages", "deepScrape"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("autoNext").checked = !!s.autoNext;
  $("autoMaxPages").value = s.autoMaxPages || 5;
  $("deepScrape").checked = !!s.deepScrape;
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

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
});

$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("autoNext").addEventListener("change", (e) => saveSetting("autoNext", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) =>
  saveSetting("autoMaxPages", Number(e.target.value) || 5)
);
$("deepScrape").addEventListener("change", (e) => saveSetting("deepScrape", e.target.checked));

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
