// =====================================================================
// Maps Lead Scraper Pro — content script (v6.0 — KING MODE)
// =====================================================================
// Resilient architecture:
//  - Saves every lead to chrome.storage IMMEDIATELY (cache-as-you-go)
//  - Survives tab focus loss and minor DOM re-renders
//  - Multi-strategy extraction with broad fallbacks (3-5 per field)
//  - Real MouseEvent dispatch for jsaction-delegated clicks
//  - Visible toast + heavy console logging for debugging
// =====================================================================

(function () {
  "use strict";

  // ---- Always-on logging
  const log  = (...a) => { try { console.log("%c[MLS]", "color:#2563eb;font-weight:bold", ...a); } catch (_) {} };
  const warn = (...a) => { try { console.warn("%c[MLS]", "color:#f59e0b;font-weight:bold", ...a); } catch (_) {} };
  const err  = (...a) => { try { console.error("%c[MLS]", "color:#dc2626;font-weight:bold", ...a); } catch (_) {} };

  // ---- State
  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ---- Helpers
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (base) => Math.round(base + (Math.random() - 0.5) * base * 0.25);

  function isMapsPage() {
    return /\/maps(\/|$|\?)/i.test(location.pathname) || /^maps\.google\./i.test(location.hostname);
  }

  async function setProgress(patch) {
    try {
      const { progress = {} } = await chrome.storage.local.get(["progress"]);
      await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
    } catch (_) {}
  }
  async function clearProgress() {
    try { await chrome.storage.local.set({ progress: { isRunning: false } }); } catch (_) {}
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
        position: "fixed", bottom: "24px", right: "24px",
        background: "#2563eb", color: "#fff",
        padding: "14px 18px", borderRadius: "12px",
        font: "14px/1.5 system-ui, sans-serif",
        zIndex: 2147483647, boxShadow: "0 10px 30px rgba(0,0,0,0.3)",
        opacity: "0", transition: "opacity .3s ease",
        maxWidth: "360px", fontWeight: "600",
        pointerEvents: "none"
      });
      document.body.appendChild(toast);
    }
    toast.style.background = color || "#2563eb";
    toast.textContent = message;
    setTimeout(() => (toast.style.opacity = "1"), 10);
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 5000);
  }

  // ============================================================
  // CAPTCHA detection
  // ============================================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    return { detected: false };
  }

  // ============================================================
  // FEED FINDER (5 strategies)
  // ============================================================
  function findFeed() {
    let feed = document.querySelector('div[role="feed"]');
    if (feed) { log("Feed: role=feed"); return feed; }

    const labeled = document.querySelectorAll('div[aria-label]');
    for (const d of labeled) {
      const lbl = (d.getAttribute("aria-label") || "").toLowerCase();
      if (/result/i.test(lbl) && d.querySelector('a[href*="/maps/place/"]')) {
        log("Feed: aria-label =", lbl); return d;
      }
    }

    const firstA = document.querySelector('a[href*="/maps/place/"]');
    if (firstA) {
      let el = firstA.parentElement;
      for (let i = 0; i < 15 && el; i++) {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
             el.scrollHeight > el.clientHeight + 80 &&
             el.clientHeight > 200) {
          log("Feed: scroll-parent walk"); return el;
        }
        el = el.parentElement;
      }
    }

    feed = document.querySelector('.m6QErb[role="feed"]') ||
           document.querySelector('.m6QErb.DxyBCb') ||
           document.querySelector('.section-scrollbox');
    if (feed) { log("Feed: class fallback"); return feed; }

    return null;
  }

  // ============================================================
  // SCROLL FEED
  // ============================================================
  async function scrollFeed(feed, maxScrolls, waitMs) {
    let lastH = feed.scrollHeight;
    let lastN = 0;
    let stuck = 0;

    log(`Scrolling: max=${maxScrolls}, wait=${waitMs}ms`);
    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      await sleep(jitter(waitMs));

      const cards = feed.querySelectorAll('a[href*="/maps/place/"]').length;
      log(`Scroll #${i + 1}: ${cards} cards`);

      await setProgress({
        isRunning: true,
        title: "Loading results...",
        currentPage: i + 1,
        totalPages: maxScrolls,
        totalFound: cards,
        currentItem: `Found ${cards} businesses`
      });

      if (feed.scrollHeight === lastH && cards === lastN) {
        if (++stuck >= 3) { log("Scroll done"); break; }
      } else stuck = 0;
      lastH = feed.scrollHeight;
      lastN = cards;
    }
  }

  // ============================================================
  // Collect place cards
  // ============================================================
  function collectPlaces(feed) {
    const out = [];
    const seen = new Set();
    feed.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
      if (!a.href || seen.has(a.href)) return;
      seen.add(a.href);
      out.push({
        href: a.href,
        name: (a.getAttribute("aria-label") || "").trim()
      });
    });
    log(`Collected ${out.length} places`);
    return out;
  }

  // ============================================================
  // REAL CLICK — synthesizes mousedown/mouseup/click
  // ============================================================
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, button: 0, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup",   opts));
    el.dispatchEvent(new MouseEvent("click",     opts));
  }

  // ============================================================
  // OPEN PLACE
  // ============================================================
  async function openPlace(place, maxWaitMs) {
    // Find the anchor — first try by href, then by scrolling
    let anchor = null;
    const findAnchor = () => {
      const all = document.querySelectorAll('a[href*="/maps/place/"]');
      for (const a of all) {
        if (a.href === place.href) return a;
      }
      for (const a of all) {
        if ((a.getAttribute("aria-label") || "").trim() === place.name) return a;
      }
      return null;
    };

    anchor = findAnchor();

    // If anchor not in DOM, it's virtualized — scroll feed to find it
    if (!anchor) {
      const feed = findFeed();
      if (feed) {
        log("Scrolling feed to find card:", place.name);
        // Scroll through the feed looking for our anchor
        for (let attempt = 0; attempt < 20; attempt++) {
          feed.scrollBy({ top: 300, behavior: "smooth" });
          await sleep(300);
          anchor = findAnchor();
          if (anchor) break;
        }
        // If still not found, scroll back to top and try again
        if (!anchor) {
          feed.scrollTo({ top: 0, behavior: "smooth" });
          await sleep(500);
          for (let attempt = 0; attempt < 30; attempt++) {
            feed.scrollBy({ top: 400, behavior: "smooth" });
            await sleep(300);
            anchor = findAnchor();
            if (anchor) break;
          }
        }
      }
    }

    if (!anchor) { warn("Anchor not found:", place.name); return false; }

    try { anchor.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    await sleep(400);

    // Click with both methods
    try { anchor.click(); } catch (_) {}
    realClick(anchor);

    // Wait for the DETAIL PANEL to appear
    // Key insight: when a place is open, there's a specific container
    // with data-item-id buttons AND an h1. We wait for THAT.
    const deadline = Date.now() + maxWaitMs;
    let ready = false;
    while (Date.now() < deadline && !SHOULD_STOP) {
      await sleep(400);
      // The detail panel is ready when we can see data-item-id buttons
      // AND an h1.DUwDvf with real content (not "Results")
      const h1 = document.querySelector('h1.DUwDvf');
      const hasButtons = document.querySelector('[data-item-id^="phone"], [data-item-id="address"], [data-item-id="authority"]');
      if (h1 && h1.textContent.trim().length > 1 && hasButtons) {
        const title = h1.textContent.trim();
        // Reject if it's just the search results heading
        if (title.toLowerCase() !== "results" &&
            !title.toLowerCase().startsWith("results for")) {
          ready = true;
          log("Opened:", title);
          break;
        }
      }
    }

    if (!ready) { warn("Panel never opened for:", place.name); return false; }

    // Extra settle time for all buttons to render
    await sleep(jitter(1500));
    return true;
  }

  // ============================================================
  // EXTRACTION
  // ============================================================
  function getRoot() { return document.querySelector('div[role="main"]') || document.body; }
  function txt(el) { if (!el) return ""; return (el.textContent || "").replace(/\s+/g, " ").trim(); }

  function extractTitle(root) {
    const candidates = [
      txt(root.querySelector('h1.DUwDvf')),
      txt(root.querySelector('h1.fontHeadlineLarge')),
      txt(root.querySelector('div[role="main"] h1')),
      txt(root.querySelector('h1'))
    ];
    for (const title of candidates) {
      if (!title) continue;
      // Reject search-results headings
      if (/^results?\b/i.test(title)) continue;
      if (/^search results/i.test(title)) continue;
      return title;
    }
    return "";
  }

  function extractPhone(root) {
    const phoneEl = root.querySelector('[data-item-id^="phone:tel:"]');
    if (phoneEl) {
      const id = phoneEl.getAttribute("data-item-id");
      const num = id.replace(/^phone:tel:/, "").trim();
      if (num) return num;
    }
    const tel = root.querySelector('a[href^="tel:"]');
    if (tel) return tel.getAttribute("href").replace(/^tel:/, "").trim();
    const phoneAria = root.querySelector('button[aria-label^="Phone:" i], button[data-item-id*="phone" i]');
    if (phoneAria) {
      const aria = phoneAria.getAttribute("aria-label") || "";
      const m = aria.match(/(\+?[\d][\d\s\-().]{6,}\d)/);
      if (m) return m[1].trim();
    }
    const tip = root.querySelector('button[data-tooltip*="phone" i]');
    if (tip) {
      const aria = tip.getAttribute("aria-label") || "";
      const m = aria.match(/(\+?[\d][\d\s\-().]{6,}\d)/);
      if (m) return m[1].trim();
    }
    return "";
  }

  function extractAddress(root) {
    const a = root.querySelector('[data-item-id="address"]');
    if (a) {
      const t = txt(a.querySelector('.Io6YTe')) || txt(a.querySelector('.rogA2c'));
      if (t) return t;
      const aria = a.getAttribute("aria-label") || "";
      const cleaned = aria.replace(/^Address:\s*/i, "").trim();
      if (cleaned) return cleaned;
    }
    const aria = root.querySelector('button[aria-label^="Address:" i]');
    if (aria) {
      return aria.getAttribute("aria-label").replace(/^Address:\s*/i, "").trim();
    }
    const tip = root.querySelector('button[data-tooltip*="address" i]');
    if (tip) {
      const t = txt(tip.querySelector('.Io6YTe')) || txt(tip);
      if (t) return t;
    }
    return "";
  }

  function extractWebsite(root) {
    const a = root.querySelector('a[data-item-id="authority"]');
    if (a) {
      const href = a.getAttribute("href") || a.href || "";
      if (/^https?:\/\//i.test(href)) return href;
      const t = txt(a.querySelector('.Io6YTe')) || txt(a);
      if (t && t.includes(".")) return t.startsWith("http") ? t : "https://" + t;
    }
    const aria = root.querySelector('a[aria-label^="Website:" i]');
    if (aria) {
      const href = aria.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) return href;
    }
    return "";
  }

  function extractCategory(root) {
    return txt(root.querySelector('button.DkEaL')) ||
           txt(root.querySelector('button[jsaction*="category"]')) ||
           txt(root.querySelector('.DkEaL'));
  }

  function extractRating(root) {
    const fnice = root.querySelector('div.F7nice');
    if (fnice) {
      const span = fnice.querySelector('span[aria-hidden="true"]');
      if (span) {
        const r = parseFloat(txt(span).replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) return r;
      }
    }
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

  function extractReviewCount(root) {
    const fnice = root.querySelector('div.F7nice');
    if (fnice) {
      const r = fnice.querySelector('span[aria-label*="review" i]');
      if (r) {
        const aria = r.getAttribute("aria-label") || "";
        const m = aria.match(/([\d,.\s]+)/);
        if (m) {
          const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
          if (n > 0) return n;
        }
      }
      const all = fnice.textContent || "";
      const m2 = all.match(/\(\s*([\d,.\s]+)\s*\)/);
      if (m2) {
        const n = parseInt(m2[1].replace(/[,.\s]/g, ""), 10);
        if (n > 0) return n;
      }
    }
    const btn = root.querySelector('button[aria-label*="review" i]');
    if (btn) {
      const m = (btn.getAttribute("aria-label") || "").match(/([\d,.\s]+)\s*review/i);
      if (m) {
        const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
        if (n > 0) return n;
      }
    }
    return null;
  }

  function extractHours(root) {
    const el = root.querySelector('[data-item-id^="oh"]') ||
               root.querySelector('button[aria-label*="Hours" i]');
    if (el) {
      const t = txt(el.querySelector('.Io6YTe')) || txt(el);
      if (t) return t.split("\n")[0];
    }
    return "";
  }

  function extractPlusCode(root) {
    const el = root.querySelector('[data-item-id="oloc"]') ||
               root.querySelector('[data-item-id="plus_code"]');
    if (el) {
      const t = txt(el.querySelector('.Io6YTe')) || txt(el);
      if (t) return t;
    }
    return "";
  }

  function extractCoords() {
    const m1 = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
    const m2 = location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
    return { lat: null, lng: null };
  }

  function extractDetail() {
    const root = getRoot();
    const c = extractCoords();
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
      latitude: c.lat,
      longitude: c.lng,
      url: location.href,
      domain: "",
      email: "",
      facebook: "", instagram: "", twitter: "", youtube: "", linkedin: "",
      scrapedAt: new Date().toISOString()
    };

    if (lead.website) {
      try { lead.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }
    const mailto = root.querySelector('a[href^="mailto:"]');
    if (mailto) lead.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();

    log("EXTRACTED:", {
      title: lead.title || "(empty)",
      phone: lead.phone || "(empty)",
      website: lead.website || "(empty)",
      address: lead.address || "(empty)",
      rating: lead.rating
    });
    return lead;
  }

  // ============================================================
  // Enrich website
  // ============================================================
  async function enrichWebsite(lead) {
    if (!lead.website) return lead;
    try {
      const r = await chrome.runtime.sendMessage({ type: "FETCH_WEBSITE_CONTACTS", url: lead.website });
      if (r && r.ok) {
        if (!lead.email && r.email)         lead.email     = r.email;
        if (!lead.facebook && r.facebook)   lead.facebook  = r.facebook;
        if (!lead.instagram && r.instagram) lead.instagram = r.instagram;
        if (!lead.twitter && r.twitter)     lead.twitter   = r.twitter;
        if (!lead.youtube && r.youtube)     lead.youtube   = r.youtube;
        if (!lead.linkedin && r.linkedin)   lead.linkedin  = r.linkedin;
      }
    } catch (e) { warn("enrich failed:", e); }
    return lead;
  }

  // ============================================================
  // Filter
  // ============================================================
  function filterLead(lead, fields) {
    const out = { scrapedAt: lead.scrapedAt, url: lead.url, title: lead.title };
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
  // Save
  // ============================================================
  async function saveLead(data) {
    // Never save leads with empty or generic titles
    if (!data.title || /^results?\b/i.test(data.title)) {
      warn("Refusing to save bad title:", data.title);
      return false;
    }

    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const dup = leads.some(l =>
      (l.url && l.url === data.url) ||
      (l.title && data.title && l.title === data.title && (l.address || "") === (data.address || ""))
    );
    if (dup) { log("Duplicate, skipped:", data.title); return false; }

    leads.push(data);
    await chrome.storage.local.set({ leads });

    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });

    log("✓ SAVED:", data.title);
    return true;
  }

  // ============================================================
  // Back to list — click Maps panel back button (NOT history.back)
  // history.back() breaks feed virtualization!
  // ============================================================
  async function backToList() {
    // Strategy 1: Maps' own back button (keeps feed intact!)
    const backSelectors = [
      'button[jsaction*="pane.back"]',
      'button[aria-label="Back"]',
      'button[aria-label*="Back" i]',
      'button.hYkMDe',  // Known Maps back-button class
      '.section-back-to-list-button'
    ];
    for (const sel of backSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) { // visible
        log("Click back:", sel);
        try { btn.click(); } catch (_) {}
        realClick(btn);
        await sleep(1500);
        return;
      }
    }

    // Strategy 2: If no back button visible, press Escape key
    log("No back btn, pressing Escape");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(1500);
  }

  // ============================================================
  // CAMPAIGN
  // ============================================================
  async function runCampaign() {
    if (CAMPAIGN_RUNNING) { showToast("Already running", "#f59e0b"); return { ok: false, error: "running" }; }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    const s = await chrome.storage.local.get(["targetLeads", "searchScroll", "profileWait", "fields"]);
    const target = s.targetLeads || 100;
    const profileWait = (s.profileWait || 7) * 1000;
    const fields = s.fields || {
      title: true, phone: true, email: true, website: true,
      address: true, category: true, rating: true, reviewCount: true,
      facebook: true, instagram: true, twitter: true, youtube: true
    };

    const wantEnrich = !!(fields.email || fields.facebook || fields.instagram ||
                          fields.twitter || fields.youtube || fields.linkedin);

    log("===== CAMPAIGN START =====");
    log("Settings:", { target, profileWait, fields, wantEnrich });

    showToast("Starting... Press F12 → Console for live logs", "#2563eb");

    if (detectCaptcha().detected) {
      showToast("CAPTCHA detected", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    await sleep(1200);

    let feed = findFeed();
    if (!feed) {
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await sleep(500);
        feed = findFeed();
        if (feed) break;
      }
    }
    if (!feed) {
      showToast("No results sidebar! Search Maps first.", "#dc2626");
      err("No feed found");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Loading...", currentPage: 0, totalPages: s.searchScroll || 25, totalFound: 0 });

    await scrollFeed(feed, s.searchScroll || 25, profileWait * 0.4);
    if (SHOULD_STOP) { CAMPAIGN_RUNNING = false; await clearProgress(); return { ok: true, stopped: true }; }

    const places = collectPlaces(feed);
    if (!places.length) {
      showToast("No businesses!", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-places" };
    }

    showToast(`${places.length} businesses found, extracting...`, "#2563eb");

    let saved = 0;
    let errors = 0;
    const limit = Math.min(places.length, target);

    for (let i = 0; i < limit && !SHOULD_STOP; i++) {
      const p = places[i];
      log(`\n--- [${i + 1}/${limit}] ${p.name} ---`);

      await setProgress({
        isRunning: true,
        title: `Profile ${i + 1}/${limit}`,
        currentPage: i + 1,
        totalPages: limit,
        totalFound: saved,
        currentItem: p.name
      });

      try {
        const opened = await openPlace(p, Math.max(15000, profileWait * 2));
        if (!opened) { errors++; continue; }

        let lead = extractDetail();

        if (!lead.title) {
          warn("No title, skip");
          errors++;
          await backToList();
          await sleep(800);
          continue;
        }

        if (wantEnrich && lead.website) {
          await setProgress({ currentItem: `Enriching ${lead.domain}...` });
          log("Enrich:", lead.website);
          lead = await enrichWebsite(lead);
        }

        const filtered = filterLead(lead, fields);
        if (await saveLead(filtered)) saved++;

      } catch (e) {
        err("Loop error:", e);
        errors++;
      }

      try { await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 }); } catch (_) {}

      await backToList();

      let backOk = false;
      for (let w = 0; w < 8000; w += 400) {
        const f = findFeed();
        if (f && f.querySelectorAll('a[href*="/maps/place/"]').length > 0) {
          backOk = true; break;
        }
        await sleep(400);
      }
      if (!backOk) {
        warn("List didn't return, ending");
        break;
      }

      await sleep(jitter(profileWait / 5));
    }

    await setProgress({ isRunning: false, title: "Done", currentItem: `${saved} saved, ${errors} errors` });
    setTimeout(clearProgress, 5000);
    showToast(`Done! Saved ${saved} leads (${errors} errors)`, saved > 0 ? "#22c55e" : "#dc2626");
    log(`===== DONE: ${saved} saved, ${errors} errors =====`);
    CAMPAIGN_RUNNING = false;
    return { ok: true, saved, errors };
  }

  // ============================================================
  // Multi-keyword
  // ============================================================
  async function runMulti() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const kws = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
    const locs = savedLocations.split("\n").map(s => s.trim()).filter(Boolean);
    if (!kws.length) { showToast("No keywords", "#dc2626"); return { ok: false, error: "no-keywords" }; }
    if (isMapsPage() && findFeed()) return await runCampaign();
    location.href = `https://www.google.com/maps/search/${encodeURIComponent(kws[0] + (locs.length ? " " + locs[0] : ""))}`;
    return { ok: true, navigating: true };
  }

  // ============================================================
  // Message router
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "SCRAPE_NOW") {
          if (isMapsPage()) sendResponse(await runCampaign());
          else sendResponse({ ok: false, error: "Open Google Maps first" });
        } else if (msg.type === "STOP_SCRAPE") {
          SHOULD_STOP = true;
          showToast("Stopping...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "RUN_MULTI_CAMPAIGN") {
          sendResponse(await runMulti());
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other" });
        }
      } catch (e) { err("Msg:", e); sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  });

  // ============================================================
  // Auto-start
  // ============================================================
  (async () => {
    log("v6.0 loaded:", location.href);
    if (detectCaptcha().detected) { showToast("CAPTCHA on this page", "#dc2626"); return; }
    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) return;
    if (autoScrape && isMapsPage()) {
      log("Auto-scrape ON, starting in 4s...");
      setTimeout(() => runCampaign(), 4000);
    }
  })();

})();
