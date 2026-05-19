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
  // Maps-specific preferred order. `allPhones` is set by deepScrapeAll and
  // surfaces here so deep-enriched exports keep a stable column order.
  const preferred = [
    "title", "phone", "allPhones", "email",
    "allEmails", "facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok",
    "website", "address", "category",
    "rating", "reviewCount", "hours", "domain",
    "latitude", "longitude", "plusCode", "url", "scrapedAt"
  ];
  const headers = preferred.filter(k => keys.has(k))
    .concat([...keys].filter(k => !preferred.includes(k)));

  const rows = [headers.map(csvEscape).join(",")];
  for (const l of leads) {
    rows.push(headers.map(h => {
      const v = l[h];
      if (Array.isArray(v)) return csvEscape(v.join("; "));
      // Plain objects (e.g. the nested `social` snapshot from deepScrapeAll)
      // would otherwise stringify as "[object Object]". Serialize them as
      // JSON so the cell is at least machine-readable.
      if (v && typeof v === "object") {
        try { return csvEscape(JSON.stringify(v)); } catch (_) { return csvEscape(""); }
      }
      return csvEscape(v);
    }).join(","));
  }
  return rows.join("\n");
}

function downloadText(text, filename, mime) {
  const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  return chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

// ----- Deep enrichment (visit websites for emails) -----
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

// Canonical regex source for social-media URL detection.
// content.js mirrors these patterns (separate JS context for content scripts).
// Keep these in sync with the SOCIAL_PATTERNS object near the top of content.js.
//
// YouTube alternation requires a literal `/` after `channel|user|c` so paths like
// `youtube.com/cooking` do not match as a "c" channel. The `@` handle keeps no
// trailing slash (it is followed directly by the username).
const SOCIAL_PATTERNS = {
  facebook:  /https?:\/\/(?:www\.|m\.|business\.)?facebook\.com\/[A-Za-z0-9_.\-/?=&%]+/gi,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.\-/?=&%]+/gi,
  twitter:   /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9_.\-/?=&%]+/gi,
  linkedin:  /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9_.\-/?=&%]+/gi,
  youtube:   /https?:\/\/(?:www\.)?youtube\.com\/(?:(?:channel|user|c)\/|@)[A-Za-z0-9_.\-/?=&%]+/gi,
  tiktok:    /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.\-/?=&%]+/gi
};

