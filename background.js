// ============================================
// Maps Lead Scraper Pro — service worker
// ============================================

// ----- Export helpers -----
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads) {
  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
  // Maps-specific preferred order
  const preferred = [
    "title", "phone", "email", "website", "address", "category",
    "rating", "reviewCount",
    "facebook", "instagram", "twitter", "youtube", "linkedin",
    "hours", "domain",
    "latitude", "longitude", "plusCode", "url", "scrapedAt"
  ];
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

// ----- Deep enrichment (visit websites for emails + socials) -----
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const EMAIL_SKIP = /(example\.com|sentry|wixpress|gmail-noreply|noreply@|@x\.com|@2x\.|@3x\.|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.webp)/i;

// Match a real social-media profile/page URL, NOT a share/intent link.
const SOCIAL_PATTERNS = {
  facebook:  /https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/([A-Za-z0-9.\-_]+)(?:\/?|\?)/i,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)(?:\/?|\?)/i,
  twitter:   /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?:\/?|\?)/i,
  youtube:   /https?:\/\/(?:www\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)?([A-Za-z0-9_\-.]+)(?:\/?|\?)/i,
  linkedin:  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/([A-Za-z0-9\-_.]+)(?:\/?|\?)/i,
};
// These usernames belong to share-buttons or generic pages, not the business itself.
const SOCIAL_BLOCKLIST = /^(sharer|sharer\.php|share|intent|tr|home|login|signup|watch|results|pages|dialog|plugins|hashtag|search|explore|reel|reels|p|stories|tv|public|profile\.php)$/i;

