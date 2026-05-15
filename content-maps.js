// content-maps.js — runs on Google Maps pages
// Scrapes business listings with: name, address, phone, website, rating, reviews, hours, social links
// Supports Multi-Source Data Fusion with Google Search leads

(function () {
  "use strict";

  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const SOCIAL_RE = {
    facebook: /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9._%-]+/gi,
    instagram: /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._%-]+/gi,
    linkedin: /https?:\/\/(www\.)?linkedin\.com\/(company|in)\/[a-zA-Z0-9._%-]+/gi,
    twitter: /https?:\/\/(www\.)?(twitter|x)\.com\/[a-zA-Z0-9._%-]+/gi,
    youtube: /https?:\/\/(www\.)?youtube\.com\/(channel|c|@)[\/a-zA-Z0-9._%-]+/gi
  };

  // ===== Utility Functions =====
  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function getDomain(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return ""; }
  }

  // ===== FEATURE 10: Social Media Detection =====
  function extractSocialLinks(text) {
    const socials = {};
    for (const [platform, regex] of Object.entries(SOCIAL_RE)) {
      const matches = text.match(regex);
      if (matches && matches.length > 0) {
        // Deduplicate and take first valid one
        const unique = [...new Set(matches.map(u => u.replace(/\/+$/, "")))];
        socials[platform] = unique[0];
      }
    }
    return socials;
  }

  // ===== FEATURE 13: Opening Hours Detail =====
  function extractOpeningHours() {
    const hours = {};
    const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

    // Try multiple selectors for hours table
    const hoursTable = document.querySelector('table.eK4R0e') ||
                       document.querySelector('div[aria-label*="hour"]') ||
                       document.querySelector('.section-open-hours-container');

    if (hoursTable) {
      const rows = hoursTable.querySelectorAll('tr, div.OqCZI');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td, div');
        if (cells.length >= 2) {
          const day = clean(cells[0].textContent);
          const time = clean(cells[1].textContent);
          if (day && time) {
            hours[day] = time;
          }
        }
      });
    }

    // Alternative: Parse from aria-label attributes
    if (Object.keys(hours).length === 0) {
      const hoursBtn = document.querySelector('[data-item-id="oh"], button[aria-label*="hour"]');
      if (hoursBtn) {
        const label = hoursBtn.getAttribute("aria-label") || "";
        // Parse patterns like "Monday, 9 AM to 9 PM; Tuesday, 9 AM to 9 PM"
        const parts = label.split(/[;.]/).filter(Boolean);
        for (const part of parts) {
          for (const day of daysOfWeek) {
            if (part.includes(day)) {
              const timeMatch = part.replace(day, "").replace(/^[\s,]+/, "").trim();
              if (timeMatch) hours[day] = timeMatch;
            }
          }
        }
      }
    }

    // Try to parse from the info section text
    if (Object.keys(hours).length === 0) {
      const allText = document.body.innerText;
      for (const day of daysOfWeek) {
        const re = new RegExp(day + "[:\\s]+([\\d:]+\\s*(?:AM|PM|am|pm)\\s*[-–to]+\\s*[\\d:]+\\s*(?:AM|PM|am|pm))", "i");
        const m = allText.match(re);
        if (m) hours[day] = m[1].trim();
      }
    }

    return Object.keys(hours).length > 0 ? hours : null;
  }

  // ===== FEATURE 11: Reviews Scraping =====
  function extractReviews() {
    const reviewData = {
      averageRating: null,
      totalReviews: null,
      ratingDistribution: {},
      topReviews: []
    };

    // Get average rating
    const ratingEl = document.querySelector('span.ceNzKf, div.fontDisplayLarge, span[aria-label*="stars"]');
    if (ratingEl) {
      const ratingText = ratingEl.textContent || ratingEl.getAttribute("aria-label") || "";
      const ratingMatch = ratingText.match(/([\d.]+)/);
      if (ratingMatch) reviewData.averageRating = parseFloat(ratingMatch[1]);
    }

    // Get total review count
    const countEl = document.querySelector('span.fontBodyMedium[aria-label*="review"], button[aria-label*="review"]');
    if (countEl) {
      const countText = countEl.textContent || countEl.getAttribute("aria-label") || "";
      const countMatch = countText.match(/([\d,]+)\s*review/i);
      if (countMatch) reviewData.totalReviews = parseInt(countMatch[1].replace(/,/g, ""));
    }

    // Alternative total count
    if (!reviewData.totalReviews) {
      const altCount = document.querySelector('.fontBodyMedium span[aria-label]');
      if (altCount) {
        const txt = altCount.getAttribute("aria-label") || altCount.textContent || "";
        const m = txt.match(/([\d,]+)\s*review/i);
        if (m) reviewData.totalReviews = parseInt(m[1].replace(/,/g, ""));
      }
    }

    // Rating distribution (5-star, 4-star, etc.)
    const distRows = document.querySelectorAll('tr.BHOKXe, div[aria-label*="star"]');
    distRows.forEach(row => {
      const label = row.getAttribute("aria-label") || row.textContent || "";
      const starMatch = label.match(/(\d)\s*star/i);
      const percentMatch = label.match(/(\d+)%/) || label.match(/([\d,]+)\s*review/i);
      if (starMatch) {
        const stars = starMatch[1];
        if (percentMatch) {
          reviewData.ratingDistribution[`${stars}_star`] = percentMatch[1].includes("%")
            ? percentMatch[1]
            : parseInt(percentMatch[1].replace(/,/g, ""));
        }
      }
    });

    // Top 5 reviews
    const reviewEls = document.querySelectorAll(
      'div.jftiEf, div[data-review-id], div.section-review'
    );

    let count = 0;
    reviewEls.forEach(el => {
      if (count >= 5) return;

      const authorEl = el.querySelector('.d4r55, span.WNxzHc, div.section-review-title');
      const textEl = el.querySelector('.wiI7pd, span.rsqaWe, div.section-review-text');
      const starsEl = el.querySelector('span[aria-label*="star"], span.kvMYJc');
      const dateEl = el.querySelector('span.rsqaWe, span.DU9Pgb');

      const review = {};
      if (authorEl) review.author = clean(authorEl.textContent);
      if (textEl) review.text = clean(textEl.textContent).slice(0, 500);
      if (starsEl) {
        const starLabel = starsEl.getAttribute("aria-label") || starsEl.textContent || "";
        const sm = starLabel.match(/([\d.]+)/);
        if (sm) review.rating = parseFloat(sm[1]);
      }
      if (dateEl) review.date = clean(dateEl.textContent);

      if (review.text || review.author) {
        reviewData.topReviews.push(review);
        count++;
      }
    });

    return reviewData;
  }

  // ===== Extract single business detail from Maps side panel =====
  function extractBusinessDetail() {
    const biz = {};

    // Business name
    const nameEl = document.querySelector('h1.DUwDvf, h1.fontHeadlineLarge, div[role="main"] h1');
    biz.title = nameEl ? clean(nameEl.textContent) : "";

    // Category/type
    const catEl = document.querySelector('button[jsaction*="category"], span.DkEaL');
    biz.category = catEl ? clean(catEl.textContent) : "";

    // Address
    const addrEl = document.querySelector('button[data-item-id="address"], div[data-item-id="address"]');
    biz.address = addrEl ? clean(addrEl.textContent).replace(/^[^:]*:\s*/, "") : "";

    // Alternative address
    if (!biz.address) {
      const addrAlt = document.querySelector('[aria-label*="Address"], .rogA2c .Io6YTe');
      if (addrAlt) biz.address = clean(addrAlt.textContent || addrAlt.getAttribute("aria-label") || "");
    }

    // Phone
    const phoneEl = document.querySelector('button[data-item-id*="phone"], div[data-item-id*="phone"]');
    biz.phone = phoneEl ? clean(phoneEl.textContent).replace(/^[^:]*:\s*/, "") : "";

    if (!biz.phone) {
      const phoneAlt = document.querySelector('[aria-label*="Phone"], a[href^="tel:"]');
      if (phoneAlt) {
        biz.phone = clean(phoneAlt.textContent || phoneAlt.getAttribute("aria-label") || "");
        if (!biz.phone && phoneAlt.href) biz.phone = phoneAlt.href.replace("tel:", "");
      }
    }

    // Website
    const webEl = document.querySelector('a[data-item-id="authority"], a[aria-label*="website"], a[aria-label*="Website"]');
    biz.website = webEl ? (webEl.href || "") : "";

    if (!biz.website) {
      const webAlt = document.querySelector('button[data-item-id="authority"]');
      if (webAlt) biz.website = clean(webAlt.textContent);
    }

    // Rating
    const ratingEl = document.querySelector('span.ceNzKf, div.fontDisplayLarge');
    if (ratingEl) {
      const m = (ratingEl.textContent || "").match(/([\d.]+)/);
      if (m) biz.rating = parseFloat(m[1]);
    }

    // Review count
    const reviewCountEl = document.querySelector('span[aria-label*="review"], button[aria-label*="review"]');
    if (reviewCountEl) {
      const txt = reviewCountEl.getAttribute("aria-label") || reviewCountEl.textContent || "";
      const m = txt.match(/([\d,]+)/);
      if (m) biz.totalReviews = parseInt(m[1].replace(/,/g, ""));
    }

    // Plus code / coordinates from URL
    try {
      const urlMatch = location.href.match(/@([-\d.]+),([-\d.]+)/);
      if (urlMatch) {
        biz.latitude = parseFloat(urlMatch[1]);
        biz.longitude = parseFloat(urlMatch[2]);
      }
    } catch (_) {}

    // Google Maps URL
    biz.mapsUrl = location.href;

    // Domain from website
    biz.domain = biz.website ? getDomain(biz.website) : "";

    // Extract emails from visible page text
    const pageText = document.body.innerText || "";
    const emails = Array.from(new Set((pageText.match(EMAIL_RE) || []).map(s => s.toLowerCase())));
    biz.emails = emails.filter(e => !/(example|test|noreply)/i.test(e));

    // Extract phones from page
    const phones = (pageText.match(PHONE_RE) || [])
      .map(p => p.trim())
      .filter(p => { const d = p.replace(/\D/g, ""); return d.length >= 8 && d.length <= 15; });
    biz.phones = Array.from(new Set([biz.phone, ...phones].filter(Boolean)));

    // FEATURE 10: Social media from Maps page links
    const allLinks = Array.from(document.querySelectorAll("a[href]")).map(a => a.href).join(" ");
    biz.socialLinks = extractSocialLinks(allLinks + " " + pageText);

    // FEATURE 13: Opening hours
    biz.openingHours = extractOpeningHours();

    // FEATURE 11: Reviews
    biz.reviews = extractReviews();

    // Source tracking for multi-source fusion
    biz.source = "google_maps";
    biz.scrapedAt = new Date().toISOString();

    return biz;
  }

  // ===== Extract list of businesses from Maps search results =====
  function extractMapsSearchResults() {
    const results = [];
    const seen = new Set();

    // Maps search results feed
    const items = document.querySelectorAll(
      'div[role="feed"] > div > div > a, ' +
      'div.Nv2PK, ' +
      'a.hfpxzc'
    );

    items.forEach((item, idx) => {
      const link = item.closest("a") || item;
      const href = link.href || "";
      if (!href || seen.has(href)) return;
      seen.add(href);

      const biz = {};
      biz.mapsUrl = href;
      biz.position = idx + 1;

      // Name from aria-label
      const label = link.getAttribute("aria-label") || "";
      biz.title = clean(label);

      // Try to get details from parent container
      const container = link.closest('div.Nv2PK') || link.parentElement;
      if (container) {
        // Rating
        const ratingEl = container.querySelector('span.MW4etd, span[role="img"]');
        if (ratingEl) {
          const m = (ratingEl.textContent || ratingEl.getAttribute("aria-label") || "").match(/([\d.]+)/);
          if (m) biz.rating = parseFloat(m[1]);
        }

        // Review count
        const countEl = container.querySelector('span.UY7F9');
        if (countEl) {
          const m = (countEl.textContent || "").match(/([\d,]+)/);
          if (m) biz.totalReviews = parseInt(m[1].replace(/,/g, ""));
        }

        // Category
        const catEls = container.querySelectorAll('.W4Efsd span, .fontBodyMedium span');
        const cats = [];
        catEls.forEach(el => {
          const t = clean(el.textContent);
          if (t && t.length < 50 && !t.includes("review") && !t.match(/^\d/)) cats.push(t);
        });
        if (cats.length > 0) biz.category = cats[0];

        // Address snippet
        const addrSpans = container.querySelectorAll('.W4Efsd .W4Efsd span:not(.UY7F9):not(.MW4etd)');
        addrSpans.forEach(el => {
          const t = clean(el.textContent);
          if (t.length > 10 && !biz.address) biz.address = t;
        });

        // Phone from text
        const allText = container.textContent || "";
        const phoneMatches = allText.match(PHONE_RE);
        if (phoneMatches) {
          biz.phones = Array.from(new Set(
            phoneMatches.map(p => p.trim()).filter(p => {
              const d = p.replace(/\D/g, ""); return d.length >= 8 && d.length <= 15;
            })
          ));
        }
      }

      biz.source = "google_maps";
      biz.scrapedAt = new Date().toISOString();
      results.push(biz);
    });

    return results;
  }

  // ===== Toast notification =====
  function showToast(message) {
    let toast = document.getElementById("__gls_maps_toast__");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "__gls_maps_toast__";
      Object.assign(toast.style, {
        position: "fixed", bottom: "20px", right: "20px",
        background: "#34a853", color: "#fff",
        padding: "10px 14px", borderRadius: "8px",
        font: "13px/1.4 system-ui, sans-serif",
        zIndex: 999999, boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        opacity: "0", transition: "opacity .25s ease",
        maxWidth: "300px"
      });
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    requestAnimationFrame(() => (toast.style.opacity = "1"));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toast.style.opacity = "0"), 3000);
  }

  // ===== Progress helper =====
  async function setProgress(patch) {
    const { progress = {} } = await chrome.storage.local.get(["progress"]);
    const next = { ...progress, ...patch, updatedAt: Date.now() };
    await chrome.storage.local.set({ progress: next });
  }

  // ===== Update live preview =====
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

  // ===== Save Maps results with dedup =====
  async function saveMapsResults(results) {
    if (!results.length) return 0;
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    const seen = new Set(leads.map(l => l.mapsUrl || l.url));
    let added = 0;

    for (const r of results) {
      const key = r.mapsUrl || r.url || r.title;
      if (!seen.has(key)) {
        leads.push(r);
        seen.add(key);
        added++;
      }
    }

    await chrome.storage.local.set({ leads });
    await updateLivePreview();
    return added;
  }

  // ===== Scroll to load all results in Maps feed =====
  async function scrollToLoadAll(maxScrolls = 10) {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return;

    let prevCount = 0;
    for (let i = 0; i < maxScrolls; i++) {
      const items = feed.querySelectorAll('a.hfpxzc, div.Nv2PK');
      if (items.length === prevCount && i > 2) break;
      prevCount = items.length;

      feed.scrollTop = feed.scrollHeight;
      await sleep(1500 + Math.random() * 1000);

      await setProgress({
        currentItem: `Scrolling... loaded ${items.length} results`
      });
    }
  }

  // ===== Message handlers =====
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    if (msg.type === "SCRAPE_MAPS_LIST") {
      (async () => {
        await setProgress({
          isRunning: true,
          title: "Scraping Maps results...",
          currentPage: 1,
          totalPages: 1,
          currentItem: "Scrolling to load results..."
        });

        // Scroll to load more results
        await scrollToLoadAll(msg.maxScrolls || 8);

        const results = extractMapsSearchResults();
        const added = await saveMapsResults(results);

        showToast(`Maps: Found ${results.length} businesses, ${added} new saved`);

        await setProgress({
          isRunning: false,
          currentItem: `Done! ${results.length} found, ${added} new.`
        });

        setTimeout(async () => {
          await chrome.storage.local.set({ progress: { isRunning: false } });
        }, 3000);

        sendResponse({ ok: true, found: results.length, added });
      })();
      return true;
    }

    if (msg.type === "SCRAPE_MAPS_DETAIL") {
      (async () => {
        await setProgress({
          isRunning: true,
          title: "Scraping business detail...",
          currentItem: "Extracting data..."
        });

        const detail = extractBusinessDetail();
        const added = await saveMapsResults([detail]);

        showToast(`Scraped: ${detail.title || "Business"} (${detail.phones.length} phones, ${detail.emails.length} emails)`);

        await setProgress({
          isRunning: false,
          currentItem: `Done! ${detail.title}`
        });

        setTimeout(async () => {
          await chrome.storage.local.set({ progress: { isRunning: false } });
        }, 3000);

        sendResponse({ ok: true, detail, added });
      })();
      return true;
    }

    if (msg.type === "SCRAPE_MAPS_WITH_DETAILS") {
      // Scrape list then visit each for full details
      (async () => {
        await setProgress({
          isRunning: true,
          title: "Deep Maps scrape...",
          currentItem: "Loading list..."
        });

        await scrollToLoadAll(msg.maxScrolls || 6);
        const listResults = extractMapsSearchResults();

        await setProgress({
          totalPages: listResults.length,
          currentItem: `Found ${listResults.length} businesses. Starting detail scrape...`
        });

        // We'll click into each one — but since we can't navigate away,
        // we save the list results and let background handle detail enrichment
        const added = await saveMapsResults(listResults);

        showToast(`Maps: ${listResults.length} businesses found, ${added} new. Use "Enrich" to get full details.`);

        await setProgress({
          isRunning: false,
          currentItem: `Saved ${added} new businesses from Maps.`
        });

        setTimeout(async () => {
          await chrome.storage.local.set({ progress: { isRunning: false } });
        }, 3000);

        sendResponse({ ok: true, found: listResults.length, added });
      })();
      return true;
    }

    if (msg.type === "EXTRACT_HOURS") {
      const hours = extractOpeningHours();
      sendResponse({ ok: true, hours });
      return true;
    }

    if (msg.type === "EXTRACT_REVIEWS") {
      const reviews = extractReviews();
      sendResponse({ ok: true, reviews });
      return true;
    }

    if (msg.type === "EXTRACT_SOCIAL") {
      const pageText = document.body.innerText || "";
      const allLinks = Array.from(document.querySelectorAll("a[href]")).map(a => a.href).join(" ");
      const socials = extractSocialLinks(allLinks + " " + pageText);
      sendResponse({ ok: true, socials });
      return true;
    }
  });

  // Auto-detection: show hint if on Maps
  (async () => {
    await sleep(2000);
    if (location.href.includes("/maps/search") || location.href.includes("/maps/place")) {
      showToast("Google Lead Scraper active on Maps! Use the extension popup to scrape.");
    }
  })();
})();
