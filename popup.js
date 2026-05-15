// popup.js — UI controller. Talks to content script via background.

const $ = (id) => document.getElementById(id);

const DEFAULTS = {
  keywords: "cafe",
  locations: "dhaka",
  targetLeads: 100,
  maxPerSearch: 50,
  profileWait: 5,
  scrollLimit: 25,
  filterPhone: false,
  filterAddress: false,
  filterWebsite: false
};

// ---------- Settings ----------
async function loadSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  $("keywords").value = s.keywords ?? DEFAULTS.keywords;
  $("locations").value = s.locations ?? DEFAULTS.locations;
  $("targetLeads").value = s.targetLeads ?? DEFAULTS.targetLeads;
  $("maxPerSearch").value = s.maxPerSearch ?? DEFAULTS.maxPerSearch;
  $("profileWait").value = s.profileWait ?? DEFAULTS.profileWait;
  $("scrollLimit").value = s.scrollLimit ?? DEFAULTS.scrollLimit;
  $("filterPhone").checked = !!s.filterPhone;
  $("filterAddress").checked = !!s.filterAddress;
  $("filterWebsite").checked = !!s.filterWebsite;
}

async function saveSettings() {
  await chrome.storage.local.set({
    keywords: $("keywords").value,
    locations: $("locations").value,
    targetLeads: Number($("targetLeads").value) || 100,
    maxPerSearch: Number($("maxPerSearch").value) || 50,
    profileWait: Number($("profileWait").value) || 5,
    scrollLimit: Number($("scrollLimit").value) || 25,
    filterPhone: $("filterPhone").checked,
    filterAddress: $("filterAddress").checked,
    filterWebsite: $("filterWebsite").checked
  });
}

// Auto-save when fields change
["keywords","locations","targetLeads","maxPerSearch","profileWait","scrollLimit",
 "filterPhone","filterAddress","filterWebsite"].forEach(id => {
  $(id).addEventListener("change", saveSettings);
  $(id).addEventListener("input", saveSettings);
});

// ---------- Progress rendering ----------
function renderState(state) {
  if (!state) return;
  const collected = state.collected || 0;
  const target = state.target || 0;
  const pct = target > 0 ? Math.min(100, Math.round((collected / target) * 100)) : 0;

  $("progressPct").textContent = pct + "%";
  $("progressFill").style.width = pct + "%";
  $("statCollected").textContent = collected;
  $("statPhone").textContent = state.phoneCount || 0;
  $("statAddress").textContent = state.addressCount || 0;
  $("statQueue").textContent = state.queue || 0;

  if (state.logs && state.logs.length) {
    $("logBox").textContent = state.logs.slice(-12).join("\n");
    $("logBox").scrollTop = $("logBox").scrollHeight;
  }

  // Toggle button states
  const running = state.status === "running";
  const paused = state.status === "paused";
  $("startBtn").disabled = running || paused;
  $("startBtn").textContent = running ? "Collecting..." : (paused ? "Paused" : "Start Profile Collection");
  $("pauseBtn").disabled = !running;
  $("resumeBtn").disabled = !paused;
  $("stopBtn").disabled = state.status === "idle" || state.status === "stopped";
}

async function refreshState() {
  const { state } = await chrome.storage.local.get(["state"]);
  renderState(state || { status: "idle", collected: 0, target: 0, queue: 0, logs: [] });
  refreshLeadCount();
}

async function refreshLeadCount() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  // (lead count shown in stats already; nothing extra)
}

// React to live updates from content/background scripts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.state) renderState(changes.state.newValue);
});

// ---------- Tab helpers ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isMapsUrl(url) {
  return /^https?:\/\/www\.google\.[a-z.]+\/maps/i.test(url || "");
}

async function ensureMapsTab() {
  const tab = await getActiveTab();
  if (tab && isMapsUrl(tab.url)) return tab;
  // Open Google Maps in current tab
  const newTab = await chrome.tabs.update(tab.id, { url: "https://www.google.com/maps" });
  // Wait for it to load
  await new Promise(r => setTimeout(r, 2500));
  return newTab;
}

async function sendToContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    // Inject content.js if missing
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      await new Promise(r => setTimeout(r, 400));
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch (e2) {
      console.warn("sendToContent failed:", e2);
      return null;
    }
  }
}

