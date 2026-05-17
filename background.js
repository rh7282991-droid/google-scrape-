// ============================================
// Maps Lead Scraper Pro v5.0 — Snapshot Architecture
// Background: Extract Engine (offline HTML parser) + Export
// ============================================

// ===== Regex =====
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

// ============================================
// EXTRACT ENGINE — Parse saved HTML offline
// ============================================
function extractFromHTML(html, url) {
  // Create a DOM parser (no network, pure offline)
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const out = {};

  // URL
  out.url = url || "";

  // Title (h1)
  const h1 = doc.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');
  if (h1) out.title = h1.textContent.trim();

  // Rating
  const ratingEl = doc.querySelector('div.F7nice span[aria-hidden="true"], span.ceNzKf');
  if (ratingEl) {
    const r = parseFloat(ratingEl.textContent);
    if (r) out.rating = r;
  }

  // Review count
  const reviewEl = doc.querySelector('button[jsaction*="reviewChart"] span, span.UY7F9');
  if (reviewEl) {
    const m = reviewEl.textContent.match(/(\d[\d,]*)/);
    if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""));
  }

  // Category
  const catEl = doc.querySelector('button[jsaction*="category"], .DkEaL');
  if (catEl) out.category = catEl.textContent.trim();

  // Action buttons (phone, address, website, hours)
  const buttons = doc.querySelectorAll('button[data-item-id], a[data-item-id]');
  buttons.forEach(btn => {
    const id = btn.getAttribute("data-item-id") || "";
    const aria = btn.getAttribute("aria-label") || "";
    const text = btn.textContent.trim();

    if (id.includes("phone") || id.startsWith("phone:tel:") || aria.toLowerCase().includes("phone")) {
      const m = (aria + " " + text).match(/\+?[\d][\d\s\-().]{7,}\d/);
      if (m) out.phone = m[0].trim();
    }
    if (id === "address" || aria.toLowerCase().includes("address")) {
      out.address = text || aria.replace(/^address[: ]/i, "").trim();
    }
    if (id === "authority" || aria.toLowerCase().includes("website")) {
      out.website = btn.getAttribute("href") || btn.getAttribute("data-url") || "";
    }
    if (id.startsWith("oh") || aria.toLowerCase().includes("hours")) {
      out.hours = text.split("\n")[0];
    }
  });

  // Phone fallback
  if (!out.phone) {
    const tel = doc.querySelector('a[href^="tel:"]');
    if (tel) out.phone = tel.getAttribute("href").replace(/^tel:/, "").trim();
  }

  // Email — mailto links
  const mailto = doc.querySelector('a[href^="mailto:"]');
  if (mailto) out.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();

  // Email — scan text
  if (!out.email) {
    const bodyText = doc.body ? doc.body.textContent : "";
    const emailMatches = bodyText.match(EMAIL_RE);
    if (emailMatches) {
      const clean = emailMatches.filter(e =>
        !/(example|test|noreply|no-reply|sentry|wixpress|googleusercontent)\./i.test(e) &&
        !/\.(png|jpg|gif|svg)$/i.test(e)
      );
      if (clean.length) out.email = clean[0].toLowerCase();
    }
  }

  // Social media — scan all href attributes in HTML
  const allLinks = Array.from(doc.querySelectorAll('a[href]'))
    .map(a => a.getAttribute("href") || "")
    .filter(href => href && !href.includes("google.com") && !href.includes("gstatic"));
  const linksText = allLinks.join("\n");

  for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
    const m = linksText.match(regex);
    if (m) {
      let matchUrl = m[0];
      if (!/^https?:\/\//i.test(matchUrl)) matchUrl = "https://" + matchUrl;
      out[platform] = matchUrl.split(/[\s"'<>]/)[0].replace(/[.,;)]+$/, "");
    }
  }

  // Domain from website
  if (out.website) {
    try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
  }

  // Coordinates from URL
  if (url) {
    const coordMatch = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (coordMatch) {
      out.latitude = parseFloat(coordMatch[1]);
      out.longitude = parseFloat(coordMatch[2]);
    }
  }

  return out;
}

// ============================================
// EXTRACT ALL — Process all unextracted snapshots
// ============================================
async function extractAll() {
  const { snapshots = [], leads = [], fields = {} } = await chrome.storage.local.get(["snapshots", "leads", "fields"]);

  const unextracted = snapshots.filter(s => !s.extracted);
  if (!unextracted.length) return { ok: true, extracted: 0, msg: "All snapshots already extracted" };

  await setProgress({ isRunning: true, title: "Extracting from cache...", currentPage: 0, totalPages: unextracted.length, totalFound: 0 });

  // Determine which fields user wants
  const ALL_POSSIBLE = [
    "title", "url", "phone", "address", "website", "domain",
    "category", "rating", "reviewCount", "hours", "email",
    "latitude", "longitude",
    "facebook", "instagram", "twitter", "linkedin", "youtube",
    "tiktok", "whatsapp", "pinterest"
  ];
  const hasFieldSelection = Object.keys(fields).length > 0;

  let extracted = 0;
  const existingUrls = new Set(leads.map(l => l.url));

  for (let i = 0; i < unextracted.length; i++) {
    const snap = unextracted[i];

    await setProgress({
      currentPage: i + 1,
      totalFound: extracted,
      currentItem: snap.name ? snap.name.slice(0, 35) : `Snapshot ${i + 1}`
    });

    // Parse HTML (OFFLINE — no network!)
    const data = extractFromHTML(snap.html, snap.url);

    if (!data.title) {
      // Mark as extracted (empty) so we don't retry
      snap.extracted = true;
      continue;
    }

    // Dedup
    if (existingUrls.has(data.url) || leads.some(l => l.title === data.title && l.address === data.address)) {
      snap.extracted = true;
      continue;
    }

    // Filter by user field selection
    const filtered = {};
    for (const f of ALL_POSSIBLE) {
      const userWants = hasFieldSelection ? !!fields[f] : true;
      if (!userWants) continue;
      if (data[f] !== undefined && data[f] !== null && data[f] !== "") {
        filtered[f] = data[f];
      }
    }
    // Always keep title + url for dedup
    if (data.title) filtered.title = data.title;
    if (data.url) filtered.url = data.url;
    filtered.scrapedAt = new Date().toISOString();

    leads.push(filtered);
    existingUrls.add(data.url);
    snap.extracted = true;
    extracted++;
  }

  // Save
  await chrome.storage.local.set({ snapshots, leads });

  // Update today count
  const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
  const today = new Date().toDateString();
  const newCount = (todayLeadDate === today) ? todayLeadCount + extracted : extracted;
  await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });

  await setProgress({ isRunning: false, title: "Extraction complete!", currentItem: `${extracted} new leads from ${unextracted.length} snapshots` });

  return { ok: true, extracted, totalLeads: leads.length };
}

