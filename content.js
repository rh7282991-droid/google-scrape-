// content.js — runs on every Google search results page
// Extracts result blocks (title, url, description) and sends them to background.

(function () {
  "use strict";

  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  // International-ish phone number regex (loose, post-filtered for digit count)
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;

  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function unwrapGoogleUrl(href) {
    if (!href) return "";
    try {
      // Google sometimes wraps URLs as /url?q=ACTUAL&...
      if (href.startsWith("/url?")) {
        const u = new URL(href, location.origin);
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        if (q) return q;
      }
      return href;
    } catch (_) {
      return href;
    }
  }

  function extractFromText(text) {
    const emails = Array.from(new Set((text.match(EMAIL_RE) || []).map(s => s.toLowerCase())));
    const phonesRaw = text.match(PHONE_RE) || [];
    const phones = Array.from(new Set(
      phonesRaw
        .map(p => p.trim())
        .filter(p => {
          const digits = p.replace(/\D/g, "");
          return digits.length >= 8 && digits.length <= 15;
        })
    ));
    return { emails, phones };
  }

  function extractResults() {
    const out = [];
    const seen = new Set();

    // Modern Google SERP: each organic result lives inside div.g (or [data-hveid] containing an h3)
    // We use a forgiving selector and dedupe by URL.
    const blocks = document.querySelectorAll(
      "div.g, div.tF2Cxc, div[data-hveid] div[data-snc], div[jscontroller][data-hveid]"
    );

    blocks.forEach(block => {
      const linkEl = block.querySelector("a[href]");
      const titleEl = block.querySelector("h3");
      if (!linkEl || !titleEl) return;

      let url = unwrapGoogleUrl(linkEl.getAttribute("href"));
      if (!url || !/^https?:\/\//i.test(url)) return;
      if (url.includes("google.com/search") || url.includes("webcache.googleusercontent.com")) return;
      if (seen.has(url)) return;
      seen.add(url);

      const title = clean(titleEl.textContent);

      // Description: try several known containers, fallback to block text minus title
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
        title,
        url,
        description,
        emails,
        phones,
        query: new URLSearchParams(location.search).get("q") || "",
        page: Number(new URLSearchParams(location.search).get("start") || 0) / 10 + 1,
        scrapedAt: new Date().toISOString()
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
        position: "fixed",
        bottom: "20px",
        right: "20px",
        background: "#1a73e8",
        color: "#fff",
        padding: "10px 14px",
        borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        zIndex: 999999,
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        opacity: "0",
        transition: "opacity .25s ease"
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 2200);
  }

  async function isAutoMode() {
    const data = await chrome.storage.local.get(["autoScrape"]);
    return !!data.autoScrape;
  }

  async function saveResults(results) {
    if (!results.length) return 0;
    const data = await chrome.storage.local.get(["leads"]);
    const leads = data.leads || [];
    const seen = new Set(leads.map(l => l.url));
    let added = 0;
    for (const r of results) {
      if (!seen.has(r.url)) {
        leads.push(r);
        seen.add(r.url);
        added++;
      }
    }
    await chrome.storage.local.set({ leads });
    return added;
  }

  async function runScrape() {
    const results = extractResults();
    const added = await saveResults(results);
    showToast(`Scraped ${results.length} result(s) on this page • ${added} new saved`);
    return { found: results.length, added };
  }

  async function maybeAutoNext() {
    const { autoNext, autoMaxPages } = await chrome.storage.local.get(["autoNext", "autoMaxPages"]);
    if (!autoNext) return;
    const params = new URLSearchParams(location.search);
    const currentStart = Number(params.get("start") || 0);
    const currentPage = currentStart / 10 + 1;
    const maxPages = Number(autoMaxPages || 5);
    if (currentPage >= maxPages) {
      showToast(`Auto-scrape finished (max ${maxPages} pages reached)`);
      await chrome.storage.local.set({ autoScrape: false, autoNext: false });
      return;
    }
    // Find Next link
    const nextLink =
      document.querySelector("a#pnnext") ||
      document.querySelector('a[aria-label="Next page"]') ||
      document.querySelector('a[aria-label="Next"]');
    if (nextLink) {
      // Random small delay 2-5s to look human-ish
      const delay = 2000 + Math.floor(Math.random() * 3000);
      showToast(`Going to page ${currentPage + 1} in ${(delay / 1000).toFixed(1)}s...`);
      setTimeout(() => {
        location.href = nextLink.href;
      }, delay);
    } else {
      showToast("No Next page link found — auto-scrape stopped.");
      await chrome.storage.local.set({ autoScrape: false, autoNext: false });
    }
  }

  // Listen to popup messages
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "SCRAPE_NOW") {
      runScrape().then(r => sendResponse(r));
      return true; // async
    }
  });

  // Auto-mode: run on page load
  (async () => {
    if (await isAutoMode()) {
      // small wait for results to render fully
      setTimeout(async () => {
        await runScrape();
        await maybeAutoNext();
      }, 1200);
    }
  })();
})();