// Strip trailing punctuation and quote-like characters that often follow URLs in HTML.
// Includes ',' and ';' which appear after bare URLs in JSON-LD blobs and visible text.
function cleanSocialUrl(u) {
  if (!u) return u;
  let s = String(u).trim();
  // Strip trailing quote/bracket/paren/comma/semicolon/whitespace characters
  s = s.replace(/[",;'<>)\]\s]+$/g, "");
  // Strip a single trailing slash for canonical comparison (but keep e.g. /channel/UC...)
  s = s.replace(/\/+$/, "");
  return s;
}

function extractSocialFromHtml(html) {
  const out = { facebook: [], instagram: [], twitter: [], linkedin: [], youtube: [], tiktok: [] };
  if (!html) return out;
  for (const platform of Object.keys(SOCIAL_PATTERNS)) {
    const re = SOCIAL_PATTERNS[platform];
    re.lastIndex = 0;
    const matches = html.match(re) || [];
    const seen = new Set();
    for (const raw of matches) {
      const u = cleanSocialUrl(raw);
      if (!u) continue;
      const key = u.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out[platform].push(u);
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
  const social = extractSocialFromHtml(html);
  return { emails, phones, social };
}

async function fetchPage(url, externalSignal) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  // If an outer caller (e.g. enrichLeadFromWebsite's overall budget) aborts,
  // propagate the abort to this fetch so the service worker isn't tied up
  // doing work whose result will be discarded.
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else {
      onExternalAbort = () => ctrl.abort();
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }
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
  finally {
    clearTimeout(t);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

// Fetch the homepage + common contact pages of a lead's website in parallel and
// extract emails / phones / social URLs from the combined HTML. Capped at 4 pages
// total. Each fetchPage() has its own 12s timeout, all four run in parallel so the
// wall-clock is bounded near ~12s; we add an overall ~25s safety wrapper that
// aborts any still-in-flight fetches so the service worker isn't kept busy
// after the budget elapses.
//
// Note on /contact vs /contact-us: many sites 200-redirect one to the other, so
// both fetches can cost a round trip. We keep both because some sites only
// publish one or the other (and the dedup at the email/social level absorbs
// duplicate content from a redirect). If latency becomes a problem, drop one.
async function enrichLeadFromWebsite(websiteUrl) {
  const empty = { emails: [], phones: [], social: { facebook: [], instagram: [], twitter: [], linkedin: [], youtube: [], tiktok: [] } };
  if (!websiteUrl) return empty;

  let origin = "";
  try { origin = new URL(websiteUrl).origin; } catch (_) { return empty; }

  const urls = [
    websiteUrl,
    origin + "/contact",
    origin + "/about",
    origin + "/contact-us"
  ].slice(0, 4);

  // Outer budget controller: aborts every fetchPage when the 25s wall-clock
  // elapses, so the race below doesn't leave orphan fetches running until
  // their own 12s timeouts.
  const outer = new AbortController();
  const budgetTimer = setTimeout(() => outer.abort(), 25000);

  let htmls;
  try {
    htmls = await Promise.all(urls.map(u => fetchPage(u, outer.signal).catch(() => null)));
  } finally {
    clearTimeout(budgetTimer);
  }
  if (!Array.isArray(htmls)) htmls = [];

  const merged = { emails: new Set(), phones: new Set(), social: { facebook: new Set(), instagram: new Set(), twitter: new Set(), linkedin: new Set(), youtube: new Set(), tiktok: new Set() } };
  for (const html of htmls) {
    if (!html) continue;
    const c = extractContactsFromHtml(html);
    c.emails.forEach(e => merged.emails.add(e));
    c.phones.forEach(p => merged.phones.add(p));
    for (const platform of Object.keys(merged.social)) {
      (c.social[platform] || []).forEach(u => merged.social[platform].add(u));
    }
  }

  const social = {};
  for (const platform of Object.keys(merged.social)) {
    social[platform] = Array.from(merged.social[platform]);
  }
  return {
    emails: Array.from(merged.emails),
    phones: Array.from(merged.phones),
    social
  };
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

      const enriched = await enrichLeadFromWebsite(lead.website);
      if (!enriched) return;
      const { emails, phones, social } = enriched;

      if (emails.length && !lead.email) lead.email = emails[0];
      lead.allEmails = emails;
      if (phones.length && !lead.phone) lead.phone = phones[0];
      lead.allPhones = phones;
      lead.social = social;
      // Flat per-platform fields (first match) for simpler CSV columns.
      for (const platform of Object.keys(social)) {
        if (social[platform] && social[platform].length) {
          lead[platform] = social[platform][0];
        }
      }
      lead.deepScrapedAt = new Date().toISOString();

      const socialCount = Object.values(social).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
      if (emails.length || phones.length || socialCount) {
        updated++;
        totalContacts += emails.length + phones.length + socialCount;
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

// ===== Webhook =====
// Validate that a webhook URL parses and uses an http(s) scheme. We accept
// http:// because some self-hosted n8n / Zapier-style relays inside private
// networks are http-only, but the popup surfaces a warning on the status line
// for any non-HTTPS URL so a typo to a public http target isn't silent.
function validateWebhookUrl(url) {
  if (!url || typeof url !== "string") {
    return { ok: false, error: "Webhook URL not configured" };
  }
  let parsed;
  try { parsed = new URL(url); } catch (_) {
    return { ok: false, error: "Webhook URL is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `Webhook URL must use http(s):// (got ${parsed.protocol})` };
  }
  return { ok: true, parsed };
}

async function postWebhook(url, body, authHeader) {
  const v = validateWebhookUrl(url);
  if (!v.ok) return { ok: false, status: 0, error: v.error };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (authHeader && String(authHeader).trim()) {
      // The Authorization header is sent verbatim. Caller must include
      // "Bearer " prefix if needed. Note: the value is stored in plain
      // chrome.storage.local; document this in the popup field hint.
      headers["Authorization"] = String(authHeader).trim();
    }
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers,
      body: JSON.stringify(body)
    });
    let responseText = "";
    try { responseText = await res.text(); } catch (_) {}
    return {
      ok: res.ok,
      status: res.status,
      responseText: responseText.slice(0, 500),
      error: res.ok ? undefined : `HTTP ${res.status}`
    };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function webhookTest() {
  const { webhookUrl, webhookAuthHeader } = await chrome.storage.local.get([
    "webhookUrl", "webhookAuthHeader"
  ]);
  if (!webhookUrl) return { ok: false, status: 0, error: "Webhook URL not configured" };
  const payload = {
    event: "test",
    source: "maps-lead-scraper-pro",
    timestamp: new Date().toISOString(),
    sample: {
      title: "Test Business",
      phone: "+1-555-0100",
      email: "test@example.com"
    }
  };
  return postWebhook(webhookUrl, payload, webhookAuthHeader);
}

async function webhookSendAll() {
  const {
    leads = [],
    webhookUrl,
    webhookAuthHeader,
    webhookMode = "batch",
    webhookBatchSize = 50
  } = await chrome.storage.local.get([
    "leads", "webhookUrl", "webhookAuthHeader", "webhookMode", "webhookBatchSize"
  ]);

  if (!webhookUrl) return { ok: false, error: "Webhook URL not configured" };
  const total = leads.length;
  if (!total) return { ok: false, error: "No leads to send" };

  const batchSize = Math.max(1, Math.min(500, Number(webhookBatchSize) || 50));
  let sent = 0;
  let failed = 0;

  await setProgress({
    isRunning: true,
    title: "Sending leads to webhook...",
    currentPage: 0,
    totalPages: total,
    totalFound: 0,
    currentItem: ""
  });

  if (webhookMode === "per-lead") {
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      await setProgress({
        currentPage: i + 1,
        currentItem: `Sending: ${lead.title || lead.url || "(unnamed)"}`
      });
      const res = await postWebhook(
        webhookUrl,
        { event: "lead", lead },
        webhookAuthHeader
      );
      if (res.ok) sent++; else failed++;
      await setProgress({ totalFound: sent });
      await new Promise(r => setTimeout(r, 200));
    }
    // Sending all is treated as a flush - mark them all as already pushed
    await chrome.storage.local.set({ webhookLastSentIndex: leads.length });
  } else {
    // batch mode
    for (let i = 0; i < leads.length; i += batchSize) {
      const chunk = leads.slice(i, i + batchSize);
      await setProgress({
        currentPage: Math.min(i + batchSize, total),
        currentItem: `Sending batch ${Math.floor(i / batchSize) + 1} (${chunk.length} leads)`
      });
      const res = await postWebhook(
        webhookUrl,
        { event: "leads_batch", count: chunk.length, leads: chunk },
        webhookAuthHeader
      );
      if (res.ok) sent += chunk.length; else failed += chunk.length;
      await setProgress({ totalFound: sent });
      await new Promise(r => setTimeout(r, 200));
    }
    // Batch send is also a flush - mark all current leads as pushed so the
    // per-lead auto-push listener doesn't replay from index 0 after a later
    // mode switch.
    await chrome.storage.local.set({ webhookLastSentIndex: leads.length });
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. Sent ${sent}/${total}, failed ${failed}.`
  });
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: failed === 0, sent, failed, total };
}

// Auto-push hook: when leads array grows AND webhookEnabled=true AND mode=per-lead,
// POST each new lead to the webhook. Tracks webhookLastSentIndex to avoid resending.
//
// Watermark fragility (intentional, deferred): this slices by index and relies on
// `leads` being strictly append-only between firings. If a future change reorders,
// deletes, or parallelizes lead writes, switch to a per-lead `pushedAt` flag or
// an ID set. Today saveLead() in content.js is the only writer and it always
// pushes to the end of the array, so the watermark holds.
async function autoPushNewLeads(oldLeads, newLeads) {
  // Only act when leads were appended
  if (!Array.isArray(newLeads) || !Array.isArray(oldLeads)) return;
  if (newLeads.length <= oldLeads.length) return;

  const {
    webhookEnabled,
    webhookMode = "batch",
    webhookUrl,
    webhookAuthHeader,
    webhookLastSentIndex = 0
  } = await chrome.storage.local.get([
    "webhookEnabled", "webhookMode", "webhookUrl",
    "webhookAuthHeader", "webhookLastSentIndex"
  ]);

  if (!webhookEnabled) return;
  if (webhookMode !== "per-lead") return;
  if (!webhookUrl) return;

  const startIdx = Math.min(
    Math.max(0, Number(webhookLastSentIndex) || 0),
    newLeads.length
  );
  const toSend = newLeads.slice(startIdx);
  if (!toSend.length) return;

  for (const lead of toSend) {
    try {
      await postWebhook(
        webhookUrl,
        { event: "lead", lead },
        webhookAuthHeader
      );
    } catch (_) { /* swallow - best effort */ }
    await new Promise(r => setTimeout(r, 150));
  }
  await chrome.storage.local.set({ webhookLastSentIndex: newLeads.length });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!changes.leads) return;
  const oldLeads = changes.leads.oldValue || [];
  const newLeads = changes.leads.newValue || [];
  // Reset sent-index on shrink (e.g. user cleared leads). Do not push.
  if (newLeads.length < oldLeads.length) {
    chrome.storage.local.set({ webhookLastSentIndex: newLeads.length });
    return;
  }
  if (newLeads.length === oldLeads.length) return;
  autoPushNewLeads(oldLeads, newLeads);
});

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
      } else if (msg.type === "ENRICH_LEAD") {
        sendResponse(await enrichLeadFromWebsite(msg.website));
      } else if (msg.type === "WEBHOOK_TEST") {
        sendResponse(await webhookTest());
      } else if (msg.type === "WEBHOOK_SEND_ALL") {
        sendResponse(await webhookSendAll());
      } else if (msg.type === "FETCH_SUGGESTIONS") {
        sendResponse({ suggestions: await fetchGoogleSuggestions(msg.query) });
      } else if (msg.type === "CAPTCHA_DETECTED") {
        await showCaptchaNotification(msg.info);
        sendResponse({ ok: true });
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
  const cur = await chrome.storage.local.get(["leads", "fields", "lifetimeQuota"]);
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
  // One-time cleanup of orphaned multi-account-rotation keys from older
  // installs. The feature was removed; these keys are no longer read or
  // written but linger in existing user profiles.
  try {
    await chrome.storage.local.remove([
      "accounts",
      "activeAccountIndex",
      "accountLeadsCount",
      "accountRotationThreshold",
      "lastRotation"
    ]);
  } catch (_) { /* best effort */ }
  // Setup alarms
  chrome.alarms.create("captcha-cooldown-check", { periodInMinutes: 1 });
  chrome.alarms.create("midnight-reset", { periodInMinutes: 60 });
});
