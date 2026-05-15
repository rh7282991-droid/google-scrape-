// background.js — service worker
// Uses a hidden minimized window to actually LOAD each page in a real browser tab.
// This bypasses CORS, bot blocks, and JS-only sites — same as you visiting it manually.

// ----- Export helpers -----
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads) {
  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
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

// ===== Hidden scraping window =====
let scrapingWindowId = null;

async function getScrapingWindow() {
  if (scrapingWindowId !== null) {
    try {
      await chrome.windows.get(scrapingWindowId);
      return scrapingWindowId;
    } catch (_) {
      scrapingWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: "about:blank",
    focused: false,
    state: "minimized",
    type: "normal",
    width: 800,
    height: 600
  });
  scrapingWindowId = win.id;
  // Keep it minimized
  try {
    await chrome.windows.update(win.id, { state: "minimized", focused: false });
  } catch (_) {}
  return win.id;
}

async function closeScrapingWindow() {
  if (scrapingWindowId !== null) {
    try { await chrome.windows.remove(scrapingWindowId); } catch (_) {}
    scrapingWindowId = null;
  }
}

// ===== Page extraction (runs in target page context) =====
// This function is injected into each loaded page; it has full access to the rendered DOM.
function __extractContactsInPage() {
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

  // Smart phone regexes for real phone numbers
  const PHONE_PATTERNS = [
    // Bangladesh: +880XXXXXXXXXX, 880-XXXX-XXXXXX, 01XXXXXXXXX
    /(?:\+?880[\s\-.]?\d[\s\-.]?\d{4}[\s\-.]?\d{4,5})/g,
    /(?:0?1[3-9]\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3,4})/g,
    // International: +XX (X) XXXX-XXXX or +XX XXXXXXXXXX
    /(?:\+\d{1,3}[\s\-.]?\(?\d{1,5}\)?[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}[\s\-.]?\d{0,4})/g,
    // General: numbers near phone-related keywords (captured via context below)
  ];

  // Keywords that indicate the nearby number is a phone
  const PHONE_KEYWORDS = /phone|mobile|call|tel|hotline|whatsapp|viber|contact|helpline|fax|cell/i;

  const emails = new Set();
  const phones = new Set();

  // ===== PHONE: Priority 1 — tel: links (most reliable) =====
  document.querySelectorAll('a[href^="tel:"], a[href^="Tel:"]').forEach(a => {
    let p = a.getAttribute("href").replace(/^tel:/i, "").replace(/\s/g, "");
    try { p = decodeURIComponent(p); } catch (_) {}
    if (p && p.replace(/\D/g, "").length >= 8) phones.add(p);
  });

  // ===== PHONE: Priority 2 — JSON-LD telephone field =====
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const data = JSON.parse(s.textContent);
      const collect = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) { o.forEach(collect); return; }
        if (o.email && typeof o.email === "string") emails.add(o.email.toLowerCase());
        if (o.telephone && typeof o.telephone === "string") {
          const t = o.telephone.trim();
          if (t.replace(/\D/g, "").length >= 8) phones.add(t);
        }
        if (o.phone && typeof o.phone === "string") {
          const t = o.phone.trim();
          if (t.replace(/\D/g, "").length >= 8) phones.add(t);
        }
        Object.values(o).forEach(collect);
      };
      collect(data);
    } catch (_) {}
  });

  // ===== PHONE: Priority 3 — itemprop=telephone or content with phone =====
  document.querySelectorAll('[itemprop="telephone"]').forEach(el => {
    const val = el.getAttribute("content") || el.textContent || "";
    const cleaned = val.trim();
    if (cleaned.replace(/\D/g, "").length >= 8) phones.add(cleaned);
  });

  // ===== PHONE: Priority 4 — Phone patterns in page text =====
  const bodyText = (document.body && document.body.innerText) || "";

  PHONE_PATTERNS.forEach(re => {
    (bodyText.match(re) || []).forEach(p => {
      const cleaned = p.trim();
      const digits = cleaned.replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 15) {
        phones.add(cleaned);
      }
    });
  });

  // ===== PHONE: Priority 5 — Context-aware: numbers near "phone" keywords =====
  const lines = bodyText.split("\n");
  lines.forEach(line => {
    if (!PHONE_KEYWORDS.test(line)) return;
    // Find numbers in lines that mention phone/call/mobile etc.
    const nums = line.match(/[\+]?\d[\d\s\-().]{7,}\d/g) || [];
    nums.forEach(n => {
      const digits = n.replace(/\D/g, "");
      if (digits.length >= 10 && digits.length <= 15) {
        // Extra filter: should not look like a price or date
        if (!/\$|USD|BDT|Tk|Taka|৳|Price|amount|year|date|order/i.test(line)) {
          phones.add(n.trim());
        }
      }
    });
  });

  // ===== EMAIL: Priority 1 — mailto: links =====
  document.querySelectorAll('a[href^="mailto:"]').forEach(a => {
    let e = a.getAttribute("href").replace(/^mailto:/i, "").split("?")[0];
    try { e = decodeURIComponent(e); } catch (_) {}
    if (e && /@/.test(e)) emails.add(e.toLowerCase());
  });

  // ===== EMAIL: Priority 2 — Cloudflare-obfuscated =====
  document.querySelectorAll("[data-cfemail]").forEach(el => {
    const hex = el.getAttribute("data-cfemail");
    if (!hex) return;
    try {
      const r = parseInt(hex.substr(0, 2), 16);
      let email = "";
      for (let i = 2; i < hex.length; i += 2) {
        email += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ r);
      }
      if (/@/.test(email)) emails.add(email.toLowerCase());
    } catch (_) {}
  });

  // ===== EMAIL: Priority 3 — Regex from visible text =====
  (bodyText.match(EMAIL_RE) || []).forEach(e => {
    const lo = e.toLowerCase();
    if (!/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf|mp4)$/i.test(lo)) {
      emails.add(lo);
    }
  });

  // ===== EMAIL: Priority 4 — Deobfuscate [at] [dot] patterns =====
  const deob = bodyText
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s*\{\s*at\s*\}\s*/gi, "@")
    .replace(/\s+at\s+(?=[a-zA-Z])/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s*\{\s*dot\s*\}\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
  (deob.match(EMAIL_RE) || []).forEach(e => emails.add(e.toLowerCase()));

  // ===== EMAIL: Priority 5 — Raw HTML (hidden attributes) =====
  try {
    const html = document.documentElement.outerHTML;
    (html.match(EMAIL_RE) || []).forEach(e => {
      const lo = e.toLowerCase();
      if (!/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf|mp4)$/i.test(lo)
          && !/sentry|wixpress|@x\.com$/i.test(lo)) {
        emails.add(lo);
      }
    });
  } catch (_) {}

  // ===== Final filtering =====
  const blockEmail = /(sentry|wixpress|example\.com|test@test|noreply@example|yoursite|yourdomain|your-email|@x\.com$|^[0-9a-f]{16,}@)/i;

  // Phone cleanup: normalize and deduplicate by digit content
  const seenDigits = new Set();
  const cleanPhones = [];
  Array.from(phones).forEach(p => {
    const digits = p.replace(/\D/g, "");
    // Must be 10-15 digits for a real phone
    if (digits.length < 10 || digits.length > 15) return;
    // Skip if looks like a price
    if (/^\d{1,3},\d{3}/.test(p)) return; // 1,234,567 pattern = price
    if (seenDigits.has(digits)) return;
    // If starts with 0 but not 01X (BD mobile), skip short ones
    if (/^0[^1]/.test(digits) && digits.length < 10) return;
    seenDigits.add(digits);
    cleanPhones.push(p);
  });

  return {
    emails: Array.from(emails).filter(e => !blockEmail.test(e) && e.length < 80 && e.length > 5),
    phones: cleanPhones.slice(0, 15)
  };
}