function pickFirstSocial(html, key) {
  const re = SOCIAL_PATTERNS[key];
  if (!re) return "";
  const matches = html.match(new RegExp(re.source, "gi")) || [];
  for (const m of matches) {
    const sub = m.match(re);
    if (!sub) continue;
    let handle = sub[1] || "";
    // Strip trailing .php / .html etc that sneak through the regex
    handle = handle.replace(/\.(php|html?|aspx?)$/i, "");
    if (!handle || SOCIAL_BLOCKLIST.test(handle)) continue;
    // Strip query string / trailing slash
    return m.split(/[?#]/)[0].replace(/\/$/, "");
  }
  return "";
}

function extractContactsFromHtml(html, baseUrl) {
  // Strip script/style for clean text scan
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // Emails
  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);
  const emails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase().trim())
      .filter(s => !EMAIL_SKIP.test(s))
  ));

  // Phones
  const tels = Array.from(html.matchAll(/tel:([^"'>\s?]+)/gi)).map(m => m[1]);
  const phones = Array.from(new Set(
    [...tels, ...(text.match(PHONE_RE) || [])]
      .map(p => p.trim())
      .filter(p => {
        const d = p.replace(/\D/g, "");
        return d.length >= 8 && d.length <= 15;
      })
  ));

  // Socials — only real profile links, never share-button urls
  const socials = {
    facebook:  pickFirstSocial(html, "facebook"),
    instagram: pickFirstSocial(html, "instagram"),
    twitter:   pickFirstSocial(html, "twitter"),
    youtube:   pickFirstSocial(html, "youtube"),
    linkedin:  pickFirstSocial(html, "linkedin"),
  };

  return { emails, phones, ...socials };
}

// Cache websites for 1 hour to avoid re-fetching duplicates within a campaign
const _websiteCache = new Map();
async function fetchWebsiteContacts(websiteUrl) {
  if (!websiteUrl) return { ok: false, error: "no url" };

  const cached = _websiteCache.get(websiteUrl);
  if (cached && (Date.now() - cached.t) < 60 * 60 * 1000) return cached.v;

  // Try the homepage AND a /contact-style page for better recall
  const candidates = [websiteUrl];
  try {
    const u = new URL(websiteUrl);
    for (const path of ["/contact", "/contact-us", "/contacts", "/about", "/about-us"]) {
      candidates.push(u.origin + path);
    }
  } catch (_) {}

  let combined = { emails: [], phones: [], facebook: "", instagram: "", twitter: "", youtube: "", linkedin: "" };
  for (const url of candidates.slice(0, 3)) {        // cap at 3 fetches per lead
    const html = await fetchPage(url);
    if (!html) continue;
    const got = extractContactsFromHtml(html, url);
    combined.emails = Array.from(new Set([...combined.emails, ...got.emails]));
    combined.phones = Array.from(new Set([...combined.phones, ...got.phones]));
    for (const k of ["facebook", "instagram", "twitter", "youtube", "linkedin"]) {
      if (!combined[k] && got[k]) combined[k] = got[k];
    }
    // Stop early if we already have an email + at least one social
    if (combined.emails.length && (combined.facebook || combined.instagram)) break;
  }

  const out = {
    ok: true,
    email: combined.emails[0] || "",
    allEmails: combined.emails,
    facebook: combined.facebook,
    instagram: combined.instagram,
    twitter: combined.twitter,
    youtube: combined.youtube,
    linkedin: combined.linkedin,
  };
  _websiteCache.set(websiteUrl, { t: Date.now(), v: out });
  return out;
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

  const enrichable = leads.filter(l => l.website && !l.deepScrapedAt);
  if (!enrichable.length) return { ok: true, updated: 0, msg: "All leads already enriched" };

  await setProgress({
    isRunning: true,
    title: "Deep-enriching websites...",
    currentPage: 0,
    totalPages: enrichable.length,
    totalFound: 0,
    currentItem: ""
  });

  let updated = 0;
  let processed = 0;
  let totalContacts = 0;

  const BATCH = 3;
  for (let i = 0; i < enrichable.length; i += BATCH) {
    const batch = enrichable.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead) => {
      processed++;
      await setProgress({
        currentPage: processed,
        currentItem: `Visiting: ${lead.domain || lead.website}`
      });

      const html = await fetchPage(lead.website);
      if (!html) return;
      const got = extractContactsFromHtml(html, lead.website);

      if (got.emails.length && !lead.email) lead.email = got.emails[0];
      lead.allEmails = got.emails;
      if (got.phones.length && !lead.phone) lead.phone = got.phones[0];
      lead.allPhones = got.phones;
      if (!lead.facebook  && got.facebook)  lead.facebook  = got.facebook;
      if (!lead.instagram && got.instagram) lead.instagram = got.instagram;
      if (!lead.twitter   && got.twitter)   lead.twitter   = got.twitter;
      if (!lead.youtube   && got.youtube)   lead.youtube   = got.youtube;
      if (!lead.linkedin  && got.linkedin)  lead.linkedin  = got.linkedin;
      lead.deepScrapedAt = new Date().toISOString();

      if (got.emails.length || got.phones.length) {
        updated++;
        totalContacts += got.emails.length + got.phones.length;
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
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated };
}

// ===== Google Autocomplete =====
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
    if (Array.isArray(data) && Array.isArray(data[1])) return data[1].slice(0, 8);
    return [];
  } catch (_) { return []; }
}

// ===== CAPTCHA notification =====
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
  } catch (e) { console.warn("[MLS] Notification failed:", e); }
}

