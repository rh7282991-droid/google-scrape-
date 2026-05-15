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
    if (mailto) out.email = mailto.href.replace(/^mailto:/, "").trim();

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

    // 2. Find results sidebar
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
          const added = await saveLead(data);
          if (added) totalSaved++;
        }
      } catch (e) {
        console.warn("[Maps] Failed to extract profile:", e);
      }

      // Track for account rotation
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
      // Wait a moment for Maps to fully load
      setTimeout(async () => {
        await runMapsCampaign();
      }, 2000);
    }
  })();

})();
