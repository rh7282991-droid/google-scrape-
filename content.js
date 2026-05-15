// content.js — runs on every Google search results page
// Extracts result blocks based on user-selected fields and reports live progress.
// Features: Smart random delay, lead quality scoring

(function () {
  "use strict";

  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

  const DEFAULT_FIELDS = {
    title: true, url: true, description: true, domain: true,
    emails: true, phones: true, position: false, query: false
  };

  // ===== FEATURE 1: Smart Random Delay (content-side) =====
  const SmartDelay = {
    baseMin: 2000,
    baseMax: 5000,
    consecutivePages: 0,
    lastNavTime: 0,
    backoffMultiplier: 1,

    getDelay() {
      const now = Date.now();
      const timeSinceLast = now - this.lastNavTime;

      // Increase backoff for rapid page navigation
      if (timeSinceLast < 5000 && this.lastNavTime > 0) {
        this.consecutivePages++;
        this.backoffMultiplier = Math.min(5, 1 + (this.consecutivePages * 0.4));
      } else if (timeSinceLast > 15000) {
        // Cooldown after long pause
        this.consecutivePages = Math.max(0, this.consecutivePages - 2);
        this.backoffMultiplier = Math.max(1, this.backoffMultiplier - 0.5);
      }

      // Gaussian-like jitter
      const jitter = this._pseudoGaussian() * 1500;
      const base = this.baseMin + Math.random() * (this.baseMax - this.baseMin);
      const delay = Math.round((base + jitter) * this.backoffMultiplier);

      // 15% chance of a longer "human reading" pause
      const readingPause = Math.random() < 0.15 ? (4000 + Math.random() * 6000) : 0;

      // Occasional very short pause to seem random (5% chance)
      const quickPause = Math.random() < 0.05 ? -(delay * 0.4) : 0;

      this.lastNavTime = now;
      return Math.max(1200, delay + readingPause + quickPause);
    },

    _pseudoGaussian() {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * 0.3;
    },

    getState() {
      return {
        multiplier: this.backoffMultiplier.toFixed(1),
        consecutive: this.consecutivePages,
        avgDelay: Math.round((this.baseMin + this.baseMax) / 2 * this.backoffMultiplier)
      };
    }
  };

  // ===== FEATURE 4: Lead Quality Score =====
  function calculateLeadQuality(lead) {
    let score = 0;

    if (lead.title && lead.title.trim().length > 3) score += 10;
    if (lead.url && lead.url.startsWith("http")) score += 5;
    if (lead.domain && lead.domain.length > 3) score += 5;

    if (lead.description) {
      score += 10;
      if (lead.description.length > 100) score += 5;
    }

    const emails = lead.emails || [];
    if (emails.length > 0) {
      score += 15;
      const businessEmails = emails.filter(e =>
        !/(gmail|yahoo|hotmail|outlook|aol|mail)\./i.test(e)
      );
      if (businessEmails.length > 0) score += 10;
    }

    const phones = lead.phones || [];
    if (phones.length > 0) score += 20;

    if (lead.domain) {
      if (lead.domain.length < 20) score += 3;
      if (/\.(com|io|co|org|net)$/i.test(lead.domain)) score += 3;
      if (!/^(facebook|twitter|linkedin|yelp|yellowpages|pinterest)/i.test(lead.domain)) score += 4;
    }

    return Math.min(100, Math.max(0, score));
  }

  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function unwrapGoogleUrl(href) {
    if (!href) return "";
    try {
      if (href.startsWith("/url?")) {
        const u = new URL(href, location.origin);
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        if (q) return q;
      }
      return href;
    } catch (_) { return href; }
  }

  function extractFromText(text) {
    const emails = Array.from(new Set((text.match(EMAIL_RE) || []).map(s => s.toLowerCase())));
    const phonesRaw = text.match(PHONE_RE) || [];
    const phones = Array.from(new Set(
      phonesRaw.map(p => p.trim()).filter(p => {
        const digits = p.replace(/\D/g, "");
        return digits.length >= 8 && digits.length <= 15;
      })
    ));
    return { emails, phones };
  }

  function getDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return ""; }
  }

  function getCurrentPage() {
    const start = Number(new URLSearchParams(location.search).get("start") || 0);
    return Math.floor(start / 10) + 1;
  }

  function applyFields(rec, fields) {
    const out = { scrapedAt: new Date().toISOString() };
    if (fields.title) out.title = rec.title;
    if (fields.url) out.url = rec.url;
    if (fields.description) out.description = rec.description;
    if (fields.domain) out.domain = rec.domain;
    if (fields.emails) out.emails = rec.emails;
    if (fields.phones) out.phones = rec.phones;
    if (fields.position) out.position = rec.position;
    if (fields.query) out.query = rec.query;
    out.url = rec.url; // always keep url internally for dedup
    out.qualityScore = rec.qualityScore; // always include quality score
    return out;
  }

  function extractResults() {
    const out = [];
    const seen = new Set();

    const blocks = document.querySelectorAll(
      "div.g, div.tF2Cxc, div[data-hveid] div[data-snc], div[jscontroller][data-hveid]"
    );

    let position = (getCurrentPage() - 1) * 10;
    blocks.forEach(block => {
      const linkEl = block.querySelector("a[href]");
      const titleEl = block.querySelector("h3");
      if (!linkEl || !titleEl) return;

      let url = unwrapGoogleUrl(linkEl.getAttribute("href"));
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (url.includes("google.com/search") || url.includes("webcache.googleusercontent.com")) return;
      if (seen.has(url)) return;
      seen.add(url);
      position++;

      const title = clean(titleEl.textContent);

      let descEl =
        block.querySelector("div[data-sncf='1']") ||
        block.querySelector("div.VwiC3b") ||
        block.querySelector("div.IsZvec") ||
        block.querySelector("span.aCOpRe") ||
        block.querySelector("div.s") ||
        null;
      let description = descEl ? clean(descEl.textContent) : "";
      if (!description) {
        description = clean(block.textContent.replace(title, ""));
        if (description.length > 400) description = description.slice(0, 400) + "...";
      }

      const combined = `${title} ${description}`;
      const { emails, phones } = extractFromText(combined);

      const lead = {
        title, url, description,
        domain: getDomain(url),
        emails, phones,
        position,
        query: new URLSearchParams(location.search).get("q") || ""
      };

      // FEATURE 4: Calculate quality score
      lead.qualityScore = calculateLeadQuality(lead);

      out.push(lead);
    });

    return out;
  }

  function showToast(message) {
    let toast = document.getElementById("__gls_toast__");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__gls_toast__";
      Object.assign(toast.style, {
        position: "fixed", bottom: "20px", right: "20px",
        background: "#1a73e8", color: "#fff",
        padding: "10px 14px", borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        zIndex: 999999, boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        opacity: "0", transition: "opacity .25s ease"
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 2200);
  }

  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    const next = { ...progress, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ progress: next });
  }

  async function clearProgress() {
    await chrome.storage.local.set({ progress: { isRunning: false } });
  }

  async function getFields() {
    const { fields } = await chrome.storage.local.get(["fields"]);
    return fields || DEFAULT_FIELDS;
  }

  // Update live preview after saving
  async function updateLivePreview() {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const last5 = leads.slice(-5).reverse().map(l => ({
      title: (l.title || "").slice(0, 50),
      domain: l.domain || "",
      emails: (l.emails || []).slice(0, 2),
      phones: (l.phones || []).slice(0, 1),
      qualityScore: l.qualityScore || 0
    }));
    await chrome.storage.local.set({ livePreview: last5 });
  }

  async function saveResults(results, fields) {
    if (!results.length) return 0;
    const data = await chrome.storage.local.get(["leads"]);
    const leads = data.leads || [];
    const seen = new Set(leads.map(l => l.url));
    let added = 0;
    for (const r of results) {
      if (!seen.has(r.url)) {
        leads.push(applyFields(r, fields));
        seen.add(r.url);
        added++;
      }
    }
    await chrome.storage.local.set({ leads });
    // FEATURE 3: Update live preview
    await updateLivePreview();
    return added;
  }

  async function runScrape({ silent = false } = {}) {
    const fields = await getFields();
    const results = extractResults();

    const { autoMaxPages = 5, autoNext } = await chrome.storage.local.get(["autoMaxPages", "autoNext"]);
    const totalPages = autoNext ? Number(autoMaxPages) : 1;
    const currentPage = getCurrentPage();

    await setProgress({
      isRunning: true,
      title: autoNext ? "Auto-scraping pages..." : "Scraping current page",
      currentPage,
      totalPages,
      currentItem: `Found ${results.length} on page ${currentPage}`
    });

    const added = await saveResults(results, fields);
    const { leads = [] } = await chrome.storage.local.get(["leads"]);

    await setProgress({
      isRunning: true,
      totalFound: leads.length,
      currentItem: `Page ${currentPage}: +${added} new (${results.length} on page)`
    });

    if (!silent) {
      showToast(`Scraped ${results.length} on page ${currentPage} • ${added} new saved`);
    }
    return { found: results.length, added };
  }

  async function maybeAutoNext() {
    const { autoNext, autoMaxPages } = await chrome.storage.local.get(["autoNext", "autoMaxPages"]);
    if (!autoNext) {
      await clearProgress();
      return;
    }
    const currentPage = getCurrentPage();
    const maxPages = Number(autoMaxPages || 5);

    if (currentPage >= maxPages) {
      showToast(`Auto-scrape finished (max ${maxPages} pages reached)`);
      await setProgress({ isRunning: false, currentItem: "Done!" });
      await chrome.storage.local.set({ autoScrape: false, autoNext: false });
      return;
    }

    const nextLink =
      document.querySelector("a#pnnext") ||
      document.querySelector('a[aria-label="Next page"]') ||
      document.querySelector('a[aria-label="Next"]');

    if (nextLink) {
      // FEATURE 1: Smart random delay instead of basic random
      const delay = SmartDelay.getDelay();
      const seconds = (delay / 1000).toFixed(1);
      showToast(`Going to page ${currentPage + 1} in ${seconds}s (anti-block)...`);

      // Live countdown in popup with delay info
      let remaining = delay;
      const tick = setInterval(async () => {
        remaining -= 250;
        await setProgress({
          isRunning: true,
          currentItem: `Next page in ${(Math.max(0, remaining) / 1000).toFixed(1)}s... (delay ×${SmartDelay.getState().multiplier})`,
          delayInfo: SmartDelay.getState()
        });
        if (remaining <= 0) clearInterval(tick);
      }, 250);

      setTimeout(() => { location.href = nextLink.href; }, delay);
    } else {
      showToast("No Next page link found — auto-scrape stopped.");
      await setProgress({ isRunning: false, currentItem: "No more pages." });
      await chrome.storage.local.set({ autoScrape: false, autoNext: false });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "SCRAPE_NOW") {
      runScrape().then(async (r) => {
        setTimeout(() => clearProgress(), 1500);
        sendResponse(r);
      });
      return true;
    }
  });

  (async () => {
    const { autoScrape } = await chrome.storage.local.get(["autoScrape"]);
    if (autoScrape) {
      // FEATURE 1: Smart delay before auto-scrape starts
      const initialDelay = 1200 + Math.random() * 1500;
      setTimeout(async () => {
        await runScrape({ silent: false });
        await maybeAutoNext();
      }, initialDelay);
    }
  })();
})();
