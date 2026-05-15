// background.js — service worker
// Handles: CSV/JSON export, deep-scrape, email enrichment, lead quality scoring,
// multi-source data fusion, social media detection, reviews scraping, opening hours

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const SOCIAL_RE = {
  facebook: /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9._%-]+/gi,
  instagram: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._%-]+/gi,
  linkedin: /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[a-zA-Z0-9._%-]+/gi,
  twitter: /https?:\/\/(www\.)?(twitter|x)\.com\/[a-zA-Z0-9._%-]+/gi,
  youtube: /https?:\/\/(www\.)?youtube\.com\/(channel|c|@)[\/a-zA-Z0-9._%-]+/gi
};

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
                     "qualityScore", "category", "address", "rating", "totalReviews",
                     "socialLinks", "openingHours", "position", "query", "source",
                     "scrapedAt", "deepScrapedAt", "enrichedAt", "fusedAt", "socialDetectedAt",
                     "reviewsScrapedAt", "hoursScrapedAt"];
  const headers = preferred.filter(k => keys.has(k))
    .concat([...keys].filter(k => !preferred.includes(k)));

  const rows = [headers.map(csvEscape).join(",")];
  for (const l of leads) {
    rows.push(headers.map(h => {
      const v = l[h];
      if (Array.isArray(v)) return csvEscape(v.join("; "));
      if (v && typeof v === "object") return csvEscape(JSON.stringify(v));
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

// ===== FEATURE 8: Multi-Source Data Fusion =====
// Merges data from Google Maps, Google Search, and website enrichment
// If one source has phone but not email, another source fills it in
async function fuseMultiSourceData() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  let mergeCount = 0;
  const domainMap = {};

  // Group leads by domain for fusion
  for (let i = 0; i < leads.length; i++) {
    const domain = leads[i].domain || "";
    if (!domain) continue;
    if (!domainMap[domain]) domainMap[domain] = [];
    domainMap[domain].push(i);
  }

  // Fuse data for leads with same domain
  for (const [domain, indices] of Object.entries(domainMap)) {
    if (indices.length < 2) continue;

    // Collect all data across sources for this domain
    const allEmails = new Set();
    const allPhones = new Set();
    const allSocials = {};
    let bestTitle = "";
    let bestDescription = "";
    let bestAddress = "";
    let bestRating = null;
    let bestReviews = null;
    let bestHours = null;
    let bestCategory = "";

    for (const idx of indices) {
      const lead = leads[idx];
      (lead.emails || []).forEach(e => allEmails.add(e));
      (lead.phones || []).forEach(p => allPhones.add(p));
      if (lead.phone) allPhones.add(lead.phone);

      // Merge social links
      if (lead.socialLinks) {
        for (const [platform, url] of Object.entries(lead.socialLinks)) {
          if (url && !allSocials[platform]) allSocials[platform] = url;
        }
      }

      // Best title (longest usually most descriptive)
      if ((lead.title || "").length > bestTitle.length) bestTitle = lead.title;
      if ((lead.description || "").length > bestDescription.length) bestDescription = lead.description;
      if ((lead.address || "").length > bestAddress.length) bestAddress = lead.address;
      if (lead.rating && (!bestRating || lead.rating > bestRating)) bestRating = lead.rating;
      if (lead.reviews && lead.reviews.topReviews && lead.reviews.topReviews.length > 0) bestReviews = lead.reviews;
      if (lead.openingHours && Object.keys(lead.openingHours).length > 0) bestHours = lead.openingHours;
      if ((lead.category || "").length > bestCategory.length) bestCategory = lead.category;
    }

    // Apply fused data back to all leads with this domain
    for (const idx of indices) {
      const lead = leads[idx];
      const oldEmailCount = (lead.emails || []).length;
      const oldPhoneCount = (lead.phones || []).length;

      lead.emails = [...allEmails];
      lead.phones = [...allPhones];
      if (Object.keys(allSocials).length > 0) lead.socialLinks = { ...(lead.socialLinks || {}), ...allSocials };
      if (!lead.address && bestAddress) lead.address = bestAddress;
      if (!lead.rating && bestRating) lead.rating = bestRating;
      if (!lead.reviews && bestReviews) lead.reviews = bestReviews;
      if (!lead.openingHours && bestHours) lead.openingHours = bestHours;
      if (!lead.category && bestCategory) lead.category = bestCategory;

      lead.fusedAt = new Date().toISOString();
      lead.qualityScore = calculateLeadQuality(lead);

      if (lead.emails.length > oldEmailCount || lead.phones.length > oldPhoneCount) {
        mergeCount++;
      }
    }
  }

  await chrome.storage.local.set({ leads });
  await updateLivePreview();
  return { ok: true, merged: mergeCount, totalDomains: Object.keys(domainMap).length };
}

// ===== FEATURE 10: Social Media Detection =====
// Visit business websites to find Facebook, Instagram, LinkedIn URLs
function extractSocialLinksFromHtml(html) {
  const socials = {};
  for (const [platform, regex] of Object.entries(SOCIAL_RE)) {
    const matches = html.match(regex);
    if (matches && matches.length > 0) {
      const unique = [...new Set(matches.map(u => u.replace(/\/+$/, "")))];
      // Filter out generic/login pages
      const filtered = unique.filter(u =>
        !/(\/login|\/share|\/sharer|\/intent|\/dialog)/i.test(u)
      );
      if (filtered.length > 0) socials[platform] = filtered[0];
      else if (unique.length > 0) socials[platform] = unique[0];
    }
  }
  return socials;
}

async function detectSocialMedia() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  SmartDelay.reset();

  // Filter leads that have a website but no social links
  const needsSocial = leads.filter(l =>
    (l.url || l.website) && (!l.socialLinks || Object.keys(l.socialLinks).length === 0)
  );

  if (!needsSocial.length) {
    return { ok: true, updated: 0, message: "All leads already have social profiles detected" };
  }

  await setProgress({
    isRunning: true,
    title: "Detecting social media...",
    currentPage: 0,
    totalPages: needsSocial.length,
    totalFound: 0,
    currentItem: "Starting social media scan..."
  });

  let enriched = 0;
  let totalProfiles = 0;

  for (let i = 0; i < needsSocial.length; i++) {
    const lead = needsSocial[i];
    const leadIndex = leads.indexOf(lead);
    const targetUrl = lead.website || lead.url;

    await setProgress({
      currentPage: i + 1,
      currentItem: `Checking: ${lead.domain || targetUrl}`,
      delayInfo: SmartDelay.getState()
    });

    try {
      const html = await fetchPage(targetUrl);
      if (!html) continue;

      const socials = extractSocialLinksFromHtml(html);

      if (Object.keys(socials).length > 0) {
        lead.socialLinks = { ...(lead.socialLinks || {}), ...socials };
        lead.socialDetectedAt = new Date().toISOString();
        lead.qualityScore = calculateLeadQuality(lead);
        enriched++;
        totalProfiles += Object.keys(socials).length;
        leads[leadIndex] = lead;
      }
    } catch (e) {
      // Continue on error
    }

    await setProgress({ totalFound: totalProfiles });
    await chrome.storage.local.set({ leads });
    await updateLivePreview();

    // Smart delay
    const delay = SmartDelay.getDelay();
    await setProgress({
      currentItem: `Waiting ${(delay / 1000).toFixed(1)}s (anti-block)...`,
      delayInfo: SmartDelay.getState()
    });
    await new Promise(r => setTimeout(r, delay));
  }

  await setProgress({
    isRunning: false,
    currentItem: `Done. ${enriched} leads got social profiles (${totalProfiles} links).`
  });
  await updateLivePreview();

  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated: enriched, totalProfiles };
}

// ===== FEATURE 11: Reviews Scraping (from website) =====
// Extracts review-like content from business pages
function extractReviewsFromHtml(html) {
  const reviews = { topReviews: [] };

  // Look for schema.org review data
  const schemaMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (schemaMatches) {
    for (const match of schemaMatches) {
      try {
        const jsonText = match.replace(/<\/?script[^>]*>/gi, "");
        const data = JSON.parse(jsonText);
        if (data.aggregateRating) {
          reviews.averageRating = parseFloat(data.aggregateRating.ratingValue) || null;
          reviews.totalReviews = parseInt(data.aggregateRating.reviewCount || data.aggregateRating.ratingCount) || null;
        }
        if (data.review && Array.isArray(data.review)) {
          for (const r of data.review.slice(0, 5)) {
            reviews.topReviews.push({
              author: r.author?.name || r.author || "",
              text: (r.reviewBody || r.description || "").slice(0, 500),
              rating: r.reviewRating?.ratingValue ? parseFloat(r.reviewRating.ratingValue) : null,
              date: r.datePublished || ""
            });
          }
        }
      } catch (_) {}
    }
  }

  return reviews.topReviews.length > 0 || reviews.averageRating ? reviews : null;
}

async function scrapeReviews() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  SmartDelay.reset();

  const needsReviews = leads.filter(l =>
    (l.url || l.website) && (!l.reviews || !l.reviews.topReviews || l.reviews.topReviews.length === 0)
  );

  if (!needsReviews.length) {
    return { ok: true, updated: 0, message: "All leads already have reviews" };
  }

  await setProgress({
    isRunning: true,
    title: "Scraping reviews...",
    currentPage: 0,
    totalPages: needsReviews.length,
    totalFound: 0,
    currentItem: "Starting reviews scan..."
  });

  let enriched = 0;

  for (let i = 0; i < needsReviews.length; i++) {
    const lead = needsReviews[i];
    const leadIndex = leads.indexOf(lead);
    const targetUrl = lead.website || lead.url;

    await setProgress({
      currentPage: i + 1,
      currentItem: `Checking reviews: ${lead.domain || targetUrl}`
    });

    try {
      const html = await fetchPage(targetUrl);
      if (!html) continue;

      const reviews = extractReviewsFromHtml(html);
      if (reviews) {
        lead.reviews = reviews;
        lead.reviewsScrapedAt = new Date().toISOString();
        lead.qualityScore = calculateLeadQuality(lead);
        enriched++;
        leads[leadIndex] = lead;
      }
    } catch (e) {}

    await chrome.storage.local.set({ leads });

    const delay = SmartDelay.getDelay();
    await new Promise(r => setTimeout(r, delay));
  }

  await setProgress({ isRunning: false, currentItem: `Done. ${enriched} leads got reviews.` });
  await updateLivePreview();

  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated: enriched };
}

