// ============================================
// Maps Lead Scraper Pro v5.0 — Snapshot Architecture
// Phase 1: CAPTURE (fast click + save HTML)
// Phase 2: PASSIVE (auto-save while browsing)
// ============================================

(function () {
  "use strict";

  let CAPTURE_RUNNING = false;
  let SHOULD_STOP = false;

  // ============================================
  // Helpers
  // ============================================
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function randomDelay(base) {
    return base + (Math.random() - 0.3) * base * 0.4;
  }

  function isMapsPage() {
    return /^https?:\/\/(www\.)?(google\.com\/maps|maps\.google\.com)/.test(location.href);
  }

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
  // CAPTCHA Detection
  // ============================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/") || location.hostname.includes("sorry.google")) {
      return { detected: true, type: "sorry-page" };
    }
    const bodyText = (document.body && document.body.innerText || "").toLowerCase();
    const phrases = ["unusual traffic", "our systems have detected", "please show you're not a robot", "verify you are human"];
    for (const phrase of phrases) {
      if (bodyText.includes(phrase)) return { detected: true, type: "challenge-text" };
    }
    if (document.querySelector("#captcha") || document.querySelector(".g-recaptcha") || document.querySelector('iframe[src*="recaptcha"]')) {
      return { detected: true, type: "recaptcha-element" };
    }
    return { detected: false };
  }

  async function handleCaptcha() {
    const cooldownUntil = Date.now() + 30 * 60 * 1000;
    await chrome.storage.local.set({
      captchaDetected: { detected: true, detectedAt: Date.now(), cooldownUntil, url: location.href }
    });
    await setProgress({ isRunning: false, title: "CAPTCHA detected — paused 30 min" });
    showToast("CAPTCHA detected! Pausing 30 min.", "#dc2626");
    try { await chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", info: { cooldownUntil } }); } catch (_) {}
  }

  // ============================================
  // Progress helper
  // ============================================
  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
  }

  // ============================================
  // Find results container (sidebar feed)
  // ============================================
  function findResultsContainer() {
    return document.querySelector('div[role="feed"]') ||
           document.querySelector('[aria-label*="Results for" i]') ||
           document.querySelector('.section-scrollbox, .section-listbox') || null;
  }

  // ============================================
  // Get all place links from results
  // ============================================
  function getAllPlaceLinks(container) {
    const links = container.querySelectorAll('a[href*="/maps/place/"]');
    const results = [];
    const seen = new Set();
    links.forEach(link => {
      if (!seen.has(link.href)) {
        seen.add(link.href);
        // Get place name from aria-label
        const name = link.getAttribute("aria-label") || "";
        results.push({ link, name, href: link.href });
      }
    });
    return results;
  }

  // ============================================
  // Scroll results to load more
  // ============================================
  async function scrollResults(container, maxScrolls) {
    let lastHeight = container.scrollHeight;
    let scrollCount = 0;
    let stuckCount = 0;

    while (scrollCount < maxScrolls && !SHOULD_STOP) {
      if (scrollCount % 5 === 0 && detectCaptcha().detected) {
        await handleCaptcha();
        return false;
      }

      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
      await sleep(800 + Math.random() * 400);
      scrollCount++;

      const cards = container.querySelectorAll('a[href*="/maps/place/"]');
      await setProgress({
        isRunning: true,
        title: "Scrolling results...",
        currentPage: scrollCount,
        totalPages: maxScrolls,
        totalFound: cards.length,
        currentItem: `Found ${cards.length} places`
      });

      const endText = container.innerText || "";
      if (endText.includes("You've reached the end") || endText.includes("no more")) break;

      const newHeight = container.scrollHeight;
      if (newHeight === lastHeight) { stuckCount++; if (stuckCount >= 3) break; }
      else stuckCount = 0;
      lastHeight = newHeight;
    }
    return true;
  }

  // ============================================
  // CAPTURE: Get detail panel HTML (the key!)
  // ============================================
  function getDetailPanelHTML() {
    // The detail panel — multiple possible selectors
    const panel = document.querySelector('div[role="main"]') ||
                  document.querySelector('.section-hero-header-title-description') ||
                  document.querySelector('[data-attrid]')?.closest('div[role="main"]');

    if (panel) return panel.innerHTML;

    // Fallback: get the whole right side
    const rightPanel = document.querySelector('.section-layout-root') ||
                       document.querySelector('[role="main"]');
    if (rightPanel) return rightPanel.innerHTML;

    // Last resort: save relevant portion of body
    return document.body.innerHTML;
  }

  // Quick name extraction from panel (for label only)
  function getQuickName() {
    const h1 = document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');
    return h1 ? h1.textContent.trim() : "";
  }

  // ============================================
  // PHASE 1: CAPTURE MODE
  // Fast click through places, save only HTML
  // ============================================
  async function runCapture() {
    if (CAPTURE_RUNNING) {
      showToast("Capture already running", "#f59e0b");
      return { ok: false, error: "already-running" };
    }
    CAPTURE_RUNNING = true;
    SHOULD_STOP = false;

    const settings = await chrome.storage.local.get(["targetLeads", "searchScroll", "captureWait"]);
    const target = settings.targetLeads || 100;
    const maxScrolls = settings.searchScroll || 25;
    const waitPerPlace = (settings.captureWait || 2) * 1000; // default 2 sec — FAST!

    showToast("Starting capture...", "#2563eb");

    // CAPTCHA check
    if (detectCaptcha().detected) {
      await handleCaptcha();
      CAPTURE_RUNNING = false;
      return { ok: false, captcha: true };
    }

    // Find results
    const container = findResultsContainer();
    if (!container) {
      showToast("No results found. Search something on Maps first.", "#dc2626");
      CAPTURE_RUNNING = false;
      return { ok: false, error: "no-feed" };
    }

    await setProgress({ isRunning: true, title: "Scrolling to load places...", currentPage: 0, totalPages: maxScrolls, totalFound: 0 });

    // Scroll to load
    const scrollOk = await scrollResults(container, maxScrolls);
    if (!scrollOk || SHOULD_STOP) {
      CAPTURE_RUNNING = false;
      await setProgress({ isRunning: false });
      return { ok: true, stopped: true };
    }

    // Get all place links
    const places = getAllPlaceLinks(container);
    const toCapture = Math.min(places.length, target);
    showToast(`Found ${places.length} places. Capturing ${toCapture}...`, "#2563eb");

    // Load existing snapshots
    const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
    const existingUrls = new Set(snapshots.map(s => s.url));

    let captured = 0;

    for (let i = 0; i < toCapture; i++) {
      if (SHOULD_STOP) break;

      // CAPTCHA check every 15 places
      if (i > 0 && i % 15 === 0 && detectCaptcha().detected) {
        await handleCaptcha();
        break;
      }

      const place = places[i];

      // Skip already captured
      if (existingUrls.has(place.href)) {
        await setProgress({ currentItem: `Skipping (already cached): ${place.name.slice(0, 30)}` });
        continue;
      }

      await setProgress({
        isRunning: true,
        title: `Capturing ${i + 1}/${toCapture}`,
        currentPage: i + 1,
        totalPages: toCapture,
        totalFound: captured,
        currentItem: place.name.slice(0, 40) || `Place ${i + 1}`
      });

      // Click the place
      place.link.click();

      // Wait for detail panel to load (FAST — just 2 sec)
      await sleep(randomDelay(waitPerPlace));

      // Grab HTML
      const html = getDetailPanelHTML();
      const name = getQuickName() || place.name || `Place ${i + 1}`;
      const currentUrl = location.href;

      // Save snapshot
      const snapshot = {
        id: "snap_" + Date.now() + "_" + i,
        url: currentUrl,
        name: name,
        html: html,
        capturedAt: new Date().toISOString(),
        extracted: false
      };

      snapshots.push(snapshot);
      existingUrls.add(currentUrl);
      captured++;

      // Save every 5 snapshots (batch save for performance)
      if (captured % 5 === 0 || i === toCapture - 1) {
        await chrome.storage.local.set({ snapshots });
      }
    }

    // Final save
    await chrome.storage.local.set({ snapshots });

    await setProgress({
      isRunning: false,
      title: "Capture complete!",
      currentItem: `${captured} new snapshots saved. Total: ${snapshots.length}`
    });

    showToast(`Done! Captured ${captured} places. Go to Extract to get your data.`, "#22c55e");
    CAPTURE_RUNNING = false;
    return { ok: true, captured, total: snapshots.length };
  }

  // ============================================
  // PASSIVE CAPTURE MODE — SMART AUTO-SAVE
  // Watches: URL changes (place clicks) + scroll (visible cards in list)
  // Auto-saves in background while user browses normally
  // ============================================
  let lastPanelUrl = "";
  let passiveObserver = null;
  let passiveCardObserver = null;
  let passiveScrollListener = null;

  async function startPassiveCapture() {
    if (passiveObserver) return; // already active

    // No toast on startup — silent. Only toast when saving.

    // ===== Watcher 1: Place click → URL changes =====
    passiveObserver = setInterval(async () => {
      const currentUrl = location.href;
      if (currentUrl === lastPanelUrl) return;
      if (!currentUrl.includes("/maps/place/")) return;

      lastPanelUrl = currentUrl;

      // Wait for panel to render
      await sleep(1500);
      await capturePanel(currentUrl);
    }, 1500);

    // ===== Watcher 2: Click on place cards =====
    document.addEventListener("click", async (e) => {
      const link = e.target.closest('a[href*="/maps/place/"]');
      if (link) {
        setTimeout(async () => {
          const url = location.href;
          if (url.includes("/maps/place/")) await capturePanel(url);
        }, 2000);
      }
    }, true);

    // ===== Watcher 3: Sidebar scroll =====
    let scrollDebounce = null;
    passiveScrollListener = () => {
      clearTimeout(scrollDebounce);
      scrollDebounce = setTimeout(() => {}, 800);
    };
    document.addEventListener("scroll", passiveScrollListener, { capture: true, passive: true });
  }

  // Helper: Capture currently-visible panel
  async function capturePanel(url) {
    const html = getDetailPanelHTML();
    const name = getQuickName();
    if (!name) return; // No panel loaded

    const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);

    // Check if already saved (dedup by URL)
    if (snapshots.some(s => s.url === url)) return;

    const snapshot = {
      id: "snap_" + Date.now(),
      url: url,
      name: name,
      html: html,
      capturedAt: new Date().toISOString(),
      extracted: false
    };

    snapshots.push(snapshot);
    await chrome.storage.local.set({ snapshots });

    showToast(`📌 Auto-saved: ${name.slice(0, 25)}`, "#2563eb");
  }

  function stopPassiveCapture() {
    if (passiveObserver) {
      clearInterval(passiveObserver);
      passiveObserver = null;
    }
    if (passiveScrollListener) {
      document.removeEventListener("scroll", passiveScrollListener, { capture: true });
      passiveScrollListener = null;
    }
    showToast("Auto-Capture OFF", "#64748b");
  }

  // ============================================
  // Message handler
  // ============================================
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "CAPTURE_START") {
          const r = await runCapture();
          sendResponse(r);
        } else if (msg.type === "CAPTURE_STOP") {
          SHOULD_STOP = true;
          showToast("Stopping after current place...", "#f59e0b");
          sendResponse({ ok: true });
        } else if (msg.type === "PASSIVE_START") {
          await startPassiveCapture();
          sendResponse({ ok: true });
        } else if (msg.type === "PASSIVE_STOP") {
          stopPassiveCapture();
          sendResponse({ ok: true });
        } else if (msg.type === "PING") {
          sendResponse({ ok: true, page: isMapsPage() ? "maps" : "other", capturing: CAPTURE_RUNNING });
        } else if (msg.type === "GET_SNAPSHOT_COUNT") {
          const { snapshots = [] } = await chrome.storage.local.get(["snapshots"]);
          sendResponse({ ok: true, total: snapshots.length, unextracted: snapshots.filter(s => !s.extracted).length });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  });

  // ============================================
  // Auto-start passive ALWAYS on Maps — NO CONDITIONS
  // Extension load হলেই Maps-এ automatic start হবে
  // User কিছু করবে না, toggle check করবে না
  // ============================================
  (async () => {
    if (!isMapsPage()) return;

    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(); return; }

    // Check CAPTCHA cooldown
    const { captchaDetected } = await chrome.storage.local.get(["captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) return;

    // ALWAYS start — no toggle check needed
    // User explicitly OFF করলে শুধু তখনই বন্ধ হবে
    const { passiveCapture } = await chrome.storage.local.get(["passiveCapture"]);
    if (passiveCapture === false) return; // User manually turned OFF

    // Otherwise: START IMMEDIATELY — default behavior
    await chrome.storage.local.set({ passiveCapture: true });
    await startPassiveCapture();
  })();

})();
