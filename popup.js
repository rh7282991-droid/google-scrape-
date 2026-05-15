// popup.js — UI controller with live preview, quality scores, and delay info

const $ = (id) => document.getElementById(id);
const statusEl = $("status");

const ALL_FIELDS = ["title", "url", "description", "domain", "emails", "phones", "position", "query"];
const DEFAULT_FIELDS = {
  title: true, url: true, description: true, domain: true,
  emails: true, phones: true, position: false, query: false
};

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function refreshCount() {
  const { leads = [] } = await chrome.storage.local.get(["leads"]);
  $("count").textContent = `${leads.length} leads`;
}

async function loadSettings() {
  const s = await chrome.storage.local.get([
    "autoScrape", "autoNext", "autoMaxPages", "fields"
  ]);
  $("autoScrape").checked = !!s.autoScrape;
  $("autoNext").checked = !!s.autoNext;
  $("autoMaxPages").value = s.autoMaxPages || 5;

  const fields = s.fields || DEFAULT_FIELDS;
  for (const f of ALL_FIELDS) {
    const el = $(`f_${f}`);
    if (el) el.checked = !!fields[f];
  }
}

async function saveSetting(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function saveFields() {
  const fields = {};
  for (const f of ALL_FIELDS) {
    fields[f] = !!$(`f_${f}`).checked;
  }
  await chrome.storage.local.set({ fields });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ===== FEATURE 3: Live Preview Panel =====
function getScoreColor(score) {
  if (score >= 70) return "#34a853";
  if (score >= 40) return "#f9ab00";
  return "#ea4335";
}

function getScoreLabel(score) {
  if (score >= 70) return "High";
  if (score >= 40) return "Medium";
  return "Low";
}

function renderPreview(previewData) {
  const list = $("previewList");
  if (!previewData || previewData.length === 0) {
    list.innerHTML = '<div class="preview-empty">No leads yet. Start scraping!</div>';
    return;
  }

  list.innerHTML = previewData.map((lead, i) => `
    <div class="preview-item">
      <div class="preview-item-header">
        <span class="preview-title" title="${lead.title}">${lead.title || "Untitled"}</span>
        <span class="quality-badge" style="background:${getScoreColor(lead.qualityScore)}">
          ${lead.qualityScore}
        </span>
      </div>
      <div class="preview-domain">${lead.domain || "—"}</div>
      <div class="preview-contacts">
        ${lead.emails.length ? `<span class="preview-email">✉ ${lead.emails[0]}</span>` : ""}
        ${lead.phones.length ? `<span class="preview-phone">☎ ${lead.phones[0]}</span>` : ""}
        ${!lead.emails.length && !lead.phones.length ? '<span class="preview-none">No contacts yet</span>' : ""}
      </div>
    </div>
  `).join("");
}

async function loadPreview() {
  const { livePreview = [] } = await chrome.storage.local.get(["livePreview"]);
  renderPreview(livePreview);
}

// ===== Progress UI =====
function renderProgress(p) {
  const box = $("progressBox");
  if (!p || !p.isRunning) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  $("progressTitle").textContent = p.title || "Working...";
  $("progPage").textContent = p.currentPage || 0;
  $("progPageTotal").textContent = p.totalPages || "?";
  $("progFound").textContent = p.totalFound || 0;
  $("progCurrent").textContent = p.currentItem || "";

  const pct = p.totalPages > 0
    ? Math.min(100, Math.round((p.currentPage / p.totalPages) * 100))
    : (p.percent || 0);
  $("progressFill").style.width = pct + "%";

  // Show delay info
  const delayEl = $("delayInfo");
  if (p.delayInfo) {
    delayEl.style.display = "block";
    $("delayMultiplier").textContent = p.delayInfo.multiplier || "1.0";
  } else {
    delayEl.style.display = "none";
  }
}

async function pollProgress() {
  const { progress } = await chrome.storage.local.get(["progress"]);
  renderProgress(progress);
  refreshCount();
}

// React to live updates from content/background scripts
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.progress) renderProgress(changes.progress.newValue);
  if (changes.leads) refreshCount();
  if (changes.livePreview) renderPreview(changes.livePreview.newValue);
});

