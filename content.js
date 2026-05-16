// =====================================================================
// Maps Lead Scraper Pro — content script (v4.1 — Working Fix)
// =====================================================================
// v4.1 fixes:
//  - CSS.escape() was breaking slug lookup (slugs have %20, +, etc.)
//  - URL slug comparison was too strict (Maps normalizes URLs differently)
//  - Now uses aria-label name matching as primary readiness signal
//  - Better feed container detection (multiple fallbacks)
//  - Supports all Google country TLDs (google.co.bd, google.co.in, etc.)
//  - Scroll end detection works in any language (checks scrollHeight)
//  - Longer waits for detail panel to fully render action buttons
//  - Back button navigation to return to results list after each profile
// =====================================================================

(function () {
  "use strict";

  const DEBUG = (() => {
    try { return localStorage.getItem("MLS_DEBUG") === "1"; } catch (_) { return false; }
  })();
  const log = (...a) => { if (DEBUG) console.log("[MLS]", ...a); };
  const warn = (...a) => console.warn("[MLS]", ...a);

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================================
  // CAPTCHA Detection
  // ============================================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    const bodyText = ((document.body && document.body.innerText) || "").toLowerCase();
    const phrases = [
      "unusual traffic", "our systems have detected",
      "please show you're not a robot", "i'm not a robot",
      "verify you are human", "automated queries"
    ];
    for (const p of phrases) {
      if (bodyText.includes(p)) return { detected: true, type: "challenge-text", phrase: p };
    }
    if (
      document.querySelector("#captcha") ||
      document.querySelector(".g-recaptcha") ||
      document.querySelector('iframe[src*="recaptcha"]')
    ) return { detected: true, type: "recaptcha-element" };
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

  // ============================================================
  // Toast
  // ============================================================
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

  // ============================================================
  // Helpers
  // ============================================================
  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
  }
  async function clearProgress() {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function jitter(base) { return Math.round(base + (Math.random() - 0.5) * base * 0.4); }

  // Support ALL Google TLDs (google.com, google.co.bd, google.co.in, etc.)
  function isMapsPage() {
    return /^https?:\/\/(www\.)?google\.[a-z.]+\/maps/i.test(location.href) ||
           /^https?:\/\/maps\.google\.[a-z.]+/i.test(location.href);
  }

  // ============================================================
  // Find the scrollable results container (multiple strategies)
  // ============================================================
  function findResultsContainer() {
    // Strategy 1: role="feed" (most common)
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;

    // Strategy 2: aria-label contains "Results" (language-independent partial)
    const allDivs = document.querySelectorAll('div[aria-label]');
    for (const d of allDivs) {
      const label = d.getAttribute("aria-label") || "";
      if (/result/i.test(label) && d.scrollHeight > 400) return d;
    }

    // Strategy 3: The scrollable panel that contains place links
    const links = document.querySelectorAll('a[href*="/maps/place/"]');
    if (links.length > 0) {
      // Walk up from the first link to find the scrollable container
      let el = links[0].parentElement;
      for (let i = 0; i < 10 && el; i++) {
        if (el.scrollHeight > el.clientHeight + 100 && el.clientHeight > 200) {
          return el;
        }
        el = el.parentElement;
      }
    }

    // Strategy 4: Legacy selectors
    feed = document.querySelector('.section-scrollbox, .section-listbox, .m6QErb[aria-label]');
    return feed || null;
  }

  // ============================================================
  // Scroll the results feed
  // ============================================================
  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 25;
    const waitMs = (settings.profileWait || 2) * 300;
    let lastHeight = container.scrollHeight;
    let lastCardCount = 0;
    let stuck = 0;

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      if (i % 5 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) { await handleCaptcha(cap); return; }
      }

      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      await sleep(jitter(waitMs));

      const cards = container.querySelectorAll('a[href*="/maps/place/"]');
      const cardCount = cards.length;

      await setProgress({
        isRunning: true,
        title: "Loading Maps results...",
        currentPage: i + 1,
        totalPages: maxScrolls,
        totalFound: cardCount,
        currentItem: `Found ${cardCount} businesses`
      });

      // End detection: check if scroll height stopped growing AND card count stopped
      const newHeight = container.scrollHeight;
      if (newHeight === lastHeight && cardCount === lastCardCount) {
        stuck++;
        if (stuck >= 4) {
          log("scroll stuck, stopping");
          break;
        }
      } else {
        stuck = 0;
      }
      lastHeight = newHeight;
      lastCardCount = cardCount;

      // Also check for the "end of list" bottom element (a <span> or <p> at bottom)
      const bottomEl = container.querySelector('.HlvSq, .m6QErb + div, .lXJj5c');
      if (bottomEl && bottomEl.offsetHeight > 0) {
        log("end-of-list element visible");
        break;
      }
    }
  }

  // ============================================================
  // Collect all place cards from the feed
  // Returns: array of { href, slug, name, element }
  // ============================================================
  function collectPlaceCards(container) {
    const results = [];
    const seen = new Set();
    const links = container.querySelectorAll('a[href*="/maps/place/"]');

    links.forEach(a => {
      const href = a.href;
      if (!href || seen.has(href)) return;
      seen.add(href);

      const name = (a.getAttribute("aria-label") || "").trim();
      const slugMatch = href.match(/\/maps\/place\/([^/]+)/);
      const slug = slugMatch ? decodeURIComponent(slugMatch[1]).replace(/\+/g, " ") : "";

      results.push({ href, slug, name, element: a });
    });

    return results;
  }

  // ============================================================
  // Click a place card and wait for its detail panel to load.
  // Uses the EXPECTED NAME as the readiness signal (not URL slug).
  // This is more reliable because Maps sometimes doesn't update
  // the URL immediately, but always updates the visible h1.
  // ============================================================
  async function openPlaceAndWait(place, profileWaitMs) {
    const expectedName = place.name;

    // Re-find the anchor freshly (DOM may have recycled)
    let anchor = document.querySelector(`a[href*="/maps/place/"][aria-label="${CSS.escape(expectedName)}"]`);
    if (!anchor) {
      // Fallback: find by href substring
      const allAnchors = document.querySelectorAll('a[href*="/maps/place/"]');
      for (const a of allAnchors) {
        if (a.href === place.href || (a.getAttribute("aria-label") || "").trim() === expectedName) {
          anchor = a;
          break;
        }
      }
    }

    if (!anchor) {
      warn("Could not find anchor for", expectedName);
      return false;
    }

    // Scroll into view and click
    try { anchor.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    await sleep(200);
    anchor.click();

    // Wait for the detail panel h1 to show the expected business name
    const deadline = Date.now() + Math.max(10000, profileWaitMs * 2);
    let panelReady = false;

    while (Date.now() < deadline) {
      await sleep(300);

      // Find h1 in the detail panel
      const h1 = document.querySelector('h1.DUwDvf') ||
                 document.querySelector('div[role="main"] h1') ||
                 document.querySelector('h1.fontHeadlineLarge');

      if (!h1) continue;

      const visibleTitle = h1.textContent.trim();
      if (!visibleTitle) continue;

      // Check if this h1 matches what we expect
      // Use includes() because Maps sometimes adds extra text
      if (visibleTitle === expectedName ||
          expectedName.includes(visibleTitle) ||
          visibleTitle.includes(expectedName) ||
          normalizeText(visibleTitle) === normalizeText(expectedName)) {
        panelReady = true;
        break;
      }

      // Also accept if the URL now contains the place slug
      if (place.slug && location.href.includes(encodeURIComponent(place.slug).replace(/%20/g, "+"))) {
        panelReady = true;
        break;
      }
    }

    if (!panelReady) {
      // Last resort: if ANY h1 appeared and has content, accept it
      // (handles cases where name encoding differs)
      const h1 = document.querySelector('h1.DUwDvf') || document.querySelector('div[role="main"] h1');
      if (h1 && h1.textContent.trim().length > 1) {
        log("accepting panel with different title:", h1.textContent.trim(), "expected:", expectedName);
        panelReady = true;
      }
    }

    if (!panelReady) {
      warn("panel never loaded for:", expectedName);
      return false;
    }

    // Extra wait for action buttons (phone, address, website) to render
    // These load AFTER the h1 appears
    await sleep(jitter(1200));

    // Verify action buttons appeared
    let btnWait = 0;
    while (btnWait < 3000) {
      const btns = document.querySelectorAll('[data-item-id]');
      if (btns.length >= 1) break;
      await sleep(300);
      btnWait += 300;
    }

    return true;
  }

  function normalizeText(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9\u0980-\u09FF\u0600-\u06FF]/g, "");
  }

  // ============================================================
  // Extract data from the currently visible detail panel
  // ============================================================
  function extractDetailPanel() {
    const lead = {
      title: "",
      url: location.href,
      phone: "",
      website: "",
      email: "",
      address: "",
      category: "",
      rating: null,
      reviewCount: null,
      hours: "",
      plusCode: "",
      latitude: null,
      longitude: null,
      domain: "",
      facebook: "",
      instagram: "",
      twitter: "",
      youtube: "",
      linkedin: "",
      scrapedAt: new Date().toISOString()
    };

    // Scope to the active detail panel
    const root = document.querySelector('div[role="main"]') || document;

    // ---- Title
    const h1 = root.querySelector("h1.DUwDvf") || root.querySelector("h1");
    if (h1) lead.title = h1.textContent.trim();

    // ---- Rating + review count
    const fnice = root.querySelector("div.F7nice");
    if (fnice) {
      const ratingSpan = fnice.querySelector('span[aria-hidden="true"]');
      if (ratingSpan) {
        const r = parseFloat(ratingSpan.textContent.replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) lead.rating = r;
      }
      // Review count - multiple patterns
      const reviewEl = fnice.querySelector('span[aria-label*="review" i]') ||
                       fnice.querySelector('span[aria-label*="Rating" i]');
      if (reviewEl) {
        const m = (reviewEl.getAttribute("aria-label") || "").match(/([\d,.\s]+)/);
        if (m) lead.reviewCount = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
      }
      if (!lead.reviewCount) {
        // Try getting from parenthesized text like "(13,556)"
        const allText = fnice.textContent;
        const rm = allText.match(/\(([\d,.\s]+)\)/);
        if (rm) lead.reviewCount = parseInt(rm[1].replace(/[,.\s]/g, ""), 10);
      }
    }

    // Fallback rating
    if (lead.rating == null) {
      const starEl = root.querySelector('span[role="img"][aria-label*="star" i]');
      if (starEl) {
        const m = (starEl.getAttribute("aria-label") || "").match(/([\d.]+)/);
        if (m) lead.rating = parseFloat(m[1]);
      }
    }

    // ---- Category
    const catBtn = root.querySelector('button.DkEaL') ||
                   root.querySelector('button[jsaction*="category"]') ||
                   root.querySelector('.DkEaL');
    if (catBtn) lead.category = catBtn.textContent.trim();

    // ---- Action buttons with data-item-id
    const actionElements = root.querySelectorAll("[data-item-id]");
    actionElements.forEach(el => {
      const id = el.getAttribute("data-item-id") || "";

      // PHONE
      if (id.startsWith("phone:tel:")) {
        lead.phone = id.slice("phone:tel:".length).trim();
      } else if (!lead.phone && id.startsWith("phone")) {
        const txt = getButtonText(el);
        if (txt && /[\d+\-()]{7,}/.test(txt)) lead.phone = txt;
      }

      // ADDRESS
      if (id === "address") {
        const txt = getButtonText(el);
        if (txt) lead.address = txt;
      }

      // WEBSITE
      if (id === "authority") {
        // Try href first (it's an <a> tag)
        const href = el.getAttribute("href") || el.href || "";
        if (href && /^https?:\/\//i.test(href)) {
          lead.website = href;
        } else {
          const txt = getButtonText(el);
          if (txt && txt.includes(".")) {
            lead.website = txt.startsWith("http") ? txt : "https://" + txt;
          }
        }
      }

      // HOURS
      if (id.startsWith("oh") && !lead.hours) {
        const txt = getButtonText(el);
        if (txt) lead.hours = txt.split("\n")[0];
      }

      // PLUS CODE
      if (id === "plus_code") {
        const txt = getButtonText(el);
        if (txt) lead.plusCode = txt;
      }
    });

    // Phone fallback: tel: link
    if (!lead.phone) {
      const tel = root.querySelector('a[href^="tel:"]');
      if (tel) lead.phone = tel.getAttribute("href").replace(/^tel:/, "").trim();
    }

    // Email fallback: mailto link
    if (!lead.email) {
      const mailto = root.querySelector('a[href^="mailto:"]');
      if (mailto) lead.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();
    }

    // Domain from website
    if (lead.website) {
      try { lead.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // Coordinates from URL
    const cm = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (cm) {
      lead.latitude = parseFloat(cm[1]);
      lead.longitude = parseFloat(cm[2]);
    }
    // Fallback: @lat,lng in URL
    if (!lead.latitude) {
      const atm = location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
      if (atm) {
        lead.latitude = parseFloat(atm[1]);
        lead.longitude = parseFloat(atm[2]);
      }
    }

    return lead;
  }

  // Helper to get visible text from a Maps action button
  function getButtonText(el) {
    // Maps puts the text in a child with class "Io6YTe" or "rogA2c"
    const textEl = el.querySelector(".Io6YTe") ||
                   el.querySelector(".rogA2c") ||
                   el.querySelector('[class*="fontBody"]');
    if (textEl) return textEl.textContent.trim();
    // Fallback: aria-label
    const aria = el.getAttribute("aria-label") || "";
    if (aria) return aria;
    return el.textContent.trim();
  }

  // ============================================================
  // Deep enrichment via background script
  // ============================================================
  async function enrichFromWebsite(lead) {
    if (!lead.website) return lead;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "FETCH_WEBSITE_CONTACTS",
        url: lead.website
      });
      if (res && res.ok) {
        if (!lead.email && res.email)         lead.email     = res.email;
        if (!lead.facebook && res.facebook)   lead.facebook  = res.facebook;
        if (!lead.instagram && res.instagram) lead.instagram = res.instagram;
        if (!lead.twitter && res.twitter)     lead.twitter   = res.twitter;
        if (!lead.youtube && res.youtube)     lead.youtube   = res.youtube;
        if (!lead.linkedin && res.linkedin)   lead.linkedin  = res.linkedin;
      }
    } catch (e) { warn("enrich failed", e); }
    return lead;
  }

  // ============================================================
  // Save lead with deduplication
  // ============================================================
  async function saveLead(data) {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);

    // Dedup by title + address or by URL
    const exists = leads.some(l => {
      if (l.title && data.title && l.title === data.title && l.address === data.address) return true;
      if (l.url && data.url && l.url === data.url) return true;
      return false;
    });
    if (exists) return false;

    leads.push(data);
    await chrome.storage.local.set({ leads });

    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });
    return true;
  }

  // ============================================================
  // Go back to the results list after extracting a profile
  // ============================================================
  async function goBackToResults() {
    // Click the back arrow button in the detail panel
    const backBtn = document.querySelector('button[aria-label*="Back" i]') ||
                    document.querySelector('button[jsaction*="back"]') ||
                    document.querySelector('.section-back-to-list-button');
    if (backBtn) {
      backBtn.click();
      await sleep(800);
      return;
    }

    // Fallback: browser back
    history.back();
    await sleep(1000);
  }

  // ============================================================
  // MAIN CAMPAIGN RUNNER
  // ============================================================
  async function runMapsCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Campaign already running", "#f59e0b");
      return { ok: false, error: "already-running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    const settings = await chrome.storage.local.get([
      "targetLeads", "searchScroll", "profileWait",
      "fields", "savedKeywords", "savedLocations"
    ]);
    const target = settings.targetLeads || 100;
    const profileWaitMs = (settings.profileWait || 7) * 1000;
    const fields = settings.fields || {};
    // Auto-enrich from website if ANY social/email field is checked
    const wantEnrich = !!(fields.email || fields.facebook || fields.instagram || fields.twitter || fields.youtube || fields.linkedin);

    showToast("Starting Maps scrape...", "#2563eb");

    // CAPTCHA check
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    // Find the results container
    const container = findResultsContainer();
    if (!container) {
      showToast("Results sidebar not found. Search for something on Google Maps first.", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Loading Maps results...", currentPage: 0, totalPages: settings.searchScroll || 25, totalFound: 0, currentItem: "" });

    // Scroll to load all results
    await scrollResults(container, settings);
    if (SHOULD_STOP) { CAMPAIGN_RUNNING = false; await clearProgress(); return { ok: true, stopped: true }; }

    // Collect all place cards
    const places = collectPlaceCards(container);
    if (!places.length) {
      showToast("No businesses found in results.", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-places" };
    }

    showToast(`Found ${places.length} businesses, extracting...`, "#2563eb");

    let saved = 0;
    const limit = Math.min(places.length, target);

    for (let i = 0; i < limit; i++) {
      if (SHOULD_STOP) break;

      // CAPTCHA check every 10
      if (i > 0 && i % 10 === 0) {
        const c = detectCaptcha();
        if (c.detected) { await handleCaptcha(c); break; }
      }

      const place = places[i];
      await setProgress({
        isRunning: true,
        title: `Profile ${i + 1}/${limit}`,
        currentPage: i + 1,
        totalPages: limit,
        totalFound: saved,
        currentItem: place.name || `Business ${i + 1}`
      });

      try {
        // Open the place detail panel
        const ok = await openPlaceAndWait(place, profileWaitMs);
        if (!ok) {
          warn("skip — panel never loaded for:", place.name);
          continue;
        }

        // Extract data from the panel
        let lead = extractDetailPanel();

        // Sanity: must have a title
        if (!lead.title) {
          warn("skip — no title extracted");
          continue;
        }

        // Deep enrichment (visit website for email + socials)
        if (wantEnrich && lead.website) {
          await setProgress({ currentItem: `Enriching: ${lead.domain || lead.website}` });
          lead = await enrichFromWebsite(lead);
        }

        // Filter: only keep fields that user has checked
        const filteredLead = { scrapedAt: lead.scrapedAt, url: lead.url };
        if (fields.title !== false) filteredLead.title = lead.title;
        if (fields.phone) filteredLead.phone = lead.phone;
        if (fields.email) filteredLead.email = lead.email;
        if (fields.website) filteredLead.website = lead.website;
        if (fields.address) filteredLead.address = lead.address;
        if (fields.category) filteredLead.category = lead.category;
        if (fields.rating) filteredLead.rating = lead.rating;
        if (fields.reviewCount) filteredLead.reviewCount = lead.reviewCount;
        if (fields.facebook) filteredLead.facebook = lead.facebook;
        if (fields.instagram) filteredLead.instagram = lead.instagram;
        if (fields.twitter) filteredLead.twitter = lead.twitter;
        if (fields.youtube) filteredLead.youtube = lead.youtube;
        if (fields.linkedin) filteredLead.linkedin = lead.linkedin;
        if (fields.hours) filteredLead.hours = lead.hours;
        if (fields.domain) filteredLead.domain = lead.domain;
        if (fields.latitude) { filteredLead.latitude = lead.latitude; filteredLead.longitude = lead.longitude; }

        // Save
        const added = await saveLead(filteredLead);
        if (added) saved++;

        log(`[${i + 1}/${limit}] ${lead.title} | ${lead.phone} | ${lead.address}`);

      } catch (e) {
        warn("loop error for", place.name, e);
      }

      try { await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 }); } catch (_) {}

      // Go back to results list
      await goBackToResults();

      // Wait for the results container to re-appear
      let feedBack = false;
      for (let w = 0; w < 5000; w += 300) {
        const f = findResultsContainer();
        if (f && f.querySelectorAll('a[href*="/maps/place/"]').length > 0) {
          feedBack = true;
          break;
        }
        await sleep(300);
      }
      if (!feedBack) {
        warn("results list didn't come back, stopping");
        break;
      }

      // Human-like delay between profiles
      await sleep(jitter(profileWaitMs / 4));
    }

    await setProgress({ isRunning: false, title: "Campaign complete", currentItem: `Saved ${saved} new leads` });
    setTimeout(clearProgress, 4000);
    showToast(`Done! Saved ${saved} new leads.`, "#22c55e");
    CAMPAIGN_RUNNING = false;
    return { ok: true, saved };
  }

  // ============================================================
  // Multi-keyword campaign
  // ============================================================
  async function runMultiCampaign() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const keywords = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
    const locations = savedLocations.split("\n").map(s => s.trim()).filter(Boolean);
    if (!keywords.length) {
      showToast("No keywords set.", "#dc2626");
      return { ok: false, error: "no-keywords" };
    }
    if (isMapsPage() && findResultsContainer()) return await runMapsCampaign();
    const q = keywords[0] + (locations.length ? " " + locations[0] : "");
    location.href = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
    return { ok: true, navigating: true };
  }

  // ============================================================
  // Message router
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "SCRAPE_NOW") {
          if (isMapsPage()) sendResponse(await runMapsCampaign());
          else sendResponse({ ok: false, error: "Open Google Maps first" });
        } else if (msg.type === "STOP_SCRAPE") {
          SHOULD_STOP = true;
          showToast("Stopping after current item...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "RUN_MULTI_CAMPAIGN") {
          sendResponse(await runMultiCampaign());
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other" });
        }
      } catch (e) { sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  });

  // ============================================================
  // Auto-start
  // ============================================================
  (async () => {
    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(cap); return; }
    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
      await setProgress({ isRunning: false, title: "Cooldown", currentItem: `${minsLeft} min remaining` });
      return;
    }
    if (autoScrape && isMapsPage()) {
      setTimeout(() => runMapsCampaign(), 3000);
    }
  })();

})();