// ===== FEATURE 13: Opening Hours from Google Business Profile =====
// Attempts to find opening hours from structured data on business websites
function extractHoursFromHtml(html) {
  const hours = {};
  const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  // Try schema.org OpeningHoursSpecification
  const schemaMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (schemaMatches) {
    for (const match of schemaMatches) {
      try {
        const jsonText = match.replace(/<\/?script[^>]*>/gi, "");
        const data = JSON.parse(jsonText);
        const specs = data.openingHoursSpecification || data.openingHours;
        if (Array.isArray(specs)) {
          for (const spec of specs) {
            const days = Array.isArray(spec.dayOfWeek) ? spec.dayOfWeek : [spec.dayOfWeek];
            for (const day of days) {
              const dayName = typeof day === "string" ? day.replace("http://schema.org/", "").replace("https://schema.org/", "") : "";
              if (dayName && spec.opens && spec.closes) {
                hours[dayName] = `${spec.opens} - ${spec.closes}`;
              }
            }
          }
        } else if (typeof specs === "string") {
          // Format: "Mo-Fr 09:00-17:00"
          hours._raw = specs;
        }
      } catch (_) {}
    }
  }

  // Try parsing from visible text patterns
  if (Object.keys(hours).length === 0) {
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
    for (const day of daysOfWeek) {
      const re = new RegExp(day + "[:\\s]+([\\d:]+\\s*(?:AM|PM|am|pm)?\\s*[-–to]+\\s*[\\d:]+\\s*(?:AM|PM|am|pm)?)", "i");
      const m = text.match(re);
      if (m) hours[day] = m[1].trim();
    }
  }

  return Object.keys(hours).length > 0 ? hours : null;
}