// Wait for a tab to finish loading (or timeout)
function waitForTabLoad(tabId, timeoutMs = 18000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
      try { chrome.tabs.onRemoved.removeListener(removedListener); } catch (_) {}
      clearTimeout(timer);
      resolve(status);
    };
    function listener(updatedTabId, info) {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        // Give JS a moment to finish (lazy-loaded content, etc.)
        setTimeout(() => finish("complete"), 1500);
      }
    }
    function removedListener(removedTabId) {
      if (removedTabId === tabId) finish("removed");
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

async function extractFromUrlViaTab(url) {
  let tabId = null;
  try {
    const winId = await getScrapingWindow();
    const tab = await chrome.tabs.create({
      windowId: winId,
      url: url,
      active: false
    });
    tabId = tab.id;

    const status = await waitForTabLoad(tabId);
    if (status === "removed") return { emails: [], phones: [] };

    // Try to inject extraction script
    let result = { emails: [], phones: [] };
    try {
      const out = await chrome.scripting.executeScript({
        target: { tabId },
        func: __extractContactsInPage,
        world: "MAIN"
      });
      if (out && out[0] && out[0].result) result = out[0].result;
    } catch (e) {
      // Try ISOLATED world if MAIN failed
      try {
        const out = await chrome.scripting.executeScript({
          target: { tabId },
          func: __extractContactsInPage
        });
        if (out && out[0] && out[0].result) result = out[0].result;
      } catch (_) {}
    }

    return result;
  } catch (e) {
    return { emails: [], phones: [] };
  } finally {
    if (tabId !== null) {
      try { await chrome.tabs.remove(tabId); } catch (_) {}
    }
  }
}

// Build candidate contact URLs from a base URL
function contactCandidates(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    return [
      origin + "/contact",
      origin + "/contact-us",
      origin + "/contactus",
      origin + "/about",
      origin + "/about-us",
      origin + "/en/contact",
      origin + "/en/about"
    ];
  } catch (_) { return []; }
}

