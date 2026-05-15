// popup.js — UI controller with live preview, quality scores, and delay info

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

// ===== FEATURE 3: Live Preview Panel =====
function getScoreColor(score) {
  if (score >= 70) return "#34a853";
  if (score >= 40) return "#f9ab00";
  return "#ea4335";
}

function getScoreLabel(score) {
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

function renderPreview(previewData) {
  const list = $("previewList");
  if (!previewData || previewData.length === 0) {
    list.innerHTML = '<div class="preview-empty">No leads yet. Start scraping!</div>';
    return;
  }

  list.innerHTML = previewData.map((lead, i) => `
    <div class="preview-item">
      <div class="preview-item-header">
        <span class="preview-title" title="${lead.title}">${lead.title || "Untitled"}</span>
        <span class="quality-badge" style="background:${getScoreColor(lead.qualityScore)}">
          ${lead.qualityScore}
        </span>
      </div>
      <div class="preview-domain">${lead.domain || "—"}</div>
      <div class="preview-contacts">
        ${lead.emails.length ? `<span class="preview-email">✉ ${lead.emails[0]}</span>` : ""}
        ${lead.phones.length ? `<span class="preview-phone">☎ ${lead.phones[0]}</span>` : ""}
        ${!lead.emails.length && !lead.phones.length ? '<span class="preview-none">No contacts yet</span>' : ""}
      </div>
    </div>
  `).join("");
}

async function loadPreview() {
  const { livePreview = [] } = await chrome.storage.local.get(["livePreview"]);
  renderPreview(livePreview);
}

// ===== Progress UI =====
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

  // Show delay info
  const delayEl = $("delayInfo");
  if (p.delayInfo) {
    delayEl.style.display = "block";
    $("delayMultiplier").textContent = p.delayInfo.multiplier || "1.0";
  } else {
    delayEl.style.display = "none";
  }
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
  if (changes.livePreview) renderPreview(changes.livePreview.newValue);
});

// ===== Buttons =====
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
  loadPreview();
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
  loadPreview();
});

// FEATURE 2: Email enrichment button
$("enrichEmails").addEventListener("click", async () => {
  setStatus("Starting email enrichment... visiting websites...");
  const res = await chrome.runtime.sendMessage({ type: "ENRICH_EMAILS" });
  if (res && res.ok) {
    setStatus(`Email enrichment done. ${res.updated} leads enriched (${res.totalEmails || 0} emails found).`);
  } else {
    setStatus(`Enrichment failed: ${res ? (res.message || res.error) : "unknown error"}`);
  }
  refreshCount();
  loadPreview();
});

// FEATURE 4: Recalculate scores
$("recalcScores").addEventListener("click", async () => {
  setStatus("Recalculating quality scores...");
  const res = await chrome.runtime.sendMessage({ type: "RECALC_SCORES" });
  if (res && res.ok) {
    setStatus(`Scores updated for ${res.count} leads.`);
  } else {
    setStatus("Failed to recalculate scores.");
  }
  loadPreview();
});

// FEATURE 3: Refresh preview
$("refreshPreview").addEventListener("click", () => {
  loadPreview();
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
  await chrome.storage.local.set({ leads: [], livePreview: [] });
  setStatus("All leads cleared.");
  refreshCount();
  loadPreview();
});

// init
loadSettings();
refreshCount();
pollProgress();
loadPreview();
