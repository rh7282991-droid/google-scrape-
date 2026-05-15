// background.js — service worker
// Handles: CSV/JSON export, deep-scrape with live progress, email enrichment, lead quality scoring

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

// ===== FEATURE 1: Smart Random Delay for Anti-Block =====
const SmartDelay = {
  // Adaptive delay system that mimics human behavior
  baseMin: 1500,
  baseMax: 4000,
  consecutiveRequests: 0,
  lastRequestTime: 0,
  backoffMultiplier: 1,

  // Generates a random delay using exponential distribution (more human-like)
  getDelay() {
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;

    // If requests are coming fast, increase backoff
    if (timeSinceLast < 3000) {
      this.consecutiveRequests++;
      this.backoffMultiplier = Math.min(4, 1 + (this.consecutiveRequests * 0.3));
    } else {
      // Cool down gradually
      this.consecutiveRequests = Math.max(0, this.consecutiveRequests - 1);
      this.backoffMultiplier = Math.max(1, this.backoffMultiplier - 0.2);
    }

    // Human-like jitter using gaussian-ish distribution
    const jitter = this._gaussianRandom() * 1000;
    const base = this.baseMin + Math.random() * (this.baseMax - this.baseMin);
    const delay = Math.round((base + jitter) * this.backoffMultiplier);

    // Add occasional longer "reading" pauses (10% chance)
    const readingPause = Math.random() < 0.1 ? (3000 + Math.random() * 5000) : 0;

    this.lastRequestTime = now;
    return Math.max(800, delay + readingPause);
  },

  // Box-Muller transform for gaussian-like random
  _gaussianRandom() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * 0.3;
  },

  // Reset after a long idle
  reset() {
    this.consecutiveRequests = 0;
    this.backoffMultiplier = 1;
    this.lastRequestTime = 0;
  },

  // Get current state for UI display
  getState() {
    return {
      multiplier: this.backoffMultiplier.toFixed(1),
      consecutive: this.consecutiveRequests,
      avgDelay: Math.round((this.baseMin + this.baseMax) / 2 * this.backoffMultiplier)
    };
  }
};

// ===== FEATURE 4: Lead Quality Score (0-100) =====
function calculateLeadQuality(lead) {
  let score = 0;

  // Has title (10 pts)
  if (lead.title && lead.title.trim().length > 3) score += 10;

  // Has URL (5 pts)
  if (lead.url && lead.url.startsWith("http")) score += 5;

  // Has domain (5 pts)
  if (lead.domain && lead.domain.length > 3) score += 5;

  // Has description (10 pts, up to 15 for longer)
  if (lead.description) {
    score += 10;
    if (lead.description.length > 100) score += 5;
  }

  // Has emails (25 pts - high value)
  const emails = lead.emails || [];
  if (emails.length > 0) {
    score += 15;
    // Bonus for business emails (not gmail/yahoo/hotmail)
    const businessEmails = emails.filter(e =>
      !/(gmail|yahoo|hotmail|outlook|aol|mail)\./i.test(e)
    );
    if (businessEmails.length > 0) score += 10;
  }

  // Has phones (20 pts)
  const phones = lead.phones || [];
  if (phones.length > 0) score += 20;

  // Has been deep-scraped (5 pts)
  if (lead.deepScrapedAt) score += 5;

  // Domain quality indicators (up to 10 pts)
  if (lead.domain) {
    // Short domains tend to be more legitimate
    if (lead.domain.length < 20) score += 3;
    // Has common business TLDs
    if (/\.(com|io|co|org|net)$/i.test(lead.domain)) score += 3;
    // Not a social media/directory page
    if (!/^(facebook|twitter|linkedin|yelp|yellowpages|pinterest)/i.test(lead.domain)) score += 4;
  }

  return Math.min(100, Math.max(0, score));
}

// ===== Export helpers =====

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads) {
  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
  const preferred = ["title", "url", "domain", "description", "emails", "phones",
                     "qualityScore", "position", "query", "scrapedAt", "deepScrapedAt", "enrichedAt"];
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

// ===== Deep scrape with smart delays =====

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

// ===== FEATURE 2: Email Enrichment - Find emails from business website =====
function extractEmailsFromWebsite(html, domain) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  // Extract all emails
  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);
  const allEmails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase().trim())
      .filter(s => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(s))
      .filter(s => !/(example|test|noreply|no-reply|mailer-daemon)/i.test(s))
  ));

  // Find contact/about page links for deeper enrichment
  const contactLinks = [];
  const linkMatches = html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  for (const m of linkMatches) {
    const href = m[1];
    const linkText = m[2].replace(/<[^>]+>/g, "").toLowerCase();
    if (/contact|about|team|reach|connect/i.test(linkText) || /contact|about/i.test(href)) {
      if (href.startsWith("/") || href.includes(domain)) {
        contactLinks.push(href);
      }
    }
  }

  return { emails: allEmails, contactLinks: contactLinks.slice(0, 3) };
}

async function fetchPage(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (compatible; LeadScraper/1.0)"
      }
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

// Update live preview with latest leads
async function updateLivePreview() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const last5 = leads.slice(-5).reverse().map(l => ({
    title: (l.title || "").slice(0, 50),
    domain: l.domain || "",
    emails: (l.emails || []).slice(0, 2),
    phones: (l.phones || []).slice(0, 1),
    qualityScore: l.qualityScore || 0
  }));
  await chrome.storage.local.set({ livePreview: last5 });
}

