// content.js — Google Maps scraping engine.
// Runs on the Google Maps page. Handles search, scroll, profile clicks, and extraction.

(function () {
  "use strict";
  if (window.__GMS_LOADED__) return;
  window.__GMS_LOADED__ = true;

  // ---------- Runtime state ----------
  const RT = {
    status: "idle",       // idle | running | paused | stopped
    config: null,         // user campaign config
    queue: [],            // [{keyword, location}]
    currentTask: null,
    target: 0,
    collected: 0,
    seenNames: new Set(),
    seenUrls: new Set(),
    abortFlag: false
  };

  // ---------- Helpers ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min));

  async function waitWhilePaused() {
    while (RT.status === "paused") await sleep(300);
  }
  function shouldStop() {
    return RT.status === "stopped" || RT.abortFlag;
  }

  async function pushLog(msg) {
    const { state = {} } = await chrome.storage.local.get(["state"]);
    const logs = (state.logs || []).slice(-49);
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    await saveState({ logs });
    console.log("[GMS]", msg);
  }

  async function saveState(patch) {
    const { state = {} } = await chrome.storage.local.get(["state"]);
    const next = { ...state, ...patch };
    await chrome.storage.local.set({ state: next });
  }

  async function recountStats() {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const phoneCount = leads.filter(l => l.phone).length;
    const addressCount = leads.filter(l => l.address).length;
    await saveState({
      collected: leads.length,
      phoneCount,
      addressCount,
      queue: RT.queue.length,
      target: RT.target,
      status: RT.status
    });
  }

  // ---------- DOM helpers ----------
  function getResultsContainer() {
    // The scrolling list of search results
    return document.querySelector('div[role="feed"]') ||
           document.querySelector('div[aria-label*="Results"]') ||
           document.querySelector('.m6QErb[aria-label]');
  }

  function getResultCards() {
    const feed = getResultsContainer();
    if (!feed) return [];
    // Each business is an <a href="/maps/place/..."> within the feed
    return Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
  }

  function getDetailPanel() {
    // The right-side detail panel that opens when a place is clicked
    return document.querySelector('div[role="main"][aria-label]') ||
           document.querySelector('div[role="main"]');
  }

  // ---------- Search navigation ----------
  async function navigateToSearch(query) {
    const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    if (location.href.split("?")[0] !== url.split("?")[0]) {
      location.href = url;
      // Page will reload; engine will resume on next load via persisted state
      return false;
    }
    return true;
  }

  async function waitForFeed(timeoutMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (shouldStop()) return false;
      const feed = getResultsContainer();
      if (feed && getResultCards().length > 0) return true;
      await sleep(500);
    }
    return false;
  }

  // ---------- Scroll the feed to load more results ----------
  async function scrollFeed(maxScrolls) {
    const feed = getResultsContainer();
    if (!feed) return 0;

    let lastCount = 0;
    let stagnant = 0;
    for (let i = 0; i < maxScrolls; i++) {
      if (shouldStop()) break;
      await waitWhilePaused();

      feed.scrollTop = feed.scrollHeight;
      await sleep(rand(900, 1500));

      const cards = getResultCards();
      const txt = (feed.textContent || "").slice(-200);
      // "You've reached the end of the list."
      if (/end of the list|end of results/i.test(txt)) {
        await pushLog(`Reached end of list after ${i + 1} scrolls (${cards.length} results)`);
        return cards.length;
      }
      if (cards.length === lastCount) {
        stagnant++;
        if (stagnant >= 3) {
          await pushLog(`No new results after ${i + 1} scrolls (${cards.length} results)`);
          return cards.length;
        }
      } else {
        stagnant = 0;
        lastCount = cards.length;
      }
    }
    return getResultCards().length;
  }

  // ---------- Extract data from the open detail panel ----------
  function extractFromDetailPanel() {
    const panel = getDetailPanel();
    if (!panel) return null;

    const txt = (sel) => {
      const el = panel.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };
    const attr = (sel, name) => {
      const el = panel.querySelector(sel);
      return el ? (el.getAttribute(name) || "") : "";
    };

    // Name (usually h1)
    const name = txt('h1') || txt('h1.DUwDvf') || txt('[role="main"] h1');

    // Rating
    const rating = txt('div.F7nice span[aria-hidden="true"]') ||
                   txt('span[aria-label*="star" i]') ||
                   "";

    // Reviews count
    let reviews = "";
    const revEl = panel.querySelector('button[aria-label*="review" i]') ||
                  panel.querySelector('span[aria-label*="review" i]');
    if (revEl) {
      const m = (revEl.getAttribute("aria-label") || revEl.textContent).match(/([\d,]+)/);
      if (m) reviews = m[1].replace(/,/g, "");
    }

    // Category (usually a button right under the name)
    const category = txt('button[jsaction*="category" i]') ||
                     txt('.DkEaL') ||
                     txt('button.DkEaL') ||
                     "";

    // Address — buttons with data-item-id starting with 'address'
    const address = (
      attr('button[data-item-id="address"]', 'aria-label') ||
      attr('button[data-item-id^="address"]', 'aria-label') ||
      txt('button[data-item-id^="address"]')
    ).replace(/^Address:\s*/i, "").trim();

    // Phone
    let phone = "";
    const phoneBtn = panel.querySelector('button[data-item-id^="phone"]') ||
                     panel.querySelector('button[aria-label*="Phone" i]');
    if (phoneBtn) {
      phone = (phoneBtn.getAttribute("aria-label") || phoneBtn.textContent || "")
        .replace(/^Phone:\s*/i, "")
        .trim();
    }
    if (!phone) {
      const tel = panel.querySelector('a[href^="tel:"]');
      if (tel) phone = tel.getAttribute("href").replace(/^tel:/, "");
    }

    // Website
    let website = "";
    const webA = panel.querySelector('a[data-item-id="authority"]') ||
                 panel.querySelector('a[aria-label*="Website" i]') ||
                 panel.querySelector('a[data-item-id^="authority"]');
    if (webA) {
      website = webA.getAttribute("href") || "";
      const lbl = webA.getAttribute("aria-label") || "";
      // The aria-label sometimes is "Website: example.com"
      if (!website && lbl) website = lbl.replace(/^Website:\s*/i, "").trim();
    }

    // Plus code
    const plusCode = (
      attr('button[data-item-id^="oloc"]', 'aria-label') ||
      txt('button[data-item-id^="oloc"]')
    ).replace(/^Plus code:\s*/i, "").trim();

    // Hours
    let hours = "";
    const hoursBtn = panel.querySelector('div[aria-label*="Hours" i]') ||
                     panel.querySelector('button[aria-label*="Hours" i]');
    if (hoursBtn) {
      hours = (hoursBtn.getAttribute("aria-label") || "")
        .replace(/^Hours,?\s*/i, "")
        .replace(/Hide open hours.*$/i, "")
        .trim();
    }

    // Google Maps URL — use the current URL, since the panel is the open place
    const googleMapsUrl = location.href;

    if (!name) return null;
    return {
      name, phone, website, address, rating, reviews,
      category, plusCode, hours, googleMapsUrl
    };
  }

  // ---------- Process a single result card ----------
  async function processCard(card, idx, total, ctx) {
    if (shouldStop()) return;
    await waitWhilePaused();

    // Get the place URL (used as primary dedup key)
    const placeUrl = card.href || "";
    if (placeUrl && RT.seenUrls.has(placeUrl)) return;

    // Click to open the detail panel
    try {
      card.scrollIntoView({ block: "center", behavior: "instant" });
    } catch (_) {}
    await sleep(rand(300, 600));
    card.click();

    // Wait for the panel to populate (h1 text appears)
    const waitMs = (ctx.profileWaitSec || 5) * 1000;
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (shouldStop()) return;
      const panel = getDetailPanel();
      if (panel && panel.querySelector('h1') && panel.querySelector('h1').textContent.trim()) break;
      await sleep(250);
    }
    // Extra small wait so phone/address fully render
    await sleep(rand(400, 900));

    const data = extractFromDetailPanel();
    if (!data) {
      await pushLog(`Skip ${idx + 1}/${total}: no data`);
      return;
    }

    // Dedup by name OR url
    const key = (data.name + "|" + (data.phone || "")).toLowerCase();
    if (RT.seenNames.has(key)) return;
    RT.seenNames.add(key);
    if (placeUrl) RT.seenUrls.add(placeUrl);

    const lead = {
      ...data,
      keyword: ctx.keyword,
      location: ctx.location,
      collectedAt: new Date().toISOString()
    };

    // Persist
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    leads.push(lead);
    await chrome.storage.local.set({ leads });
    RT.collected = leads.length;

    await pushLog(`+ ${data.name}${data.phone ? "  ☎ " + data.phone : ""}`);
    await recountStats();
  }

  // ---------- Process one keyword × location task ----------
  async function processTask(task) {
    const { keyword, location: loc } = task;
    const query = `${keyword} in ${loc}`;
    await pushLog(`▶ Searching: ${query}`);

    // Save active task in storage so we resume after page reload
    await chrome.storage.local.set({ activeTask: task });

    // Navigate (may cause reload — engine resumes via auto-start)
    const isCurrent = await navigateToSearch(query);
    if (!isCurrent) return false; // page is reloading; will resume

    const ok = await waitForFeed(15000);
    if (!ok) {
      await pushLog(`No results for: ${query}`);
      return true;
    }

    await pushLog(`Loading more results (scroll)...`);
    const total = await scrollFeed(RT.config.scrollLimit || 25);
    await pushLog(`Found ${total} listings. Visiting each...`);

    const cards = getResultCards();
    const max = Math.min(cards.length, RT.config.maxPerSearch || 50);
    for (let i = 0; i < max; i++) {
      if (shouldStop()) break;
      if (RT.collected >= RT.target) break;
      await waitWhilePaused();
      await processCard(cards[i], i, max, {
        keyword, location: loc,
        profileWaitSec: RT.config.profileWaitSec
      });
      await sleep(rand(200, 500));
    }
    return true;
  }

  // ---------- Main loop ----------
  async function runEngine() {
    RT.status = "running";
    await saveState({ status: "running", target: RT.target, logs: [] });
    await pushLog(`Campaign started — target ${RT.target} leads, ${RT.queue.length} tasks queued`);

    while (RT.queue.length && !shouldStop() && RT.collected < RT.target) {
      await waitWhilePaused();
      const task = RT.queue.shift();
      RT.currentTask = task;
      await chrome.storage.local.set({
        gmsQueue: RT.queue,
        gmsActive: task,
        gmsConfig: RT.config,
        gmsTarget: RT.target
      });
      await recountStats();
      const finished = await processTask(task);
      if (!finished) return; // page reloading
    }

    RT.status = shouldStop() ? "stopped" : "idle";
    await saveState({ status: RT.status });
    await pushLog(RT.collected >= RT.target
      ? `✓ Target reached (${RT.collected} leads)`
      : (shouldStop() ? `■ Stopped (${RT.collected} leads)` : `✓ Done (${RT.collected} leads)`));

    // Cleanup persistent run state
    await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget", "activeTask"]);
  }

  // ---------- Resume after page navigation ----------
  async function tryResume() {
    const { gmsQueue, gmsActive, gmsConfig, gmsTarget, leads = [] } =
      await chrome.storage.local.get(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget", "leads"]);
    if (!gmsActive || !gmsConfig) return;

    // Restore runtime
    RT.config = gmsConfig;
    RT.queue = gmsQueue || [];
    RT.target = gmsTarget || 100;
    RT.collected = leads.length;
    RT.seenNames = new Set(leads.map(l => (l.name + "|" + (l.phone || "")).toLowerCase()));
    RT.status = "running";
    await pushLog(`Resuming after navigation: ${gmsActive.keyword} in ${gmsActive.location}`);

    // We just navigated to this search; continue from there
    const ok = await waitForFeed(15000);
    if (ok) {
      await scrollFeed(RT.config.scrollLimit || 25);
      const cards = getResultCards();
      const max = Math.min(cards.length, RT.config.maxPerSearch || 50);
      for (let i = 0; i < max; i++) {
        if (shouldStop()) break;
        if (RT.collected >= RT.target) break;
        await waitWhilePaused();
        await processCard(cards[i], i, max, {
          keyword: gmsActive.keyword, location: gmsActive.location,
          profileWaitSec: RT.config.profileWaitSec
        });
        await sleep(rand(200, 500));
      }
    }

    // Continue with remaining queue
    while (RT.queue.length && !shouldStop() && RT.collected < RT.target) {
      const task = RT.queue.shift();
      await chrome.storage.local.set({ gmsQueue: RT.queue, gmsActive: task });
      await recountStats();
      const finished = await processTask(task);
      if (!finished) return;
    }

    RT.status = shouldStop() ? "stopped" : "idle";
    await saveState({ status: RT.status });
    await pushLog(`✓ Done (${RT.collected} leads)`);
    await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget"]);
  }

  // ---------- Message router ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "START") {
          if (RT.status === "running") return sendResponse({ ok: false, error: "already running" });
          RT.config = msg.config;
          RT.target = msg.config.targetLeads || 100;
          RT.queue = [];
          for (const k of msg.config.keywords) {
            for (const l of msg.config.locations) {
              RT.queue.push({ keyword: k, location: l });
            }
          }
          // Reset previous session leads? No, keep them; user can Clear manually.
          const { leads = [] } = await chrome.storage.local.get(["leads"]);
          RT.collected = leads.length;
          RT.seenNames = new Set(leads.map(l => (l.name + "|" + (l.phone || "")).toLowerCase()));
          RT.seenUrls = new Set();
          RT.abortFlag = false;
          sendResponse({ ok: true });
          // Fire and forget
          runEngine();
        } else if (msg.type === "PAUSE") {
          if (RT.status === "running") {
            RT.status = "paused";
            await saveState({ status: "paused" });
            await pushLog("⏸ Paused");
          }
          sendResponse({ ok: true });
        } else if (msg.type === "RESUME") {
          if (RT.status === "paused") {
            RT.status = "running";
            await saveState({ status: "running" });
            await pushLog("▶ Resumed");
          }
          sendResponse({ ok: true });
        } else if (msg.type === "STOP") {
          RT.status = "stopped";
          RT.abortFlag = true;
          await saveState({ status: "stopped" });
          await pushLog("■ Stopped by user");
          await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget"]);
          sendResponse({ ok: true });
        } else if (msg.type === "PING") {
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "unknown message" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  });

  // ---------- Auto-resume on page load ----------
  (async () => {
    await sleep(800); // let Maps boot up
    await tryResume();
  })();
})();