// ===== Account rotation =====
async function addAccount(label) {
  if (!label || !label.trim()) return { ok: false, error: "Label required" };
  const { accounts = [] } = await chrome.storage.local.get(["accounts"]);
  const id = "acc_" + Date.now();
  accounts.push({
    id, label: label.trim(),
    leadsCollected: 0, flaggedCount: 0,
    addedAt: Date.now(), lastUsedAt: null
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
    accounts = [], activeAccountIndex = 0, accountRotationThreshold = 50
  } = await chrome.storage.local.get(["accounts", "activeAccountIndex", "accountRotationThreshold"]);

  if (!accounts.length) return { ok: true, hasAccounts: false };
  const active = accounts[activeAccountIndex];
  if (!active) return { ok: true };

  active.leadsCollected = (active.leadsCollected || 0) + count;
  active.lastUsedAt = Date.now();
  await chrome.storage.local.set({ accounts });

  if (active.leadsCollected >= accountRotationThreshold) {
    return await rotateAccount(`reached ${accountRotationThreshold} leads`);
  }
  return { ok: true, leadsCollected: active.leadsCollected };
}

async function rotateAccount(reason) {
  const { accounts = [], activeAccountIndex = 0 } = await chrome.storage.local.get(["accounts", "activeAccountIndex"]);
  if (accounts.length < 2) return { ok: false, error: "Need 2+ accounts to rotate" };

  if (reason && reason.includes("flagged")) {
    accounts[activeAccountIndex].flaggedCount = (accounts[activeAccountIndex].flaggedCount || 0) + 1;
  }
  accounts[activeAccountIndex].leadsCollected = 0;
  const nextIndex = (activeAccountIndex + 1) % accounts.length;

  await chrome.storage.local.set({
    accounts, activeAccountIndex: nextIndex,
    lastRotation: { at: Date.now(), from: accounts[activeAccountIndex].label, to: accounts[nextIndex].label, reason }
  });

  try {
    await chrome.notifications.create("account-rotated-" + Date.now(), {
      type: "basic", iconUrl: "icons/icon128.png",
      title: "Account rotated",
      message: `Switched to "${accounts[nextIndex].label}". Reason: ${reason}.`,
      priority: 1
    });
  } catch (_) {}
  return { ok: true, rotated: true, to: accounts[nextIndex].label };
}

// ===== Message router =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "EXPORT_CSV") {
        const { leads = [] } = await chrome.storage.local.get(["leads"]);
        if (!leads.length) return sendResponse({ ok: false });
        const csv = leadsToCsv(leads);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(csv, `maps-leads-${stamp}.csv`, "text/csv");
        sendResponse({ ok: true });
      } else if (msg.type === "EXPORT_JSON") {
        const { leads = [] } = await chrome.storage.local.get(["leads"]);
        if (!leads.length) return sendResponse({ ok: false });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(JSON.stringify(leads, null, 2), `maps-leads-${stamp}.json`, "application/json");
        sendResponse({ ok: true });
      } else if (msg.type === "DEEP_SCRAPE_ALL") {
        sendResponse(await deepScrapeAll());
      } else if (msg.type === "FETCH_WEBSITE_CONTACTS") {
        sendResponse(await fetchWebsiteContacts(msg.url));
      } else if (msg.type === "FETCH_SUGGESTIONS") {
        sendResponse({ suggestions: await fetchGoogleSuggestions(msg.query) });
      } else if (msg.type === "CAPTCHA_DETECTED") {
        await showCaptchaNotification(msg.info);
        sendResponse({ ok: true });
      } else if (msg.type === "ACCOUNT_LEADS_INCREMENT") {
        sendResponse(await incrementAccountLeads(msg.count || 0));
      } else if (msg.type === "ACCOUNT_FLAGGED") {
        sendResponse(await rotateAccount("flagged: " + (msg.reason || "unknown")));
      } else if (msg.type === "ADD_ACCOUNT") {
        sendResponse(await addAccount(msg.label));
      } else if (msg.type === "REMOVE_ACCOUNT") {
        sendResponse(await removeAccount(msg.id));
      } else if (msg.type === "ROTATE_ACCOUNT") {
        sendResponse(await rotateAccount("manual"));
      } else if (msg.type === "OPEN_MAPS") {
        // Open Google Maps with query
        const query = msg.query || "";
        const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
        const tab = await getActiveTab();
        if (tab) chrome.tabs.update(tab.id, { url });
        else chrome.tabs.create({ url });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== Campaign state save (Feature 17) =====
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !/^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(tab.url)) return;

  const { autoScrape } = await chrome.storage.local.get(["autoScrape"]);
  if (!autoScrape) return;

  // Extract query from /maps/search/QUERY
  const m = tab.url.match(/\/maps\/search\/([^/?]+)/);
  const query = m ? decodeURIComponent(m[1]) : "";
  const { leads = [] } = await chrome.storage.local.get(["leads"]);

  await chrome.storage.local.set({
    campaignState: {
      isActive: true, completed: false,
      query, currentPage: 1,
      totalPages: 1, leadsCollected: leads.length,
      lastUrl: tab.url, savedAt: Date.now()
    }
  });
});

