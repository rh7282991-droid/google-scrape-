// background.js — service worker
// Auto-enriches every saved lead with emails/phones by visiting the actual page.
// Handles obfuscated emails, contact pages, JSON-LD, and HTML entities.

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

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

// ===== Contact extraction logic =====

function decodeHtmlEntities(text) {
  text = text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  text = text.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const map = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&nbsp;": " ", "&apos;": "'"
  };
  return text.replace(/&[a-z]+;/gi, m => map[m] || m);
}

function deobfuscateEmail(text) {
  return text
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
}

// Cloudflare-style email obfuscation
function decodeCfEmail(hex) {
  try {
    const r = parseInt(hex.substr(0, 2), 16);
    let email = "";
    for (let i = 2; i < hex.length; i += 2) {
      email += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ r);
    }
    return email;
  } catch (_) { return ""; }
}

function extractContactsFromHtml(html) {
  const emails = new Set();
  const phones = new Set();

  // 1) mailto: and tel: links
  Array.from(html.matchAll(/mailto:([^"'>\s?&]+)/gi))
    .forEach(m => {
      try { emails.add(decodeURIComponent(m[1]).toLowerCase()); }
      catch (_) { emails.add(m[1].toLowerCase()); }
    });
  Array.from(html.matchAll(/tel:([^"'>\s?&]+)/gi))
    .forEach(m => {
      try { phones.add(decodeURIComponent(m[1])); }
      catch (_) { phones.add(m[1]); }
    });

  // 2) Cloudflare obfuscated emails
  Array.from(html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi))
    .forEach(m => {
      const decoded = decodeCfEmail(m[1]);
      if (decoded && /@/.test(decoded)) emails.add(decoded.toLowerCase());
    });

  // 3) JSON-LD structured data
  Array.from(html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi))
    .forEach(m => {
      try {
        const data = JSON.parse(m[1].trim());
        const collect = (o) => {
          if (!o) return;
          if (typeof o === "string") return;
          if (Array.isArray(o)) { o.forEach(collect); return; }
          if (typeof o === "object") {
            if (o.email && typeof o.email === "string") emails.add(o.email.toLowerCase());
            if (o.telephone && typeof o.telephone === "string") phones.add(String(o.telephone));
            if (o.contactPoint) collect(o.contactPoint);
            Object.values(o).forEach(collect);
          }
        };
        collect(data);
      } catch (_) {}
    });

  // 4) Strip scripts/styles, decode entities, then regex
  let textHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  let text = textHtml.replace(/<[^>]+>/g, " ");
  text = decodeHtmlEntities(text);
  const deob = deobfuscateEmail(text);

  [text, deob].forEach(t => {
    (t.match(EMAIL_RE) || []).forEach(e => {
      const lo = e.toLowerCase();
      if (!/\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf)$/i.test(lo)) {
        emails.add(lo);
      }
    });
    (t.match(PHONE_RE) || []).forEach(p => {
      const trimmed = p.trim();
      const digits = trimmed.replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) phones.add(trimmed);
    });
  });

  // Filter junk
  const blockEmail = /(sentry|wixpress|example\.com|test@test|noreply@example|yoursite|yourdomain|your-email|@x\.com$)/i;
  return {
    emails: Array.from(emails).filter(e => !blockEmail.test(e) && e.length < 80),
    phones: Array.from(phones).slice(0, 10)
  };
}

async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "Accept": "text/html,application/xhtml+xml,*/*" }
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct && !ct.includes("text/html") && !ct.includes("application/xhtml") && !ct.includes("text/plain")) {
      return null;
    }
    return await res.text();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

function contactCandidates(baseUrl) {
  try {
    const u = new URL(baseUrl);
    const origin = u.origin;
    return [
      origin + "/contact",
      origin + "/contact-us",
      origin + "/contactus",
      origin + "/about",
      origin + "/about-us"
    ];
  } catch (_) { return []; }
}

async function enrichLead(lead) {
  const found = {
    emails: new Set(lead.emails || []),
    phones: new Set(lead.phones || [])
  };

  // Visit the lead URL itself first
  const html = await fetchPage(lead.url);
  if (html) {
    const got = extractContactsFromHtml(html);
    got.emails.forEach(e => found.emails.add(e));
    got.phones.forEach(p => found.phones.add(p));
  }

  // If still missing, try common contact pages on same domain
  if (found.emails.size === 0 || found.phones.size === 0) {
    for (const candidate of contactCandidates(lead.url)) {
      const h = await fetchPage(candidate);
      if (!h) continue;
      const got = extractContactsFromHtml(h);
      got.emails.forEach(e => found.emails.add(e));
      got.phones.forEach(p => found.phones.add(p));
      if (found.emails.size > 0 && found.phones.size > 0) break;
    }
  }

  lead.emails = Array.from(found.emails);
  lead.phones = Array.from(found.phones);
  lead.deepScrapedAt = new Date().toISOString();
  return (found.emails.size + found.phones.size);
}

async function setProgress(patch) {
  const { progress = {} } = await chrome.storage.local.get(["progress"]);
  await chrome.storage.local.set({
    progress: { ...progress, ...patch, updatedAt: Date.now() }
  });
}

// Auto-enrich newly added leads (called after every Google page scrape)
async function autoEnrichLeads(urls) {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const targets = leads.filter(l => urls.includes(l.url) && !l.deepScrapedAt);
  if (!targets.length) return { ok: true, enriched: 0 };

  await setProgress({
    isRunning: true,
    title: "Finding emails & phones...",
    currentPage: 0,
    totalPages: targets.length,
    totalFound: 0,
    currentItem: ""
  });

  let processed = 0;
  let totalContacts = 0;
  const BATCH = 3;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead) => {
      processed++;
      await setProgress({
        currentPage: processed,
        currentItem: `Visiting: ${lead.domain || lead.url}`
      });
      const before = (lead.emails || []).length + (lead.phones || []).length;
      await enrichLead(lead);
      const after = (lead.emails || []).length + (lead.phones || []).length;
      totalContacts += Math.max(0, after - before);
      await setProgress({ totalFound: totalContacts });
    }));
    await chrome.storage.local.set({ leads });
    await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. Got ${totalContacts} contact(s).`
  });
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, enriched: targets.length, totalContacts };
}

// Manual deep-scrape ALL
async function deepScrapeAll() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  await setProgress({
    isRunning: true,
    title: "Deep-scraping all leads...",
    currentPage: 0,
    totalPages: leads.length,
    totalFound: 0,
    currentItem: ""
  });

  let processed = 0;
  let totalContacts = 0;
  const BATCH = 3;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead) => {
      processed++;
      await setProgress({
        currentPage: processed,
        currentItem: `Visiting: ${lead.domain || lead.url}`
      });
      const before = (lead.emails || []).length + (lead.phones || []).length;
      await enrichLead(lead);
      const after = (lead.emails || []).length + (lead.phones || []).length;
      if (after > before) totalContacts += (after - before);
      await setProgress({ totalFound: totalContacts });
    }));
    await chrome.storage.local.set({ leads });
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. Got ${totalContacts} contact(s).`
  });
  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated: processed, totalContacts };
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
