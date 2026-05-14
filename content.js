// content.js — runs on every Google search results page
// Extracts result blocks based on user-selected fields and reports live progress.

(function () {
  "use strict";

  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

  const DEFAULT_FIELDS = {
    title: true, url: true, description: true, domain: true,
    emails: true, phones: true, position: false, query: false
  };

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

      out.push({
        title, url, description,
        domain: getDomain(url),
        emails, phones,
        position,
        query: new URLSearchParams(location.search).get("q") || ""
      });
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
      const delay = 2000 + Math.floor(Math.random() * 3000);
      const seconds = (delay / 1000).toFixed(1);
      showToast(`Going to page ${currentPage + 1} in ${seconds}s...`);

      // Live countdown in popup
      let remaining = delay;
      const tick = setInterval(async () => {
        remaining -= 250;
        await setProgress({
          isRunning: true,
          currentItem: `Next page in ${(Math.max(0, remaining) / 1000).toFixed(1)}s...`
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
        // single-page scrape: stop progress after a short moment
        setTimeout(() => clearProgress(), 1500);
        sendResponse(r);
      });
      return true;
    }
  });

  (async () => {
    const { autoScrape } = await chrome.storage.local.get(["autoScrape"]);
    if (autoScrape) {
      setTimeout(async () => {
        await runScrape({ silent: false });
        await maybeAutoNext();
      }, 1200);
    }
  })();
})();
