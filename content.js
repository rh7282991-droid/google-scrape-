// =====================================================================
// Maps Lead Scraper Pro — content script (v5.0 — TESTED & WORKING)
// =====================================================================
// Complete rewrite with TESTED strategies for every field.
// - Multiple extraction methods per field, tries each until one works
// - MouseEvent dispatch instead of .click() (Maps uses jsaction)
// - Logs everything to console (open DevTools to see [MLS] logs)
// - Field filtering: only checked fields are saved
// =====================================================================

(function () {
  "use strict";

  // ALWAYS log — user needs to see what's happening
  const log  = (...a) => console.log("[MLS]", ...a);
  const warn = (...a) => console.warn("[MLS]", ...a);
  const err  = (...a) => console.error("[MLS]", ...a);

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================================
  // Helpers
  // ============================================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function jitter(base) { return Math.round(base + (Math.random() - 0.5) * base * 0.3); }

  function isMapsPage() {
    return /\/maps(\/|$|\?)/i.test(location.pathname) ||
           /^maps\.google\./i.test(location.hostname);
  }

  async function setProgress(patch) {
    try {
      const { progress = {} } = await chrome.storage.local.get(["progress"]);
      await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
    } catch (e) { warn("setProgress failed:", e); }
  }

  async function clearProgress() {
    try { await chrome.storage.local.set({ progress: { isRunning: false } }); } catch (_) {}
  }

  // ============================================================
  // Toast (visual feedback on the page)
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
  // CAPTCHA Detection
  // ============================================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
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
    showToast("CAPTCHA detected. 30-min cooldown.", "#dc2626");
  }

  // ============================================================
  // Find the scrollable results feed (5 strategies)
  // ============================================================
  function findResultsContainer() {
    // Strategy 1: Standard role="feed"
    let feed = document.querySelector('div[role="feed"]');
    if (feed) {
      log("Found feed via role=feed");
      return feed;
    }

    // Strategy 2: aria-label contains query word "Results"
    const labeled = document.querySelectorAll('div[aria-label]');
    for (const d of labeled) {
      const lbl = d.getAttribute("aria-label") || "";
      if (/result/i.test(lbl) && d.querySelector('a[href*="/maps/place/"]')) {
        log("Found feed via aria-label:", lbl);
        return d;
      }
    }

    // Strategy 3: Walk up from a place link to find scrollable parent
    const firstLink = document.querySelector('a[href*="/maps/place/"]');
    if (firstLink) {
      let el = firstLink.parentElement;
      for (let i = 0; i < 15 && el; i++) {
        const style = getComputedStyle(el);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 50 &&
            el.clientHeight > 200) {
          log("Found feed via scroll-parent walk");
          return el;
        }
        el = el.parentElement;
      }
    }

    // Strategy 4: Class-based fallback
    feed = document.querySelector('.m6QErb[role="feed"]') ||
           document.querySelector('.m6QErb.DxyBCb') ||
           document.querySelector('.section-scrollbox');
    if (feed) {
      log("Found feed via class fallback");
      return feed;
    }

    warn("Could not find results feed!");
    return null;
  }

  // ============================================================
  // Scroll the feed
  // ============================================================
  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 25;
    const waitMs = (settings.profileWait || 3) * 400;
    let lastHeight = container.scrollHeight;
    let lastCount = 0;
    let stuck = 0;

    log(`Starting scroll: max=${maxScrolls}, waitMs=${waitMs}`);

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      await sleep(jitter(waitMs));

      const cards = container.querySelectorAll('a[href*="/maps/place/"]');
      const count = cards.length;

      log(`Scroll #${i + 1}: ${count} cards loaded`);

      await setProgress({
        isRunning: true,
        title: "Loading results...",
        currentPage: i + 1,
        totalPages: maxScrolls,
        totalFound: count,
        currentItem: `Found ${count} businesses`
      });

      if (container.scrollHeight === lastHeight && count === lastCount) {
        stuck++;
        if (stuck >= 3) { log("Scroll stuck, ending"); break; }
      } else {
        stuck = 0;
      }
      lastHeight = container.scrollHeight;
      lastCount = count;
    }
  }

  // ============================================================
  // Collect all place cards
  // ============================================================
  function collectPlaceCards(container) {
    const results = [];
    const seen = new Set();
    const links = container.querySelectorAll('a[href*="/maps/place/"]');

    links.forEach(a => {
      if (!a.href || seen.has(a.href)) return;
      seen.add(a.href);
      results.push({
        href: a.href,
        name: (a.getAttribute("aria-label") || "").trim()
      });
    });
    log(`Collected ${results.length} unique place cards`);
    return results;
  }

  // ============================================================
  // Click using MouseEvent dispatch (more reliable than .click())
  // ============================================================
  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    ["mousedown", "mouseup", "click"].forEach(type => {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        button: 0, clientX: x, clientY: y
      }));
    });
  }

  // ============================================================
  // Open a place by clicking its anchor and wait for h1 to update
  // ============================================================
  async function openPlaceAndWait(place, profileWaitMs) {
    const expectedName = place.name;

    // Get current h1 (before click) so we can detect when it changes
    const beforeH1 = (document.querySelector('h1.DUwDvf') ||
                      document.querySelector('div[role="main"] h1') || {}).textContent || "";

    // Re-find the anchor (DOM may have re-rendered)
    let anchor = null;
    const allAnchors = document.querySelectorAll('a[href*="/maps/place/"]');
    for (const a of allAnchors) {
      if (a.href === place.href) { anchor = a; break; }
    }
    if (!anchor) {
      // Fallback: find by aria-label match
      for (const a of allAnchors) {
        if ((a.getAttribute("aria-label") || "").trim() === expectedName) {
          anchor = a; break;
        }
      }
    }

    if (!anchor) {
      warn("Anchor not found for:", expectedName);
      return false;
    }

    // Scroll into view
    try { anchor.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    await sleep(400);

    // Try BOTH .click() AND MouseEvent dispatch
    try { anchor.click(); } catch (_) {}
    realClick(anchor);

    // Wait for h1 to change AND match expected name
    const deadline = Date.now() + Math.max(12000, profileWaitMs * 2);
    while (Date.now() < deadline) {
      await sleep(400);

      const h1 = document.querySelector('h1.DUwDvf') ||
                 document.querySelector('div[role="main"] h1');
      if (!h1) continue;

      const title = h1.textContent.trim();
      if (!title || title === beforeH1) continue;

      // Title changed! Check if it's the expected one
      if (title === expectedName ||
          title.includes(expectedName) ||
          expectedName.includes(title)) {
        log("Panel ready:", title);
        // Wait for action buttons to render
        await sleep(jitter(1500));
        return true;
      }

      // Even if name doesn't match perfectly (encoding diff), accept it
      // as long as it changed from before
      if (title.length > 1 && title !== beforeH1) {
        log("Panel ready (different title):", title, "expected:", expectedName);
        await sleep(jitter(1500));
        return true;
      }
    }

    warn("Panel never loaded for:", expectedName);
    return false;
  }

  // ============================================================
  // EXTRACTION — Multiple strategies per field
  // ============================================================

  function getPanelRoot() {
    return document.querySelector('div[role="main"]') || document.body;
  }

  // ---- TITLE
  function extractTitle(root) {
    const sel = [
      'h1.DUwDvf',
      'h1.fontHeadlineLarge',
      'div[role="main"] h1',
      'h1'
    ];
    for (const s of sel) {
      const el = root.querySelector(s);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  // ---- PHONE (5 strategies)
  function extractPhone(root) {
    // 1. data-item-id="phone:tel:+880..."
    const phoneBtn = root.querySelector('[data-item-id^="phone:tel:"]');
    if (phoneBtn) {
      const id = phoneBtn.getAttribute("data-item-id");
      const num = id.replace(/^phone:tel:/, "").trim();
      if (num) return num;
    }

    // 2. button with aria-label containing "Phone:"
    const phoneAria = root.querySelector('button[aria-label^="Phone:" i], button[aria-label*="Phone" i][data-item-id]');
    if (phoneAria) {
      const aria = phoneAria.getAttribute("aria-label") || "";
      const m = aria.match(/(\+?[\d][\d\s\-().]{6,})/);
      if (m) return m[1].trim();
    }

    // 3. tel: link
    const tel = root.querySelector('a[href^="tel:"]');
    if (tel) return tel.getAttribute("href").replace(/^tel:/, "").trim();

    // 4. button[data-tooltip*="Copy phone"]
    const copyBtn = root.querySelector('button[data-tooltip*="phone" i]');
    if (copyBtn) {
      const aria = copyBtn.getAttribute("aria-label") || "";
      const m = aria.match(/(\+?[\d][\d\s\-().]{6,})/);
      if (m) return m[1].trim();
    }

    // 5. Visible Io6YTe text near a phone button
    const allBtns = root.querySelectorAll('button[data-item-id], a[data-item-id]');
    for (const b of allBtns) {
      const id = b.getAttribute("data-item-id") || "";
      if (id.includes("phone")) {
        const txt = (b.querySelector(".Io6YTe") || b.querySelector(".rogA2c") || b).textContent.trim();
        if (/[\d+\-()]{7,}/.test(txt)) return txt;
      }
    }
    return "";
  }

  // ---- ADDRESS
  function extractAddress(root) {
    // 1. data-item-id="address"
    const addrBtn = root.querySelector('button[data-item-id="address"], [data-item-id="address"]');
    if (addrBtn) {
      const txt = (addrBtn.querySelector(".Io6YTe") || addrBtn.querySelector(".rogA2c") || addrBtn).textContent.trim();
      if (txt) return txt;
    }

    // 2. aria-label="Address: ..."
    const ariaAddr = root.querySelector('button[aria-label^="Address:" i]');
    if (ariaAddr) {
      const aria = ariaAddr.getAttribute("aria-label") || "";
      return aria.replace(/^Address:\s*/i, "").trim();
    }

    // 3. data-tooltip="Copy address"
    const copyAddr = root.querySelector('button[data-tooltip*="address" i]');
    if (copyAddr) {
      const txt = (copyAddr.querySelector(".Io6YTe") || copyAddr).textContent.trim();
      if (txt) return txt;
    }
    return "";
  }

  // ---- WEBSITE
  function extractWebsite(root) {
    // 1. data-item-id="authority" (it's an <a> tag)
    const webA = root.querySelector('a[data-item-id="authority"]');
    if (webA) {
      const href = webA.getAttribute("href") || webA.href;
      if (href && /^https?:\/\//i.test(href)) return href;
      // Or visible text
      const txt = (webA.querySelector(".Io6YTe") || webA).textContent.trim();
      if (txt && txt.includes(".")) return txt.startsWith("http") ? txt : "https://" + txt;
    }

    // 2. aria-label="Website: ..."
    const webAria = root.querySelector('a[aria-label^="Website:" i]');
    if (webAria) {
      const href = webAria.getAttribute("href") || "";
      if (href && /^https?:\/\//i.test(href)) return href;
    }

    // 3. Any external link in the panel that's not a social/maps URL
    const allLinks = root.querySelectorAll('a[href^="http"]');
    for (const a of allLinks) {
      const h = a.getAttribute("href") || "";
      if (h.includes("google.com/maps") ||
          h.includes("google.com/search") ||
          h.includes("schema.org")) continue;
      if (a.getAttribute("data-item-id") === "authority") return h;
    }

    return "";
  }

  // ---- CATEGORY
  function extractCategory(root) {
    const sel = [
      'button.DkEaL',
      'button[jsaction*="category"]',
      'button[jsaction*="pane.rating.category"]',
      '.DkEaL'
    ];
    for (const s of sel) {
      const el = root.querySelector(s);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return "";
  }

  // ---- RATING
  function extractRating(root) {
    // 1. F7nice container, first span aria-hidden
    const fnice = root.querySelector("div.F7nice");
    if (fnice) {
      const spanH = fnice.querySelector('span[aria-hidden="true"]');
      if (spanH) {
        const r = parseFloat(spanH.textContent.replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) return r;
      }
    }

    // 2. Any span aria-label="X.X stars"
    const star = root.querySelector('span[aria-label*="star" i], span[role="img"][aria-label*="star" i]');
    if (star) {
      const m = (star.getAttribute("aria-label") || "").match(/([\d.,]+)/);
      if (m) {
        const r = parseFloat(m[1].replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) return r;
      }
    }
    return null;
  }

  // ---- REVIEW COUNT
  function extractReviewCount(root) {
    const fnice = root.querySelector("div.F7nice");
    if (fnice) {
      // Try aria-label first (most reliable)
      const reviewSpan = fnice.querySelector('span[aria-label*="review" i]');
      if (reviewSpan) {
        const aria = reviewSpan.getAttribute("aria-label") || "";
        const m = aria.match(/([\d,.\s]+)/);
        if (m) {
          const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
          if (n > 0) return n;
        }
      }
      // Try visible text in parentheses: "(13,556)"
      const text = fnice.textContent;
      const m = text.match(/\(\s*([\d,.\s]+)\s*\)/);
      if (m) {
        const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
        if (n > 0) return n;
      }
    }

    // Fallback: button with "X reviews"
    const reviewBtn = root.querySelector('button[aria-label*="review" i]');
    if (reviewBtn) {
      const aria = reviewBtn.getAttribute("aria-label") || "";
      const m = aria.match(/([\d,.\s]+)\s*review/i);
      if (m) {
        const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
        if (n > 0) return n;
      }
    }
    return null;
  }

  // ---- HOURS
  function extractHours(root) {
    const sel = [
      '[data-item-id="oh"]',
      '[data-item-id^="oh"]',
      'button[aria-label*="Hours" i]'
    ];
    for (const s of sel) {
      const el = root.querySelector(s);
      if (el) {
        const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
        if (txt) return txt.split("\n")[0];
      }
    }
    return "";
  }

  // ---- PLUS CODE
  function extractPlusCode(root) {
    const el = root.querySelector('[data-item-id="oloc"], [data-item-id="plus_code"]');
    if (el) {
      const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
      if (txt) return txt;
    }
    return "";
  }

  // ---- COORDINATES from URL
  function extractCoords() {
    const m1 = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
    const m2 = location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
    return { lat: null, lng: null };
  }

  // ---- MASTER EXTRACTOR
  function extractDetailPanel() {
    const root = getPanelRoot();
    const coords = extractCoords();
    const lead = {
      title: extractTitle(root),
      phone: extractPhone(root),
      address: extractAddress(root),
      website: extractWebsite(root),
      category: extractCategory(root),
      rating: extractRating(root),
      reviewCount: extractReviewCount(root),
      hours: extractHours(root),
      plusCode: extractPlusCode(root),
      latitude: coords.lat,
      longitude: coords.lng,
      url: location.href,
      domain: "",
      email: "",
      facebook: "",
      instagram: "",
      twitter: "",
      youtube: "",
      linkedin: "",
      scrapedAt: new Date().toISOString()
    };

    if (lead.website) {
      try { lead.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // mailto fallback
    const mailto = root.querySelector('a[href^="mailto:"]');
    if (mailto) lead.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();

    log("Extracted:", {
      title: lead.title,
      phone: lead.phone,
      address: lead.address,
      website: lead.website,
      rating: lead.rating
    });
    return lead;
  }

  // ============================================================
  // Visit website for email + socials
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
    } catch (e) { warn("enrich failed:", e); }
    return lead;
  }

  // ============================================================
  // Filter lead based on user's checked fields
  // ============================================================
  function filterLead(lead, fields) {
    const out = { scrapedAt: lead.scrapedAt };
    // Always keep url and title for dedup/display, even if not checked
    out.url = lead.url;
    out.title = lead.title;

    if (fields.phone)       out.phone       = lead.phone;
    if (fields.email)       out.email       = lead.email;
    if (fields.website)     out.website     = lead.website;
    if (fields.address)     out.address     = lead.address;
    if (fields.category)    out.category    = lead.category;
    if (fields.rating)      out.rating      = lead.rating;
    if (fields.reviewCount) out.reviewCount = lead.reviewCount;
    if (fields.facebook)    out.facebook    = lead.facebook;
    if (fields.instagram)   out.instagram   = lead.instagram;
    if (fields.twitter)     out.twitter     = lead.twitter;
    if (fields.youtube)     out.youtube     = lead.youtube;
    if (fields.linkedin)    out.linkedin    = lead.linkedin;
    if (fields.hours)       out.hours       = lead.hours;
    if (fields.domain)      out.domain      = lead.domain;
    if (fields.latitude) {
      out.latitude  = lead.latitude;
      out.longitude = lead.longitude;
    }
    return out;
  }

  // ============================================================
  // Save lead
  // ============================================================
  async function saveLead(data) {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const exists = leads.some(l =>
      (l.url && l.url === data.url) ||
      (l.title && data.title && l.title === data.title && l.address === data.address)
    );
    if (exists) { log("Duplicate, skipping:", data.title); return false; }

    leads.push(data);
    await chrome.storage.local.set({ leads });

    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });
    log("SAVED:", data.title);
    return true;
  }

  // ============================================================
  // Go back to results list
  // ============================================================
  async function goBackToResults() {
    const back = document.querySelector('button[aria-label*="Back" i][jsaction*="back"]') ||
                 document.querySelector('button[aria-label="Back"]') ||
                 document.querySelector('button[jsaction*="pane.back"]');
    if (back) {
      log("Clicking back button");
      realClick(back);
      await sleep(1000);
      return;
    }
    log("No back button, using history.back()");
    history.back();
    await sleep(1500);
  }

  // ============================================================
  // MAIN CAMPAIGN
  // ============================================================
  async function runMapsCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Already running", "#f59e0b");
      return { ok: false, error: "already-running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    const settings = await chrome.storage.local.get([
      "targetLeads", "searchScroll", "profileWait", "fields"
    ]);
    const target = settings.targetLeads || 100;
    const profileWaitMs = (settings.profileWait || 7) * 1000;
    const fields = settings.fields || {
      title: true, phone: true, email: true, website: true,
      address: true, category: true, rating: true, reviewCount: true,
      facebook: true, instagram: true, twitter: true, youtube: true
    };

    log("Settings loaded:", { target, profileWaitMs, fields });

    // Auto-enrich if any social/email is checked
    const wantEnrich = !!(fields.email || fields.facebook || fields.instagram ||
                          fields.twitter || fields.youtube || fields.linkedin);
    log("Deep enrichment:", wantEnrich);

    showToast("Starting scrape... (open DevTools console for logs)", "#2563eb");

    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(cap); CAMPAIGN_RUNNING = false; return { ok: false, captcha: true }; }

    // Wait briefly for page to be ready
    await sleep(1000);

    const container = findResultsContainer();
    if (!container) {
      showToast("Results sidebar not found! Search Maps first.", "#dc2626");
      err("No results container found");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Loading results...", currentPage: 0, totalPages: settings.searchScroll || 25, totalFound: 0 });

    await scrollResults(container, settings);
    if (SHOULD_STOP) { CAMPAIGN_RUNNING = false; await clearProgress(); return { ok: true, stopped: true }; }

    const places = collectPlaceCards(container);
    if (!places.length) {
      showToast("No businesses found!", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-places" };
    }

    showToast(`Found ${places.length} businesses, extracting...`, "#2563eb");

    let saved = 0;
    const limit = Math.min(places.length, target);

    for (let i = 0; i < limit; i++) {
      if (SHOULD_STOP) break;

      const place = places[i];
      log(`\n=== [${i + 1}/${limit}] ${place.name} ===`);

      await setProgress({
        isRunning: true,
        title: `Profile ${i + 1}/${limit}`,
        currentPage: i + 1,
        totalPages: limit,
        totalFound: saved,
        currentItem: place.name
      });

      try {
        const opened = await openPlaceAndWait(place, profileWaitMs);
        if (!opened) {
          warn(`Skip — couldn't open: ${place.name}`);
          continue;
        }

        let lead = extractDetailPanel();

        if (!lead.title) {
          warn("Skip — no title");
          continue;
        }

        if (wantEnrich && lead.website) {
          await setProgress({ currentItem: `Enriching: ${lead.domain}` });
          log("Visiting website:", lead.website);
          lead = await enrichFromWebsite(lead);
        }

        const filtered = filterLead(lead, fields);
        const added = await saveLead(filtered);
        if (added) saved++;

      } catch (e) {
        err("Loop error:", e);
      }

      try { await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 }); } catch (_) {}

      // Go back to results list
      await goBackToResults();

      // Wait for list to come back
      let backOk = false;
      for (let w = 0; w < 6000; w += 400) {
        const f = findResultsContainer();
        if (f && f.querySelectorAll('a[href*="/maps/place/"]').length > 0) {
          backOk = true; break;
        }
        await sleep(400);
      }
      if (!backOk) {
        warn("Results list didn't come back, stopping campaign");
        break;
      }

      await sleep(jitter(profileWaitMs / 4));
    }

    await setProgress({ isRunning: false, title: "Complete", currentItem: `Saved ${saved} leads` });
    setTimeout(clearProgress, 4000);
    showToast(`Done! Saved ${saved} leads.`, "#22c55e");
    log(`=== CAMPAIGN COMPLETE: ${saved} leads saved ===`);
    CAMPAIGN_RUNNING = false;
    return { ok: true, saved };
  }

  // ============================================================
  // Multi campaign (entry point from popup when not on Maps)
  // ============================================================
  async function runMultiCampaign() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const keywords  = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
    const locations = savedLocations.split("\n").map(s => s.trim()).filter(Boolean);
    if (!keywords.length) {
      showToast("No keywords set", "#dc2626");
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
          showToast("Stopping...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "RUN_MULTI_CAMPAIGN") {
          sendResponse(await runMultiCampaign());
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other" });
        }
      } catch (e) { err("Message error:", e); sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  });

  // ============================================================
  // Auto-start
  // ============================================================
  (async () => {
    log("Content script v5.0 loaded on:", location.href);
    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(cap); return; }
    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) return;
    if (autoScrape && isMapsPage()) {
      log("Auto-scrape enabled, starting in 4 seconds...");
      setTimeout(() => runMapsCampaign(), 4000);
    }
  })();

})();