// ===== Buttons =====
$("scrapeNow").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !/^https?:\/\/(www\.)?google\.com\/search/.test(tab.url || "")) {
    setStatus("Please open google.com/search first.");
    return;
  }
  setStatus("Scraping current page...");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_NOW" });
    if (res) {
      setStatus(`Found ${res.found} result(s), ${res.added} new saved.`);
    } else {
      setStatus("No response from page. Try reloading the search page.");
    }
  } catch (e) {
    setStatus("Could not reach page. Reload the Google search tab.");
  }
  refreshCount();
  loadPreview();
});

$("autoScrape").addEventListener("change", (e) => saveSetting("autoScrape", e.target.checked));
$("autoNext").addEventListener("change", (e) => saveSetting("autoNext", e.target.checked));
$("autoMaxPages").addEventListener("change", (e) =>
  saveSetting("autoMaxPages", Number(e.target.value) || 5)
);
ALL_FIELDS.forEach(f => {
  const el = $(`f_${f}`);
  if (el) el.addEventListener("change", saveFields);
});

$("runDeep").addEventListener("click", async () => {
  setStatus("Starting deep-scrape... (this may take a while)");
  const res = await chrome.runtime.sendMessage({ type: "DEEP_SCRAPE_ALL" });
  if (res && res.ok) {
    setStatus(`Deep-scrape done. Updated ${res.updated} leads.`);
  } else {
    setStatus(`Deep-scrape failed: ${res ? res.error : "unknown error"}`);
  }
  refreshCount();
  loadPreview();
});

// FEATURE 2: Email enrichment button
$("enrichEmails").addEventListener("click", async () => {
  setStatus("Starting email enrichment... visiting websites...");
  const res = await chrome.runtime.sendMessage({ type: "ENRICH_EMAILS" });
  if (res && res.ok) {
    setStatus(`Email enrichment done. ${res.updated} leads enriched (${res.totalEmails || 0} emails found).`);
  } else {
    setStatus(`Enrichment failed: ${res ? (res.message || res.error) : "unknown error"}`);
  }
  refreshCount();
  loadPreview();
});

// FEATURE 4: Recalculate scores
$("recalcScores").addEventListener("click", async () => {
  setStatus("Recalculating quality scores...");
  const res = await chrome.runtime.sendMessage({ type: "RECALC_SCORES" });
  if (res && res.ok) {
    setStatus(`Scores updated for ${res.count} leads.`);
  } else {
    setStatus("Failed to recalculate scores.");
  }
  loadPreview();
});

// FEATURE 3: Refresh preview
$("refreshPreview").addEventListener("click", () => {
  loadPreview();
});

// ===== Google Maps Scraping =====
$("scrapeMaps").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !/google\.com\/maps/.test(tab.url || "")) {
    setStatus("Please open Google Maps with a search first.");
    return;
  }
  setStatus("Scraping Maps results...");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_MAPS_LIST", maxScrolls: 8 });
    if (res && res.ok) {
      setStatus(`Maps: Found ${res.found} businesses, ${res.added} new saved.`);
    } else {
      setStatus("No response from Maps page. Try reloading.");
    }
  } catch (e) {
    setStatus("Could not reach Maps page. Reload the tab.");
  }
  refreshCount();
  loadPreview();
});

$("scrapeMapsBiz").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab || !/google\.com\/maps/.test(tab.url || "")) {
    setStatus("Please open a Google Maps business page first.");
    return;
  }
  setStatus("Scraping business detail...");
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_MAPS_DETAIL" });
    if (res && res.ok) {
      const d = res.detail || {};
      setStatus(`Scraped: ${d.title || "Business"} (${(d.phones || []).length} phones, ${(d.emails || []).length} emails)`);
    } else {
      setStatus("No response. Make sure a business panel is open.");
    }
  } catch (e) {
    setStatus("Could not reach Maps page. Reload the tab.");
  }
  refreshCount();
  loadPreview();
});

// ===== Social Media Detection =====
$("detectSocial").addEventListener("click", async () => {
  setStatus("Detecting social media profiles... (visiting websites)");
  const res = await chrome.runtime.sendMessage({ type: "DETECT_SOCIAL" });
  if (res && res.ok) {
    setStatus(`Social detection done. ${res.updated} leads enriched (${res.totalProfiles || 0} profiles found).`);
  } else {
    setStatus(`Social detection: ${res ? (res.message || res.error) : "failed"}`);
  }
  refreshCount();
  loadPreview();
});

