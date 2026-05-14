// background.js — service worker
// Handles: CSV/JSON export, deep-scrape (visit each result url and extract emails/phones)

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

// ----- Export helpers -----

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads) {
  const headers = ["title", "url", "description", "emails", "phones", "query", "page", "scrapedAt"];
  const rows = [headers.join(",")];
  for (const l of leads) {
    rows.push([
      csvEscape(l.title),
      csvEscape(l.url),
      csvEscape(l.description),
      csvEscape((l.emails || []).join("; ")),
      csvEscape((l.phones || []).join("; ")),
      csvEscape(l.query),
      csvEscape(l.page),
      csvEscape(l.scrapedAt)
    ].join(","));
  }
  return rows.join("\n");
}

function downloadText(text, filename, mime) {
  // Service workers cannot use URL.createObjectURL on Blob in MV3 reliably,
  // so we use a data URL instead.
  const dataUrl = `data:${mime};charset=utf-8,` + encodeURIComponent(text);
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true
  });
}

// ----- Deep scrape -----

function extractContactsFromHtml(html) {
  // Strip tags very loosely so we still pick up obfuscated mailto: too
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // Also pull mailto: and tel: links explicitly
  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);
  const tels = Array.from(html.matchAll(/tel:([^"'>\s?]+)/gi)).map(m => m[1]);

  const emails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase())
      .filter(s => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(s))
  ));

  const phonesRaw = [...tels, ...(text.match(PHONE_RE) || [])];
  const phones = Array.from(new Set(
    phonesRaw
      .map(p => p.trim())
      .filter(p => {
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
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // Pretend to be a normal browser; the host_permissions cover <all_urls>.
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    return await res.text();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function deepScrapeAll() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  let updated = 0;
  // Concurrency: process 3 at a time, with a small jitter between batches
  const BATCH = 3;
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead) => {
      // Skip if we already have at least one email AND one phone — saves time
      if ((lead.emails || []).length && (lead.phones || []).length) return;
      const html = await fetchPage(lead.url);
      if (!html) return;
      const { emails, phones } = extractContactsFromHtml(html);
      const merged = {
        ...lead,
        emails: Array.from(new Set([...(lead.emails || []), ...emails])),
        phones: Array.from(new Set([...(lead.phones || []), ...phones])),
        deepScrapedAt: new Date().toISOString()
      };
      Object.assign(lead, merged);
      updated++;
    }));
    await chrome.storage.local.set({ leads });
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
  }
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
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  })();
  return true; // async
});

// First-install defaults
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "autoMaxPages"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.autoMaxPages) await chrome.storage.local.set({ autoMaxPages: 5 });
});