async function deepScrapeAll() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  SmartDelay.reset(); // Reset delay system for fresh batch

  await setProgress({
    isRunning: true,
    title: "Deep-scraping URLs...",
    currentPage: 0,
    totalPages: leads.length,
    totalFound: 0,
    currentItem: "",
    delayInfo: SmartDelay.getState()
  });

  let updated = 0;
  let processed = 0;
  let totalContacts = 0;

  const BATCH = 2; // Reduced batch size for anti-block
  for (let i = 0; i < leads.length; i += BATCH) {
    const batch = leads.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead, idx) => {
      processed++;
      await setProgress({
        currentPage: processed,
        currentItem: `Visiting: ${lead.domain || lead.url}`,
        delayInfo: SmartDelay.getState()
      });

      if ((lead.emails || []).length && (lead.phones || []).length) return;
      const html = await fetchPage(lead.url);
      if (!html) return;
      const { emails, phones } = extractContactsFromHtml(html);
      lead.emails = Array.from(new Set([...(lead.emails || []), ...emails]));
      lead.phones = Array.from(new Set([...(lead.phones || []), ...phones]));
      lead.deepScrapedAt = new Date().toISOString();

      // Calculate quality score
      lead.qualityScore = calculateLeadQuality(lead);

      if (emails.length || phones.length) {
        updated++;
        totalContacts += emails.length + phones.length;
      }
      await setProgress({ totalFound: totalContacts });
    }));

    await chrome.storage.local.set({ leads });
    await updateLivePreview();

    // FEATURE 1: Smart delay between batches
    const delay = SmartDelay.getDelay();
    await setProgress({
      currentItem: `Waiting ${(delay / 1000).toFixed(1)}s (anti-block)...`,
      delayInfo: SmartDelay.getState()
    });
    await new Promise(r => setTimeout(r, delay));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. ${updated} leads enriched.`
  });
  await updateLivePreview();

  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated };
}

// ===== FEATURE 2: Email Enrichment - Visit website contact pages =====
async function enrichEmails() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  SmartDelay.reset();

  // Filter leads that need email enrichment
  const needsEnrichment = leads.filter(l =>
    l.url && (!l.emails || l.emails.length === 0)
  );

  if (!needsEnrichment.length) {
    return { ok: true, updated: 0, message: "All leads already have emails" };
  }

  await setProgress({
    isRunning: true,
    title: "Email enrichment...",
    currentPage: 0,
    totalPages: needsEnrichment.length,
    totalFound: 0,
    currentItem: "Starting email discovery..."
  });

  let enriched = 0;
  let totalEmails = 0;

  for (let i = 0; i < needsEnrichment.length; i++) {
    const lead = needsEnrichment[i];
    const leadIndex = leads.indexOf(lead);

    await setProgress({
      currentPage: i + 1,
      currentItem: `Checking: ${lead.domain || lead.url}`,
      delayInfo: SmartDelay.getState()
    });

    try {
      // Step 1: Visit main URL
      const mainHtml = await fetchPage(lead.url);
      if (!mainHtml) continue;

      const { emails: mainEmails, contactLinks } = extractEmailsFromWebsite(mainHtml, lead.domain);
      let foundEmails = [...mainEmails];

      // Step 2: Visit contact/about pages if no emails found on main page
      if (foundEmails.length === 0 && contactLinks.length > 0) {
        for (const link of contactLinks.slice(0, 2)) {
          const fullUrl = link.startsWith("http") ? link : `https://${lead.domain}${link}`;

          // Smart delay between sub-page visits
          const subDelay = SmartDelay.getDelay() * 0.5;
          await new Promise(r => setTimeout(r, subDelay));

          const contactHtml = await fetchPage(fullUrl, 8000);
          if (contactHtml) {
            const { emails: contactEmails } = extractEmailsFromWebsite(contactHtml, lead.domain);
            foundEmails.push(...contactEmails);
          }
        }
      }

      // Deduplicate and update
      foundEmails = Array.from(new Set(foundEmails));
      if (foundEmails.length > 0) {
        lead.emails = Array.from(new Set([...(lead.emails || []), ...foundEmails]));
        lead.enrichedAt = new Date().toISOString();
        lead.qualityScore = calculateLeadQuality(lead);
        enriched++;
        totalEmails += foundEmails.length;
        leads[leadIndex] = lead;
      }
    } catch (e) {
      // Continue on error
    }

    await setProgress({ totalFound: totalEmails });
    await chrome.storage.local.set({ leads });
    await updateLivePreview();

    // Smart delay between leads
    const delay = SmartDelay.getDelay();
    await setProgress({
      currentItem: `Waiting ${(delay / 1000).toFixed(1)}s (anti-block)...`,
      delayInfo: SmartDelay.getState()
    });
    await new Promise(r => setTimeout(r, delay));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. ${enriched} leads got new emails (${totalEmails} total found).`
  });
  await updateLivePreview();

  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated: enriched, totalEmails };
}

// ===== Recalculate all quality scores =====
async function recalculateScores() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  for (const lead of leads) {
    lead.qualityScore = calculateLeadQuality(lead);
  }
  await chrome.storage.local.set({ leads });
  await updateLivePreview();
  return { ok: true, count: leads.length };
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
      } else if (msg.type === "ENRICH_EMAILS") {
        const r = await enrichEmails();
        sendResponse(r);
      } else if (msg.type === "RECALC_SCORES") {
        const r = await recalculateScores();
        sendResponse(r);
      } else if (msg.type === "GET_LIVE_PREVIEW") {
        await updateLivePreview();
        const { livePreview = [] } = await chrome.storage.local.get(["livePreview"]);
        sendResponse({ ok: true, preview: livePreview });
      } else if (msg.type === "GET_DELAY_STATE") {
        sendResponse({ ok: true, state: SmartDelay.getState() });
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
  const cur = await chrome.storage.local.get(["leads", "autoMaxPages", "fields"]);
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
  // Initialize live preview
  await updateLivePreview();
});