async function scrapeOpeningHours() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  if (!leads.length) return { ok: false, error: "No leads saved" };

  SmartDelay.reset();

  const needsHours = leads.filter(l =>
    (l.url || l.website) && (!l.openingHours || Object.keys(l.openingHours).length === 0)
  );

  if (!needsHours.length) {
    return { ok: true, updated: 0, message: "All leads already have opening hours" };
  }

  await setProgress({
    isRunning: true,
    title: "Scraping opening hours...",
    currentPage: 0,
    totalPages: needsHours.length,
    totalFound: 0,
    currentItem: "Starting hours scan..."
  });

  let enriched = 0;

  for (let i = 0; i < needsHours.length; i++) {
    const lead = needsHours[i];
    const leadIndex = leads.indexOf(lead);
    const targetUrl = lead.website || lead.url;

    await setProgress({
      currentPage: i + 1,
      currentItem: `Checking hours: ${lead.domain || targetUrl}`
    });

    try {
      const html = await fetchPage(targetUrl);
      if (!html) continue;

      const hours = extractHoursFromHtml(html);
      if (hours) {
        lead.openingHours = hours;
        lead.hoursScrapedAt = new Date().toISOString();
        enriched++;
        leads[leadIndex] = lead;
      }
    } catch (e) {}

    await chrome.storage.local.set({ leads });

    const delay = SmartDelay.getDelay();
    await new Promise(r => setTimeout(r, delay));
  }

  await setProgress({ isRunning: false, currentItem: `Done. ${enriched} leads got hours.` });
  await updateLivePreview();

  setTimeout(async () => {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }, 4000);

  return { ok: true, updated: enriched };
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
      } else if (msg.type === "FUSE_DATA") {
        const r = await fuseMultiSourceData();
        sendResponse(r);
      } else if (msg.type === "DETECT_SOCIAL") {
        const r = await detectSocialMedia();
        sendResponse(r);
      } else if (msg.type === "SCRAPE_REVIEWS") {
        const r = await scrapeReviews();
        sendResponse(r);
      } else if (msg.type === "SCRAPE_HOURS") {
        const r = await scrapeOpeningHours();
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