// Reset today counter at midnight
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "midnight-reset") {
    const today = new Date().toDateString();
    const { todayLeadDate } = await chrome.storage.local.get(["todayLeadDate"]);
    if (todayLeadDate !== today) {
      await chrome.storage.local.set({ todayLeadCount: 0, todayLeadDate: today });
    }
  } else if (alarm.name === "captcha-cooldown-check") {
    const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil <= Date.now()) {
      await chrome.storage.local.remove(["captchaDetected"]);
      try {
        await chrome.notifications.create("cooldown-ended-" + Date.now(), {
          type: "basic", iconUrl: "icons/icon128.png",
          title: "Cooldown ended", message: "You can resume scraping now.", priority: 1
        });
      } catch (_) {}
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "fields", "accounts", "lifetimeQuota"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.lifetimeQuota) await chrome.storage.local.set({ lifetimeQuota: 300 });
  if (!cur.fields) {
    await chrome.storage.local.set({
      fields: {
        title: true, phone: true, email: true, website: true,
        address: true, category: true, rating: true, reviewCount: true
      }
    });
  }
  if (!cur.accounts) {
    await chrome.storage.local.set({
      accounts: [], activeAccountIndex: 0,
      accountLeadsCount: 0, accountRotationThreshold: 50
    });
  }
  // Setup alarms
  chrome.alarms.create("captcha-cooldown-check", { periodInMinutes: 1 });
  chrome.alarms.create("midnight-reset", { periodInMinutes: 60 });
});



// ============================================
// AUTO-WEBHOOK — sends new leads automatically
// Runs in service worker (background) so works
// even when popup is closed or browser tab changes.
// ============================================

let _lastLeadCount = 0;
let _webhookSending = false;

// Watch for storage changes — when leads array grows, auto-send new ones
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!changes.leads) return;

  const { autoWebhook, webhookUrl } = await chrome.storage.local.get(["autoWebhook", "webhookUrl"]);
  if (!autoWebhook || !webhookUrl) return;

  const newLeads = changes.leads.newValue || [];
  const oldLeads = changes.leads.oldValue || [];

  // Only send the NEW leads (diff)
  if (newLeads.length <= oldLeads.length) return;
  const freshLeads = newLeads.slice(oldLeads.length);

  if (!freshLeads.length || _webhookSending) return;
  _webhookSending = true;

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(freshLeads)
    });
    if (res.ok) {
      console.log(`[MLS-BG] Auto-webhook: sent ${freshLeads.length} new leads (total: ${newLeads.length})`);
      // Track how many we've sent
      const { webhookSentCount = 0 } = await chrome.storage.local.get(["webhookSentCount"]);
      await chrome.storage.local.set({ webhookSentCount: webhookSentCount + freshLeads.length });
    } else {
      console.warn(`[MLS-BG] Auto-webhook error: ${res.status}`);
    }
  } catch (e) {
    console.warn("[MLS-BG] Auto-webhook fetch failed:", e.message);
  }
  _webhookSending = false;
});

// Also watch for campaign end — stop auto-webhook when done
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (!changes.progress) return;

  const p = changes.progress.newValue;
  if (p && !p.isRunning) {
    // Campaign ended
    const { autoWebhook, webhookSentCount = 0 } = await chrome.storage.local.get(["autoWebhook", "webhookSentCount"]);
    if (autoWebhook && webhookSentCount > 0) {
      console.log(`[MLS-BG] Campaign done. Total ${webhookSentCount} leads sent to webhook.`);
      // Optionally auto-disable (uncomment if you want one-shot behavior):
      // await chrome.storage.local.set({ autoWebhook: false });
    }
  }
});
