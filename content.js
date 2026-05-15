// ============================================
// Maps Lead Scraper Pro — 3-Phase Content Script
// Phase 1: Bulk Scroll (fast, no click)
// Phase 2: Deep Click (phone/website/address)
// Phase 3: Triggers background deep-enrich (emails)
// ============================================

(function () {
  "use strict";

  let CAMPAIGN_RUNNING = false;
  let SHOULD_STOP = false;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => min + Math.random() * (max - min);
  const log = (...args) => console.log("[MLS]", ...args);

  async function waitFor(fn, timeout = 10000, interval = 300) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const r = fn();
      if (r) return r;
      await sleep(interval);
    }
    return null;
  }

  // ============================================
  // CAPTCHA
  // ============================================
  function detectCaptcha() {
    if (location.pathname.includes("/sorry/")) return { detected: true, type: "sorry" };
    const text = (document.body?.innerText || "").toLowerCase();
    if (["unusual traffic", "i'm not a robot", "automated queries"].some(p => text.includes(p))) {
      return { detected: true, type: "text" };
    }
    if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]')) {
      return { detected: true, type: "recaptcha" };
    }
    return { detected: false };
  }

  async function handleCaptcha() {
    const cooldownUntil = Date.now() + 30 * 60 * 1000;
    await chrome.storage.local.set({
      autoScrape: false,
      captchaDetected: { detected: true, detectedAt: Date.now(), cooldownUntil }
    });
    await setProgress({ isRunning: false, title: "CAPTCHA detected", currentItem: "Paused 30 min" });
    showToast("CAPTCHA detected! Pausing 30 min.", "#dc2626");
    try { await chrome.runtime.sendMessage({ type: "CAPTCHA_DETECTED", info: { cooldownUntil } }); } catch (_) {}
  }

  // ============================================
  // UI Toast
  // ============================================
  function showToast(msg, color) {
    let t = document.getElementById("__mls_toast__");
    if (!t) {
      t = document.createElement("div");
      t.id = "__mls_toast__";
      Object.assign(t.style, {
        position: "fixed", bottom: "20px", right: "20px", background: "#2563eb",
        color: "#fff", padding: "12px 16px", borderRadius: "10px", zIndex: 999999,
        font: "13px/1.4 system-ui", boxShadow: "0 8px 24px rgba(0,0,0,.2)",
        opacity: "0", transition: "opacity .25s", maxWidth: "320px", fontWeight: "500"
      });
      document.body.appendChild(t);
    }
    t.style.background = color || "#2563eb";
    t.textContent = msg;
    t.style.opacity = "1";
    clearTimeout(t._t);
    t._t = setTimeout(() => (t.style.opacity = "0"), 4000);
  }

  // ============================================
  // Storage
  // ============================================
  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    await chrome.storage.local.set({ progress: { ...progress, ...patch, updatedAt: Date.now() } });
  }

  // ============================================
  // FIND RESULTS CONTAINER
  // ============================================
  function findFeed() {
    let el = document.querySelector('div[role="feed"]');
    if (el) return el;

    // Scrollable panel with place links
    for (const div of document.querySelectorAll('div.m6QErb')) {
      if (div.scrollHeight > div.clientHeight + 50 && div.querySelector('a[href*="/maps/place/"]')) return div;
    }

    // Walk up from first place link
    const link = document.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
    if (link) {
      let p = link.parentElement;
      while (p && p !== document.body) {
        if (p.scrollHeight > p.clientHeight + 100) return p;
        p = p.parentElement;
      }
    }
    return null;
  }

  // ============================================
  // PHASE 1: BULK SCROLL — collect all cards fast
  // No clicking, no waiting, just scroll + extract from sidebar
  // ============================================
  async function phase1_scroll(container, maxScrolls) {
    log("Phase 1: Scrolling to load all businesses...");
    let lastCount = 0, stuckCount = 0;

    for (let i = 0; i < maxScrolls && !SHOULD_STOP; i++) {
      // CAPTCHA check every 10 scrolls
      if (i > 0 && i % 10 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) { await handleCaptcha(); return []; }
      }

      container.scrollTop = container.scrollHeight;
      await sleep(rand(800, 1300));

      const count = container.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]').length;

      await setProgress({
        isRunning: true, title: "Phase 1: Loading results...",
        currentPage: i + 1, totalPages: maxScrolls,
        totalFound: count, currentItem: `${count} businesses found`
      });

      // End of list check
      const endEl = container.querySelector('span.HlvSq, p.fontBodyMedium');
      if (endEl && endEl.textContent.toLowerCase().includes("end")) {
        log(`End of results at scroll ${i + 1}, total: ${count}`);
        break;
      }

      if (count === lastCount) {
        stuckCount++;
        if (stuckCount >= 5) { log(`Stuck after ${stuckCount} attempts, total: ${count}`); break; }
        await sleep(1500);
      } else {
        stuckCount = 0;
      }
      lastCount = count;
    }

    // Extract data from all cards
    const cards = container.querySelectorAll('div.Nv2PK');
    let fallbackCards = [];
    if (cards.length === 0) {
      // Fallback: find by links
      const links = container.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]');
      const seen = new Set();
      links.forEach(link => {
        if (!seen.has(link.href)) {
          seen.add(link.href);
          const wrapper = link.closest('div.Nv2PK') || link.closest('div[jsaction]') || link.parentElement;
          if (wrapper) fallbackCards.push(wrapper);
        }
      });
    }

    const allCards = cards.length > 0 ? Array.from(cards) : fallbackCards;
    log(`Phase 1 complete: ${allCards.length} cards found`);

    // Extract basic data from each card
    const results = [];
    const seenUrls = new Set();

    for (const card of allCards) {
      const data = extractFromCard(card);
      if (data && data.title && data.url && !seenUrls.has(data.url)) {
        seenUrls.add(data.url);
        results.push({ card, data });
      }
    }

    log(`Phase 1 extracted: ${results.length} unique businesses`);
    return results;
  }

  // Extract data from sidebar card (NO click needed)
  // FIXED: Properly separates rating/reviews/price from address/category
  function extractFromCard(card) {
    const out = { scrapedAt: new Date().toISOString() };

    // Title + URL from main link
    const link = card.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
    if (!link) return null;
    out.url = link.href;
    out.title = (link.getAttribute("aria-label") || "").trim();

    if (!out.title) {
      const h = card.querySelector('.qBF1Pd, .fontHeadlineSmall, div[role="heading"]');
      if (h) out.title = h.textContent.trim();
    }
    if (!out.title) return null;

    // Clean title — remove "· Visited..." or "· X mentions"
    out.title = out.title.replace(/\s*·\s*(Visited|Mentioned|Featured).*$/i, "").trim();

    // Rating — from dedicated element
    const rEl = card.querySelector('.MW4etd');
    if (rEl) {
      const r = parseFloat(rEl.textContent);
      if (r > 0 && r <= 5) out.rating = r;
    }

    // Review count — from dedicated element
    const revEl = card.querySelector('.UY7F9');
    if (revEl) {
      const text = revEl.textContent.replace(/[()]/g, "");
      const m = text.match(/(\d[\d,]*)/);
      if (m) out.reviewCount = parseInt(m[1].replace(/,/g, ""), 10);
    }

    // === SMART PARSING of card text ===
    // Google Maps card has multiple info rows. We need to correctly identify:
    // - Category (short text, no digits, like "Cafe", "Restaurant")
    // - Address (has road/house numbers, comma-separated)
    // - Price (starts with currency symbol: $, ৳, €, £, ₹)
    // - Phone (digit pattern 8-15 digits)
    // - Hours (Open/Closed/Opens/Closes)
    // - Rating text like "4.3(1,696)" — MUST SKIP this

    const allText = card.innerText || "";
    const lines = allText.split("\n").map(s => s.trim()).filter(s => s && s !== "·");

    // Skip patterns — these are NOT address/category
    const SKIP_PATTERNS = [
      /^\d+\.\d+\(\d/, // "4.3(1,696)" — rating(reviews) 
      /^\d+\.\d+$/, // "4.3" — just rating
      /^\(\d/, // "(1,696)" — just reviews
      /^[\$€£₹৳¥₩]\d/, // "$10" "৳600" — price
      /^[\$€£₹৳¥₩]\s?\d/, // "$ 10"
      /^\d[\d,]*\s*reviews?$/i, // "1,696 reviews"
      /^Visited/i, // "Visited last week"
      /^Mentioned/i, // "Mentioned in..."
      /^Open\b|^Closed\b|^Opens\b|^Closes\b/i, // Hours
      /^\d+\s*(min|km|mi|m)\b/i, // Distance "5 min", "2.3 km"
    ];

    // Price range pattern (like ৳600-800, $10-20, $$)
    const PRICE_RE = /^[\$€£₹৳¥₩]+[\d\s\-–,]*$|^\$+$/;

    for (const line of lines) {
      // Skip the title itself
      if (line === out.title) continue;
      // Skip any pattern we know is not useful for category/address
      if (SKIP_PATTERNS.some(re => re.test(line))) continue;
      // Skip price ranges
      if (PRICE_RE.test(line)) continue;
      // Skip very short items (1-2 chars like "·")
      if (line.length < 3) continue;

      // === Identify PHONE ===
      if (!out.phone) {
        const phoneMatch = line.match(/(\+?\d[\d\s\-().]{7,}\d)/);
        if (phoneMatch) {
          const digits = phoneMatch[1].replace(/\D/g, "");
          if (digits.length >= 8 && digits.length <= 15) {
            out.phone = phoneMatch[1].trim();
            continue;
          }
        }
      }

      // === Identify HOURS ===
      if (!out.hours && /^(Open|Closed|Opens|Closes)/i.test(line)) {
        out.hours = line;
        continue;
      }

      // === Identify CATEGORY ===
      // Category: short (< 35 chars), no digits (or very few), no commas usually
      if (!out.category && line.length < 35 && !/\d{2,}/.test(line) && !line.includes(",")) {
        // Extra check: not a distance or price
        if (!/^\d/.test(line) && !/[₹$€£৳]/.test(line)) {
          out.category = line;
          continue;
        }
      }

      // === Identify ADDRESS ===
      // Address: longer text, has numbers or comma, looks like street/area
      if (!out.address && line.length > 5 && line.length < 200) {
        // Must contain a digit OR comma OR known address keywords
        if (/\d/.test(line) || line.includes(",") ||
            /\b(road|rd|street|st|house|floor|block|sector|lane|plot|area|no\.?)\b/i.test(line)) {
          // Make sure it's not a phone (too many consecutive digits)
          const digitOnly = line.replace(/\D/g, "");
          if (digitOnly.length < 11) { // Phone numbers are 8-15 digits
            out.address = line;
            continue;
          }
        }
      }
    }

    // Coordinates from URL
    const coordMatch = out.url.match(/!3d(-?[\d.]+)!4d(-?[\d.]+)/);
    if (coordMatch) {
      out.latitude = parseFloat(coordMatch[1]);
      out.longitude = parseFloat(coordMatch[2]);
    }

    return out;
  }

  // ============================================
  // PHASE 2: DEEP CLICK — get phone/website/address
  // Only click cards that are missing critical data
  // ============================================
  async function phase2_deepClick(results, profileWaitSec) {
    log("Phase 2: Clicking profiles for full data...");
    const waitMs = profileWaitSec * 1000;
    let enriched = 0;

    for (let i = 0; i < results.length && !SHOULD_STOP; i++) {
      const { card, data } = results[i];

      // Skip ONLY if has phone WITH country code AND website AND address
      const hasFullPhone = data.phone && data.phone.startsWith("+");
      if (hasFullPhone && data.website && data.address) continue;

      // CAPTCHA check every 8 profiles
      if (enriched > 0 && enriched % 8 === 0) {
        const cap = detectCaptcha();
        if (cap.detected) { await handleCaptcha(); break; }
      }

      await setProgress({
        isRunning: true, title: `Phase 2: Profile ${enriched + 1}`,
        currentPage: i + 1, totalPages: results.length,
        totalFound: enriched, currentItem: data.title.slice(0, 35)
      });

      try {
        const link = card.querySelector('a.hfpxzc, a[href*="/maps/place/"]');
        if (!link) continue;

        // Scroll into view + click
        link.scrollIntoView({ block: "center", behavior: "instant" });
        await sleep(rand(200, 400));
        link.click();

        // Wait for detail panel
        await sleep(rand(waitMs * 0.7, waitMs * 1.3));

        // Extract from detail panel
        const detail = extractFromDetailPanel();

        // Merge: detail ALWAYS wins for phone (has country code)
        if (detail.phone) data.phone = detail.phone; // Always use detail phone (has +country code)
        if (detail.website && !data.website) data.website = detail.website;
        if (detail.address && !data.address) data.address = detail.address;
        if (detail.email) data.email = detail.email;
        if (detail.hours && !data.hours) data.hours = detail.hours;
        if (detail.category && !data.category) data.category = detail.category;
        if (detail.plusCode) data.plusCode = detail.plusCode;

        // Domain from website
        if (data.website && !data.domain) {
          try { data.domain = new URL(data.website).hostname.replace(/^www\./, ""); } catch (_) {}
        }

        enriched++;
      } catch (e) {
        log("Phase 2 error:", e.message);
      }

      // Anti-detection: random pause every few profiles
      if (enriched % 5 === 0 && enriched > 0) {
        await sleep(rand(2000, 4000));
      }
    }

    log(`Phase 2 complete: ${enriched} profiles enriched`);
  }

  // Extract data from the currently open detail panel (right side)
  function extractFromDetailPanel() {
    const out = {};

    // Phone — THE most reliable way: data-item-id contains the number!
    document.querySelectorAll('[data-item-id]').forEach(el => {
      const id = el.getAttribute("data-item-id") || "";
      const aria = el.getAttribute("aria-label") || "";

      // Phone: data-item-id="phone:tel:+8801XXX" — FULL number with country code
      if (id.startsWith("phone:tel:")) {
        out.phone = id.replace("phone:tel:", "").trim();
      }
      // Address: aria-label has clean address
      if (id === "address" && aria) {
        out.address = aria.replace(/^Address:\s*/i, "").trim();
      }
      // Website: data-item-id="authority"
      if (id === "authority") {
        const href = el.href || el.querySelector("a")?.href || "";
        if (href && href.startsWith("http") && !href.includes("google.com")) {
          out.website = href;
        }
      }
      // Hours: id starts with "oh"
      if (id.startsWith("oh") && !out.hours) {
        out.hours = (aria || el.textContent || "").split("\n")[0].trim();
      }
      // Plus code
      if (id === "oloc") {
        out.plusCode = el.textContent.trim();
      }
    });

    // Fallback phone from tel: link (includes country code)
    if (!out.phone) {
      const tel = document.querySelector('a[href^="tel:"]');
      if (tel) out.phone = tel.href.replace("tel:", "").trim();
    }

    // Fallback: aria-label on phone button often has full number
    if (!out.phone) {
      const phoneBtn = document.querySelector('[data-item-id*="phone"], [aria-label*="Phone" i]');
      if (phoneBtn) {
        const label = phoneBtn.getAttribute("aria-label") || "";
        const m = label.match(/(\+?\d[\d\s\-().]{7,}\d)/);
        if (m) out.phone = m[1].trim();
      }
    }

    // Fallback website
    if (!out.website) {
      const authority = document.querySelector('a[data-item-id="authority"]');
      if (authority && authority.href && !authority.href.includes("google.com")) {
        out.website = authority.href;
      }
    }

    // Email
    const mailto = document.querySelector('a[href^="mailto:"]');
    if (mailto) out.email = mailto.href.replace("mailto:", "").split("?")[0].trim();

    // Category
    const catEl = document.querySelector('button[jsaction*="category"], .DkEaL');
    if (catEl) out.category = catEl.textContent.trim();

    return out;
  }

  // ============================================
  // PHASE 3: Save + Trigger Deep Enrich
  // ============================================
  async function phase3_save(results) {
    log("Phase 3: Saving leads...");
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    let saved = 0;

    for (const { data } of results) {
      if (!data || !data.title) continue;

      // Dedup
      const exists = leads.some(l =>
        (l.url && l.url === data.url) ||
        (l.title === data.title && l.address && l.address === data.address)
      );
      if (exists) continue;

      leads.push(data);
      saved++;
    }

    await chrome.storage.local.set({ leads });

    // Update today count
    const { todayLeadCount = 0, todayLeadDate } = await chrome.storage.local.get(["todayLeadCount", "todayLeadDate"]);
    const today = new Date().toDateString();
    await chrome.storage.local.set({
      todayLeadCount: todayLeadDate === today ? todayLeadCount + saved : saved,
      todayLeadDate: today
    });

    log(`Phase 3 complete: ${saved} new leads saved (total: ${leads.length})`);
    return saved;
  }

  // ============================================
  // MAIN CAMPAIGN RUNNER
  // ============================================
  async function runCampaign() {
    if (CAMPAIGN_RUNNING) {
      showToast("Already running!", "#f59e0b");
      return { ok: false, error: "running" };
    }
    CAMPAIGN_RUNNING = true;
    SHOULD_STOP = false;

    try {
      // Settings
      const settings = await chrome.storage.local.get(["targetLeads", "searchScroll", "profileWait"]);
      const maxScrolls = settings.searchScroll || 50;
      const profileWait = settings.profileWait || 5;
      const target = settings.targetLeads || 500;

      // CAPTCHA check
      const cap = detectCaptcha();
      if (cap.detected) { await handleCaptcha(); return { ok: false, captcha: true }; }

      showToast("Starting scrape...", "#2563eb");

      // Wait for feed
      const container = await waitFor(findFeed, 15000, 500);
      if (!container) {
        showToast("Results not found. Reload Maps.", "#dc2626");
        return { ok: false, error: "no-feed" };
      }

      // === PHASE 1: Scroll & Extract Cards ===
      const results = await phase1_scroll(container, maxScrolls);
      if (SHOULD_STOP || results.length === 0) {
        await setProgress({ isRunning: false });
        return { ok: true, saved: 0, stopped: SHOULD_STOP };
      }

      // Limit to target
      const limited = results.slice(0, target);
      showToast(`Found ${limited.length} businesses. Getting details...`, "#2563eb");

      // === PHASE 2: Click for Phone/Website ===
      await phase2_deepClick(limited, profileWait);

      if (SHOULD_STOP) {
        await setProgress({ isRunning: false });
      }

      // === PHASE 3: Save All ===
      const saved = await phase3_save(limited);

      // ALWAYS trigger background deep-enrich for emails (automatic)
      try { await chrome.runtime.sendMessage({ type: "DEEP_SCRAPE_ALL" }); } catch (_) {}

      await setProgress({
        isRunning: false, title: "Done!",
        currentItem: `${saved} leads saved`, totalFound: saved
      });
      setTimeout(() => setProgress({ isRunning: false }), 4000);

      showToast(`Done! ${saved} new leads saved.`, "#22c55e");
      return { ok: true, saved };

    } catch (err) {
      log("Campaign error:", err);
      showToast("Error: " + err.message, "#dc2626");
      return { ok: false, error: err.message };
    } finally {
      CAMPAIGN_RUNNING = false;
    }
  }

  // ============================================
  // MESSAGE HANDLER
  // ============================================
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    (async () => {
      if (msg.type === "SCRAPE_NOW") {
        sendResponse(await runCampaign());
      } else if (msg.type === "STOP_SCRAPE") {
        SHOULD_STOP = true;
        showToast("Stopping...", "#f59e0b");
        sendResponse({ ok: true });
      } else if (msg.type === "PING") {
        const isMaps = /google\.[a-z.]+\/maps/.test(location.href);
        sendResponse({ ok: true, page: isMaps ? "maps" : "other" });
      } else {
        sendResponse({ ok: false });
      }
    })();
    return true;
  });

  // ============================================
  // AUTO-START
  // ============================================
  (async () => {
    if (!/google\.[a-z.]+\/maps/.test(location.href)) return;

    const cap = detectCaptcha();
    if (cap.detected) { await handleCaptcha(); return; }

    const { autoScrape, captchaDetected } = await chrome.storage.local.get(["autoScrape", "captchaDetected"]);
    if (captchaDetected && captchaDetected.cooldownUntil > Date.now()) return;

    if (autoScrape) {
      log("Auto-scrape: waiting for Maps to load...");
      await sleep(3000);
      const feed = await waitFor(findFeed, 15000, 500);
      if (feed) {
        log("Auto-scrape: starting campaign");
        await runCampaign();
      }
    }
  })();

})();
