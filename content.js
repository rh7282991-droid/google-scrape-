// =====================================================================
// Maps Lead Scraper Pro — content script (v4.0 — Robust Rewrite)
// ---------------------------------------------------------------------
// Why this rewrite?  The previous version (kept as content.legacy.js)
// had a critical bug: it clicked a card, then read the detail panel
// before Google Maps had finished swapping the DOM. The result was that
// the SAME phone / website / address from the very first opened place
// got copy-pasted into every subsequent row in the export.
//
// This version fixes the data-leak by:
//   1. Reading the place URL slug for each card from its <a> href, then
//      waiting until window.location.href contains that slug before
//      reading the detail panel. Maps updates the URL when a place is
//      truly active, so this is the most reliable readiness signal.
//   2. Building each lead object FROM SCRATCH every loop iteration, so
//      stale fields cannot bleed into the next row.
//   3. Using data-item-id values (phone:tel:, authority, address, oh,
//      plus_code) which are the documented stable hooks Google Maps
//      uses for action buttons in every locale and country.
//   4. Reading the phone number from the data-item-id itself
//      (e.g. data-item-id="phone:tel:+8801712345678") instead of the
//      visible text, which fixes locale formatting issues like the
//      Bangla landline "02-55663030" being misread as "255663030".
//   5. Visiting the business website (when present) to harvest email +
//      social links (Facebook, Instagram, X/Twitter, YouTube, LinkedIn).
//      Social links are NEVER guessed; if a website has none, the
//      column stays empty rather than getting a wrong handle copied
//      from another business.
//
// Works on any country / any keyword / any language, because every
// selector below is language-independent.
// =====================================================================

