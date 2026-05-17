// ============================================
// Maps Lead Scraper Pro — service worker
// ============================================

// ----- Export helpers -----
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads, fields) {
  // Determine which fields to include in export
  const ALL_POSSIBLE = [
    "title", "phone", "email", "website", "address", "category",
    "rating", "reviewCount", "hours", "domain",
    "facebook", "instagram", "twitter", "linkedin", "youtube",
    "tiktok", "whatsapp", "pinterest",
    "latitude", "longitude", "plusCode", "url"
  ];

  const hasUserSelection = fields && Object.keys(fields).length > 0;
  const selected = hasUserSelection
    ? ALL_POSSIBLE.filter(f => !!fields[f])
    : ALL_POSSIBLE;

  // Only include columns that user selected AND have data in at least one lead
  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
  const headers = selected.filter(k => keys.has(k));

  // Always include title even if not selected (for usability)
  if (!headers.includes("title") && keys.has("title")) headers.unshift("title");

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
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

const SOCIAL_PATTERNS = {
  facebook:  /(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/(?!sharer|share|tr|plugins|dialog|v\d)([A-Za-z0-9._\-]+(?:\/[A-Za-z0-9._\-]+)?)/i,
  instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?!p\/|reel\/|stories\/|explore\/|accounts\/)([A-Za-z0-9._\-]+)/i,
  twitter:   /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter|x)\.com\/(?!share|intent|home|search|i\/)([A-Za-z0-9_]{1,15})/i,
  linkedin:  /(?:https?:\/\/)?(?:www\.|[a-z]{2}\.)?linkedin\.com\/(?:company|in|school|pub)\/([A-Za-z0-9._\-%]+)/i,
  youtube:   /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)([A-Za-z0-9._\-]+)/i,
  tiktok:    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9._\-]+)/i,
  whatsapp:  /(?:https?:\/\/)?(?:wa\.me\/[\d+]+|api\.whatsapp\.com\/send\?phone=[\d+]+|chat\.whatsapp\.com\/[A-Za-z0-9]+)/i,
  pinterest: /(?:https?:\/\/)?(?:www\.)?pinterest\.[a-z.]+\/([A-Za-z0-9._\-]+)\/?/i
};

function extractSocialsFromHtml(html) {
  const out = {};
  for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
    const m = html.match(regex);
    if (m) {
      let url = m[0];
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      // Clean trailing punctuation/quotes
      url = url.replace(/["'<>\s].*$/, "").replace(/[.,;)]+$/, "");
      out[platform] = url;
    }
  }
  return out;
}

function extractContactsFromHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);
  const tels = Array.from(html.matchAll(/tel:([^"'>\s?]+)/gi)).map(m => m[1]);

  const emails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase().trim())
      .filter(s =>
        !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(s) &&
        !/(sentry|wixpress|googleusercontent|cloudflare|noreply|no-reply|example|donotreply)/i.test(s) &&
        s.length < 100
      )
  ));

  const phonesRaw = [...tels, ...(text.match(PHONE_RE) || [])];
  const phones = Array.from(new Set(
    phonesRaw.map(p => p.trim()).filter(p => {
      const digits = p.replace(/\D/g, "");
      return digits.length >= 8 && digits.length <= 15;
    })
  ));

  // Add social media
  const socials = extractSocialsFromHtml(html);

  return { emails, phones, allEmails: emails, ...socials };
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
  const SOCIAL_KEYS = ["facebook","instagram","twitter","linkedin","youtube","tiktok","whatsapp","pinterest"];

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
      const contacts = extractContactsFromHtml(html);
      const { emails, phones } = contacts;

      if (emails.length && !lead.email) lead.email = emails[0];
      lead.allEmails = emails;
      if (phones.length && !lead.phone) lead.phone = phones[0];
      lead.allPhones = phones;

      // Merge socials
      for (const k of SOCIAL_KEYS) {
        if (contacts[k] && !lead[k]) lead[k] = contacts[k];
      }

      lead.deepScrapedAt = new Date().toISOString();

      if (emails.length || phones.length || SOCIAL_KEYS.some(k => contacts[k])) {
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
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated };
}

// Single-website enrichment (used inline during campaign)
async function enrichSingleWebsite(url) {
  if (!url) return { ok: false, error: "no-url" };
  const html = await fetchPage(url);
  if (!html) return { ok: false, error: "fetch-failed" };
  const contacts = extractContactsFromHtml(html);
  return { ok: true, contacts };
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
        const { leads = [], fields = {} } = await chrome.storage.local.get(["leads", "fields"]);
        if (!leads.length) return sendResponse({ ok: false });
        const csv = leadsToCsv(leads, fields);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(csv, `maps-leads-${stamp}.csv`, "text/csv");
        sendResponse({ ok: true });
      } else if (msg.type === "EXPORT_JSON") {
        const { leads = [], fields = {} } = await chrome.storage.local.get(["leads", "fields"]);
        if (!leads.length) return sendResponse({ ok: false });

        // Filter JSON to only include selected fields
        const ALL_POSSIBLE = [
          "title", "phone", "email", "website", "address", "category",
          "rating", "reviewCount", "hours", "domain",
          "facebook", "instagram", "twitter", "linkedin", "youtube",
          "tiktok", "whatsapp", "pinterest",
          "latitude", "longitude", "plusCode", "url"
        ];
        const hasUserSel = Object.keys(fields).length > 0;
        const selected = hasUserSel
          ? ALL_POSSIBLE.filter(f => !!fields[f])
          : ALL_POSSIBLE;
        if (!selected.includes("title")) selected.unshift("title");

        const filteredLeads = leads.map(l => {
          const out = {};
          for (const k of selected) {
            if (l[k] !== undefined && l[k] !== null && l[k] !== "") out[k] = l[k];
          }
          return out;
        });

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(JSON.stringify(filteredLeads, null, 2), `maps-leads-${stamp}.json`, "application/json");
        sendResponse({ ok: true });
      } else if (msg.type === "DEEP_SCRAPE_ALL") {
        sendResponse(await deepScrapeAll());
      } else if (msg.type === "ENRICH_WEBSITE") {
        sendResponse(await enrichSingleWebsite(msg.url));
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
        address: true, category: true, rating: true, reviewCount: true,
        facebook: true, instagram: true, linkedin: true,
        twitter: false, youtube: false, tiktok: false, whatsapp: false, pinterest: false,
        hours: false, domain: false, latitude: false, longitude: false, url: false
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