// ===== Reviews Scraping =====
$("scrapeReviews").addEventListener("click", async () => {
  setStatus("Scraping reviews from websites...");
  const res = await chrome.runtime.sendMessage({ type: "SCRAPE_REVIEWS" });
  if (res && res.ok) {
    setStatus(`Reviews done. ${res.updated} leads got review data.`);
  } else {
    setStatus(`Reviews: ${res ? (res.message || res.error) : "failed"}`);
  }
  refreshCount();
  loadPreview();
});

// ===== Opening Hours =====
$("scrapeHours").addEventListener("click", async () => {
  setStatus("Scraping opening hours from websites...");
  const res = await chrome.runtime.sendMessage({ type: "SCRAPE_HOURS" });
  if (res && res.ok) {
    setStatus(`Hours done. ${res.updated} leads got opening hours.`);
  } else {
    setStatus(`Hours: ${res ? (res.message || res.error) : "failed"}`);
  }
  refreshCount();
  loadPreview();
});

// ===== Multi-Source Data Fusion =====
$("fuseData").addEventListener("click", async () => {
  setStatus("Fusing multi-source data...");
  const res = await chrome.runtime.sendMessage({ type: "FUSE_DATA" });
  if (res && res.ok) {
    setStatus(`Data fusion done. ${res.merged} leads enriched across ${res.totalDomains} domains.`);
  } else {
    setStatus(`Fusion: ${res ? (res.message || res.error) : "failed"}`);
  }
  refreshCount();
  loadPreview();
});

$("exportCsv").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_CSV" });
  setStatus(res && res.ok ? "CSV exported to Downloads." : "Nothing to export.");
});

$("exportJson").addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "EXPORT_JSON" });
  setStatus(res && res.ok ? "JSON exported to Downloads." : "Nothing to export.");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete all saved leads?")) return;
  await chrome.storage.local.set({ leads: [], livePreview: [] });
  setStatus("All leads cleared.");
  refreshCount();
  loadPreview();
});

// ===== FEATURE 18: Duplicate Detection Across Sessions =====
$("runDedup").addEventListener("click", async () => {
  setStatus("Removing duplicates...");
  const res = await chrome.runtime.sendMessage({ type: "RUN_DEDUP" });
  if (res && res.ok) {
    setStatus(`Dedup done. Removed ${res.removed} duplicates (${res.remaining} remain).`);
    loadDedupStats();
  } else {
    setStatus("Dedup failed.");
  }
  refreshCount();
  loadPreview();
});

$("clearDedupDb").addEventListener("click", async () => {
  if (!confirm("Reset dedup history? Future scrapes won't know about previously seen leads.")) return;
  await chrome.storage.local.set({ dedupIndex: {} });
  setStatus("Dedup history cleared.");
  loadDedupStats();
});

async function loadDedupStats() {
  const { dedupIndex = {}, leads = [] } = await chrome.storage.local.get(["dedupIndex", "leads"]);
  const totalSeen = Object.keys(dedupIndex).length;
  const el = $("dedupStats");
  el.textContent = `Seen ${totalSeen} unique businesses across all sessions. Current: ${leads.length} leads.`;
}

