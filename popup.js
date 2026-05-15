document.addEventListener("DOMContentLoaded", async () => {
  const collectBtn = document.getElementById("collectBtn");
  const exportCsv = document.getElementById("exportCsv");
  const exportJson = document.getElementById("exportJson");
  const clearBtn = document.getElementById("clearBtn");
  const progress = document.getElementById("progress");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");

  async function updateStats() {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    document.getElementById("totalLeads").textContent = leads.length;
    document.getElementById("totalPhones").textContent = leads.filter(l => l.phone).length;
    document.getElementById("totalEmails").textContent = leads.filter(l => l.email).length;
  }

  collectBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes("google.") || !tab.url.includes("/maps")) {
      alert("Please open Google Maps first and search for businesses.");
      return;
    }

    collectBtn.disabled = true;
    collectBtn.textContent = "Collecting...";
    progress.style.display = "block";
    progressFill.style.width = "10%";
    progressText.textContent = "Scanning page for businesses...";

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeGoogleMaps
      });

      if (results && results[0] && results[0].result) {
        const newLeads = results[0].result;
        progressFill.style.width = "80%";
        progressText.textContent = `Found ${newLeads.length} businesses. Saving...`;

        // Save to storage (dedup by name+phone)
        const { leads = [] } = await chrome.storage.local.get(["leads"]);
        const existing = new Set(leads.map(l => l.name + "|" + l.phone));
        let added = 0;
        for (const lead of newLeads) {
          const key = lead.name + "|" + lead.phone;
          if (!existing.has(key)) {
            leads.push(lead);
            existing.add(key);
            added++;
          }
        }
        await chrome.storage.local.set({ leads });

        progressFill.style.width = "100%";
        progressText.textContent = `Done! Added ${added} new leads (${newLeads.length} found on page).`;
      } else {
        progressText.textContent = "No businesses found. Try scrolling the results list first.";
      }
    } catch (e) {
      progressText.textContent = "Error: " + (e.message || "Could not access page");
    }

    collectBtn.disabled = false;
    collectBtn.textContent = "Collect Leads from This Page";
    updateStats();
  });

  exportCsv.addEventListener("click", async () => {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    if (!leads.length) { alert("No leads to export"); return; }
    const headers = ["name", "phone", "website", "email", "address", "rating", "reviews", "category", "collectedAt"];
    const rows = [headers.join(",")];
    for (const l of leads) {
      rows.push(headers.map(h => {
        const v = l[h] || "";
        return '"' + String(v).replace(/"/g, '""') + '"';
      }).join(","));
    }
    const csv = rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `google-leads-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  exportJson.addEventListener("click", async () => {
    const { leads = [] } = await chrome.storage.local.get(["leads"]);
    if (!leads.length) { alert("No leads to export"); return; }
    const blob = new Blob([JSON.stringify(leads, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `google-leads-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener("click", async () => {
    if (!confirm("Delete all saved leads?")) return;
    await chrome.storage.local.set({ leads: [] });
    updateStats();
  });

  updateStats();
});

// This function runs INSIDE the Google Maps page
function scrapeGoogleMaps() {
  const leads = [];

  // Google Maps search results are in the left panel
  // Each result card contains business info
  const cards = document.querySelectorAll('[data-result-channel-provider-id]') ||
                document.querySelectorAll('div[role="feed"] > div') ||
                document.querySelectorAll('.Nv2PK');

  // Also try: the currently open business panel (right side)
  const panel = document.querySelector('[role="main"]');

  // Strategy 1: If a single business is open (detail view)
  if (panel) {
    const nameEl = panel.querySelector('h1') || panel.querySelector('[data-attrid="title"]');
    const phoneEls = panel.querySelectorAll('button[data-tooltip*="phone"], button[aria-label*="Phone"], a[href^="tel:"], [data-item-id*="phone"]');
    const websiteEls = panel.querySelectorAll('a[data-item-id*="authority"], a[aria-label*="Website"], a[data-tooltip*="website"]');
    const addressEls = panel.querySelectorAll('button[data-item-id*="address"], [data-item-id*="address"], button[aria-label*="Address"]');
    const ratingEl = panel.querySelector('span[role="img"][aria-label*="star"]') || panel.querySelector('.fontDisplayLarge');
    const reviewEl = panel.querySelector('span[aria-label*="review"]');
    const categoryEl = panel.querySelector('button[jsaction*="category"]') || panel.querySelector('.DkEaL');

    // Extract phone from various possible locations
    let phone = "";
    phoneEls.forEach(el => {
      const text = el.getAttribute("aria-label") || el.textContent || el.getAttribute("data-tooltip") || "";
      const match = text.match(/[\+]?[\d\s\-()]{8,}/);
      if (match && !phone) phone = match[0].trim();
    });
    // Also check for tel: links
    if (!phone) {
      const telLink = panel.querySelector('a[href^="tel:"]');
      if (telLink) phone = telLink.href.replace("tel:", "");
    }

    // Extract website
    let website = "";
    websiteEls.forEach(el => {
      const href = el.getAttribute("href") || "";
      if (href && !href.includes("google.com") && !website) website = href;
    });

    // Extract address
    let address = "";
    addressEls.forEach(el => {
      const text = el.getAttribute("aria-label") || el.textContent || "";
      if (text.length > 5 && !address) address = text.replace(/^Address:\s*/i, "").trim();
    });

    const name = nameEl ? nameEl.textContent.trim() : "";
    if (name) {
      leads.push({
        name,
        phone,
        website,
        email: "", // Google Maps rarely shows email
        address,
        rating: ratingEl ? ratingEl.textContent.trim() : "",
        reviews: reviewEl ? reviewEl.textContent.replace(/[^0-9]/g, "") : "",
        category: categoryEl ? categoryEl.textContent.trim() : "",
        collectedAt: new Date().toISOString()
      });
    }
  }

  // Strategy 2: Multiple results in the left panel (list view)
  const feedItems = document.querySelectorAll('div[role="feed"] > div, .Nv2PK, a[href*="/maps/place/"]');
  const seen = new Set();

  feedItems.forEach(item => {
    try {
      // Get the link to the place
      const link = item.querySelector('a[href*="/maps/place/"]') || (item.tagName === "A" ? item : null);
      if (!link) return;

      const nameEl = item.querySelector('.qBF1Pd, .fontHeadlineSmall, [role="heading"]') ||
                     item.querySelector('span.fontHeadlineSmall') ||
                     link.getAttribute("aria-label");

      const name = typeof nameEl === "string" ? nameEl :
                   (nameEl ? nameEl.textContent.trim() : "");
      if (!name || seen.has(name)) return;
      seen.add(name);

      // Rating
      const ratingEl = item.querySelector('.MW4etd, span[role="img"]');
      const rating = ratingEl ? ratingEl.textContent.trim() : "";

      // Review count
      const reviewEl = item.querySelector('.UY7F9, span[aria-label*="review"]');
      const reviews = reviewEl ? reviewEl.textContent.replace(/[^0-9]/g, "") : "";

      // Category / type
      const catEl = item.querySelector('.W4Efsd:nth-child(2), .r6bRMd, .rllt__details .rllt__wrapped');
      const category = catEl ? catEl.textContent.trim().split("·")[0].trim() : "";

      // Address (often in second line)
      const addrParts = item.querySelectorAll('.W4Efsd');
      let address = "";
      addrParts.forEach(p => {
        const t = p.textContent.trim();
        if (t.length > 10 && !t.includes("star") && !address) address = t;
      });

      // Phone - Google Maps list sometimes shows it
      let phone = "";
      const allText = item.textContent || "";
      const phoneMatch = allText.match(/(\+?\d{1,3}[\s\-]?\d{3,5}[\s\-]?\d{3,8})/);
      if (phoneMatch) phone = phoneMatch[1].trim();

      // Website
      let website = "";
      const webLink = item.querySelector('a[href]:not([href*="google.com"]):not([href*="maps"])');
      if (webLink) website = webLink.href;

      leads.push({
        name, phone, website, email: "", address, rating, reviews, category,
        collectedAt: new Date().toISOString()
      });
    } catch (_) {}
  });

  return leads;
}
