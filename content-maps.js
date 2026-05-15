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

  // ===== FEATURE 1: Smart Random Delay (Gaussian Human-like Timing) =====
  // Instead of fixed delays, uses Gaussian distribution to simulate natural human pauses.
  // People don't click at fixed intervals — they pause, read, get distracted.
  const HumanDelay = {
    baseMin: 2000,
    baseMax: 8000,
    burstCount: 0,
    lastActionTime: 0,

    // Box-Muller transform for Gaussian random (mean=0, stddev=1)
    _gaussian() {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    },

    // Returns a delay between 2-15 seconds following Gaussian distribution
    // centered around 5-7s with occasional spikes to 12-15s (simulating "reading")
    getDelay() {
      const now = Date.now();
      const elapsed = now - this.lastActionTime;

      // Track burst behavior — if user is clicking fast, slow down
      if (elapsed < 3000 && this.lastActionTime > 0) {
        this.burstCount++;
      } else if (elapsed > 10000) {
        this.burstCount = Math.max(0, this.burstCount - 2);
      }

      // Gaussian centered at 5.5s with stddev ~2s
      const mean = 5500 + (this.burstCount * 800); // shift mean higher if bursting
      const stddev = 2000;
      let delay = mean + this._gaussian() * stddev;

      // 12% chance of a "reading pause" (person stops to read something)
      if (Math.random() < 0.12) {
        delay += 4000 + Math.random() * 8000; // adds 4-12s extra
      }

      // 5% chance of a very quick action (person already knows where to click)
      if (Math.random() < 0.05) {
        delay = 1500 + Math.random() * 1000;
      }

      // Clamp to 2-15 seconds
      delay = Math.max(2000, Math.min(15000, delay));

      this.lastActionTime = now;
      return Math.round(delay);
    },

    // Shorter delay for sub-actions (e.g., between scroll steps)
    getMicroDelay() {
      const base = 300 + this._gaussian() * 200;
      return Math.max(100, Math.min(1200, Math.round(base + 400)));
    }
  };

  // ===== FEATURE 2: Mouse Movement Simulation =====
  // Fires realistic mousemove events along a curved path before clicking.
  // Google's bot detection tracks mouse trails — no trail = bot.
  const MouseSimulator = {
    // Generate a bezier curve path from current mouse pos to target
    _bezierPath(startX, startY, endX, endY, steps) {
      const points = [];
      // Random control points for natural curve
      const cp1x = startX + (endX - startX) * 0.3 + (Math.random() - 0.5) * 100;
      const cp1y = startY + (endY - startY) * 0.1 + (Math.random() - 0.5) * 80;
      const cp2x = startX + (endX - startX) * 0.7 + (Math.random() - 0.5) * 60;
      const cp2y = startY + (endY - startY) * 0.9 + (Math.random() - 0.5) * 40;

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const mt = 1 - t;
        const mt2 = mt * mt;
        const mt3 = mt2 * mt;

        // Cubic bezier
        const x = mt3 * startX + 3 * mt2 * t * cp1x + 3 * mt * t2 * cp2x + t3 * endX;
        const y = mt3 * startY + 3 * mt2 * t * cp1y + 3 * mt * t2 * cp2y + t3 * endY;

        // Add tiny jitter (hand shake)
        points.push({
          x: x + (Math.random() - 0.5) * 2,
          y: y + (Math.random() - 0.5) * 2
        });
      }
      return points;
    },

    // Simulate mouse movement to an element, then click
    async moveAndClick(element) {
      if (!element) return;

      const rect = element.getBoundingClientRect();
      // Random point within the element (not dead center — humans are imprecise)
      const targetX = rect.left + rect.width * (0.3 + Math.random() * 0.4);
      const targetY = rect.top + rect.height * (0.3 + Math.random() * 0.4);

      // Start from a random-ish position (last known or random)
      const startX = this._lastX || (window.innerWidth * Math.random());
      const startY = this._lastY || (window.innerHeight * Math.random());

      // Generate path with 15-30 steps
      const steps = 15 + Math.floor(Math.random() * 15);
      const path = this._bezierPath(startX, startY, targetX, targetY, steps);

      // Fire mousemove events along the path
      for (let i = 0; i < path.length; i++) {
        const { x, y } = path[i];
        const moveEvent = new MouseEvent("mousemove", {
          clientX: x, clientY: y,
          bubbles: true, cancelable: true,
          view: window
        });
        document.elementFromPoint(x, y)?.dispatchEvent(moveEvent);

        // Variable speed: slow start, fast middle, slow end (ease-in-out)
        const progress = i / path.length;
        const speedFactor = 1 - Math.abs(progress - 0.5) * 1.5; // slower at edges
        const delay = 8 + speedFactor * 20 + Math.random() * 10;
        await sleep(delay);
      }

      // Save last position
      this._lastX = targetX;
      this._lastY = targetY;

      // Hover pause (human hesitates 100-400ms before clicking)
      await sleep(100 + Math.random() * 300);

      // Fire mouseenter and mouseover on target
      element.dispatchEvent(new MouseEvent("mouseenter", { clientX: targetX, clientY: targetY, bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseover", { clientX: targetX, clientY: targetY, bubbles: true }));

      await sleep(50 + Math.random() * 100);

      // Fire mousedown → mouseup → click sequence
      element.dispatchEvent(new MouseEvent("mousedown", { clientX: targetX, clientY: targetY, bubbles: true }));
      await sleep(50 + Math.random() * 80); // hold duration
      element.dispatchEvent(new MouseEvent("mouseup", { clientX: targetX, clientY: targetY, bubbles: true }));
      element.dispatchEvent(new MouseEvent("click", { clientX: targetX, clientY: targetY, bubbles: true }));
    },

    _lastX: null,
    _lastY: null
  };

  // ===== FEATURE 3: Random Scroll Patterns =====
  // Instead of always scrolling down, mixes up/down/slow/fast to look human.
  // Humans don't scroll linearly — they overshoot, go back, pause to read.
  const HumanScroll = {
    // Scroll a container with human-like patterns
    async scroll(container, options = {}) {
      const { maxScrolls = 10 } = options;
      let prevCount = 0;

      for (let i = 0; i < maxScrolls; i++) {
        const items = container.querySelectorAll('a.hfpxzc, div.Nv2PK');
        if (items.length === prevCount && i > 2) break;
        prevCount = items.length;

        // Decide scroll behavior for this iteration
        const action = this._pickAction(i, maxScrolls);

        switch (action.type) {
          case "down_fast":
            // Quick scroll to bottom
            container.scrollTop = container.scrollHeight;
            break;

          case "down_slow":
            // Gradual scroll down (multiple small steps)
            await this._smoothScroll(container, "down", action.distance);
            break;

          case "up_partial":
            // Scroll back up a bit (like re-reading something)
            await this._smoothScroll(container, "up", action.distance);
            // Then scroll back down past where we were
            await sleep(HumanDelay.getMicroDelay());
            await this._smoothScroll(container, "down", action.distance * 1.5);
            break;

          case "pause_read":
            // Don't scroll — just pause as if reading
            await sleep(2000 + Math.random() * 3000);
            break;
        }

        // Wait between scroll actions
        const waitTime = HumanDelay.getMicroDelay() + 800 + Math.random() * 700;
        await sleep(waitTime);

        await setProgress({
          currentItem: `Scrolling... loaded ${items.length} results (${action.type})`
        });
      }
    },

    // Pick what scroll action to do — weighted random
    _pickAction(iteration, total) {
      const rand = Math.random();
      const progress = iteration / total;

      // Early scrolls: mostly down
      if (progress < 0.3) {
        if (rand < 0.6) return { type: "down_fast" };
        if (rand < 0.85) return { type: "down_slow", distance: 300 + Math.random() * 500 };
        return { type: "pause_read" };
      }

      // Middle scrolls: mix everything (2 out of 10 go backward)
      if (rand < 0.4) return { type: "down_fast" };
      if (rand < 0.65) return { type: "down_slow", distance: 200 + Math.random() * 400 };
      if (rand < 0.85) return { type: "up_partial", distance: 150 + Math.random() * 300 };
      return { type: "pause_read" };
    },

    // Smooth scroll in small increments
    async _smoothScroll(container, direction, totalDistance) {
      const steps = 5 + Math.floor(Math.random() * 8);
      const stepSize = totalDistance / steps;

      for (let s = 0; s < steps; s++) {
        // Non-uniform step sizes (accelerate then decelerate)
        const progress = s / steps;
        const factor = Math.sin(progress * Math.PI); // bell curve speed
        const thisStep = stepSize * (0.5 + factor);

        if (direction === "down") {
          container.scrollTop += thisStep;
        } else {
          container.scrollTop -= thisStep;
        }

        // Variable timing between scroll micro-steps
        await sleep(30 + Math.random() * 60 + (1 - factor) * 40);
      }
    }
  };

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
  // Uses FEATURE 3 (Random Scroll Patterns) + FEATURE 1 (Smart Delay)
  async function scrollToLoadAll(maxScrolls = 10) {
    const feed = document.querySelector('div[role="feed"]');
    if (!feed) return;

    // Use human-like scroll patterns instead of simple scrollTop = scrollHeight
    await HumanScroll.scroll(feed, { maxScrolls });
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

        // FEATURE 1: Smart delay before starting (human doesn't act instantly)
        await sleep(HumanDelay.getMicroDelay() + 500);

        // FEATURE 3: Scroll with human-like patterns
        await scrollToLoadAll(msg.maxScrolls || 8);

        // FEATURE 1: Pause after scrolling (reading results)
        await sleep(HumanDelay.getDelay() * 0.4);

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

        // FEATURE 1: Initial human pause
        await sleep(HumanDelay.getMicroDelay() + 300);

        // FEATURE 3: Human-like scroll to load
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

    // FEATURE 2: Click a Maps result card with mouse simulation
    if (msg.type === "CLICK_RESULT_CARD") {
      (async () => {
        const feed = document.querySelector('div[role="feed"]');
        if (!feed) return sendResponse({ ok: false, error: "No feed found" });

        const cards = feed.querySelectorAll('a.hfpxzc, div.Nv2PK a');
        const index = msg.index || 0;
        if (index >= cards.length) return sendResponse({ ok: false, error: "Card index out of range" });

        const card = cards[index];
        // FEATURE 1: Human delay before clicking
        await sleep(HumanDelay.getDelay() * 0.3);
        // FEATURE 2: Simulate realistic mouse movement + click
        await MouseSimulator.moveAndClick(card);
        sendResponse({ ok: true, clicked: index });
      })();
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