// ============================================
// WEBSITE ENRICHMENT — Visit websites for email/socials
// ============================================
async function fetchPage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "Accept": "text/html" } });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html") && !ct.includes("xhtml")) return null;
    return await res.text();
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

function extractContactsFromWebsite(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const mailtos = Array.from(html.matchAll(/mailto:([^"'>\s?]+)/gi)).map(m => m[1]);

  const emails = Array.from(new Set(
    [...mailtos, ...(text.match(EMAIL_RE) || [])]
      .map(s => s.toLowerCase().trim())
      .filter(s => !/\.(png|jpg|gif|svg|webp)$/i.test(s) && !/(sentry|wixpress|googleusercontent|cloudflare|noreply|example)/i.test(s) && s.length < 100)
  ));

  const phonesRaw = [...Array.from(html.matchAll(/tel:([^"'>\s?]+)/gi)).map(m => m[1]), ...(text.match(PHONE_RE) || [])];
  const phones = Array.from(new Set(phonesRaw.map(p => p.trim()).filter(p => { const d = p.replace(/\D/g, ""); return d.length >= 8 && d.length <= 15; })));

  // Socials
  const socials = {};
  for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
    const m = html.match(regex);
    if (m) {
      let u = m[0];
      if (!/^https?:\/\//i.test(u)) u = "https://" + u;
      socials[platform] = u.replace(/["'<>\s].*$/, "").replace(/[.,;)]+$/, "");
    }
  }

  return { emails, phones, ...socials };
}

async function enrichLeads() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  const enrichable = leads.filter(l => l.website && !l.deepScrapedAt);
  if (!enrichable.length) return { ok: true, updated: 0 };

  await setProgress({ isRunning: true, title: "Enriching websites...", currentPage: 0, totalPages: enrichable.length, totalFound: 0 });

  let updated = 0;
  const SOCIAL_KEYS = ["facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok", "whatsapp", "pinterest"];
  const BATCH = 3;

  for (let i = 0; i < enrichable.length; i += BATCH) {
    const batch = enrichable.slice(i, i + BATCH);
    await Promise.all(batch.map(async (lead) => {
      await setProgress({ currentPage: i + 1, currentItem: `Visiting: ${lead.domain || lead.website}` });
      const html = await fetchPage(lead.website);
      if (!html) return;
      const contacts = extractContactsFromWebsite(html);
      if (contacts.emails && contacts.emails.length && !lead.email) lead.email = contacts.emails[0];
      if (contacts.phones && contacts.phones.length && !lead.phone) lead.phone = contacts.phones[0];
      for (const k of SOCIAL_KEYS) { if (contacts[k] && !lead[k]) lead[k] = contacts[k]; }
      lead.deepScrapedAt = new Date().toISOString();
      updated++;
    }));
    await chrome.storage.local.set({ leads });
    await new Promise(r => setTimeout(r, 300 + Math.random() * 500));
  }

  await setProgress({ isRunning: false, title: "Enrichment complete!", currentItem: `${updated} leads enriched` });
  return { ok: true, updated };
}

async function enrichSingleWebsite(url) {
  if (!url) return { ok: false };
  const html = await fetchPage(url);
  if (!html) return { ok: false };
  return { ok: true, contacts: extractContactsFromWebsite(html) };
}

// ============================================
// EXPORT
// ============================================
function csvEscape(v) {
  if (v == null) return "";
  const s = String(v).replace(/"/g, '""');
  return `"${s}"`;
}

function leadsToCsv(leads, fields) {
  const ALL_POSSIBLE = [
    "title", "phone", "email", "website", "address", "category",
    "rating", "reviewCount", "hours", "domain",
    "facebook", "instagram", "twitter", "linkedin", "youtube",
    "tiktok", "whatsapp", "pinterest",
    "latitude", "longitude", "url"
  ];
  const hasSelection = fields && Object.keys(fields).length > 0;
  const selected = hasSelection ? ALL_POSSIBLE.filter(f => !!fields[f]) : ALL_POSSIBLE;

  const keys = new Set();
  leads.forEach(l => Object.keys(l).forEach(k => keys.add(k)));
  const headers = selected.filter(k => keys.has(k));
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

// ============================================
// Progress helper
// ============================================
async function setProgress(patch) {
  const { progress = {} } = await chrome.storage.local.get(["progress"]);
  await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
}

// ============================================
// CAPTCHA notification
// ============================================
async function showCaptchaNotification(info) {
  try {
    await chrome.notifications.create("captcha-" + Date.now(), {
      type: "basic", iconUrl: "icons/icon128.png",
      title: "CAPTCHA Detected", message: "Taking a 30-min break. Resume after cooldown.", priority: 2
    });
  } catch (_) {}
}

// ============================================
// SNAPSHOT MANAGEMENT
// ============================================
async function getSnapshotStats() {
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  return {
    total: snapshots.length,
    extracted: snapshots.filter(s => s.extracted).length,
    unextracted: snapshots.filter(s => !s.extracted).length,
    names: snapshots.slice(-10).map(s => ({ name: s.name, extracted: s.extracted, capturedAt: s.capturedAt }))
  };
}

async function clearSnapshots() {
  await chrome.storage.local.set({ snapshots: [] });
  return { ok: true };
}

async function clearExtractedSnapshots() {
  const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
  const kept = snapshots.filter(s => !s.extracted);
  await chrome.storage.local.set({ snapshots: kept });
  return { ok: true, removed: snapshots.length - kept.length, remaining: kept.length };
}

// ============================================
// MESSAGE ROUTER
// ============================================
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "EXTRACT_ALL") {
        sendResponse(await extractAll());
      } else if (msg.type === "ENRICH_LEADS") {
        sendResponse(await enrichLeads());
      } else if (msg.type === "ENRICH_WEBSITE") {
        sendResponse(await enrichSingleWebsite(msg.url));
      } else if (msg.type === "EXPORT_CSV") {
        const { leads = [], fields = {} } = await chrome.storage.local.get(["leads", "fields"]);
        if (!leads.length) return sendResponse({ ok: false });
        const csv = leadsToCsv(leads, fields);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(csv, `maps-leads-${stamp}.csv`, "text/csv");
        sendResponse({ ok: true });
      } else if (msg.type === "EXPORT_JSON") {
        const { leads = [], fields = {} } = await chrome.storage.local.get(["leads", "fields"]);
        if (!leads.length) return sendResponse({ ok: false });
        // Filter by fields
        const ALL_POSSIBLE = ["title","phone","email","website","address","category","rating","reviewCount","hours","domain","facebook","instagram","twitter","linkedin","youtube","tiktok","whatsapp","pinterest","latitude","longitude","url"];
        const hasS = Object.keys(fields).length > 0;
        const sel = hasS ? ALL_POSSIBLE.filter(f => !!fields[f]) : ALL_POSSIBLE;
        if (!sel.includes("title")) sel.unshift("title");
        const filtered = leads.map(l => { const o = {}; for (const k of sel) { if (l[k] != null && l[k] !== "") o[k] = l[k]; } return o; });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await downloadText(JSON.stringify(filtered, null, 2), `maps-leads-${stamp}.json`, "application/json");
        sendResponse({ ok: true });
      } else if (msg.type === "GET_STATS") {
        const { leads = [], todayLeadCount = 0 } = await chrome.storage.local.get(["leads", "todayLeadCount"]);
        const snapStats = await getSnapshotStats();
        sendResponse({ ok: true, totalLeads: leads.length, todayLeads: todayLeadCount, snapshots: snapStats });
      } else if (msg.type === "CLEAR_LEADS") {
        await chrome.storage.local.set({ leads: [], todayLeadCount: 0 });
        sendResponse({ ok: true });
      } else if (msg.type === "CLEAR_SNAPSHOTS") {
        sendResponse(await clearSnapshots());
      } else if (msg.type === "CLEAR_EXTRACTED_SNAPSHOTS") {
        sendResponse(await clearExtractedSnapshots());
      } else if (msg.type === "CAPTCHA_DETECTED") {
        await showCaptchaNotification(msg.info);
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "unknown" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// ============================================
// INSTALL & ALARMS
// ============================================
chrome.runtime.onInstalled.addListener(async () => {
  const cur = await chrome.storage.local.get(["leads", "snapshots", "fields"]);
  if (!cur.leads) await chrome.storage.local.set({ leads: [] });
  if (!cur.snapshots) await chrome.storage.local.set({ snapshots: [] });
  if (!cur.fields) {
    await chrome.storage.local.set({
      fields: {
        title: true, phone: true, email: true, website: true,
        address: true, category: true, rating: true, reviewCount: true,
        facebook: true, instagram: true, linkedin: true,
        twitter: false, youtube: false, tiktok: false, whatsapp: false, pinterest: false,
        hours: false, domain: false, latitude: false, url: false
      }
    });
  }
  chrome.alarms.create("captcha-cooldown-check", { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "captcha-cooldown-check") {
    const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil <= Date.now()) {
      await chrome.storage.local.remove(["captchaDetected"]);
      try {
        await chrome.notifications.create("cooldown-ended", {
          type: "basic", iconUrl: "icons/icon128.png",
          title: "Cooldown ended", message: "You can resume capturing now.", priority: 1
        });
      } catch (_) {}
    }
  }
});
