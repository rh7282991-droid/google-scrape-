// =====================================================================
// Maps Lead Scraper Pro — content script (v7.0 — STEALTH MODE)
// =====================================================================
// SNAPSHOT ARCHITECTURE:
// 1. CAPTURE mode (fast online):
//    - Click each place, wait briefly, save full HTML of detail panel
//    - No extraction during capture — minimize Google interaction
//    - Each snapshot stored in chrome.storage.local
//
// 2. EXTRACT mode (fully offline):
//    - Parse cached HTMLs with DOMParser
//    - No network, no clicks, no Google contact at all
//    - Can be re-run unlimited times to fix/add fields
//
// 3. PASSIVE mode (background while browsing):
//    - MutationObserver watches detail panel changes
//    - When user manually opens a place, HTML auto-saved
//    - Zero scraper-like behavior — pure "user is browsing"
// =====================================================================

(function () {
  "use strict";

  const log  = (...a) => { try { console.log("%c[MLS]", "color:#2563eb;font-weight:bold", ...a); } catch (_) {} };
  const warn = (...a) => { try { console.warn("%c[MLS]", "color:#f59e0b;font-weight:bold", ...a); } catch (_) {} };
  const err  = (...a) => { try { console.error("%c[MLS]", "color:#dc2626;font-weight:bold", ...a); } catch (_) {} };

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;
  let PASSIVE_OBSERVER = null;
  let PASSIVE_LAST_URL = "";

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (base) => Math.round(base + (Math.random() - 0.5) * base * 0.4);

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
  // Toast (visual feedback on Maps page)
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

  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    return { detected: false };
  }

  // ============================================================
  // FEED finder
  // ============================================================
  function findFeed() {
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;

    const labeled = document.querySelectorAll('div[aria-label]');
    for (const d of labeled) {
      const lbl = (d.getAttribute("aria-label") || "").toLowerCase();
      if (/result/i.test(lbl) && d.querySelector('a[href*="/maps/place/"]')) return d;
    }

    const firstA = document.querySelector('a[href*="/maps/place/"]');
    if (firstA) {
      let el = firstA.parentElement;
      for (let i = 0; i < 15 && el; i++) {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") &&
             el.scrollHeight > el.clientHeight + 80 &&
             el.clientHeight > 200) return el;
        el = el.parentElement;
      }
    }

    return document.querySelector('.m6QErb[role="feed"]') ||
           document.querySelector('.m6QErb.DxyBCb') ||
           document.querySelector('.section-scrollbox') || null;
  }

  // ============================================================
  // SCROLL feed
  // ============================================================
  async function scrollFeed(feed, maxScrolls, waitMs) {
    let lastH = feed.scrollHeight;
    let lastN = 0;
    let stuck = 0;

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
      await sleep(jitter(waitMs));

      const cards = feed.querySelectorAll('a[href*="/maps/place/"]').length;
      log(`Scroll #${i + 1}: ${cards} cards`);

      await setProgress({
        isRunning: true,
        title: "Loading places...",
        currentPage: i + 1,
        totalPages: maxScrolls,
        totalFound: cards,
        currentItem: `${cards} businesses found`
      });

      if (feed.scrollHeight === lastH && cards === lastN) {
        if (++stuck >= 3) break;
      } else stuck = 0;
      lastH = feed.scrollHeight;
      lastN = cards;
    }
  }

  // ============================================================
  // Collect places (URL + name)
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
    return out;
  }

  // ============================================================
  // REAL CLICK (mousedown/up/click events)
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
  // OPEN PLACE (with virtualized-feed scroll fallback)
  // ============================================================
  async function openPlace(place, maxWaitMs) {
    let anchor = null;
    const findAnchor = () => {
      const all = document.querySelectorAll('a[href*="/maps/place/"]');
      for (const a of all) if (a.href === place.href) return a;
      for (const a of all) {
        if ((a.getAttribute("aria-label") || "").trim() === place.name) return a;
      }
      return null;
    };

    anchor = findAnchor();

    if (!anchor) {
      const feed = findFeed();
      if (feed) {
        for (let attempt = 0; attempt < 20 && !anchor; attempt++) {
          feed.scrollBy({ top: 300, behavior: "smooth" });
          await sleep(250);
          anchor = findAnchor();
        }
        if (!anchor) {
          feed.scrollTo({ top: 0, behavior: "smooth" });
          await sleep(400);
          for (let attempt = 0; attempt < 30 && !anchor; attempt++) {
            feed.scrollBy({ top: 400, behavior: "smooth" });
            await sleep(250);
            anchor = findAnchor();
          }
        }
      }
    }

    if (!anchor) { warn("Anchor not found:", place.name); return false; }

    try { anchor.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
    await sleep(300);
    try { anchor.click(); } catch (_) {}
    realClick(anchor);

    // Wait for h1 + data-item-id buttons to appear with NON-results title
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline && !SHOULD_STOP) {
      await sleep(300);
      const h1 = document.querySelector('h1.DUwDvf');
      const hasButtons = document.querySelector('[data-item-id^="phone"], [data-item-id="address"], [data-item-id="authority"]');
      if (h1 && h1.textContent.trim().length > 1 && hasButtons) {
        const t = h1.textContent.trim();
        if (!/^results?\b/i.test(t)) {
          await sleep(jitter(800)); // settle
          return true;
        }
      }
    }
    warn("Panel never opened for:", place.name);
    return false;
  }

  // ============================================================
  // BACK to results list (no history.back!)
  // ============================================================
  async function backToList() {
    const sel = [
      'button[jsaction*="pane.back"]',
      'button[aria-label="Back"]',
      'button[aria-label*="Back" i]',
      'button.hYkMDe',
      '.section-back-to-list-button'
    ];
    for (const s of sel) {
      const btn = document.querySelector(s);
      if (btn && btn.offsetParent !== null) {
        try { btn.click(); } catch (_) {}
        realClick(btn);
        await sleep(1200);
        return;
      }
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await sleep(1200);
  }

  // ============================================================
  // SNAPSHOT helpers
  // ============================================================
  function getDetailRoot() {
    return document.querySelector('div[role="main"]') || null;
  }

  function getCurrentTitle() {
    const root = getDetailRoot();
    if (!root) return "";
    const h1 = root.querySelector('h1.DUwDvf') || root.querySelector('h1');
    return h1 ? h1.textContent.trim() : "";
  }

  function snapshotKey(url) {
    // Use the place slug from URL as unique ID
    const m = (url || location.href).match(/\/maps\/place\/([^/]+)/);
    return m ? decodeURIComponent(m[1]).slice(0, 200) : ("snap_" + Date.now());
  }

  async function saveSnapshot(meta) {
    const root = getDetailRoot();
    if (!root) { warn("No detail root to save"); return false; }

    const title = getCurrentTitle();
    if (!title || /^results?\b/i.test(title)) {
      warn("No real business title, skipping snapshot");
      return false;
    }

    const html = root.outerHTML;
    if (!html || html.length < 500) {
      warn("HTML too small, skipping snapshot");
      return false;
    }

    const id = snapshotKey(location.href);
    const { snapshots = {} } = await chrome.storage.local.get(["snapshots"]);

    if (snapshots[id]) {
      log("Snapshot exists, skipping:", title);
      return false;
    }

    snapshots[id] = {
      id,
      title,
      url: location.href,
      html,
      capturedAt: new Date().toISOString(),
      mode: meta?.mode || "capture"
    };
    await chrome.storage.local.set({ snapshots });
    log("✓ Snapshot saved:", title, `(${(html.length / 1024).toFixed(1)}KB)`);
    return true;
  }

  // ============================================================
  // CAPTURE CAMPAIGN — click + save HTML, no extraction
  // ============================================================
  async function runCaptureCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Already running", "#f59e0b");
      return { ok: false, error: "running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    const s = await chrome.storage.local.get(["targetLeads", "searchScroll", "profileWait"]);
    const target = s.targetLeads || 100;
    const profileWait = (s.profileWait || 7) * 1000;

    log("===== CAPTURE START =====");
    showToast("Capturing... (no extraction yet)", "#2563eb");

    if (detectCaptcha().detected) {
      showToast("CAPTCHA detected — stopping", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    await sleep(1000);

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
      showToast("No results sidebar — search Maps first", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Loading places...", currentPage: 0, totalPages: s.searchScroll || 25, totalFound: 0 });
    await scrollFeed(feed, s.searchScroll || 25, profileWait * 0.4);
    if (SHOULD_STOP) { CAMPAIGN_RUNNING = false; await clearProgress(); return { ok: true, stopped: true }; }

    const places = collectPlaces(feed);
    if (!places.length) {
      showToast("No businesses!", "#dc2626");
      CAMPAIGN_RUNNING = false;
      return { ok: false, error: "no-places" };
    }

    showToast(`Capturing ${places.length} places...`, "#2563eb");

    let captured = 0;
    let errors = 0;
    const limit = Math.min(places.length, target);

    for (let i = 0; i < limit && !SHOULD_STOP; i++) {
      const p = places[i];
      log(`\n[CAPTURE ${i + 1}/${limit}] ${p.name}`);

      await setProgress({
        isRunning: true,
        title: `Capturing ${i + 1}/${limit}`,
        currentPage: i + 1,
        totalPages: limit,
        totalFound: captured,
        currentItem: p.name
      });

      try {
        const opened = await openPlace(p, Math.max(12000, profileWait * 1.6));
        if (!opened) { errors++; continue; }

        // SAVE SNAPSHOT — no extraction
        const saved = await saveSnapshot({ mode: "capture" });
        if (saved) captured++;

      } catch (e) {
        err("Capture error:", e);
        errors++;
      }

      try { await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 }); } catch (_) {}

      await backToList();

      // Wait for list to come back
      let backOk = false;
      for (let w = 0; w < 6000; w += 400) {
        const f = findFeed();
        if (f && f.querySelectorAll('a[href*="/maps/place/"]').length > 0) {
          backOk = true; break;
        }
        await sleep(400);
      }
      if (!backOk) { warn("List didn't return"); break; }

      // Short pace between captures (no extraction = faster)
      await sleep(jitter(profileWait / 4));
    }

    await setProgress({ isRunning: false, title: "Capture done", currentItem: `${captured} snapshots saved` });
    setTimeout(clearProgress, 4000);
    showToast(`Captured ${captured} HTMLs! Now click "Extract" offline.`, captured > 0 ? "#22c55e" : "#dc2626");
    log(`===== CAPTURE DONE: ${captured} snapshots, ${errors} errors =====`);
    CAMPAIGN_RUNNING = false;
    return { ok: true, captured, errors };
  }

  // ============================================================
  // EXTRACT FROM CACHE — fully offline, runs in this tab's
  // context but no Google interaction (just parses stored HTMLs)
  // ============================================================
  function txt(el) { if (!el) return ""; return (el.textContent || "").replace(/\s+/g, " ").trim(); }

  function extractTitleDoc(root) {
    const candidates = [
      txt(root.querySelector('h1.DUwDvf')),
      txt(root.querySelector('h1.fontHeadlineLarge')),
      txt(root.querySelector('h1'))
    ];
    for (const t of candidates) {
      if (t && !/^results?\b/i.test(t)) return t;
    }
    return "";
  }

  function extractPhoneDoc(root) {
    const phoneEl = root.querySelector('[data-item-id^="phone:tel:"]');
    if (phoneEl) {
      const id = phoneEl.getAttribute("data-item-id");
      const num = id.replace(/^phone:tel:/, "").trim();
      if (num) return num;
    }
    const tel = root.querySelector('a[href^="tel:"]');
    if (tel) return tel.getAttribute("href").replace(/^tel:/, "").trim();
    const phoneAria = root.querySelector('button[aria-label^="Phone:" i]');
    if (phoneAria) {
      const m = (phoneAria.getAttribute("aria-label") || "").match(/(\+?[\d][\d\s\-().]{6,}\d)/);
      if (m) return m[1].trim();
    }
    return "";
  }

  function extractAddressDoc(root) {
    const a = root.querySelector('[data-item-id="address"]');
    if (a) {
      const t = txt(a.querySelector('.Io6YTe')) || txt(a.querySelector('.rogA2c'));
      if (t) return t;
      const aria = a.getAttribute("aria-label") || "";
      const cleaned = aria.replace(/^Address:\s*/i, "").trim();
      if (cleaned) return cleaned;
    }
    const aria = root.querySelector('button[aria-label^="Address:" i]');
    if (aria) return aria.getAttribute("aria-label").replace(/^Address:\s*/i, "").trim();
    return "";
  }

  function extractWebsiteDoc(root) {
    const a = root.querySelector('a[data-item-id="authority"]');
    if (a) {
      const href = a.getAttribute("href") || "";
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

  function extractCategoryDoc(root) {
    return txt(root.querySelector('button.DkEaL')) ||
           txt(root.querySelector('button[jsaction*="category"]')) ||
           txt(root.querySelector('.DkEaL'));
  }

  function extractRatingDoc(root) {
    const fnice = root.querySelector('div.F7nice');
    if (fnice) {
      const span = fnice.querySelector('span[aria-hidden="true"]');
      if (span) {
        const r = parseFloat(txt(span).replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) return r;
      }
    }
    const star = root.querySelector('span[aria-label*="star" i]');
    if (star) {
      const m = (star.getAttribute("aria-label") || "").match(/([\d.,]+)/);
      if (m) {
        const r = parseFloat(m[1].replace(",", "."));
        if (isFinite(r) && r > 0 && r <= 5) return r;
      }
    }
    return null;
  }

  function extractReviewCountDoc(root) {
    const fnice = root.querySelector('div.F7nice');
    if (fnice) {
      const r = fnice.querySelector('span[aria-label*="review" i]');
      if (r) {
        const m = (r.getAttribute("aria-label") || "").match(/([\d,.\s]+)/);
        if (m) {
          const n = parseInt(m[1].replace(/[,.\s]/g, ""), 10);
          if (n > 0) return n;
        }
      }
      const m2 = (fnice.textContent || "").match(/\(\s*([\d,.\s]+)\s*\)/);
      if (m2) {
        const n = parseInt(m2[1].replace(/[,.\s]/g, ""), 10);
        if (n > 0) return n;
      }
    }
    return null;
  }

  function extractHoursDoc(root) {
    const el = root.querySelector('[data-item-id^="oh"]') ||
               root.querySelector('button[aria-label*="Hours" i]');
    if (el) {
      const t = txt(el.querySelector('.Io6YTe')) || txt(el);
      if (t) return t.split("\n")[0];
    }
    return "";
  }

  function extractPlusCodeDoc(root) {
    const el = root.querySelector('[data-item-id="oloc"]') ||
               root.querySelector('[data-item-id="plus_code"]');
    if (el) {
      const t = txt(el.querySelector('.Io6YTe')) || txt(el);
      if (t) return t;
    }
    return "";
  }

  function extractCoordsFromUrl(url) {
    const m1 = url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
    const m2 = url.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
    return { lat: null, lng: null };
  }

  function parseSnapshotToLead(snap) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(snap.html, "text/html");
    const root = doc.body;

    const c = extractCoordsFromUrl(snap.url || "");
    const lead = {
      title: extractTitleDoc(root) || snap.title || "",
      phone: extractPhoneDoc(root),
      address: extractAddressDoc(root),
      website: extractWebsiteDoc(root),
      category: extractCategoryDoc(root),
      rating: extractRatingDoc(root),
      reviewCount: extractReviewCountDoc(root),
      hours: extractHoursDoc(root),
      plusCode: extractPlusCodeDoc(root),
      latitude: c.lat,
      longitude: c.lng,
      url: snap.url || "",
      domain: "",
      email: "",
      facebook: "", instagram: "", twitter: "", youtube: "", linkedin: "",
      scrapedAt: snap.capturedAt
    };

    if (lead.website) {
      try { lead.domain = new URL(lead.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }
    const mailto = root.querySelector('a[href^="mailto:"]');
    if (mailto) lead.email = mailto.getAttribute("href").replace(/^mailto:/, "").split("?")[0].trim();

    return lead;
  }

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

  async function saveLead(data) {
    if (!data.title || /^results?\b/i.test(data.title)) return false;

    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const dup = leads.some(l =>
      (l.url && l.url === data.url) ||
      (l.title && data.title && l.title === data.title && (l.address || "") === (data.address || ""))
    );
    if (dup) return false;

    leads.push(data);
    await chrome.storage.local.set({ leads });

    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = (todayLeadDate === today) ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });
    return true;
  }

  // ============================================================
  // EXTRACT FROM CACHE — process all snapshots offline
  // ============================================================
  async function runExtractFromCache() {
    log("===== EXTRACT FROM CACHE START =====");
    const { snapshots = {}, fields = {} } = await chrome.storage.local.get(["snapshots", "fields"]);
    const ids = Object.keys(snapshots);
    if (!ids.length) {
      showToast("No snapshots cached. Run Capture first.", "#dc2626");
      return { ok: false, error: "no-snapshots" };
    }

    const wantEnrich = !!(fields.email || fields.facebook || fields.instagram ||
                          fields.twitter || fields.youtube || fields.linkedin);

    showToast(`Extracting ${ids.length} cached HTMLs offline...`, "#2563eb");

    let saved = 0;
    let errors = 0;
    let processed = 0;

    for (const id of ids) {
      processed++;
      const snap = snapshots[id];

      await setProgress({
        isRunning: true,
        title: `Extract ${processed}/${ids.length}`,
        currentPage: processed,
        totalPages: ids.length,
        totalFound: saved,
        currentItem: snap.title
      });

      try {
        let lead = parseSnapshotToLead(snap);
        if (!lead.title) { errors++; continue; }

        log(`[${processed}/${ids.length}] EXTRACTED:`, {
          title: lead.title, phone: lead.phone, website: lead.website,
          address: lead.address?.slice(0, 50)
        });

        if (wantEnrich && lead.website) {
          await setProgress({ currentItem: `Enriching ${lead.domain}...` });
          lead = await enrichWebsite(lead);
        }

        const filtered = filterLead(lead, fields);
        if (await saveLead(filtered)) saved++;

      } catch (e) {
        err("Extract error for snapshot:", id, e);
        errors++;
      }
    }

    await setProgress({ isRunning: false, title: "Extract done", currentItem: `${saved} leads saved` });
    setTimeout(clearProgress, 4000);
    showToast(`Extracted ${saved} leads from ${ids.length} snapshots!`, saved > 0 ? "#22c55e" : "#dc2626");
    log(`===== EXTRACT DONE: ${saved} saved, ${errors} errors =====`);
    return { ok: true, saved, errors, processed: ids.length };
  }

  // ============================================================
  // PASSIVE CAPTURE — auto-save HTML while user manually browses
  // ============================================================
  function startPassiveCapture() {
    if (PASSIVE_OBSERVER) return;

    log("Passive capture: ON");
    showToast("Passive capture active — just browse Maps", "#22c55e");

    PASSIVE_LAST_URL = location.href;

    const tryCapture = async () => {
      try {
        // Only fire when URL contains /maps/place/ AND title is real
        if (!/\/maps\/place\//.test(location.href)) return;
        if (location.href === PASSIVE_LAST_URL) return;

        const root = getDetailRoot();
        if (!root) return;
        const h1 = root.querySelector('h1.DUwDvf');
        const hasButtons = root.querySelector('[data-item-id^="phone"], [data-item-id="address"], [data-item-id="authority"]');
        if (!h1 || !hasButtons) return;
        const title = h1.textContent.trim();
        if (!title || /^results?\b/i.test(title)) return;

        // Wait a tick to make sure DOM is settled
        await sleep(800);
        const saved = await saveSnapshot({ mode: "passive" });
        if (saved) {
          PASSIVE_LAST_URL = location.href;
          // Show small unobtrusive toast
          showToast(`✓ Cached: ${title}`, "#22c55e");
        }
      } catch (e) { warn("passive capture err:", e); }
    };

    // Watch for URL changes (Maps SPA)
    const urlWatcher = setInterval(() => {
      if (location.href !== PASSIVE_LAST_URL) {
        tryCapture();
      }
    }, 1500);

    // Watch for DOM mutations in main panel
    PASSIVE_OBSERVER = new MutationObserver(() => {
      tryCapture();
    });
    PASSIVE_OBSERVER.observe(document.body, { childList: true, subtree: true });
    PASSIVE_OBSERVER._urlWatcher = urlWatcher;

    // Also try once now if a place is already open
    tryCapture();
  }

  function stopPassiveCapture() {
    if (PASSIVE_OBSERVER) {
      PASSIVE_OBSERVER.disconnect();
      if (PASSIVE_OBSERVER._urlWatcher) clearInterval(PASSIVE_OBSERVER._urlWatcher);
      PASSIVE_OBSERVER = null;
      log("Passive capture: OFF");
      showToast("Passive capture stopped", "#f59e0b");
    }
  }

  // ============================================================
  // Multi-keyword launcher
  // ============================================================
  async function runMulti() {
    const { savedKeywords = "", savedLocations = "" } = await chrome.storage.local.get(["savedKeywords", "savedLocations"]);
    const kws = savedKeywords.split("\n").map(s => s.trim()).filter(Boolean);
    const locs = savedLocations.split("\n").map(s => s.trim()).filter(Boolean);
    if (!kws.length) { showToast("No keywords", "#dc2626"); return { ok: false, error: "no-keywords" }; }
    if (isMapsPage() && findFeed()) return await runCaptureCampaign();
    location.href = `https://www.google.com/maps/search/${encodeURIComponent(kws[0] + (locs.length ? " " + locs[0] : ""))}`;
    return { ok: true, navigating: true };
  }

  // ============================================================
  // MESSAGE ROUTER
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "CAPTURE_NOW") {
          if (isMapsPage()) sendResponse(await runCaptureCampaign());
          else sendResponse({ ok: false, error: "Open Google Maps first" });
        } else if (msg.type === "EXTRACT_FROM_CACHE") {
          sendResponse(await runExtractFromCache());
        } else if (msg.type === "SCRAPE_NOW") {
          // Legacy alias — runs CAPTURE then EXTRACT
          if (isMapsPage()) {
            const cap = await runCaptureCampaign();
            if (cap.ok && cap.captured > 0) {
              const ext = await runExtractFromCache();
              sendResponse({ ok: true, captured: cap.captured, saved: ext.saved });
            } else sendResponse(cap);
          } else sendResponse({ ok: false, error: "Open Google Maps first" });
        } else if (msg.type === "STOP_SCRAPE") {
          SHOULD_STOP = true;
          showToast("Stopping...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "PASSIVE_START") {
          if (isMapsPage()) { startPassiveCapture(); sendResponse({ ok: true }); }
          else sendResponse({ ok: false, error: "Open Google Maps first" });
        } else if (msg.type === "PASSIVE_STOP") {
          stopPassiveCapture();
          sendResponse({ ok: true });
        } else if (msg.type === "RUN_MULTI_CAMPAIGN") {
          sendResponse(await runMulti());
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other" });
        }
      } catch (e) { err("msg err:", e); sendResponse({ ok: false, error: String(e?.message || e) }); }
    })();
    return true;
  });

  // ============================================================
  // AUTO-START
  // ============================================================
  (async () => {
    log("v7.0 loaded:", location.href);
    if (detectCaptcha().detected) { showToast("CAPTCHA on this page", "#dc2626"); return; }
    const { autoScrape, passiveOn, captchaDetected } = await chrome.storage.local.get(["autoScrape", "passiveOn", "captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) return;
    if (passiveOn && isMapsPage()) {
      log("Passive ON, starting...");
      setTimeout(() => startPassiveCapture(), 2000);
    }
    if (autoScrape && isMapsPage()) {
      log("Auto-capture ON, starting in 4s...");
      setTimeout(() => runCaptureCampaign(), 4000);
    }
  })();

})();