// ---------- Buttons: Campaign actions ----------
$("startBtn").addEventListener("click", async () => {
  await saveSettings();
  const tab = await ensureMapsTab();
  if (!tab) return;

  const config = {
    keywords: $("keywords").value.split("\n").map(s => s.trim()).filter(Boolean),
    locations: $("locations").value.split("\n").map(s => s.trim()).filter(Boolean),
    targetLeads: Number($("targetLeads").value) || 100,
    maxPerSearch: Number($("maxPerSearch").value) || 50,
    profileWaitSec: Number($("profileWait").value) || 5,
    scrollLimit: Number($("scrollLimit").value) || 25
  };

  if (!config.keywords.length || !config.locations.length) {
    alert("Please enter at least one keyword and one location.");
    return;
  }

  await sendToContent(tab.id, { type: "START", config });
  refreshState();
});

$("pauseBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) await sendToContent(tab.id, { type: "PAUSE" });
});

$("resumeBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) await sendToContent(tab.id, { type: "RESUME" });
});

$("stopBtn").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab) await sendToContent(tab.id, { type: "STOP" });
});

$("clearBtn").addEventListener("click", async () => {
  if (!confirm("Clear all leads and reset session?")) return;
  await chrome.storage.local.set({
    leads: [],
    state: { status: "idle", collected: 0, target: 0, queue: 0, phoneCount: 0, addressCount: 0, logs: ["Session cleared."] }
  });
  refreshState();
});

// ---------- Paste helpers ----------
$("pasteKeywords").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $("keywords").value = text.trim(); saveSettings(); }
  } catch (_) { alert("Could not read clipboard"); }
});
$("pasteLocations").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $("locations").value = text.trim(); saveSettings(); }
  } catch (_) { alert("Could not read clipboard"); }
});

$("doneBtn").addEventListener("click", () => window.close());

// ---------- Export ----------
function applyFilters(leads) {
  let out = leads.slice();
  if ($("filterPhone").checked) out = out.filter(l => l.phone);
  if ($("filterAddress").checked) out = out.filter(l => l.address);
  if ($("filterWebsite").checked) out = out.filter(l => l.website);
  return out;
}

const EXPORT_HEADERS = ["name", "phone", "website", "address", "rating", "reviews",
                        "category", "plusCode", "hours", "googleMapsUrl",
                        "keyword", "location", "collectedAt"];

function leadsToCsv(leads, sep = ",") {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const lines = [EXPORT_HEADERS.map(esc).join(sep)];
  for (const l of leads) {
    lines.push(EXPORT_HEADERS.map(h => esc(l[h])).join(sep));
  }
  return lines.join("\n");
}

function downloadFile(text, filename, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

$("exportCsv").addEventListener("click", async () => {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const filtered = applyFilters(leads);
  if (!filtered.length) { alert("No leads match your filters."); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(leadsToCsv(filtered, ","), `mapleads-${stamp}.csv`, "text/csv");
});

$("exportTsv").addEventListener("click", async () => {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const filtered = applyFilters(leads);
  if (!filtered.length) { alert("No leads match your filters."); return; }
  const stamp = new Date().toISOString().slice(0, 10);
  // TSV uses tabs and no quoting
  const headers = EXPORT_HEADERS.join("\t");
  const rows = filtered.map(l => EXPORT_HEADERS.map(h => String(l[h] ?? "").replace(/[\t\n\r]/g, " ")).join("\t"));
  downloadFile(headers + "\n" + rows.join("\n"), `mapleads-${stamp}.tsv`, "text/tab-separated-values");
});

$("copySheets").addEventListener("click", async () => {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const filtered = applyFilters(leads);
  if (!filtered.length) { alert("No leads match your filters."); return; }
  const headers = EXPORT_HEADERS.join("\t");
  const rows = filtered.map(l => EXPORT_HEADERS.map(h => String(l[h] ?? "").replace(/[\t\n\r]/g, " ")).join("\t"));
  const tsv = headers + "\n" + rows.join("\n");
  try {
    await navigator.clipboard.writeText(tsv);
    alert("Copied! Now paste (Ctrl+V) into Google Sheets.");
  } catch (e) {
    alert("Could not copy to clipboard.");
  }
});

$("exportDebug").addEventListener("click", async () => {
  const data = await chrome.storage.local.get(null);
  downloadFile(JSON.stringify(data, null, 2), `mapleads-debug-${Date.now()}.json`, "application/json");
});

// ---------- Init ----------
loadSettings();
refreshState();
// Poll occasionally in case storage events miss
setInterval(refreshState, 2000);
