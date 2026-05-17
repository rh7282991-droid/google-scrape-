// ============================================
// Maps Lead Scraper Pro — content script v4.1
// Extracts business profiles from Google Maps
// + Social media + auto email enrichment
// ============================================

(function () {
  "use strict";

  // ===== Regex helpers =====
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

  // Social media URL patterns
  const SOCIAL_PATTERNS = {
    facebook:  /(?:https?:\/\/)?(?:www\.|m\.|web\.)?facebook\.com\/(?!sharer|share|tr|plugins|dialog)([A-Za-z0-9._\-/?=&%]+)/i,
    instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?!p\/|reel\/|stories\/|explore\/)([A-Za-z0-9._\-]+)/i,
    twitter:   /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:twitter|x)\.com\/(?!share|intent|home|search)([A-Za-z0-9_]+)/i,
    linkedin:  /(?:https?:\/\/)?(?:www\.|[a-z]{2}\.)?linkedin\.com\/(?:company|in|school|pub)\/([A-Za-z0-9._\-]+)/i,
    youtube:   /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(?:c\/|channel\/|user\/|@)([A-Za-z0-9._\-]+)/i,
    tiktok:    /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9._\-]+)/i,
    whatsapp:  /(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com\/send|chat\.whatsapp\.com)[^\s"'<>]*/i,
    pinterest: /(?:https?:\/\/)?(?:www\.)?pinterest\.[a-z.]+\/([A-Za-z0-9._\-]+)/i
  };

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================
  // CAPTCHA Detection
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
      await chrome.runtime.sendMessage({ type: "ACCOUNT_FLAGGED", reason: "captcha" });
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
  // Social media extraction from text/HTML
  // ============================================
  function extractSocialFromText(text) {
    const out = {};
    for (const [platform, regex] of Object.entries(SOCIAL_PATTERNS)) {
      const m = text.match(regex);
      if (m) {
        let url = m[0];
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        out[platform] = url.split(/[\s"'<>]/)[0];
      }
    }
    return out;
  }

  // ============================================
  // GOOGLE MAPS SCRAPER
  // ============================================

  function findResultsContainer() {
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;
    feed = document.querySelector('[aria-label*="Results for" i]');
    if (feed) return feed;
    feed = document.querySelector('.section-scrollbox, .section-listbox');
    return feed || null;
  }

  async function extractDetailPanel() {
    const out = {};
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

    // Action buttons
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

    // Phone fallback
    if (!out.phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) out.phone = tel.href.replace(/^tel:/, "").trim();
    }

    // ===== EMAIL EXTRACTION =====
    // 1. mailto: links
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) out.email = mailto.href.replace(/^mailto:/, "").split("?")[0].trim();

    // 2. Search panel text for emails
    if (!out.email) {
      const panelText = document.body.innerText || "";
      const emailMatches = panelText.match(EMAIL_RE);
      if (emailMatches && emailMatches.length) {
        // Filter junk emails
        const clean = emailMatches.filter(e =>
          !/(example|test|noreply|no-reply|sentry|wixpress|googleusercontent)\./i.test(e) &&
          !/\.(png|jpg|gif|svg)$/i.test(e)
        );
        if (clean.length) out.email = clean[0].toLowerCase();
      }
    }

    // ===== SOCIAL MEDIA EXTRACTION =====
    // Look at all <a> hrefs in the side panel
    const allLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => href && !href.includes("google.com") && !href.includes("gstatic"));
    const linksText = allLinks.join("\n");
    const socials = extractSocialFromText(linksText);
    Object.assign(out, socials);

    // Domain
    if (out.website) {
      try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // Coordinates
    const m = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (m) {
      out.latitude = parseFloat(m[1]);
      out.longitude = parseFloat(m[2]);
    }

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 25;
    const waitMs = (settings.profileWait || 2) * 250;

    let lastHeight = container.scrollHeight;
    let scrollCount = 0;
    let stuckCount = 0;

    while (scrollCount < maxScrolls && !SHOULD_STOP) {
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

      const endText = container.innerText || "";
      if (endText.includes("You've reached the end") || endText.toLowerCase().includes("no more")) {
        showToast("Reached end of results");
        break;
      }

      if (newHeight === lastHeight) {
        stuckCount++;
        if (stuckCount >= 3) break;
      } else {
        stuckCount = 0;
      }
      lastHeight = newHeight;
    }
  }

  function getAllCards(container) {
    const links = container.querySelectorAll('a[href*="/maps/place/"]');
    const cards = [];
    const seen = new Set();
    links.forEach(link => {
      let card = link.closest('div[jsaction], div[role="article"]') || link.parentElement;
      if (card && !seen.has(link.href)) {
        seen.add(link.href);
        cards.push({ card, link });
      }
    });
    return cards;
  }

  // ============================================
  // Auto-enrich website during campaign
  // (calls background to fetch website HTML)
  // ============================================
  async function enrichLeadFromWebsite(lead) {
    if (!lead.website) return lead;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "ENRICH_WEBSITE",
        url: lead.website
      });
      if (res && res.ok && res.contacts) {
        const c = res.contacts;
        if (c.emails && c.emails.length && !lead.email) lead.email = c.emails[0];
        if (c.phones && c.phones.length && !lead.phone) lead.phone = c.phones[0];
        if (c.allEmails) lead.allEmails = c.allEmails;
        // Merge socials
        const SOCIAL_KEYS = ["facebook","instagram","twitter","linkedin","youtube","tiktok","whatsapp","pinterest"];
        for (const k of SOCIAL_KEYS) {
          if (c[k] && !lead[k]) lead[k] = c[k];
        }
      }
    } catch (_) {}
    return lead;
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
      "deepEnrich", "autoEnrichWebsite", "fields", "savedKeywords", "savedLocations"
    ]);
    const target = settings.targetLeads || 100;
    const autoEnrich = settings.autoEnrichWebsite !== false; // ON by default

    showToast("Starting Maps scrape...", "#2563eb");

    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    const container = findResultsContainer();
    if (!container) {
      showToast("Maps results sidebar not found. Make sure search results are visible.", "#dc2626");
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

    await scrollResults(container, settings);

    if (SHOULD_STOP) {
      CAMPAIGN_RUNNING = false;
      await clearProgress();
      return { ok: true, stopped: true };
    }

    const cards = getAllCards(container);
    showToast(`Found ${cards.length} businesses, extracting data...`, "#2563eb");

    let totalSaved = 0;
    const profileWaitMs = (settings.profileWait || 7) * 1000;

    for (let i = 0; i < cards.length && i < target; i++) {
      if (SHOULD_STOP) break;

      if (i % 10 === 0) {
        const c = detectCaptcha();
        if (c.detected) {
          await handleCaptcha(c);
          break;
        }
      }

      await setProgress({
        isRunning: true,
        title: "Extracting profile " + (i + 1),
        currentPage: i + 1,
        totalPages: Math.min(cards.length, target),
        totalFound: totalSaved,
        currentItem: `Profile ${i + 1}/${cards.length}`
      });

      try {
        cards[i].link.click();
        await sleep(randomDelay(profileWaitMs));

        let data = await extractDetailPanel();
        if (data && data.title) {
          // Auto-enrich from website (for email + socials)
          if (autoEnrich && data.website && (!data.email || !data.facebook)) {
            await setProgress({ currentItem: `Enriching: ${data.domain || data.website}` });
            data = await enrichLeadFromWebsite(data);
          }

          const added = await saveLead(data);
          if (added) totalSaved++;
        }
      } catch (e) {
        console.warn("[Maps] Failed to extract profile:", e);
      }

      try {
        await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 });
      } catch (_) {}
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

    const exists = leads.some(l =>
      (l.url && l.url === data.url) ||
      (l.title === data.title && l.address === data.address && l.title)
    );
    if (exists) return false;

    // All possible fields (must match popup.js ALL_FIELDS)
    const ALL_POSSIBLE = [
      "title", "url", "phone", "address", "website", "domain",
      "category", "rating", "reviewCount", "hours", "email",
      "latitude", "longitude", "plusCode",
      "facebook", "instagram", "twitter", "linkedin", "youtube",
      "tiktok", "whatsapp", "pinterest"
    ];

    // Fallback: if no fields config exists, allow common ones
    const hasUserSelection = Object.keys(fields).length > 0;
    const filtered = {};

    for (const f of ALL_POSSIBLE) {
      // Only save if user has selected this field (or no selection set yet)
      const userWants = hasUserSelection ? !!fields[f] : true;
      if (!userWants) continue;
      if (data[f] !== undefined && data[f] !== null && data[f] !== "") {
        filtered[f] = data[f];
      }
    }

    // Always save title (required for dedup) + url (required for dedup)
    if (data.title) filtered.title = data.title;
    if (data.url) filtered.url = data.url;

    // Internal-only metadata (not user-facing field)
    filtered.scrapedAt = new Date().toISOString();
    if (data.deepScrapedAt) filtered.deepScrapedAt = data.deepScrapedAt;

    leads.push(filtered);
    await chrome.storage.local.set({ leads });

    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });

    return true;
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
  // Auto-start on Maps if autoScrape is on
  // ============================================
  (async () => {
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      return;
    }

    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);

    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
      await setProgress({ isRunning: false, title: "Cooldown", currentItem: `${minsLeft} min remaining` });
      return;
    }

    if (autoScrape && isMapsPage()) {
      setTimeout(async () => {
        await runMapsCampaign();
      }, 2000);
    }
  })();

})();
