// background.js — service worker.
// Initializes default storage, ensures content.js is injected when needed.
// Uses chrome.alarms to keep itself alive during long scraping sessions.

const DEFAULT_STATE = {
  status: "idle",
  collected: 0,
  target: 0,
  queue: 0,
  phoneCount: 0,
  addressCount: 0,
  logs: ["Ready. Open the popup to start a campaign."]
};

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "state"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.state) await chrome.storage.local.set({ state: DEFAULT_STATE });
  // Create keep-alive alarm (fires every 25 sec to prevent SW death)
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.storage.local.set({
    state: { ...DEFAULT_STATE, logs: ["Browser restarted — previous run discarded."] }
  });
  await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget", "activeTask"]);
  chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
});

// Keep-alive alarm handler — just touch storage to stay awake
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepAlive") {
    // Check if a run is active; if not, clear the alarm to save resources
    const { state } = await chrome.storage.local.get(["state"]);
    if (state && (state.status === "running" || state.status === "paused")) {
      // Stay alive — do nothing, the alarm firing is enough
    }
    // Otherwise let it run anyway (low cost)
  }
});

// Inject content.js when an existing Maps tab needs it
async function ensureContentScriptInTab(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (r && r.ok) return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
    return true;
  } catch (_) {
    return false;
  }
}

// When user navigates a Maps tab, make sure our script is alive
chrome.webNavigation?.onCompleted?.addListener?.(async (details) => {
  if (details.frameId !== 0) return;
  if (!/^https?:\/\/www\.google\.[a-z.]+\/maps/i.test(details.url || "")) return;
  await ensureContentScriptInTab(details.tabId);
}, { url: [{ hostContains: "google." }] });

// Allow popup or other parts to ask the SW for utility actions
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "BG_PING") {
        sendResponse({ ok: true, ts: Date.now() });
      } else if (msg && msg.type === "BG_INJECT" && msg.tabId) {
        const ok = await ensureContentScriptInTab(msg.tabId);
        sendResponse({ ok });
      } else {
        // Not handled here; ignore so other listeners can respond.
        sendResponse({ ok: false, error: "noop" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});
