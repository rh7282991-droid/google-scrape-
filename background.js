// background.js — service worker
// Handles: CSV/JSON export, deep-scrape with live progress

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

// ----- Export helpers -----

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads) {
  // Build headers from union of keys present
  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
  // Preferred order
  const preferred = ["title", "url", "domain", "description", "emails", "phones",
                     "position", "query", "scrapedAt", "deepScrapedAt"];
  const headers = preferred.filter(k => keys.has(k))
    .concat([...keys].filter(k => !preferred.includes(k)));

  const rows = [headers.map(csvEscape).join(",")];
  for (const l of leads) {
    rows.push(headers.map(h => {
      const v = l[h];
      if (Array.isArray(v)) return csvEscape(v.join("; "));
      return csvEscape(v);
    }).join(","));
  }
  return rows.join("\n");
}

function downloadText(text, filename, mime) {
  const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

// ----- Deep scrape -----

function extractContactsFromHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);
  const tels = Array.from(html.matchAll(/tel:([^"'>\s?]+)/gi)).map(m => m[1]);

  const emails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase())
      .filter(s => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(s))
  ));

  const phonesRaw = [...tels, ...(text.match(PHONE_RE) || [])];
  const phones = Array.from(new Set(
    phonesRaw.map(p => p.trim()).filter(p => {
      const digits = p.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    })
  ));

  return { emails, phones };
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: { "Accept": "text/html,application/xhtml+xml" }
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    return await res.text();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

async function setProgress(patch) {
  const { progress = {} } = await chrome.storage.local.get(["progress"]);
  await chrome.storage.local.set({
    progress: { ...progress, ...patch, updatedAt: Date.now() }
  });
}

async function deepScrapeAll() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  await setProgress({
    isRunning: true,
    title: "Deep-scraping URLs...",
    currentPage: 0,
    totalPages: leads.length,
    totalFound: 0,
    currentItem: ""
  });

  let updated = 0;
  let processed = 0;
  let totalContacts = 0;

  const BATCH = 3;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead, idx) => {
      processed++;
      await setProgress({
        currentPage: processed,
        currentItem: `Visiting: ${lead.domain || lead.url}`
      });

      if ((lead.emails || []).length && (lead.phones || []).length) return;
      const html = await fetchPage(lead.url);
      if (!html) return;
      const { emails, phones } = extractContactsFromHtml(html);
      lead.emails = Array.from(new Set([...(lead.emails || []), ...emails]));
      lead.phones = Array.from(new Set([...(lead.phones || []), ...phones]));
      lead.deepScrapedAt = new Date().toISOString();
      if (emails.length || phones.length) {
        updated++;
        totalContacts += emails.length + phones.length;
      }
      await setProgress({ totalFound: totalContacts });
    }));
    await chrome.storage.local.set({ leads });
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. ${updated} leads enriched.`
  });
  // auto-hide after a few seconds
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated };
}

// ----- Message router -----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "EXPORT_CSV") {
        const { leads = [] } = await chrome.storage.local.get(["leads"]);
        if (!leads.length) return sendResponse({ ok: false });
        const csv = leadsToCsv(leads);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(csv, `google-leads-${stamp}.csv`, "text/csv");
        sendResponse({ ok: true });
      } else if (msg.type === "EXPORT_JSON") {
        const { leads = [] } = await chrome.storage.local.get(["leads"]);
        if (!leads.length) return sendResponse({ ok: false });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(JSON.stringify(leads, null, 2), `google-leads-${stamp}.json`, "application/json");
        sendResponse({ ok: true });
      } else if (msg.type === "DEEP_SCRAPE_ALL") {
        const r = await deepScrapeAll();
        sendResponse(r);
      } else if (msg.type === "FETCH_SUGGESTIONS") {
        // Feature 15: Smart Search Suggestions via Google Autocomplete
        const suggestions = await fetchGoogleSuggestions(msg.query);
        sendResponse({ suggestions });
      } else if (msg.type === "SAVE_CAMPAIGN_STATE") {
        // Feature 17: Save campaign state for resume
        await chrome.storage.local.set({ campaignState: msg.state });
        sendResponse({ ok: true });
      } else if (msg.type === "CAPTCHA_DETECTED") {
        // Feature 4: CAPTCHA detected - show notification
        await showCaptchaNotification(msg.info);
        sendResponse({ ok: true });
      } else if (msg.type === "ACCOUNT_LEADS_INCREMENT") {
        // Feature 5: Track per-account leads, rotate at 50
        const r = await incrementAccountLeads(msg.count || 0);
        sendResponse(r);
      } else if (msg.type === "ACCOUNT_FLAGGED") {
        // Feature 5: Account flagged (e.g., by CAPTCHA) - rotate immediately
        const r = await rotateAccount("flagged: " + (msg.reason || "unknown"));
        sendResponse(r);
      } else if (msg.type === "ADD_ACCOUNT") {
        // Feature 5: Add a Google account label
        const r = await addAccount(msg.label);
        sendResponse(r);
      } else if (msg.type === "REMOVE_ACCOUNT") {
        const r = await removeAccount(msg.id);
        sendResponse(r);
      } else if (msg.type === "ROTATE_ACCOUNT") {
        const r = await rotateAccount("manual");
        sendResponse(r);
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

// ===== Feature 15: Google Autocomplete Suggestions =====
async function fetchGoogleSuggestions(query) {
  if (!query || query.length < 2) return [];
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    // data format: [query, [suggestions], ...]
    if (Array.isArray(data) && Array.isArray(data[1])) {
      return data[1].slice(0, 8);
    }
    return [];
  } catch (_) {
    return [];
  }
}

// ===== Feature 17: Monitor tab changes to save campaign state =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !/^https?:\/\/(www\.)?google\.com\/search/.test(tab.url)) return;

  const { autoScrape, autoNext, autoMaxPages } = await chrome.storage.local.get(["autoScrape", "autoNext", "autoMaxPages"]);
  if (!autoScrape && !autoNext) return;

  // Save campaign state for resume
  const urlObj = new URL(tab.url);
  const query = urlObj.searchParams.get("q") || "";
  const start = Number(urlObj.searchParams.get("start") || 0);
  const currentPage = Math.floor(start / 10) + 1;
  const { leads = [] } = await chrome.storage.local.get(["leads"]);

  await chrome.storage.local.set({
    campaignState: {
      isActive: true,
      completed: false,
      query,
      currentPage,
      totalPages: Number(autoMaxPages || 5),
      leadsCollected: leads.length,
      lastUrl: tab.url,
      savedAt: Date.now()
    }
  });
});

// Mark campaign complete when auto-scrape finishes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autoScrape && changes.autoScrape.newValue === false) {
    chrome.storage.local.get(["campaignState"]).then(({ campaignState }) => {
      if (campaignState && campaignState.isActive) {
        campaignState.completed = true;
        campaignState.isActive = false;
        chrome.storage.local.set({ campaignState });
      }
    });
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "autoMaxPages", "fields", "accounts"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.autoMaxPages) await chrome.storage.local.set({ autoMaxPages: 5 });
  if (!cur.fields) {
    await chrome.storage.local.set({
      fields: {
        title: true, url: true, description: true, domain: true,
        emails: true, phones: true, position: false, query: false
      }
    });
  }
  if (!cur.accounts) {
    await chrome.storage.local.set({
      accounts: [],
      activeAccountIndex: 0,
      accountLeadsCount: 0,
      accountRotationThreshold: 50
    });
  }
  // Feature 4: Setup alarm to check CAPTCHA cooldown expiry every minute
  chrome.alarms.create("captcha-cooldown-check", { periodInMinutes: 1 });
});

// ===== Feature 4: CAPTCHA notification =====
async function showCaptchaNotification(info) {
  const cooldownEnd = new Date(info.cooldownUntil).toLocaleTimeString();
  try {
    await chrome.notifications.create("captcha-detected-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Suspicious activity detected",
      message: `Taking a 30-min break. Auto-scrape paused. Resume after ${cooldownEnd}.`,
      priority: 2
    });
  } catch (e) {
    // Notifications permission may not be granted; fail silently
    console.warn("[GLS] Notification failed:", e);
  }
}

// Auto-clear CAPTCHA cooldown when expired (check every minute)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "captcha-cooldown-check") {
    const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil <= Date.now()) {
      await chrome.storage.local.remove(["captchaDetected"]);
      try {
        await chrome.notifications.create("cooldown-ended-" + Date.now(), {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Cooldown ended",
          message: "You can resume scraping now.",
          priority: 1
        });
      } catch (_) {}
    }
  }
});

// ===== Feature 5: Multi-Account Rotation =====
async function addAccount(label) {
  if (!label || !label.trim()) return { ok: false, error: "Label required" };
  const { accounts = [] } = await chrome.storage.local.get(["accounts"]);
  const id = "acc_" + Date.now();
  accounts.push({
    id,
    label: label.trim(),
    leadsCollected: 0,
    flaggedCount: 0,
    addedAt: Date.now(),
    lastUsedAt: null
  });
  await chrome.storage.local.set({ accounts });
  return { ok: true, account: accounts[accounts.length - 1] };
}

async function removeAccount(id) {
  const { accounts = [], activeAccountIndex = 0 } = await chrome.storage.local.get(["accounts", "activeAccountIndex"]);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return { ok: false, error: "Not found" };
  accounts.splice(idx, 1);
  let newIdx = activeAccountIndex;
  if (newIdx >= accounts.length) newIdx = 0;
  await chrome.storage.local.set({ accounts, activeAccountIndex: newIdx });
  return { ok: true };
}

async function incrementAccountLeads(count) {
  if (!count) return { ok: true };
  const {
    accounts = [],
    activeAccountIndex = 0,
    accountRotationThreshold = 50
  } = await chrome.storage.local.get(["accounts", "activeAccountIndex", "accountRotationThreshold"]);

  if (!accounts.length) return { ok: true, hasAccounts: false };

  const active = accounts[activeAccountIndex];
  if (!active) return { ok: true };

  active.leadsCollected = (active.leadsCollected || 0) + count;
  active.lastUsedAt = Date.now();
  await chrome.storage.local.set({ accounts });

  // Check threshold
  if (active.leadsCollected >= accountRotationThreshold) {
    return await rotateAccount(`reached ${accountRotationThreshold} leads`);
  }
  return { ok: true, leadsCollected: active.leadsCollected };
}

async function rotateAccount(reason) {
  const { accounts = [], activeAccountIndex = 0 } = await chrome.storage.local.get(["accounts", "activeAccountIndex"]);
  if (accounts.length < 2) {
    return { ok: false, error: "Need 2+ accounts to rotate", hasAccounts: accounts.length > 0 };
  }

  // Mark current as flagged if reason is captcha-related
  if (reason && reason.includes("flagged")) {
    accounts[activeAccountIndex].flaggedCount = (accounts[activeAccountIndex].flaggedCount || 0) + 1;
  }

  // Reset count for current and rotate
  accounts[activeAccountIndex].leadsCollected = 0;
  const nextIndex = (activeAccountIndex + 1) % accounts.length;

  await chrome.storage.local.set({
    accounts,
    activeAccountIndex: nextIndex,
    lastRotation: { at: Date.now(), from: accounts[activeAccountIndex].label, to: accounts[nextIndex].label, reason }
  });

  // Notify user
  try {
    await chrome.notifications.create("account-rotated-" + Date.now(), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Account rotated",
      message: `Switched to "${accounts[nextIndex].label}". Reason: ${reason}.`,
      priority: 1
    });
  } catch (_) {}

  return {
    ok: true,
    rotated: true,
    from: accounts[activeAccountIndex].label,
    to: accounts[nextIndex].label,
    reason
  };
}