async function enrichLead(lead) {
  const found = {
    emails: new Set(lead.emails || []),
    phones: new Set(lead.phones || [])
  };

  // 1) Visit the lead URL itself in a real tab
  const main = await extractFromUrlViaTab(lead.url);
  main.emails.forEach(e => found.emails.add(e));
  main.phones.forEach(p => found.phones.add(p));

  // 2) If still nothing, try one contact page (avoid opening too many tabs)
  if (found.emails.size === 0 || found.phones.size === 0) {
    const candidates = contactCandidates(lead.url);
    for (const candidate of candidates.slice(0, 3)) {
      const r = await extractFromUrlViaTab(candidate);
      r.emails.forEach(e => found.emails.add(e));
      r.phones.forEach(p => found.phones.add(p));
      if (found.emails.size > 0 && found.phones.size > 0) break;
    }
  }

  lead.emails = Array.from(found.emails);
  lead.phones = Array.from(found.phones);
  lead.deepScrapedAt = new Date().toISOString();
  return found.emails.size + found.phones.size;
}

async function setProgress(patch) {
  const { progress = {} } = await chrome.storage.local.get(["progress"]);
  await chrome.storage.local.set({
    progress: { ...progress, ...patch, updatedAt: Date.now() }
  });
}

// Sequential processing — much more reliable than concurrent for tab-based scraping
async function enrichLeadsSequential(leadsList, opts = {}) {
  const { title = "Finding emails & phones..." } = opts;

  await setProgress({
    isRunning: true,
    title,
    currentPage: 0,
    totalPages: leadsList.length,
    totalFound: 0,
    currentItem: ""
  });

  let totalContacts = 0;
  for (let i = 0; i < leadsList.length; i++) {
    const lead = leadsList[i];
    await setProgress({
      currentPage: i + 1,
      currentItem: `Visiting ${lead.domain || lead.url}`
    });

    const before = (lead.emails || []).length + (lead.phones || []).length;
    try {
      await enrichLead(lead);
    } catch (e) {
      console.warn("enrich failed", lead.url, e);
    }
    const after = (lead.emails || []).length + (lead.phones || []).length;
    totalContacts += Math.max(0, after - before);

    await setProgress({ totalFound: totalContacts });

    // Persist after every lead (so user sees live progress)
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const idx = leads.findIndex(l => l.url === lead.url);
    if (idx !== -1) {
      leads[idx] = lead;
      await chrome.storage.local.set({ leads });
    }
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. Got ${totalContacts} contact(s).`
  });
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  // Clean up the hidden window when done
  await closeScrapingWindow();

  return { ok: true, totalContacts, processed: leadsList.length };
}

async function autoEnrichLeads(urls) {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const targets = leads.filter(l => urls.includes(l.url) && !l.deepScrapedAt);
  if (!targets.length) return { ok: true, totalContacts: 0 };
  return await enrichLeadsSequential(targets, { title: "Finding emails & phones..." });
}

async function deepScrapeAll() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };
  return await enrichLeadsSequential(leads, { title: "Deep-scraping all leads..." });
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
        sendResponse(await deepScrapeAll());
      } else if (msg.type === "AUTO_ENRICH") {
        sendResponse(await autoEnrichLeads(msg.urls || []));
      } else if (msg.type === "STOP_ENRICH") {
        await closeScrapingWindow();
        await chrome.storage.local.set({ progress: { isRunning: false } });
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "autoMaxPages", "fields", "autoEnrich"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.autoMaxPages) await chrome.storage.local.set({ autoMaxPages: 5 });
  if (cur.autoEnrich === undefined) await chrome.storage.local.set({ autoEnrich: true });
  if (!cur.fields) {
    await chrome.storage.local.set({
      fields: {
        title: true, url: true, description: true, domain: true,
        emails: true, phones: true, position: false, query: false
      }
    });
  }
});