// ===== FEATURE 20: Bulk Campaign Templates =====
const CAMPAIGN_TEMPLATES = {
  restaurant: {
    name: "Restaurant Lead Pack",
    keywords: ["restaurant", "cafe", "biryani house", "fast food", "chinese food", "thai food",
               "pizza shop", "burger joint", "bakery", "ice cream", "dessert shop",
               "catering service", "food delivery", "dine in", "buffet restaurant",
               "seafood restaurant", "vegetarian restaurant", "rooftop restaurant",
               "family restaurant", "fine dining"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  },
  beauty: {
    name: "Beauty Industry Pack",
    keywords: ["beauty salon", "parlor", "spa", "nail art", "hair salon",
               "bridal makeup", "skincare clinic", "beauty parlour",
               "hair treatment", "facial treatment", "waxing salon",
               "massage spa", "ayurvedic spa", "beauty academy",
               "cosmetics shop", "makeup artist", "barber shop",
               "men's grooming", "lash extension", "tattoo studio"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  },
  healthcare: {
    name: "Healthcare Pack",
    keywords: ["clinic", "doctor chamber", "hospital", "diagnostic center",
               "dental clinic", "eye hospital", "pharmacy", "health checkup",
               "gynecologist", "pediatrician", "dermatologist", "cardiologist",
               "physiotherapy", "homeopathy", "ayurvedic clinic",
               "pathology lab", "blood bank", "ambulance service",
               "nursing home", "mental health clinic"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  },
  education: {
    name: "Education Pack",
    keywords: ["school", "coaching center", "training center", "tuition",
               "english language course", "computer training", "IELTS coaching",
               "university admission", "private tutor", "online course",
               "skill development", "vocational training", "kindergarten",
               "playgroup", "madrasa", "college", "engineering coaching",
               "medical admission", "art school", "music school"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  },
  tech: {
    name: "Tech/IT Pack",
    keywords: ["software company", "IT agency", "web development", "app development",
               "digital marketing agency", "SEO service", "graphic design",
               "tech startup", "e-commerce company", "data entry service",
               "freelancer agency", "cloud service", "hosting provider",
               "cybersecurity", "AI company", "blockchain company",
               "ERP software", "POS system", "CCTV installation", "ISP provider"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  },
  realestate: {
    name: "Real Estate Pack",
    keywords: ["real estate", "property developer", "flat sale", "apartment",
               "land sale", "housing society", "real estate agent",
               "commercial space", "office rent", "warehouse",
               "interior design", "architect", "construction company",
               "building material", "paint house", "tiles shop",
               "plumbing service", "electrical contractor", "home renovation",
               "property management"],
    cities: ["Dhaka", "Chittagong", "Sylhet", "Rajshahi", "Khulna",
             "Comilla", "Gazipur", "Narayanganj", "Rangpur", "Mymensingh"]
  }
};

$("campaignTemplate").addEventListener("change", (e) => {
  const key = e.target.value;
  const preview = $("campaignPreview");
  if (!key || !CAMPAIGN_TEMPLATES[key]) {
    preview.textContent = "";
    return;
  }
  const tmpl = CAMPAIGN_TEMPLATES[key];
  const totalSearches = tmpl.keywords.length * tmpl.cities.length;
  preview.innerHTML = `<b>${tmpl.name}</b>: ${tmpl.keywords.length} keywords × ${tmpl.cities.length} cities = <b>${totalSearches} searches</b><br>` +
    `Keywords: ${tmpl.keywords.slice(0, 5).join(", ")}...<br>` +
    `Cities: ${tmpl.cities.join(", ")}`;
});

$("runCampaign").addEventListener("click", async () => {
  const key = $("campaignTemplate").value;
  if (!key || !CAMPAIGN_TEMPLATES[key]) {
    setStatus("Please select a campaign template first.");
    return;
  }
  const tmpl = CAMPAIGN_TEMPLATES[key];
  const totalSearches = tmpl.keywords.length * tmpl.cities.length;

  if (!confirm(`This will generate ${totalSearches} search URLs for "${tmpl.name}". Continue?`)) return;

  // Save campaign to storage for background to process
  const campaign = {
    name: tmpl.name,
    keywords: tmpl.keywords,
    cities: tmpl.cities,
    status: "ready",
    createdAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ activeCampaign: campaign });

  // Generate URLs list and copy to clipboard
  const urls = [];
  for (const kw of tmpl.keywords) {
    for (const city of tmpl.cities) {
      urls.push(`https://www.google.com/maps/search/${encodeURIComponent(kw + " " + city)}`);
    }
  }

  // Store URLs for reference
  await chrome.storage.local.set({ campaignUrls: urls });

  // Copy first 5 URLs to show user
  const sample = urls.slice(0, 5).join("\n");
  setStatus(`Campaign "${tmpl.name}" ready! ${totalSearches} URLs generated. Open Maps tabs and use "Scrape Maps Results".`);

  // Open first URL in a new tab as starting point
  chrome.tabs.create({ url: urls[0], active: true });
});

// init
loadSettings();
refreshCount();
pollProgress();
loadPreview();
loadDedupStats();
