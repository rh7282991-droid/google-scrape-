// content.js — runs on every Google search results page
// Robust extraction that works across all Google layouts (any country, any year)

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
      // Handle relative /url?q=...
      if (href.startsWith("/url?") || href.startsWith("/search?")) {
        const u = new URL(href, location.origin);
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        if (q && /^https?:\/\//i.test(q)) return q;
      }
      // Absolute google.com/url?q=
      if (/^https?:\/\/(www\.)?google\.[a-z.]+\/url\?/i.test(href)) {
        const u = new URL(href);
        const q = u.searchParams.get("q") || u.searchParams.get("url");
        if (q && /^https?:\/\//i.test(q)) return q;
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
    if (fields.url || true) out.url = rec.url; // always keep for dedup
    if (fields.description) out.description = rec.description;
    if (fields.domain) out.domain = rec.domain;
    if (fields.emails) out.emails = rec.emails;
    if (fields.phones) out.phones = rec.phones;
    if (fields.position) out.position = rec.position;
    if (fields.query) out.query = rec.query;
    return out;
  }

  // Find the nearest ancestor that "looks like" a result block
  // (so we can grab the description text near it)
  function findResultContainer(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      if (node.matches && (
        node.matches("div.g") ||
        node.matches("div.tF2Cxc") ||
        node.matches("div.MjjYud") ||
        node.matches("div[data-snhf]") ||
        node.matches("div[data-hveid]") ||
        node.matches("div[jscontroller]")
      )) {
        return node;
      }
      node = node.parentElement;
    }
    return el.parentElement || el;
  }

  function extractDescription(container, titleText) {
    // Try a wide range of known description containers
    const selectors = [
      "div[data-sncf='1']",
      "div[data-sncf]",
      "div.VwiC3b",
      "div.IsZvec",
      "div.lEBKkf",
      "div.lyLwlc",
      "span.aCOpRe",
      "div.s3v9rd",
      "div.s",
      "div[role='heading'] + div",
      ".kvgmc6g5"
    ];
    for (const sel of selectors) {
      const el = container.querySelector(sel);
      if (el && el.textContent.trim().length > 20) {
        return clean(el.textContent);
      }
    }
    // Fallback: take the container's text minus the title
    let text = clean((container.textContent || "").replace(titleText, ""));
    if (text.length > 400) text = text.slice(0, 400) + "...";
    return text;
  }

  function extractResults() {
    const out = [];
    const seen = new Set();

    // Strategy: find every <h3> on the page, walk up to find its <a href> ancestor
    // This is the most reliable approach since Google always wraps results around an h3.
    const headings = document.querySelectorAll("h3");
    let position = (getCurrentPage() - 1) * 10;

    headings.forEach(h3 => {
      const title = clean(h3.textContent);
      if (!title) return;

      // Walk up to find the link wrapping this h3
      let linkEl = h3.closest("a[href]");
      // If h3 is not inside an <a>, try sibling/cousin links in container
      if (!linkEl) {
        const container = findResultContainer(h3);
        linkEl = container.querySelector("a[href]");
      }
      if (!linkEl) return;

      let url = unwrapGoogleUrl(linkEl.getAttribute("href") || linkEl.href);
      if (!url || !/^https?:\/\//i.test(url)) return;

      // Filter junk
      if (url.includes("/search?") && /google\.[a-z.]+/.test(url)) return;
      if (url.includes("webcache.googleusercontent.com")) return;
      if (url.includes("/preferences?")) return;
      if (url.includes("accounts.google.com")) return;
      if (url.startsWith("https://www.google.com/url")) return;
      if (seen.has(url)) return;
      seen.add(url);
      position++;

      const container = findResultContainer(h3);
      const description = extractDescription(container, title);

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

  function showToast(message, type = "info") {
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
        opacity: "0", transition: "opacity .25s ease",
        maxWidth: "300px"
      });
      document.body.appendChild(toast);
    }
    toast.style.background = type === "error" ? "#d93025" : "#1a73e8";
    toast.textContent = message;
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 3000);
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

    const { autoMaxPages = 5, autoNext, autoEnrich = true } =
      await chrome.storage.local.get(["autoMaxPages", "autoNext", "autoEnrich"]);
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
      if (results.length === 0) {
        showToast("No results detected. Scroll the page or try a different query.", "error");
      } else {
        showToast(`Scraped ${results.length} on page ${currentPage}. Now finding emails/phones...`);
      }
    }

    // Auto-enrich newly added leads (visit each URL, look for contact info)
    if (autoEnrich && results.length > 0) {
      const urls = results.map(r => r.url);
      // Fire-and-forget — background will update progress live
      chrome.runtime.sendMessage({ type: "AUTO_ENRICH", urls }).catch(() => {});
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
      document.querySelector('a[aria-label="Next"]') ||
      document.querySelector('a[aria-label*="ext" i]');

    if (nextLink) {
      const delay = 2000 + Math.floor(Math.random() * 3000);
      const seconds = (delay / 1000).toFixed(1);
      showToast(`Going to page ${currentPage + 1} in ${seconds}s...`);

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
        setTimeout(() => clearProgress(), 1500);
        sendResponse(r);
      });
      return true;
    }
    if (msg && msg.type === "PING") {
      sendResponse({ ok: true });
      return false;
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
