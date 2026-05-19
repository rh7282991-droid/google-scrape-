// ============================================
// Maps Lead Scraper Pro — content script
// Extracts business profiles from Google Maps
// ============================================

(function () {
  "use strict";

  // ===== Regex helpers =====
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

  // Social-media URL patterns. Mirror of background.js SOCIAL_PATTERNS. Content
  // scripts and service workers are separate JS contexts, so the regex source is
  // duplicated here. Keep these in sync with background.js's SOCIAL_PATTERNS.
  // YouTube alternation requires a literal `/` after `channel|user|c` so paths
  // like `youtube.com/cooking` do not match as a "c" channel. The `@` handle
  // keeps no trailing slash (it is followed directly by the username).
  const SOCIAL_PATTERNS = {
    facebook:  /^https?:\/\/(?:www\.|m\.|business\.)?facebook\.com\/[A-Za-z0-9_.\-/?=&%]+/i,
    instagram: /^https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.\-/?=&%]+/i,
    twitter:   /^https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[A-Za-z0-9_.\-/?=&%]+/i,
    linkedin:  /^https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/[A-Za-z0-9_.\-/?=&%]+/i,
    youtube:   /^https?:\/\/(?:www\.)?youtube\.com\/(?:(?:channel|user|c)\/|@)[A-Za-z0-9_.\-/?=&%]+/i,
    tiktok:    /^https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9_.\-/?=&%]+/i
  };

  function emptySocial() {
    return { facebook: [], instagram: [], twitter: [], linkedin: [], youtube: [], tiktok: [] };
  }

  function cleanSocialUrl(u) {
    if (!u) return u;
    let s = String(u).trim();
    // Strip trailing quote/bracket/paren/comma/semicolon/whitespace characters
    s = s.replace(/[",;'<>)\]\s]+$/g, "");
    s = s.replace(/\/+$/, "");
    return s;
  }

  function mergeSocialObjects(a, b) {
    const merged = emptySocial();
    for (const platform of Object.keys(merged)) {
      const seen = new Set();
      const out = [];
      const push = (arr) => {
        if (!arr) return;
        for (const raw of arr) {
          const u = cleanSocialUrl(raw);
          if (!u) continue;
          const key = u.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(u);
        }
      };
      push(a && a[platform]);
      push(b && b[platform]);
      merged[platform] = out;
    }
    return merged;
  }

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================
  // CAPTCHA Detection (Feature 4)
  // ============================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    const bodyText = (document.body && document.body.innerText || "").toLowerCase();
    const phrases = [
      "unusual traffic", "our systems have detected",
      "please show you're not a robot", "i'm not a robot",
      "verify you are human", "automated queries"
    ];
    for (const phrase of phrases) {
      if (bodyText.includes(phrase)) return { detected: true, type: "challenge-text", phrase };
    }
    if (
      document.querySelector("#captcha") ||
      document.querySelector(".g-recaptcha") ||
      document.querySelector('iframe[src*="recaptcha"]')
    ) {
      return { detected: true, type: "recaptcha-element" };
    }
    return { detected: false };
  }

  async function handleCaptcha(info) {
    const COOLDOWN_MS = 30 * 60 * 1000;
    const cooldownUntil = Date.now() + COOLDOWN_MS;
    await chrome.storage.local.set({
      autoScrape: false,
      captchaDetected: { detected: true, type: info.type, detectedAt: Date.now(), cooldownUntil, url: location.href }
    });
    await setProgress({
      isRunning: false,
      title: "Paused: CAPTCHA detected",
      currentItem: `Cooldown 30 min. Resume after ${new Date(cooldownUntil).toLocaleTimeString()}`
    });
    showToast("Suspicious activity detected. Pausing 30 min.", "#dc2626");
    try {
      await chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", info: { ...info, cooldownUntil, url: location.href } });
    } catch (_) {}
  }

  // ============================================
  // Toast
  // ============================================
  function showToast(message, color) {
    let toast = document.getElementById("__mls_toast__");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__mls_toast__";
      Object.assign(toast.style, {
        position: "fixed", bottom: "20px", right: "20px",
        background: "#2563eb", color: "#fff",
        padding: "12px 16px", borderRadius: "10px",
        font: "13px/1.4 system-ui, sans-serif",
        zIndex: 999999, boxShadow: "0 8px 24px rgba(0,0,0,0.2)",
        opacity: "0", transition: "opacity .25s ease",
        maxWidth: "320px", fontWeight: "500"
      });
      document.body.appendChild(toast);
    }
    toast.style.background = color || "#2563eb";
    toast.textContent = message;
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 4000);
  }

  // ============================================
  // Storage helpers
  // ============================================
  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    await chrome.storage.local.set({
      progress: { ...progress, ...patch, updatedAt: Date.now() }
    });
  }

  async function clearProgress() {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function randomDelay(base) {
    const variance = base * 0.4;
    return base + (Math.random() - 0.5) * variance;
  }

  // ============================================
  // Page detection
  // ============================================
  function isMapsPage() {
    return /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(location.href);
  }

  function isGoogleSearchPage() {
    return /^https?:\/\/(www\.)?google\.com\/search/.test(location.href);
  }

  // ============================================
  // GOOGLE MAPS SCRAPER (Main feature)
  // ============================================

  // Find the scrollable results sidebar
  function findResultsContainer() {
    // Modern Google Maps: scrollable feed with role="feed"
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;
    // Fallback: any aria-label that contains "Results"
    feed = document.querySelector('[aria-label*="Results for" i]');
    if (feed) return feed;
    // Older layout
    feed = document.querySelector('.section-scrollbox, .section-listbox');
    return feed || null;
  }

  // Extract place data from a single result card in the sidebar
  function extractCardData(card) {
    const out = {};

    // Name (the main link's aria-label OR heading)
    const link = card.querySelector('a[href*="/maps/place/"]');
    if (link) {
      out.url = link.href;
      out.title = link.getAttribute("aria-label") || "";
    }
    if (!out.title) {
      const heading = card.querySelector('div[role="heading"], .fontHeadlineSmall');
      if (heading) out.title = heading.textContent.trim();
    }

    // Rating + reviews count
    const ratingEl = card.querySelector('span[role="img"][aria-label*="star" i]');
    if (ratingEl) {
      const lbl = ratingEl.getAttribute("aria-label") || "";
      const m = lbl.match(/([\d.]+)\s*star/i);
      if (m) out.rating = parseFloat(m[1]);
      const m2 = lbl.match(/(\d[\d,]*)\s*review/i);
      if (m2) out.reviewCount = parseInt(m2[1].replace(/,/g, ""));
    }

    // Category, address, hours from text spans
    const allText = card.innerText || "";
    const lines = allText.split("\n").map(l => l.trim()).filter(Boolean);

    // Phone — search whole text
    const phoneMatch = allText.match(/\+?[\d][\d\s\-().]{7,}\d/);
    if (phoneMatch) out.phone = phoneMatch[0].trim();

    // Try to identify address (line that contains a digit + street-like pattern)
    for (const line of lines) {
      if (line === out.title) continue;
      if (/\d/.test(line) && /[a-zA-Z]/.test(line) && line.length > 8 && line.length < 120) {
        if (!out.address) {
          out.address = line;
          break;
        }
      }
    }

    // Category usually 2nd line after title
    const titleIdx = lines.indexOf(out.title);
    if (titleIdx >= 0 && lines[titleIdx + 1]) {
      const next = lines[titleIdx + 1];
      if (next.length < 50 && !/\d{3}/.test(next)) out.category = next;
    }

    // Website link (sometimes available)
    const websiteLink = card.querySelector('a[data-value="Website"], a[aria-label*="Website" i]');
    if (websiteLink) out.website = websiteLink.href;

    // Hours
    const hoursMatch = allText.match(/(open|closed|opens|closes)[^\n]*/i);
    if (hoursMatch) out.hours = hoursMatch[0].trim();

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  // Click into a place card to get the detail panel (more accurate phone/website/email)
  async function openPlaceDetail(card) {
    const link = card.querySelector('a[href*="/maps/place/"]');
    if (!link) return null;
    link.click();
    // Wait for detail panel to load
    await sleep(1200);
    return await extractDetailPanel();
  }

  async function extractDetailPanel() {
    const out = {};
    // Wait for panel to render
    let attempts = 0;
    while (attempts < 8) {
      const heading = document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"]');
      if (heading) break;
      await sleep(400);
      attempts++;
    }

    // Title
    const heading = document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');
    if (heading) out.title = heading.textContent.trim();

    // URL
    out.url = location.href;

    // Rating
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"], span.ceNzKf');
    if (ratingEl) {
      const r = parseFloat(ratingEl.textContent);
      if (r) out.rating = r;
    }

    // Review count
    const reviewEl = document.querySelector('button[jsaction*="reviewChart"] span, span.UY7F9');
    if (reviewEl) {
      const m = reviewEl.textContent.match(/(\d[\d,]*)/);
      if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""));
    }

    // Category
    const catEl = document.querySelector('button[jsaction*="category"], .DkEaL');
    if (catEl) out.category = catEl.textContent.trim();

    // Action buttons (modern selectors)
    const buttons = document.querySelectorAll('button[data-item-id], a[data-item-id]');
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
        out.website = btn.href || btn.getAttribute("data-url") || "";
      }
      if (id.startsWith("oh") || aria.toLowerCase().includes("hours")) {
        out.hours = text.split("\n")[0];
      }
      if (id === "plus_code") out.plusCode = text;
    });

    // Fallback: search for tel:/mailto: links anywhere
    if (!out.phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) out.phone = tel.href.replace(/^tel:/, "").trim();
    }
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) {
      out.email = mailto.href.replace(/^mailto:/, "").trim();
      // Seed out.allEmails with the mailto value so the dedup set in
      // runMapsCampaign (and downstream consumers) starts from a trusted
      // base. Without this, a later assignment would drop the mailto value
      // from allEmails even though it survives in out.email.
      if (out.email) out.allEmails = [out.email];
    }

    // Visible-text email regex scan as a last-resort signal. div[role="main"]
    // on a Maps detail page also contains user-submitted reviews and Q&A,
    // which can mention emails that don't belong to the business (review
    // false-positives, see v2 semantic review issue #1). To bound the
    // false-positive risk we only consume panel-text hits when there's
    // nothing better to fall back on: no mailto: anchor AND no website to
    // scrape via background.js. If a website is set, enrichLeadFromWebsite
    // will pull emails from the homepage / contact pages where the
    // attribution is reliable.
    if (!out.email && !out.website) {
      const emailHits = [];
      const panelForEmail = document.querySelector('div[role="main"]') || document.body;
      if (panelForEmail) {
        const panelText = panelForEmail.innerText || "";
        EMAIL_RE.lastIndex = 0;
        const matches = panelText.match(EMAIL_RE) || [];
        const seen = new Set();
        for (const raw of matches) {
          const e = String(raw).toLowerCase();
          if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e)) continue;
          if (seen.has(e)) continue;
          seen.add(e);
          emailHits.push(e);
        }
      }
      if (emailHits.length) {
        out.email = emailHits[0];
        out.allEmails = emailHits;
      }
    }

    // Domain
    if (out.website) {
      try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // Coordinates (from URL)
    const m = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (m) {
      out.latitude = parseFloat(m[1]);
      out.longitude = parseFloat(m[2]);
    }

    // Social media: scan all anchor tags within the detail panel for URLs
    // matching the SOCIAL_PATTERNS mirror at the top of this file.
    const social = emptySocial();
    const seenSocial = { facebook: new Set(), instagram: new Set(), twitter: new Set(), linkedin: new Set(), youtube: new Set(), tiktok: new Set() };
    const panel = document.querySelector('div[role="main"]') || document.body;
    if (panel) {
      const anchors = panel.querySelectorAll('a[href]');
      anchors.forEach(a => {
        const href = a.getAttribute("href") || a.href || "";
        if (!href || !/^https?:\/\//i.test(href)) return;
        for (const platform of Object.keys(SOCIAL_PATTERNS)) {
          if (SOCIAL_PATTERNS[platform].test(href)) {
            const u = cleanSocialUrl(href);
            if (!u) return;
            const key = u.toLowerCase();
            if (!seenSocial[platform].has(key)) {
              seenSocial[platform].add(key);
              social[platform].push(u);
            }
            return;
          }
        }
      });
    }
    out.social = social;

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  // Scroll the results feed
  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 25;
    const waitMs = (settings.profileWait || 2) * 250; // shorter for scroll

    let lastHeight = container.scrollHeight;
    let scrollCount = 0;
    let stuckCount = 0;

    while (scrollCount < maxScrolls && !SHOULD_STOP) {
      // Check CAPTCHA periodically
      if (scrollCount % 5 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) {
          await handleCaptcha(cap);
          return;
        }
      }

      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      await sleep(randomDelay(waitMs));
      scrollCount++;

      const newHeight = container.scrollHeight;
      const cards = container.querySelectorAll('a[href*="/maps/place/"]');

      await setProgress({
        isRunning: true,
        title: "Scrolling Maps results...",
        currentPage: scrollCount,
        totalPages: maxScrolls,
        currentItem: `Found ${cards.length} businesses so far`,
        totalFound: cards.length
      });

      // Check for "end of list" indicator
      const endText = container.innerText || "";
      if (endText.includes("You've reached the end") || endText.toLowerCase().includes("no more")) {
        showToast("Reached end of results");
        break;
      }

      if (newHeight === lastHeight) {
        stuckCount++;
        if (stuckCount >= 3) break; // No more results loading
      } else {
        stuckCount = 0;
      }
      lastHeight = newHeight;
    }
  }

  // Extract all visible cards from feed
  function getAllCards(container) {
    const links = container.querySelectorAll('a[href*="/maps/place/"]');
    const cards = [];
    const seen = new Set();
    links.forEach(link => {
      // Find the card wrapper (parent with clickable area)
      let card = link.closest('div[jsaction], div[role="article"]') || link.parentElement;
      if (card && !seen.has(link.href)) {
        seen.add(link.href);
        cards.push({ card, link });
      }
    });
    return cards;
  }

  // ============================================
  // Main Maps campaign runner
  // ============================================
  async function runMapsCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Campaign already running", "#f59e0b");
      return { ok: false, error: "already-running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    const settings = await chrome.storage.local.get([
      "targetLeads", "searchScroll", "profileWait",
      "deepEnrich", "fields", "savedKeywords", "savedLocations"
    ]);
    const target = settings.targetLeads || 100;

    showToast("Starting Maps scrape...", "#2563eb");

    // 1. Check CAPTCHA first
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    // 2. Find results sidebar (with retry/wait)
    let container = findResultsContainer();
    if (!container) {
      await setProgress({
        isRunning: true,
        title: "Waiting for Maps results...",
        currentItem: "Results feed not yet loaded, waiting up to 30s..."
      });
      container = await waitForMapsFeed(30000);
    }
    if (!container) {
      showToast("Maps results sidebar not found. Make sure search results are visible.", "#dc2626");
      await setProgress({ isRunning: false, title: "Failed", currentItem: "No results feed found" });
      setTimeout(clearProgress, 4000);
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({
      isRunning: true,
      title: "Loading Maps results...",
      currentPage: 0,
      totalPages: settings.searchScroll || 25,
      totalFound: 0,
      currentItem: "Scrolling sidebar..."
    });

    // 3. Scroll to load results
    await scrollResults(container, settings);

    if (SHOULD_STOP) {
      CAMPAIGN_RUNNING = false;
      await clearProgress();
      return { ok: true, stopped: true };
    }

    // 4. Get all cards
    const cards = getAllCards(container);
    showToast(`Found ${cards.length} businesses, extracting data...`, "#2563eb");

    let totalSaved = 0;
    const profileWaitMs = (settings.profileWait || 7) * 1000;

    // 5. For each card, click to open detail and extract
    //
    // Latency note: per-lead enrichment (ENRICH_LEAD message round trip) runs
    // sequentially inside this loop because the Maps SPA only renders one
    // detail panel at a time, so we click + wait + extract per lead. Each
    // ENRICH_LEAD call is bounded to ~25s (see enrichLeadFromWebsite in
    // background.js), and is gated on (fields.email || fields.socialMedia)
    // AND data.website, so a campaign with both options off skips it
    // entirely. Cross-lead concurrency would require restructuring this loop
    // and is intentionally deferred.
    for (let i = 0; i < cards.length && i < target; i++) {
      if (SHOULD_STOP) break;

      // CAPTCHA check every 10 profiles
      if (i % 10 === 0) {
        const c = detectCaptcha();
        if (c.detected) {
          await handleCaptcha(c);
          break;
        }
      }

      await setProgress({
        isRunning: true,
        title: "Opening profile " + (i + 1),
        currentPage: i + 1,
        totalPages: Math.min(cards.length, target),
        totalFound: totalSaved,
        currentItem: `Profile ${i + 1}/${cards.length}`
      });

      try {
        // Click the link
        cards[i].link.click();
        await sleep(randomDelay(profileWaitMs));

        // Extract from detail panel
        const data = await extractDetailPanel();
        if (data && data.title) {
          // Optional website enrichment for emails / social links.
          const fields = settings.fields || {};
          if ((fields.email || fields.socialMedia) && data.website) {
            try {
              const resp = await chrome.runtime.sendMessage({
                type: "ENRICH_LEAD",
                website: data.website
              });
              if (resp && typeof resp === "object") {
                const emails = Array.isArray(resp.emails) ? resp.emails : [];
                const social = resp.social || {};
                if (!data.email && emails.length) data.email = emails[0];
                // Merge panel-derived emails (from EMAIL_RE on detail panel)
                // with website-fetch emails, preserving order and deduping.
                const existing = Array.isArray(data.allEmails) ? data.allEmails : [];
                const seenE = new Set();
                const mergedEmails = [];
                for (const e of [...existing, ...emails]) {
                  const k = String(e).toLowerCase();
                  if (seenE.has(k)) continue;
                  seenE.add(k);
                  mergedEmails.push(e);
                }
                data.allEmails = mergedEmails;
                data.social = mergeSocialObjects(data.social || {}, social);
                for (const platform of Object.keys(emptySocial())) {
                  const list = data.social[platform];
                  if (list && list.length && !data[platform]) {
                    data[platform] = list[0];
                  }
                }
              }
            } catch (e) {
              // Website fetch failure must not block the lead from saving.
              console.warn("[MLS] ENRICH_LEAD failed:", e);
            }
          } else if (data.social) {
            // No background enrichment: still surface flat per-platform fields
            // from whatever the panel DOM scan found.
            for (const platform of Object.keys(emptySocial())) {
              const list = data.social[platform];
              if (list && list.length && !data[platform]) {
                data[platform] = list[0];
              }
            }
          }
          const added = await saveLead(data);
          if (added) totalSaved++;
        }
      } catch (e) {
        console.warn("[Maps] Failed to extract profile:", e);
      }
    }

    await setProgress({
      isRunning: false,
      title: "Campaign complete",
      currentItem: `Saved ${totalSaved} new leads`
    });
    setTimeout(clearProgress, 4000);

    showToast(`\u2713 Done! Saved ${totalSaved} new leads.`, "#22c55e");
    CAMPAIGN_RUNNING = false;
    return { ok: true, saved: totalSaved };
  }

  // ============================================
  // Save lead to storage (with dedup)
  // ============================================
  async function saveLead(data) {
    const { leads = [], fields = {} } = await chrome.storage.local.get(["leads", "fields"]);

    // Dedup by URL or title+address
    const key = data.url || (data.title + "|" + (data.address || ""));
    const exists = leads.some(l =>
      (l.url && l.url === data.url) ||
      (l.title === data.title && l.address === data.address)
    );
    if (exists) return false;

    // Apply field filter
    const filtered = { scrapedAt: data.scrapedAt };
    const allowed = ["title", "url", "phone", "allPhones", "address", "website", "domain",
      "category", "rating", "reviewCount", "hours", "email", "allEmails",
      "social", "facebook", "instagram", "twitter", "linkedin", "youtube", "tiktok",
      "latitude", "longitude", "plusCode"];
    for (const f of allowed) {
      if (data[f] !== undefined) filtered[f] = data[f];
    }
    // Always keep url internally for dedup
    filtered.url = data.url;

    leads.push(filtered);
    await chrome.storage.local.set({ leads });

    // Update today count
    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });

    return true;
  }

  // ============================================
  // Multi-keyword/location campaign
  // ============================================
  async function runMultiCampaign() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const keywords = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
    const locations = savedLocations.split("\n").map(s => s.trim()).filter(Boolean);

    if (!keywords.length) {
      showToast("No keywords set. Enter keywords in the popup.", "#dc2626");
      return { ok: false, error: "no-keywords" };
    }

    // If currently on Maps with results — just scrape this one
    if (isMapsPage() && findResultsContainer()) {
      return await runMapsCampaign();
    }

    // Otherwise, build first search URL and navigate
    const query = keywords[0] + (locations.length ? " " + locations[0] : "");
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    location.href = searchUrl;
    return { ok: true, navigating: true };
  }

  // ============================================
  // Message handler
  // ============================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "SCRAPE_NOW") {
          if (isMapsPage()) {
            const r = await runMapsCampaign();
            sendResponse(r);
          } else {
            sendResponse({ ok: false, error: "Open Google Maps first" });
          }
        } else if (msg.type === "STOP_SCRAPE") {
          SHOULD_STOP = true;
          showToast("Stopping after current item...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "RUN_MULTI_CAMPAIGN") {
          const r = await runMultiCampaign();
          sendResponse(r);
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : (isGoogleSearchPage() ? "search" : "other") });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });

  // ============================================
  // Wait for Google Maps results feed to be ready
  // (Maps is an SPA — feed loads asynchronously)
  // ============================================
  async function waitForMapsFeed(maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (SHOULD_STOP) return null;

      // 1. Captcha check during wait
      const cap = detectCaptcha();
      if (cap.detected) {
        await handleCaptcha(cap);
        return null;
      }

      // 2. Try to find feed
      const feed = findResultsContainer();
      if (feed) {
        // Make sure at least 1 result link is rendered before proceeding
        const links = feed.querySelectorAll('a[href*="/maps/place/"]');
        if (links.length > 0) {
          // Give it 1 more second so more cards render
          await sleep(1000);
          return feed;
        }
      }

      // 3. Detect "no results" state — bail early
      const bodyText = (document.body && document.body.innerText || "").toLowerCase();
      if (
        bodyText.includes("google maps can't find") ||
        bodyText.includes("no results found") ||
        bodyText.includes("did you mean")
      ) {
        return null;
      }

      await sleep(500);
    }
    return null;
  }

  // ============================================
  // Auto-start orchestrator (handles SPA + retries)
  // ============================================
  let AUTO_START_IN_PROGRESS = false;
  let LAST_AUTO_URL = "";

  async function tryAutoStart(reason) {
    if (AUTO_START_IN_PROGRESS) return;
    if (CAMPAIGN_RUNNING) return;
    if (!isMapsPage()) return;

    // Check autoScrape flag fresh every time
    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);
    if (!autoScrape) return;

    // Honor cooldown
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
      await setProgress({ isRunning: false, title: "Cooldown", currentItem: `${minsLeft} min remaining` });
      return;
    }

    // Only auto-start on search/results URLs (not on /place/ direct links unless feed exists)
    const isSearchUrl = /\/maps\/search\//.test(location.href) || /\/maps\/?\?q=/.test(location.href);
    const hasFeedAlready = !!findResultsContainer();
    if (!isSearchUrl && !hasFeedAlready) return;

    AUTO_START_IN_PROGRESS = true;
    LAST_AUTO_URL = location.href;
    console.log("[MLS] Auto-start triggered:", reason);

    try {
      await setProgress({
        isRunning: true,
        title: "Waiting for Maps results to load...",
        currentItem: "Detecting results feed..."
      });
      showToast("Auto-scrape: waiting for results...", "#2563eb");

      // Wait up to 30s for feed
      const feed = await waitForMapsFeed(30000);
      if (!feed) {
        showToast("Could not find Maps results feed. Try reloading.", "#dc2626");
        await setProgress({ isRunning: false, title: "Failed", currentItem: "No results feed found" });
        setTimeout(clearProgress, 4000);
        AUTO_START_IN_PROGRESS = false;
        return;
      }

      // Feed found — start the actual campaign
      await runMapsCampaign();
    } catch (e) {
      console.error("[MLS] Auto-start failed:", e);
      showToast("Auto-scrape error: " + (e?.message || e), "#dc2626");
    } finally {
      AUTO_START_IN_PROGRESS = false;
    }
  }

  // ============================================
  // SPA navigation listener — Maps changes URL without reload
  // ============================================
  function watchSpaNavigation() {
    let lastUrl = location.href;

    const checkUrlChange = () => {
      if (location.href !== lastUrl) {
        const oldUrl = lastUrl;
        lastUrl = location.href;
        console.log("[MLS] URL changed:", oldUrl, "->", lastUrl);
        // New search? Re-trigger auto-scrape
        if (!CAMPAIGN_RUNNING && !AUTO_START_IN_PROGRESS) {
          // Small debounce so URL settles
          setTimeout(() => tryAutoStart("spa-nav"), 1500);
        }
      }
    };

    // 1. Patch history API
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function () {
      origPush.apply(this, arguments);
      setTimeout(checkUrlChange, 50);
    };
    history.replaceState = function () {
      origReplace.apply(this, arguments);
      setTimeout(checkUrlChange, 50);
    };

    // 2. Listen for back/forward
    window.addEventListener("popstate", () => setTimeout(checkUrlChange, 50));

    // 3. Polling fallback (Maps sometimes changes URL via internal mechanisms)
    setInterval(checkUrlChange, 1500);
  }

  // ============================================
  // Auto-start on Maps if autoScrape is on
  // ============================================
  (async () => {
    // Always check CAPTCHA on load
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      return;
    }

    // Start watching SPA navigation immediately on every page load
    if (isMapsPage()) {
      watchSpaNavigation();
    }

    // Initial auto-start attempt (with a small delay so DOM settles)
    setTimeout(() => tryAutoStart("initial-load"), 800);
  })();

  // Also re-check when storage changes (popup may toggle autoScrape mid-session)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.autoScrape && changes.autoScrape.newValue === true) {
      // Auto-scrape just got enabled — try to start
      setTimeout(() => tryAutoStart("storage-toggle"), 500);
    }
  });

})();
