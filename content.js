// ============================================
// Maps Lead Scraper Pro — content script
// Extracts business profiles from Google Maps
// ============================================

(function () {
  "use strict";

  // ===== Regex helpers =====
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

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
  // GOOGLE MAPS SCRAPER (Main feature)
  // ============================================

  // Find the scrollable results sidebar — updated for 2024/2025 Google Maps DOM
  function findResultsContainer() {
    // 1. Modern Google Maps: role="feed" (most common in 2024+)
    let feed = document.querySelector('div[role="feed"]');
    if (feed) return feed;

    // 2. The main scrollable panel with results (class-based)
    feed = document.querySelector('div.m6QErb[aria-label]');
    if (feed) return feed;

    // 3. Scrollable div inside the results panel
    feed = document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
    if (feed) return feed;

    // 4. Any aria-label containing "Results"
    feed = document.querySelector('[aria-label*="Results for" i]');
    if (feed) return feed;
    feed = document.querySelector('[aria-label*="Results" i]');
    if (feed) return feed;

    // 5. The scrollable container that holds place cards
    feed = document.querySelector('div.m6QErb.WNBkOb');
    if (feed) return feed;

    // 6. Generic fallback: find any scrollable div with place links
    const allDivs = document.querySelectorAll('div[role="main"] div');
    for (const div of allDivs) {
      if (div.scrollHeight > div.clientHeight && div.querySelector('a[href*="/maps/place/"]')) {
        return div;
      }
    }

    // 7. Older layout selectors
    feed = document.querySelector('.section-scrollbox, .section-listbox');
    if (feed) return feed;

    // 8. Last resort: any parent of place links that is scrollable
    const firstPlaceLink = document.querySelector('a[href*="/maps/place/"]');
    if (firstPlaceLink) {
      let parent = firstPlaceLink.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 100) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }

    return null;
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
      // Multiple heading selectors for different Maps versions
      const heading = card.querySelector(
        'div[role="heading"], .fontHeadlineSmall, .qBF1Pd, .NrDZNb, .dbg0pd'
      );
      if (heading) out.title = heading.textContent.trim();
    }
    // Clean title — remove trailing noise
    if (out.title) out.title = out.title.replace(/\s*·\s*$/, "").trim();

    // Rating + reviews count — multiple selector strategies
    let ratingEl = card.querySelector('span[role="img"][aria-label*="star" i]');
    if (!ratingEl) ratingEl = card.querySelector('.MW4etd, .ZkP5Je');
    if (ratingEl) {
      const lbl = ratingEl.getAttribute("aria-label") || ratingEl.textContent || "";
      const m = lbl.match(/([\d.]+)\s*star/i) || lbl.match(/([\d.]+)/);
      if (m) out.rating = parseFloat(m[1]);
    }
    // Review count
    let reviewEl = card.querySelector('.UY7F9, span[aria-label*="review" i]');
    if (reviewEl) {
      const lbl = reviewEl.getAttribute("aria-label") || reviewEl.textContent || "";
      const m2 = lbl.match(/(\d[\d,]*)/);
      if (m2) out.reviewCount = parseInt(m2[1].replace(/,/g, ""));
    }
    if (!out.reviewCount && ratingEl) {
      const lbl = ratingEl.getAttribute("aria-label") || "";
      const m2 = lbl.match(/(\d[\d,]*)\s*review/i);
      if (m2) out.reviewCount = parseInt(m2[1].replace(/,/g, ""));
    }

    // Category, address, hours from text spans
    const allText = card.innerText || "";
    const lines = allText.split("\n").map(l => l.trim()).filter(Boolean);

    // Phone — search whole text
    const phoneMatch = allText.match(/\+?[\d][\d\s\-().]{7,}\d/);
    if (phoneMatch) out.phone = phoneMatch[0].trim();

    // Try to identify address (line with digits + text, typical address pattern)
    for (const line of lines) {
      if (line === out.title) continue;
      if (line === out.category) continue;
      // Address patterns: contains number + letters, reasonable length
      if (/\d/.test(line) && /[a-zA-Z\u0980-\u09FF]/.test(line) && line.length > 6 && line.length < 150) {
        // Skip if it looks like rating/review text
        if (/^\d+\.\d+$/.test(line) || /star|review/i.test(line)) continue;
        if (!out.address) {
          out.address = line;
          break;
        }
      }
    }

    // Category: look for specific element or use position heuristics
    const catEl = card.querySelector('.W4Efsd .W4Efsd:first-child span:not([role])');
    if (catEl && catEl.textContent.trim().length < 50) {
      out.category = catEl.textContent.trim().replace(/^·\s*/, "").replace(/\s*·\s*$/, "");
    }
    if (!out.category) {
      // Category usually after title, short text without digits
      const titleIdx = lines.indexOf(out.title);
      if (titleIdx >= 0) {
        for (let i = titleIdx + 1; i < Math.min(titleIdx + 4, lines.length); i++) {
          const next = lines[i];
          if (next && next.length < 50 && next.length > 2 && !/^\d/.test(next) && !/\d{3}/.test(next)) {
            // Skip known non-category text
            if (!/open|closed|km|mi|star|review|hour/i.test(next)) {
              out.category = next.replace(/^·\s*/, "").replace(/\s*·\s*$/, "");
              break;
            }
          }
        }
      }
    }

    // Website link
    const websiteLink = card.querySelector(
      'a[data-value="Website"], a[aria-label*="Website" i], a[data-tooltip*="website" i]'
    );
    if (websiteLink) out.website = websiteLink.href;

    // Hours
    const hoursMatch = allText.match(/(open|closed|opens|closes)\s*[·⋅:]?\s*[^\n]*/i);
    if (hoursMatch) out.hours = hoursMatch[0].trim();

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  // Click into a place card to get the detail panel (more accurate phone/website/email)
  async function openPlaceDetail(card) {
    const link = card.querySelector('a[href*="/maps/place/"]');
    if (!link) return null;
    link.scrollIntoView({ behavior: "instant", block: "center" });
    await sleep(200);
    link.click();
    // Wait for detail panel to load
    await sleep(1800);
    return await extractDetailPanel();
  }

  async function extractDetailPanel() {
    const out = {};
    // Wait for panel to render — try multiple heading selectors
    let attempts = 0;
    while (attempts < 12) {
      const heading = document.querySelector(
        'h1.DUwDvf, h1.fontHeadlineLarge, h1[class*="fontHeadlineLarge"], div.lMbq3e h1, div.tAiQdd h1'
      );
      if (heading) break;
      await sleep(500);
      attempts++;
    }

    // Title — multiple selectors for different Maps versions
    const heading = document.querySelector(
      'h1.DUwDvf, h1.fontHeadlineLarge, h1[class*="fontHeadlineLarge"], div.lMbq3e h1, div.tAiQdd h1, h1'
    );
    if (heading) out.title = heading.textContent.trim();

    // URL
    out.url = location.href;

    // Rating — multiple approaches
    let ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    if (!ratingEl) ratingEl = document.querySelector('span.ceNzKf, div.F7nice span, span.MW4etd');
    if (ratingEl) {
      const r = parseFloat(ratingEl.textContent);
      if (r && r > 0 && r <= 5) out.rating = r;
    }

    // Review count — multiple approaches
    let reviewEl = document.querySelector('button[jsaction*="reviewChart"] span');
    if (!reviewEl) reviewEl = document.querySelector('span.UY7F9, div.F7nice span:last-child');
    if (reviewEl) {
      const text = reviewEl.textContent || "";
      const m = text.match(/(\d[\d,]*)/);
      if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""));
    }

    // Category
    let catEl = document.querySelector('button[jsaction*="category"], .DkEaL');
    if (!catEl) catEl = document.querySelector('.mgr77e button, span.DkEaL, div.skqShb span');
    if (catEl) out.category = catEl.textContent.trim();

    // Data items (phone, address, website, hours) — works with data-item-id
    const buttons = document.querySelectorAll(
      'button[data-item-id], a[data-item-id], div[data-item-id]'
    );
    buttons.forEach(btn => {
      const id = (btn.getAttribute("data-item-id") || "").toLowerCase();
      const aria = btn.getAttribute("aria-label") || "";
      const text = btn.textContent.trim();

      // Phone
      if (id.includes("phone") || id.startsWith("phone:") || aria.toLowerCase().includes("phone")) {
        const m = (aria + " " + text).match(/\+?[\d][\d\s\-().]{7,}\d/);
        if (m) out.phone = m[0].trim();
      }
      // Address
      if (id === "address" || id.includes("address") || aria.toLowerCase().includes("address")) {
        const addr = text || aria.replace(/^address[: ]*/i, "").trim();
        if (addr.length > 3) out.address = addr;
      }
      // Website
      if (id === "authority" || id.includes("website") || aria.toLowerCase().includes("website")) {
        const href = btn.href || btn.getAttribute("data-url") || "";
        if (href && href.startsWith("http")) out.website = href;
        else if (text && text.includes(".")) out.website = "https://" + text.replace(/^https?:\/\//, "");
      }
      // Hours
      if (id.startsWith("oh") || id.includes("hour") || aria.toLowerCase().includes("hours")) {
        out.hours = text.split("\n")[0];
      }
      // Plus code
      if (id === "plus_code" || id.includes("plus")) out.plusCode = text;
    });

    // Fallback for phone: look for clickable phone elements
    if (!out.phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) out.phone = tel.href.replace(/^tel:/, "").trim();
    }
    // Fallback for phone: aria-label with phone pattern
    if (!out.phone) {
      const phoneBtn = document.querySelector('[data-tooltip*="phone" i], [aria-label*="phone" i]');
      if (phoneBtn) {
        const lbl = phoneBtn.getAttribute("aria-label") || phoneBtn.textContent || "";
        const m = lbl.match(/\+?[\d][\d\s\-().]{7,}\d/);
        if (m) out.phone = m[0].trim();
      }
    }

    // Fallback for website: look in info section
    if (!out.website) {
      const webLinks = document.querySelectorAll('a[data-item-id="authority"], a[href*="://"][target="_blank"]');
      for (const wl of webLinks) {
        const href = wl.href || "";
        if (href && !href.includes("google.com") && !href.includes("gstatic") && href.startsWith("http")) {
          out.website = href;
          break;
        }
      }
    }

    // Fallback for address: look in the panel text
    if (!out.address) {
      const addrEl = document.querySelector('[data-item-id="address"] .Io6YTe, [data-item-id="address"] .rogA2c');
      if (addrEl) out.address = addrEl.textContent.trim();
    }

    // Email from mailto links
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) out.email = mailto.href.replace(/^mailto:/, "").split("?")[0].trim();

    // Domain
    if (out.website) {
      try { out.domain = new URL(out.website).hostname.replace(/^www\./, ""); } catch (_) {}
    }

    // Coordinates (from URL)
    const coordMatch = location.href.match(/@(-?[\d.]+),(-?[\d.]+)/);
    if (coordMatch) {
      out.latitude = parseFloat(coordMatch[1]);
      out.longitude = parseFloat(coordMatch[2]);
    } else {
      const m = location.href.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
      if (m) {
        out.latitude = parseFloat(m[1]);
        out.longitude = parseFloat(m[2]);
      }
    }

    out.scrapedAt = new Date().toISOString();
    return out;
  }

  // Scroll the results feed — improved patience & end detection
  async function scrollResults(container, settings) {
    const maxScrolls = settings.searchScroll || 40;
    const baseWaitMs = 800; // base wait between scrolls

    let lastHeight = container.scrollHeight;
    let lastCardCount = 0;
    let scrollCount = 0;
    let stuckCount = 0;
    const MAX_STUCK = 6; // more patience — Google Maps lazy-loads slowly

    while (scrollCount < maxScrolls && !SHOULD_STOP) {
      // Check CAPTCHA periodically
      if (scrollCount % 7 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) {
          await handleCaptcha(cap);
          return;
        }
      }

      // Scroll using multiple strategies for reliability
      try {
        // Strategy 1: scrollTop increment (most reliable)
        container.scrollTop = container.scrollHeight;
      } catch (_) {}
      try {
        // Strategy 2: scrollTo smooth
        container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      } catch (_) {}
      try {
        // Strategy 3: scrollIntoView on last element
        const lastChild = container.lastElementChild;
        if (lastChild) lastChild.scrollIntoView({ behavior: "smooth", block: "end" });
      } catch (_) {}

      // Dynamic wait — longer when stuck, shorter when loading fast
      const waitMs = stuckCount > 2 ? baseWaitMs * 2 : randomDelay(baseWaitMs);
      await sleep(waitMs);
      scrollCount++;

      const newHeight = container.scrollHeight;
      const cards = container.querySelectorAll('a[href*="/maps/place/"]');
      const currentCardCount = cards.length;

      await setProgress({
        isRunning: true,
        title: "Scrolling Maps results...",
        currentPage: scrollCount,
        totalPages: maxScrolls,
        currentItem: `Found ${currentCardCount} businesses so far`,
        totalFound: currentCardCount
      });

      // Check for "end of list" indicator — multiple patterns
      const endDetected = checkEndOfResults(container);
      if (endDetected) {
        showToast(`Reached end of results (${currentCardCount} found)`);
        break;
      }

      // Determine if we're stuck
      if (newHeight === lastHeight && currentCardCount === lastCardCount) {
        stuckCount++;
        if (stuckCount >= MAX_STUCK) {
          // One final attempt: click "More results" button if present
          const moreBtn = container.querySelector('button[jsaction*="more"], button[aria-label*="more" i]');
          if (moreBtn) {
            moreBtn.click();
            await sleep(2000);
            stuckCount = 0; // Reset after clicking more
          } else {
            showToast(`No more results loading (${currentCardCount} found)`);
            break;
          }
        }
        // Extra wait when stuck — give Maps time to lazy-load
        if (stuckCount >= 3) await sleep(1500);
      } else {
        stuckCount = 0;
      }
      lastHeight = newHeight;
      lastCardCount = currentCardCount;
    }
  }

  // Detect end of results in Google Maps feed
  function checkEndOfResults(container) {
    // Check the visible text for end indicators
    const text = container.innerText || "";
    const endPhrases = [
      "you've reached the end",
      "no more results",
      "end of list",
      "no results found"
    ];
    const lowerText = text.toLowerCase();
    for (const phrase of endPhrases) {
      if (lowerText.includes(phrase)) return true;
    }
    // Check for the specific "end" element Google Maps shows
    const endEl = container.querySelector(
      'span.HlvSq, p.fontBodyMedium[style*="end"], div.m6QErb + div, div.PbZDve'
    );
    if (endEl && endEl.textContent.toLowerCase().includes("end")) return true;
    return false;
  }

  // Extract all visible cards from feed — improved dedup and detection
  function getAllCards(container) {
    // Multiple selectors to find place cards
    const links = container.querySelectorAll('a[href*="/maps/place/"]');
    const cards = [];
    const seen = new Set();
    links.forEach(link => {
      const href = link.href;
      if (seen.has(href)) return;
      seen.add(href);

      // Find the card wrapper — try multiple parent patterns
      let card = link.closest('div[jsaction][class*="hfpxzc"]')  // modern cards
        || link.closest('div[role="article"]')
        || link.closest('div.Nv2PK')  // 2024 card class
        || link.closest('div[jsaction]')
        || link.parentElement;
      
      if (card) {
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
    const target = settings.targetLeads || 500;

    showToast("Starting Maps scrape...", "#2563eb");

    // 1. Check CAPTCHA first
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      CAMPAIGN_RUNNING = false;
      return { ok: false, captcha: true };
    }

    // 2. Find results sidebar — with retry logic
    let container = null;
    let retryFind = 0;
    while (!container && retryFind < 5) {
      container = findResultsContainer();
      if (!container) {
        retryFind++;
        await sleep(2000); // Wait for Maps to fully render
      }
    }
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
    let totalFailed = 0;
    const profileWaitMs = (settings.profileWait || 5) * 1000;

    // 5. For each card, click to open detail and extract
    for (let i = 0; i < cards.length && i < target; i++) {
      if (SHOULD_STOP) break;

      // CAPTCHA check every 8 profiles
      if (i > 0 && i % 8 === 0) {
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
        currentItem: `Profile ${i + 1}/${Math.min(cards.length, target)}`
      });

      try {
        // Click the link to open profile detail
        const link = cards[i].link;

        // Scroll the card into view first (important for off-screen cards)
        link.scrollIntoView({ behavior: "instant", block: "center" });
        await sleep(300);

        // Click using multiple strategies
        try { link.click(); } catch (_) {}
        // Backup: dispatch click event
        try {
          link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}

        // Wait for detail panel to load — adaptive wait
        await sleep(randomDelay(profileWaitMs));

        // Verify panel loaded (heading appeared)
        const heading = document.querySelector(
          'h1.DUwDvf, h1.fontHeadlineLarge, h1[class*="fontHeadlineLarge"], div.lMbq3e h1, div.tAiQdd h1'
        );
        if (!heading) {
          // Extra wait if panel didn't load yet
          await sleep(2000);
        }

        // Extract from detail panel
        const data = await extractDetailPanel();
        if (data && data.title) {
          const added = await saveLead(data);
          if (added) totalSaved++;
        } else {
          totalFailed++;
        }
      } catch (e) {
        console.warn("[Maps] Failed to extract profile:", e);
        totalFailed++;
      }

      // Go back to results list for next profile
      // Press the back button in Maps (the arrow at top-left)
      try {
        const backBtn = document.querySelector(
          'button[aria-label="Back"], button[jsaction*="back"], button.hYBOP'
        );
        if (backBtn) {
          backBtn.click();
          await sleep(800);
        }
      } catch (_) {}

      // Track for account rotation
      try {
        await chrome.runtime.sendMessage({ type: "ACCOUNT_LEADS_INCREMENT", count: 1 });
      } catch (_) {}

      // Small random extra delay between profiles (anti-detection)
      if (i % 3 === 0) await sleep(randomDelay(500));
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
    const allowed = ["title", "url", "phone", "address", "website", "domain",
      "category", "rating", "reviewCount", "hours", "email", "latitude", "longitude", "plusCode"];
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
  // Auto-start on Maps if autoScrape is on
  // ============================================
  (async () => {
    // Always check CAPTCHA on load
    const cap = detectCaptcha();
    if (cap.detected) {
      await handleCaptcha(cap);
      return;
    }

    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);

    // Honor cooldown
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) {
      const minsLeft = Math.ceil((captchaDetected.cooldownUntil - Date.now()) / 60000);
      await setProgress({ isRunning: false, title: "Cooldown", currentItem: `${minsLeft} min remaining` });
      return;
    }

    if (autoScrape && isMapsPage()) {
      // Wait for Maps to fully load (DOM + results panel)
      setTimeout(async () => {
        // Extra wait: make sure the results panel is available
        let waitCount = 0;
        while (!findResultsContainer() && waitCount < 10) {
          await sleep(1500);
          waitCount++;
        }
        if (findResultsContainer()) {
          await runMapsCampaign();
        }
      }, 3000);
    }
  })();

})();
