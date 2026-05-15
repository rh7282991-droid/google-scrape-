// ============================================
// Maps Lead Scraper Pro — content script
// Senior-grade Google Maps scraper
// ============================================

(function () {
  "use strict";

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================
  // Utilities
  // ============================================
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const log = (...args) => console.log("[MLS]", ...args);

  // Wait for an element to appear, with timeout
  async function waitFor(selectorFn, timeoutMs = 10000, intervalMs = 200) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = selectorFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  // ============================================
  // CAPTCHA Detection
  // ============================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    const bodyText = (document.body?.innerText || "").toLowerCase();
    const phrases = ["unusual traffic", "our systems have detected", "i'm not a robot",
      "verify you are human", "automated queries"];
    for (const phrase of phrases) {
      if (bodyText.includes(phrase)) return { detected: true, type: "challenge-text" };
    }
    if (document.querySelector('#captcha, .g-recaptcha, iframe[src*="recaptcha"]')) {
      return { detected: true, type: "recaptcha-element" };
    }
    return { detected: false };
  }

  async function handleCaptcha(info) {
    const cooldownUntil = Date.now() + 30 * 60 * 1000;
    await chrome.storage.local.set({
      autoScrape: false,
      captchaDetected: { detected: true, type: info.type, detectedAt: Date.now(), cooldownUntil, url: location.href }
    });
    await setProgress({
      isRunning: false, title: "Paused: CAPTCHA detected",
      currentItem: `Cooldown 30 min. Resume after ${new Date(cooldownUntil).toLocaleTimeString()}`
    });
    showToast("CAPTCHA detected. Pausing 30 min.", "#dc2626");
    try {
      await chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", info: { ...info, cooldownUntil, url: location.href } });
      await chrome.runtime.sendMessage({ type: "ACCOUNT_FLAGGED", reason: "captcha" });
    } catch (_) {}
  }

  // ============================================
  // Toast UI
  // ============================================
  function showToast(message, color) {
    let toast = document.getElementById("__mls_toast__");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__mls_toast__";
      Object.assign(toast.style, {
        position: "fixed", bottom: "20px", right: "20px",
        background: "#2563eb", color: "#fff", padding: "12px 16px",
        borderRadius: "10px", font: "13px/1.4 system-ui, sans-serif",
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
    await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
  }

  async function clearProgress() {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }

  // ============================================
  // Page detection
  // ============================================
  function isMapsPage() {
    return /^https?:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)/.test(location.href);
  }

  // ============================================
  // Find the scrollable results sidebar
  // Based on production Google Maps DOM (2024-2025)
  // ============================================
  function findResultsContainer() {
    // Primary: The role="feed" container is the standard for results lists
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;

    // Secondary: Look for the scrollable panel containing place links
    const panels = document.querySelectorAll('div.m6QErb');
    for (const panel of panels) {
      // Must be scrollable AND contain place links
      if (panel.scrollHeight > panel.clientHeight + 50 &&
          panel.querySelector('a[href*="/maps/place/"]')) {
        return panel;
      }
    }

    // Tertiary: Walk up from a place link to find scrollable parent
    const link = document.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
    if (link) {
      let el = link.parentElement;
      while (el && el !== document.body) {
        const style = getComputedStyle(el);
        if ((style.overflowY === "auto" || style.overflowY === "scroll") &&
            el.scrollHeight > el.clientHeight + 50) {
          return el;
        }
        el = el.parentElement;
      }
    }

    return null;
  }

  // Wait for results sidebar to appear (Maps loads asynchronously)
  async function waitForResultsContainer(maxWaitMs = 15000) {
    return await waitFor(() => findResultsContainer(), maxWaitMs, 500);
  }

  // ============================================
  // EXTRACT DATA FROM SIDEBAR CARD
  // This is the KEY function — extract everything we can from the card
  // without clicking it. Google Maps shows: name, rating, reviews,
  // category, address, phone, hours, "open now" status all in card.
  // ============================================
  function extractCardData(card) {
    const out = { scrapedAt: new Date().toISOString() };

    // 1. URL & Title — from the main place link
    const link = card.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
    if (link) {
      out.url = link.href;
      // aria-label has the cleanest title
      out.title = (link.getAttribute("aria-label") || "").trim();
    }

    // Fallback title from heading element
    if (!out.title) {
      const h = card.querySelector('.qBF1Pd, .fontHeadlineSmall, div[role="heading"]');
      if (h) out.title = h.textContent.trim();
    }

    // 2. Rating & Reviews — from .MW4etd (rating) and .UY7F9 (review count)
    const ratingEl = card.querySelector('.MW4etd, span[role="img"][aria-label*="star" i]');
    if (ratingEl) {
      const text = ratingEl.textContent || ratingEl.getAttribute("aria-label") || "";
      const m = text.match(/([\d.]+)/);
      if (m) {
        const r = parseFloat(m[1]);
        if (r > 0 && r <= 5) out.rating = r;
      }
    }

    const reviewEl = card.querySelector('.UY7F9, span[aria-label*="review" i]');
    if (reviewEl) {
      const text = reviewEl.textContent || reviewEl.getAttribute("aria-label") || "";
      const m = text.match(/(\d[\d,]*)/);
      if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""), 10);
    }

    // 3. Category, Address, Phone, Hours — all live in .W4Efsd containers
    // Google Maps uses 2 .W4Efsd divs: first has [type · address], second has [hours · phone]
    const w4Divs = card.querySelectorAll('.W4Efsd');

    if (w4Divs.length > 0) {
      // First W4Efsd: typically "Category · Address" or "Category · Price · Address"
      const firstDiv = w4Divs[0];
      const spans = firstDiv.querySelectorAll('span:not([role])');
      const parts = [];
      spans.forEach(s => {
        const t = s.textContent.trim();
        if (t && t !== "·" && t.length > 0) parts.push(t);
      });

      // Identify: short non-numeric = category; longer with digits = address
      for (const p of parts) {
        if (!p || p === "·") continue;
        if (!out.category && p.length < 50 && !/\d{3,}/.test(p) && !/^\$+$/.test(p)) {
          out.category = p;
        } else if (!out.address && /[a-zA-Z0-9]/.test(p) && p.length > 5 && p.length < 200) {
          // Address usually contains digits or has comma
          if (/\d/.test(p) || p.includes(",")) {
            out.address = p;
          }
        }
      }
    }

    if (w4Divs.length > 1) {
      // Second W4Efsd: typically "Open · Closes 10PM · Phone"
      const secondDiv = w4Divs[1];
      const text = secondDiv.innerText || secondDiv.textContent || "";

      // Extract phone — match international or local formats
      const phoneMatch = text.match(/(\+?\d[\d\s\-().]{7,}\d)/);
      if (phoneMatch) {
        const cleaned = phoneMatch[1].trim();
        const digits = cleaned.replace(/\D/g, "");
        if (digits.length >= 8 && digits.length <= 15) {
          out.phone = cleaned;
        }
      }

      // Extract hours info
      const hoursMatch = text.match(/(Open|Closed|Opens|Closes)[^·\n]*/i);
      if (hoursMatch) out.hours = hoursMatch[0].trim();
    }

    // 4. Website link — sometimes shown as action button on card
    const websiteBtn = card.querySelector('a[data-value="Website"], a[aria-label^="Website" i]');
    if (websiteBtn && websiteBtn.href && !websiteBtn.href.includes("google.com")) {
      out.website = websiteBtn.href;
    }

    // 5. Coordinates — extract from URL (!3d<lat>!4d<lng> pattern)
    if (out.url) {
      const coordMatch = out.url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
      if (coordMatch) {
        out.latitude = parseFloat(coordMatch[1]);
        out.longitude = parseFloat(coordMatch[2]);
      }
    }

    // 6. Domain from website
    if (out.website) {
      try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    return out;
  }

  // ============================================
  // EXTRACT DATA FROM DETAIL PANEL (when user clicks card)
  // Used to fill in missing fields like email, phone, website
  // ============================================
  async function extractDetailPanel() {
    const out = {};

    // Wait up to 5 seconds for the detail panel to load
    await waitFor(() => document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge'), 5000, 200);

    // Title
    const heading = document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge, h1[class*="fontHeadlineLarge"]');
    if (heading) out.title = heading.textContent.trim();

    out.url = location.href;

    // Rating
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    if (ratingEl) {
      const r = parseFloat(ratingEl.textContent);
      if (r > 0 && r <= 5) out.rating = r;
    }

    // Review count
    const reviewBtn = document.querySelector('div.F7nice span[aria-label*="review" i]');
    if (reviewBtn) {
      const m = (reviewBtn.getAttribute("aria-label") || reviewBtn.textContent).match(/(\d[\d,]*)/);
      if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""), 10);
    }

    // Category
    const catBtn = document.querySelector('button[jsaction*="category"], .DkEaL');
    if (catBtn) out.category = catBtn.textContent.trim();

    // Iterate data-item-id elements — this is how Maps marks key info
    document.querySelectorAll('[data-item-id]').forEach(el => {
      const id = (el.getAttribute("data-item-id") || "").toLowerCase();
      const aria = el.getAttribute("aria-label") || "";

      // Address
      if (id === "address" && aria) {
        out.address = aria.replace(/^Address:\s*/i, "").trim();
      }
      // Phone — id is like "phone:tel:+8801234..."
      if (id.startsWith("phone:tel:")) {
        const phone = id.replace("phone:tel:", "").trim();
        if (phone) out.phone = phone;
      }
      // Website — id="authority"
      if (id === "authority") {
        if (el.href && el.href.startsWith("http") && !el.href.includes("google.com")) {
          out.website = el.href;
        } else if (aria) {
          const m = aria.match(/[\w-]+\.[\w.-]+/);
          if (m) out.website = "https://" + m[0];
        }
      }
      // Plus code
      if (id === "oloc") {
        out.plusCode = el.textContent.trim();
      }
      // Hours — id starts with "oh"
      if (id.startsWith("oh")) {
        const hoursText = (aria || el.textContent).split("\n")[0].trim();
        if (hoursText && hoursText.length < 200) out.hours = hoursText;
      }
    });

    // Fallback: tel: links
    if (!out.phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) out.phone = tel.href.replace(/^tel:/, "").trim();
    }

    // Email from mailto links
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) {
      out.email = mailto.href.replace(/^mailto:/, "").split("?")[0].trim();
    }

    // Domain
    if (out.website) {
      try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // Coordinates from URL
    const coordMatch = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/) ||
                       location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (coordMatch) {
      out.latitude = parseFloat(coordMatch[1]);
      out.longitude = parseFloat(coordMatch[2]);
    }

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  // ============================================
  // SCROLL THE RESULTS FEED
  // Google Maps lazy-loads ~20 results per scroll
  // ============================================
  async function scrollResults(container, maxScrolls, onProgress) {
    let lastCardCount = 0;
    let stuckCount = 0;
    const MAX_STUCK = 5;

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      // CAPTCHA check
      if (i % 8 === 0 && i > 0) {
        const cap = detectCaptcha();
        if (cap.detected) { await handleCaptcha(cap); return; }
      }

      // Scroll using THE method that actually works on Maps
      container.scrollTop = container.scrollHeight;

      // Wait for new cards to load (Google needs ~600-1200ms)
      await sleep(rand(900, 1400));

      const cards = container.querySelectorAll('div.Nv2PK, a.hfpxzc');
      const cardCount = cards.length;

      if (onProgress) onProgress(i + 1, cardCount);

      // Check for explicit "end of list" indicator
      // Google shows: <p class="fontBodyMedium"><span>You've reached the end of the list.</span></p>
      const endNode = container.querySelector('p.fontBodyMedium > span, .HlvSq');
      if (endNode) {
        const endText = endNode.textContent.toLowerCase();
        if (endText.includes("end of") || endText.includes("no more")) {
          log(`End reached. Total cards: ${cardCount}`);
          return;
        }
      }

      // Stuck detection — no new cards loaded
      if (cardCount === lastCardCount) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK) {
          log(`No more results loading after ${stuckCount} attempts. Total: ${cardCount}`);
          return;
        }
        // Extra wait when stuck
        await sleep(1500);
      } else {
        stuckCount = 0;
      }
      lastCardCount = cardCount;
    }
  }

  // ============================================
  // GET ALL CARDS from feed
  // Each card is .Nv2PK in modern Maps
  // ============================================
  function getAllCards(container) {
    // Modern: .Nv2PK is the card wrapper
    let cards = Array.from(container.querySelectorAll('div.Nv2PK'));

    // Fallback: find by place link, then walk up to wrapper
    if (cards.length === 0) {
      const links = container.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]');
      const seen = new Set();
      links.forEach(link => {
        const wrapper = link.closest('div.Nv2PK') ||
                        link.closest('div[role="article"]') ||
                        link.closest('div[jsaction]');
        if (wrapper && !seen.has(link.href)) {
          seen.add(link.href);
          cards.push(wrapper);
        }
      });
    }
    return cards;
  }

  // ============================================
  // SAVE LEAD with deduplication
  // ============================================
  async function saveLead(data) {
    if (!data || !data.title) return false;
    const { leads = [] } = await chrome.storage.local.get(["leads"]);

    // Dedup by URL primarily, fall back to title+address
    const exists = leads.some(l =>
      (l.url && data.url && l.url === data.url) ||
      (l.title === data.title && l.address && l.address === data.address)
    );
    if (exists) return false;

    leads.push(data);
    await chrome.storage.local.set({ leads });

    // Update today counter
    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    const newCount = todayLeadDate === today ? todayLeadCount + 1 : 1;
    await chrome.storage.local.set({ todayLeadCount: newCount, todayLeadDate: today });
    return true;
  }

  // ============================================
  // MAIN CAMPAIGN RUNNER
  // Two-pass strategy:
  //   Pass 1: Scroll feed, extract from cards (fast, no CAPTCHA risk)
  //   Pass 2: Optionally click cards that need website/email enrichment
  // ============================================
  async function runMapsCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Campaign already running", "#f59e0b");
      return { ok: false, error: "already-running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    try {
      const settings = await chrome.storage.local.get([
        "targetLeads", "searchScroll", "profileWait", "deepEnrich"
      ]);
      const target = settings.targetLeads || 500;
      const maxScrolls = settings.searchScroll || 50;
      const enrichWebsite = settings.profileWait !== 0; // click to enrich if profileWait > 0

      // 1. CAPTCHA check
      const cap = detectCaptcha();
      if (cap.detected) {
        await handleCaptcha(cap);
        return { ok: false, captcha: true };
      }

      showToast("Starting Maps scrape...", "#2563eb");
      await setProgress({
        isRunning: true, title: "Loading Maps...",
        currentPage: 0, totalPages: maxScrolls, totalFound: 0,
        currentItem: "Waiting for results panel..."
      });

      // 2. Wait for results panel — Maps takes time to load
      const container = await waitForResultsContainer(15000);
      if (!container) {
        showToast("Maps results not found. Please reload the page.", "#dc2626");
        return { ok: false, error: "no-feed" };
      }
      log("Found results container", container);

      // 3. PASS 1 — Scroll and collect all cards
      await setProgress({
        isRunning: true, title: "Scrolling results...",
        currentPage: 0, totalPages: maxScrolls,
        currentItem: "Loading businesses..."
      });

      await scrollResults(container, maxScrolls, async (scroll, count) => {
        await setProgress({
          isRunning: true, title: "Scrolling results...",
          currentPage: scroll, totalPages: maxScrolls,
          currentItem: `Found ${count} businesses`,
          totalFound: count
        });
      });

      if (SHOULD_STOP) return { ok: true, stopped: true };

      // 4. Extract data from each card (sidebar data is rich!)
      const cards = getAllCards(container);
      log(`Got ${cards.length} cards. Extracting data...`);
      showToast(`Found ${cards.length} businesses. Extracting...`, "#2563eb");

      const cardData = [];
      for (const card of cards) {
        const data = extractCardData(card);
        if (data && data.title) cardData.push({ card, data });
        if (cardData.length >= target) break;
      }
      log(`Extracted ${cardData.length} valid records from sidebar`);

      // 5. PASS 2 (optional) — click cards to get website/email if missing
      let totalSaved = 0;
      for (let i = 0; i < cardData.length && !SHOULD_STOP; i++) {
        const { card, data } = cardData[i];

        await setProgress({
          isRunning: true, title: `Processing ${i + 1}/${cardData.length}`,
          currentPage: i + 1, totalPages: cardData.length,
          totalFound: totalSaved,
          currentItem: data.title.slice(0, 40)
        });

        // CAPTCHA check every 15 profiles
        if (i > 0 && i % 15 === 0) {
          const c = detectCaptcha();
          if (c.detected) { await handleCaptcha(c); break; }
        }

        // Enrich with detail panel ONLY if we need website/phone and don't have it
        let finalData = data;
        if (enrichWebsite && (!data.website || !data.phone)) {
          try {
            const link = card.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
            if (link) {
              link.scrollIntoView({ block: "center", behavior: "instant" });
              await sleep(rand(150, 350));
              link.click();
              // Wait for detail panel to render
              await sleep(rand(1500, 2500));

              const detail = await extractDetailPanel();
              // Merge: detail data wins, but keep card data as fallback
              finalData = { ...data, ...detail };
              if (!finalData.title) finalData.title = data.title;

              // Random small delay (anti-detection)
              if (i % 4 === 3) await sleep(rand(800, 1600));
            }
          } catch (e) {
            log("Enrichment failed for", data.title, e.message);
          }
        }

        const saved = await saveLead(finalData);
        if (saved) totalSaved++;

        try {
          await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 });
        } catch (_) {}
      }

      await setProgress({
        isRunning: false, title: "Campaign complete",
        currentItem: `Saved ${totalSaved} new leads`
      });
      setTimeout(clearProgress, 4000);
      showToast(`✓ Done! Saved ${totalSaved} new leads.`, "#22c55e");

      return { ok: true, saved: totalSaved };
    } catch (err) {
      log("Campaign error:", err);
      showToast("Error: " + err.message, "#dc2626");
      return { ok: false, error: err.message };
    } finally {
      CAMPAIGN_RUNNING = false;
    }
  }

  // ============================================
  // Message handler
  // ============================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "SCRAPE_NOW") {
          if (!isMapsPage()) {
            sendResponse({ ok: false, error: "Open Google Maps first" });
            return;
          }
          sendResponse(await runMapsCampaign());
        } else if (msg.type === "STOP_SCRAPE") {
          SHOULD_STOP = true;
          showToast("Stopping...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other" });
        } else {
          sendResponse({ ok: false });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });

  // ============================================
  // Auto-start if autoScrape enabled
  // ============================================
  (async () => {
    if (!isMapsPage()) return;

    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(cap); return; }

    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);

    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
      await setProgress({ isRunning: false, title: "Cooldown", currentItem: `${minsLeft} min remaining` });
      return;
    }

    if (autoScrape) {
      // Wait for Maps to fully load + results to render
      log("Auto-scrape enabled, waiting for Maps...");
      await sleep(2500);
      const container = await waitForResultsContainer(15000);
      if (container) {
        log("Maps ready, starting auto-scrape");
        await runMapsCampaign();
      } else {
        log("Maps results never loaded");
      }
    }
  })();

})();
