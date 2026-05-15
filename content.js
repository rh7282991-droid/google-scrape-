// content.js — Google Maps scraping engine v2
// Strategy: navigate via SPA, scroll feed, click each place link, wait for URL to
// become /maps/place/, extract via stable data-item-id attributes.

(function () {
  "use strict";
  if (window.__GMS_LOADED__) return;
  window.__GMS_LOADED__ = true;

  // ---------- Runtime ----------
  const RT = {
    status: "idle",
    config: null,
    queue: [],
    target: 0,
    collected: 0,
    seen: new Set(),
    seenUrls: new Set(),
    abort: false
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
  const shouldStop = () => RT.status === "stopped" || RT.abort;
  const waitWhilePaused = async () => { while (RT.status === "paused") await sleep(300); };

  async function pushLog(msg) {
    const { state = {} } = await chrome.storage.local.get(["state"]);
    const logs = (state.logs || []).slice(-49);
    logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    await saveState({ logs });
    console.log("[GMS]", msg);
  }
  async function saveState(patch) {
    const { state = {} } = await chrome.storage.local.get(["state"]);
    await chrome.storage.local.set({ state: { ...state, ...patch } });
  }
  async function recountStats() {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    await saveState({
      collected: leads.length,
      phoneCount: leads.filter(l => l.phone).length,
      addressCount: leads.filter(l => l.address).length,
      queue: RT.queue.length,
      target: RT.target,
      status: RT.status
    });
  }

  // ---------- Page detection ----------
  const isSearchPage = () => /\/maps\/search\//.test(location.pathname);
  const isPlacePage  = () => /\/maps\/place\//.test(location.pathname);

  function getFeed() {
    return document.querySelector('div[role="feed"]') ||
           document.querySelector('div[aria-label*="Results" i]') ||
           document.querySelector('[role="main"] div[tabindex="-1"]');
  }

  function getPlaceCards() {
    const feed = getFeed();
    if (!feed) return [];
    const cards = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    const seen = new Set();
    return cards.filter(a => {
      const href = a.href;
      if (seen.has(href)) return false;
      seen.add(href);
      return true;
    });
  }

  function getMainPanel() {
    return document.querySelector('div[role="main"][aria-label]') ||
           document.querySelector('div[role="main"]');
  }

  // ---------- Single source of truth: extract from a place page ----------
  function extractPlace() {
    const panel = getMainPanel();
    if (!panel) return null;

    const h1 = panel.querySelector('h1');
    if (!h1) return null;
    const name = h1.textContent.trim();
    if (!name || /^(Results|Search results)$/i.test(name)) return null;

    // PHONE — most reliable: data-item-id="phone:tel:+8801..."
    let phone = "";
    const phoneBtn = panel.querySelector('button[data-item-id^="phone:tel:"]');
    if (phoneBtn) {
      phone = (phoneBtn.getAttribute("data-item-id") || "")
        .replace(/^phone:tel:/, "")
        .trim();
    }
    if (!phone) {
      const altBtn = panel.querySelector('button[aria-label^="Phone:" i]');
      if (altBtn) {
        const m = (altBtn.getAttribute("aria-label") || "").match(/Phone:\s*([\+\d\s\-()]+)/i);
        if (m) phone = m[1].trim();
      }
    }
    if (!phone) {
      const tel = panel.querySelector('a[href^="tel:"]');
      if (tel) phone = tel.getAttribute("href").replace(/^tel:/, "");
    }

    // ADDRESS
    let address = "";
    const addrBtn = panel.querySelector('button[data-item-id="address"]');
    if (addrBtn) {
      const aria = addrBtn.getAttribute("aria-label") || "";
      if (/^Address:/i.test(aria)) {
        address = aria.replace(/^Address:\s*/i, "").trim();
      } else {
        address = (addrBtn.textContent || "").replace(/\s+/g, " ").trim();
      }
    }

    // WEBSITE
    let website = "";
    const webA = panel.querySelector('a[data-item-id="authority"]');
    if (webA) {
      website = webA.getAttribute("href") || "";
      if (!website || /google\.com/.test(website)) {
        const aria = webA.getAttribute("aria-label") || "";
        const m = aria.match(/Website:\s*(.+)/i);
        if (m) website = m[1].trim();
      }
    }

    // RATING
    let rating = "";
    const rEl = panel.querySelector('div.F7nice span[aria-hidden="true"]');
    if (rEl) rating = rEl.textContent.trim();
    if (!rating) {
      const r2 = panel.querySelector('[role="img"][aria-label*="star" i]');
      if (r2) {
        const m = (r2.getAttribute("aria-label") || "").match(/([0-9.,]+)\s*star/i);
        if (m) rating = m[1];
      }
    }

    // REVIEWS
    let reviews = "";
    const revEl = panel.querySelector('button[aria-label*="review" i]') ||
                  panel.querySelector('span[aria-label*="review" i]') ||
                  panel.querySelector('div.F7nice span:not([aria-hidden])');
    if (revEl) {
      const m = (revEl.getAttribute("aria-label") || revEl.textContent || "").match(/([0-9,]+)/);
      if (m) reviews = m[1].replace(/,/g, "");
    }

    // CATEGORY
    let category = "";
    const catBtn = panel.querySelector('button[jsaction*="category" i]');
    if (catBtn) category = catBtn.textContent.trim();

    // PLUS CODE
    let plusCode = "";
    const plusBtn = panel.querySelector('button[data-item-id^="oloc"]');
    if (plusBtn) {
      const aria = plusBtn.getAttribute("aria-label") || "";
      plusCode = aria.replace(/^Plus code:\s*/i, "").trim() ||
                 (plusBtn.textContent || "").trim();
    }

    // HOURS
    let hours = "";
    const hoursEl = panel.querySelector('div[aria-label*="Hours" i]') ||
                    panel.querySelector('button[aria-label*="Hours" i]');
    if (hoursEl) {
      hours = (hoursEl.getAttribute("aria-label") || "")
        .replace(/^Hours,?\s*/i, "")
        .replace(/Hide open hours.*$/i, "")
        .trim();
    }

    return {
      name, phone, website, address, rating, reviews,
      category, plusCode, hours,
      googleMapsUrl: location.href
    };
  }

  // ---------- Navigation ----------
  function navigateToSearch(query) {
    const target = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    if (location.href.split("?")[0] !== target.split("?")[0]) {
      location.href = target;
      return false;
    }
    return true;
  }

  async function waitForFeed(timeoutMs = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (shouldStop()) return false;
      const cards = getPlaceCards();
      if (cards.length > 0) return true;
      await sleep(400);
    }
    return false;
  }

  async function scrollFeed(maxScrolls) {
    const feed = getFeed();
    if (!feed) return 0;

    let last = 0, stagnant = 0;
    for (let i = 0; i < maxScrolls; i++) {
      if (shouldStop()) break;
      await waitWhilePaused();
      feed.scrollTop = feed.scrollHeight;
      await sleep(rand(900, 1400));
      const cards = getPlaceCards();
      const tail = (feed.textContent || "").slice(-200);
      if (/end of the list|end of results/i.test(tail)) {
        await pushLog(`Reached end of list (${cards.length} cards)`);
        return cards.length;
      }
      if (cards.length === last) {
        stagnant++;
        if (stagnant >= 3) {
          await pushLog(`No more results (${cards.length} cards)`);
          return cards.length;
        }
      } else {
        stagnant = 0;
        last = cards.length;
      }
    }
    return getPlaceCards().length;
  }

  // Click and wait for /maps/place/ to load + h1 to populate
  async function clickAndAwaitPlace(card, timeoutMs) {
    const before = location.href;
    try { card.scrollIntoView({ block: "center" }); } catch (_) {}
    await sleep(rand(250, 500));
    card.click();

    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (shouldStop()) return false;
      if (isPlacePage() && location.href !== before) break;
      await sleep(200);
    }
    if (!isPlacePage()) return false;

    const t1 = Date.now();
    while (Date.now() - t1 < 8000) {
      if (shouldStop()) return false;
      const panel = getMainPanel();
      if (panel) {
        const h1 = panel.querySelector('h1');
        if (h1) {
          const txt = h1.textContent.trim();
          if (txt && txt.length > 1 && !/^(Results|Search results)$/i.test(txt)) {
            await sleep(rand(800, 1300));
            return true;
          }
        }
      }
      await sleep(200);
    }
    return false;
  }

  async function processCard(card, idx, total, ctx) {
    if (shouldStop()) return;
    await waitWhilePaused();

    const placeUrl = card.href || "";
    if (placeUrl && RT.seenUrls.has(placeUrl)) return;

    const waitMs = (ctx.profileWaitSec || 5) * 1000;
    const ok = await clickAndAwaitPlace(card, Math.max(waitMs, 6000));
    if (!ok) {
      await pushLog(`✗ ${idx + 1}/${total}: place did not load`);
      return;
    }

    const data = extractPlace();
    if (!data) {
      await pushLog(`✗ ${idx + 1}/${total}: extraction failed`);
      return;
    }

    const key = (data.name + "|" + (data.phone || "")).toLowerCase();
    if (RT.seen.has(key)) return;
    RT.seen.add(key);
    if (placeUrl) RT.seenUrls.add(placeUrl);

    const lead = {
      ...data,
      keyword: ctx.keyword,
      location: ctx.location,
      collectedAt: new Date().toISOString()
    };

    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    leads.push(lead);
    await chrome.storage.local.set({ leads });
    RT.collected = leads.length;

    const tail = data.phone ? `  ☎ ${data.phone}` :
                 (data.address ? `  📍 ${data.address.slice(0, 40)}` : "");
    await pushLog(`+ ${idx + 1}/${total}: ${data.name}${tail}`);
    await recountStats();
  }

  async function processTask(task) {
    const query = `${task.keyword} in ${task.location}`;
    await pushLog(`▶ Searching: ${query}`);

    await chrome.storage.local.set({
      gmsActive: task,
      gmsQueue: RT.queue,
      gmsConfig: RT.config,
      gmsTarget: RT.target
    });

    const here = navigateToSearch(query);
    if (!here) return false;

    if (!await waitForFeed()) {
      await pushLog(`✗ No results for: ${query}`);
      return true;
    }

    await pushLog(`Loading results...`);
    const total = await scrollFeed(RT.config.scrollLimit || 25);
    if (total === 0) {
      await pushLog(`✗ Empty feed`);
      return true;
    }

    await pushLog(`Found ${total} cards. Visiting each...`);
    const cards = getPlaceCards();
    const max = Math.min(cards.length, RT.config.maxPerSearch || 50);

    for (let i = 0; i < max; i++) {
      if (shouldStop()) break;
      if (RT.collected >= RT.target) break;
      await waitWhilePaused();
      await processCard(cards[i], i, max, {
        keyword: task.keyword,
        location: task.location,
        profileWaitSec: RT.config.profileWaitSec
      });
      await sleep(rand(250, 500));
    }
    return true;
  }

  async function runEngine() {
    RT.status = "running";
    await saveState({ status: "running", target: RT.target, logs: [] });
    await pushLog(`Campaign started — target ${RT.target}, ${RT.queue.length} tasks`);

    while (RT.queue.length && !shouldStop() && RT.collected < RT.target) {
      await waitWhilePaused();
      const task = RT.queue.shift();
      await chrome.storage.local.set({ gmsQueue: RT.queue });
      await recountStats();
      const finished = await processTask(task);
      if (!finished) return;
    }

    RT.status = shouldStop() ? "stopped" : "idle";
    await saveState({ status: RT.status });
    await pushLog(RT.collected >= RT.target
      ? `✓ Target reached (${RT.collected})`
      : (shouldStop() ? `■ Stopped at ${RT.collected}` : `✓ Done (${RT.collected})`));
    await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget"]);
  }

  async function tryResume() {
    const { gmsQueue, gmsActive, gmsConfig, gmsTarget, leads = [] } =
      await chrome.storage.local.get(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget", "leads"]);
    if (!gmsActive || !gmsConfig) return;

    RT.config = gmsConfig;
    RT.queue = gmsQueue || [];
    RT.target = gmsTarget || 100;
    RT.collected = leads.length;
    RT.seen = new Set(leads.map(l => (l.name + "|" + (l.phone || "")).toLowerCase()));
    RT.seenUrls = new Set();
    RT.status = "running";
    await pushLog(`Resuming: ${gmsActive.keyword} in ${gmsActive.location}`);

    if (!await waitForFeed()) {
      await pushLog(`✗ No feed after resume`);
    } else {
      await scrollFeed(RT.config.scrollLimit || 25);
      const cards = getPlaceCards();
      const max = Math.min(cards.length, RT.config.maxPerSearch || 50);
      for (let i = 0; i < max; i++) {
        if (shouldStop()) break;
        if (RT.collected >= RT.target) break;
        await waitWhilePaused();
        await processCard(cards[i], i, max, {
          keyword: gmsActive.keyword,
          location: gmsActive.location,
          profileWaitSec: RT.config.profileWaitSec
        });
        await sleep(rand(250, 500));
      }
    }

    while (RT.queue.length && !shouldStop() && RT.collected < RT.target) {
      const task = RT.queue.shift();
      await chrome.storage.local.set({ gmsQueue: RT.queue });
      await recountStats();
      const finished = await processTask(task);
      if (!finished) return;
    }

    RT.status = shouldStop() ? "stopped" : "idle";
    await saveState({ status: RT.status });
    await pushLog(`✓ Done (${RT.collected})`);
    await chrome.storage.local.remove(["gmsQueue", "gmsActive", "gmsConfig", "gmsTarget"]);
  }

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
          const { leads = [] } = await chrome.storage.local.get(["leads"]);
          RT.collected = leads.length;
          RT.seen = new Set(leads.map(l => (l.name + "|" + (l.phone || "")).toLowerCase()));
          RT.seenUrls = new Set();
          RT.abort = false;
          sendResponse({ ok: true });
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
          RT.abort = true;
          await saveState({ status: "stopped" });
          await pushLog("■ Stopped");
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

  (async () => {
    await sleep(800);
    await tryResume();
  })();
})();