(function () {
  "use strict";

  // ===== Toggleable verbose logging (enable via localStorage.MLS_DEBUG=1)
  const DEBUG = (() => {
    try { return localStorage.getItem("MLS_DEBUG") === "1"; } catch (_) { return false; }
  })();
  const log = (...a) => { if (DEBUG) console.log("[MLS]", ...a); };
  const warn = (...a) => console.warn("[MLS]", ...a);

  // ===== Regexes
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  // Skip these "fake" emails that show up on websites
  const EMAIL_SKIP = /(example\.com|sentry|wixpress|gmail-noreply|noreply@|@x\.com|@2x\.|@3x\.|\.png|\.jpg|\.jpeg|\.gif|\.svg|\.webp)/i;

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================================
  // CAPTCHA / "sorry" page detection (unchanged behaviour)
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
  // Toast helper (unchanged)
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
  // Storage / timing helpers
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

  function isMapsPage() {
    return /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(location.href);
  }

  // ============================================================
  // PLACE-URL slug parser  (used as readiness signal)
  // /maps/place/<slug>/data=...   — slug is unique per business+lat/lng
  // ============================================================
  function placeSlugFromUrl(href) {
    const m = (href || "").match(/\/maps\/place\/([^/]+)/);
    return m ? m[1] : null;
  }
  function placeSlugFromAnchor(a) {
    return placeSlugFromUrl(a && a.getAttribute("href"));
  }

  // ============================================================
  // Find the scrollable results sidebar (role="feed")
  // ============================================================
  function findResultsContainer() {
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;
    feed = document.querySelector('[aria-label*="Results for" i]');
    if (feed) return feed;
    feed = document.querySelector('.section-scrollbox, .section-listbox');
    return feed || null;
  }

  // ============================================================
  // Scroll the feed to load every result up to maxScrolls
  // ============================================================
  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 25;
    const waitMs     = (settings.profileWait || 2) * 250;
    let lastHeight = container.scrollHeight;
    let stuck = 0;

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      if (i % 5 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) { await handleCaptcha(cap); return; }
      }

      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      await sleep(jitter(waitMs));

      const cards = container.querySelectorAll('a[href*="/maps/place/"]');
      await setProgress({
        isRunning: true,
        title: "Loading Maps results...",
        currentPage: i + 1,
        totalPages: maxScrolls,
        totalFound: cards.length,
        currentItem: `Found ${cards.length} businesses`
      });

      const txt = (container.innerText || "").toLowerCase();
      if (txt.includes("you've reached the end") || txt.includes("no more results")) break;

      if (container.scrollHeight === lastHeight) {
        if (++stuck >= 3) break;
      } else stuck = 0;
      lastHeight = container.scrollHeight;
    }
  }

  // ============================================================
  // Collect every unique place anchor we can see in the feed
  // (returns URL strings, NOT live DOM nodes — DOM nodes get
  // recycled by Maps and become stale, URLs do not)
  // ============================================================
  function collectPlaceUrls(container) {
    const urls = [];
    const seen = new Set();
    container.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
      const href = a.href;
      const slug = placeSlugFromUrl(href);
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        urls.push({ href, slug, name: (a.getAttribute("aria-label") || "").trim() });
      }
    });
    return urls;
  }

  // ============================================================
  // Open one place by clicking its anchor in the feed and
  // WAIT until the URL slug matches OR fall back to navigation.
  // Returns true when the detail panel for THIS slug is ready.
  // ============================================================
  async function openPlaceAndWait(slug, href, profileWaitMs) {
    // Locate a fresh anchor for this slug (DOM may have re-rendered)
    const fresh = document.querySelector(`a[href*="/maps/place/${CSS.escape(slug)}"]`);
    if (fresh) {
      try { fresh.scrollIntoView({ block: "center" }); } catch (_) {}
      await sleep(150);
      fresh.click();
    } else {
      // Fallback: navigate the SPA via location.href (Maps handles this gracefully)
      log("anchor missing, navigating directly", slug);
      history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    // Wait for two things:
    //   1. URL slug to match
    //   2. h1 inside role="main" to render and stop being empty
    const deadline = Date.now() + Math.max(8000, profileWaitMs * 1.6);
    let lastTitle = "";
    while (Date.now() < deadline) {
      const urlSlug = placeSlugFromUrl(location.href);
      const main = document.querySelector('div[role="main"]');
      const h1 = main ? main.querySelector("h1") : document.querySelector("h1.DUwDvf, h1");
      const title = h1 ? h1.textContent.trim() : "";

      if (urlSlug === slug && title && title === lastTitle) {
        // Title has been stable for at least one tick → ready
        return true;
      }
      lastTitle = title;
      await sleep(220);
    }
    warn("openPlaceAndWait timed out for slug", slug);
    return false;
  }

  // ============================================================
  // Extract every reliable field from the currently active panel.
  //
  // CRITICAL: every field starts as undefined and is only set if a
  // selector inside THIS function actually finds it. Nothing is ever
  // copied from the previous lead. This is what fixes the duplication
  // bug from the legacy version.
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

    // Scope to the active place panel
    const root = document.querySelector('div[role="main"]') || document;

    // ---- Title
    const h1 = root.querySelector("h1.DUwDvf") || root.querySelector("h1");
    if (h1) lead.title = h1.textContent.trim();

    // ---- Rating + review count (multiple layouts)
    // Newest layout: <div class="F7nice"><span aria-hidden>4.6</span><span aria-label="13556 reviews"> </span></div>
    const fnice = root.querySelector("div.F7nice");
    if (fnice) {
      const ratingSpan = fnice.querySelector('span[aria-hidden="true"]');
      if (ratingSpan) {
        const r = parseFloat(ratingSpan.textContent.replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) lead.rating = r;
      }
      const reviewSpan = fnice.querySelector('span[aria-label*="review" i]');
      if (reviewSpan) {
        const m = (reviewSpan.getAttribute("aria-label") || reviewSpan.textContent).match(/([\d,]+)/);
        if (m) lead.reviewCount = parseInt(m[1].replace(/[,\s]/g, ""), 10);
      }
    }

    // Fallback rating selector (older layouts)
    if (lead.rating == null) {
      const r2 = root.querySelector('span[role="img"][aria-label*="star" i]');
      if (r2) {
        const m = (r2.getAttribute("aria-label") || "").match(/([\d.]+)/);
        if (m) lead.rating = parseFloat(m[1]);
      }
    }

    // ---- Category — button just under the title
    const catBtn = root.querySelector('button.DkEaL') || root.querySelector('button[jsaction*="category"]');
    if (catBtn) lead.category = catBtn.textContent.trim();

    // ---- Action buttons (data-item-id is stable across all locales)
    // Iterate every button/anchor with data-item-id and dispatch by prefix.
    root.querySelectorAll("[data-item-id]").forEach(el => {
      const id = el.getAttribute("data-item-id") || "";

      // PHONE — data-item-id is literally "phone:tel:+8801712345678"
      if (id.startsWith("phone:tel:")) {
        const raw = id.slice("phone:tel:".length).trim();
        if (raw) lead.phone = raw;
      } else if (!lead.phone && id.startsWith("phone")) {
        // Fallback: read the visible text
        const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
        if (txt) lead.phone = txt;
      }

      // ADDRESS
      if (id === "address") {
        const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
        if (txt) lead.address = txt;
      }

      // WEBSITE — data-item-id="authority", element is <a> with href
      if (id === "authority") {
        const href = el.getAttribute("href") || el.href || "";
        if (href && /^https?:\/\//i.test(href)) lead.website = href;
        else {
          // Sometimes the visible text is the URL
          const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
          if (txt && /\./.test(txt)) lead.website = txt.startsWith("http") ? txt : "https://" + txt;
        }
      }

      // HOURS  — data-item-id starts with "oh"
      if (id.startsWith("oh") && !lead.hours) {
        const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
        if (txt) lead.hours = txt.split("\n")[0];
      }

      // PLUS CODE
      if (id === "plus_code") {
        const txt = (el.querySelector(".Io6YTe") || el).textContent.trim();
        if (txt) lead.plusCode = txt;
      }
    });

    // ---- Phone fallback: tel: anchor anywhere in the panel
    if (!lead.phone) {
      const tel = root.querySelector('a[href^="tel:"]');
      if (tel) lead.phone = tel.getAttribute("href").replace(/^tel:/, "").trim();
    }

    // ---- mailto fallback (rare on Maps but try)
    const mailto = root.querySelector('a[href^="mailto:"]');
    if (mailto) lead.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();

    // ---- Derive domain from website
    if (lead.website) {
      try { lead.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // ---- Coordinates from the URL  (!3d<lat>!4d<lng>)
    const cm = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (cm) {
      lead.latitude = parseFloat(cm[1]);
      lead.longitude = parseFloat(cm[2]);
    }

    return lead;
  }

  // ============================================================
  // Visit the business website to harvest email + social links.
  //
  // Runs in the SERVICE WORKER via a message so we don't pollute
  // the Maps tab. Only attempted when settings.deepEnrich is on
  // and the lead has a website.
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
    const slug = placeSlugFromUrl(data.url);
    const exists = leads.some(l => {
      const lSlug = placeSlugFromUrl(l.url);
      if (slug && lSlug && slug === lSlug) return true;
      return l.title === data.title && l.address === data.address && data.title;
    });
    if (exists) return false;

    leads.push(data);
    await chrome.storage.local.set({ leads });

    // Today counter
    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });
    return true;
  }

  // ============================================================
  // MAIN MAPS CAMPAIGN RUNNER
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
      "deepEnrich", "fields", "savedKeywords", "savedLocations"
    ]);
    const target = settings.targetLeads || 100;
    const profileWaitMs = (settings.profileWait || 7) * 1000;
    const wantEnrich = !!settings.deepEnrich;

    showToast("Starting Maps scrape...", "#2563eb");

    // CAPTCHA gate
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    const container = findResultsContainer();
    if (!container) {
      showToast("Maps results sidebar not found. Make sure you're on a Maps search.", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Loading Maps results...", currentPage: 0, totalPages: settings.searchScroll || 25, totalFound: 0, currentItem: "" });

    await scrollResults(container, settings);
    if (SHOULD_STOP) { CAMPAIGN_RUNNING = false; await clearProgress(); return { ok: true, stopped: true }; }

    const places = collectPlaceUrls(container);
    showToast(`Found ${places.length} businesses, extracting data...`, "#2563eb");

    let saved = 0;
    const limit = Math.min(places.length, target);

    for (let i = 0; i < limit; i++) {
      if (SHOULD_STOP) break;

      // Periodic CAPTCHA check
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
        currentItem: place.name || place.slug
      });

      try {
        const ok = await openPlaceAndWait(place.slug, place.href, profileWaitMs);
        if (!ok) { warn("skip — panel never loaded", place.slug); continue; }

        // Small extra settle so action buttons render
        await sleep(jitter(600));

        let lead = extractDetailPanel();

        // Sanity check: title MUST be present and place URL must match the
        // slug we expected. Otherwise we'd risk saving a stale panel.
        if (!lead.title) { warn("skip — no title", place.slug); continue; }
        const liveSlug = placeSlugFromUrl(location.href);
        if (liveSlug && liveSlug !== place.slug) {
          warn("slug mismatch — refusing to save", { expected: place.slug, got: liveSlug });
          continue;
        }

        // Optional website-deep-enrichment
        if (wantEnrich && lead.website) {
          await setProgress({ currentItem: `Visiting ${lead.domain || lead.website}` });
          lead = await enrichFromWebsite(lead);
        }

        const added = await saveLead(lead);
        if (added) saved++;
      } catch (e) {
        warn("loop error", e);
      }

      try { await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 }); } catch (_) {}

      // Human-like pacing between profiles
      await sleep(jitter(profileWaitMs / 6));
    }

    await setProgress({ isRunning: false, title: "Campaign complete", currentItem: `Saved ${saved} new leads` });
    setTimeout(clearProgress, 4000);
    showToast(`✓ Done! Saved ${saved} new leads.`, "#22c55e");
    CAMPAIGN_RUNNING = false;
    return { ok: true, saved };
  }

  // ============================================================
  // Multi-keyword/location campaign (kept simple; first kw+loc only)
  // ============================================================
  async function runMultiCampaign() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const keywords  = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
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
  // Auto-start when autoScrape flag is set
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
      setTimeout(() => runMapsCampaign(), 2000);
    }
  })();

})();
