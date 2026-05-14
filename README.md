# Google Lead Scraper (Chrome Extension)

একটি **free Chrome extension** যা Google search results থেকে lead data (title, URL, description, email, phone) collect করে CSV/JSON হিসেবে export করে। কোনো **proxy, API, বা paid service লাগে না** — কারণ এটা আপনার own browser থেকে চলে, তাই Google IP block-এর কোনো ভয় নাই।

## Features

- ✅ Google SERP থেকে title / URL / description extract করে
- ✅ Snippet থেকে email আর phone number auto-detect করে
- ✅ "Auto-scrape" mode — Google search-এর প্রতিটা page-এ automatic scrape
- ✅ "Auto-next" mode — automatically next page-এ যায় (with random 2–5s delay)
- ✅ "Deep-scrape" — saved প্রতিটা URL visit করে আরো emails/phones খোঁজে
- ✅ CSV / JSON export
- ✅ Manifest V3, no third-party dependency

## Install (Developer mode)

1. এই repository clone বা download করেন:
   ```bash
   git clone https://github.com/rh7282991-droid/google-scrape-.git
   ```
2. Chrome-এ `chrome://extensions` open করেন।
3. উপরের ডান কোণায় **Developer mode** ON করেন।
4. **Load unpacked** click করে এই folder-টা select করেন।
5. Extension icon toolbar-এ চলে আসবে।

## How to use

### Basic — current page scrape

1. `https://www.google.com/search?q=...` open করেন (যেমন: `"founder" site:linkedin.com dhaka`)
2. Extension icon click করেন → **Scrape this page**
3. কতগুলো result পাওয়া গেছে toast-এ দেখাবে

### Auto mode — multiple pages

1. Popup-এ **Auto-scrape on every Google page** ON করেন
2. **Auto-click "Next page"** ON করেন
3. **Max pages** set করেন (default 5)
4. Google search চালু করেন — extension নিজে নিজে সব page scrape করবে এবং next-এ যাবে
5. Random 2–5s delay দেয়া আছে যেন human-like দেখায়

### Deep-scrape (lead-এর জন্য সবচেয়ে useful)

Google snippet-এ সাধারণত email/phone থাকে না। Deep-scrape প্রতিটা saved URL visit করে real email/phone খুঁজে আনে।

1. আগে কিছু leads scrape করেন (উপরের method-এ)
2. Popup-এ **Run deep-scrape on saved leads** click করেন
3. কয়েক মিনিট লাগবে (page-এর সংখ্যার উপর depend করে)

### Export

- **Export CSV** — Excel/Google Sheets-এ open করার জন্য
- **Export JSON** — programming use-এর জন্য
- **Clear all** — সব saved data delete করে

## Search queries যেগুলো leads-এর জন্য কাজ করে

ভালো lead পেতে Google search query smart হতে হয়:

```
"contact us" "dhaka" restaurant
intext:"@gmail.com" "founder" startup bangladesh
site:linkedin.com/in/ "marketing manager" dhaka
"+880" inurl:contact textile manufacturer
"info@" site:.com.bd hospital
```

## How it stays unblocked

- কোনো automated `requests` call Google-এ যায় না
- পুরোটাই আপনার own logged-in browser session-এ চলে — Google-এর কাছে এটা normal user browsing-এর মতো লাগে
- Auto-next mode-এ random 2–5s delay দেয়া হয়েছে যেন bot pattern detect না হয়
- Tip: একটানা ৫০-১০০+ page scrape না করাই ভালো — ছোট batch-এ break নিন

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome extension manifest (V3) |
| `content.js` | Google SERP-এ inject হয়, results extract করে |
| `background.js` | Service worker — CSV export, deep-scrape |
| `popup.html` / `popup.css` / `popup.js` | UI |
| `icons/` | Extension icons |

## Limitations

- Google SERP layout মাঝে মাঝে change হয়; selectors update লাগতে পারে
- Deep-scrape কিছু site-এ block হবে (Cloudflare, captcha, etc.)
- LinkedIn-এর মতো site-এ login wall থাকে — সেখানে deep-scrape কাজ করবে না

## Disclaimer

এই tool শুধু **personal/educational use**-এর জন্য। যেই data collect করছেন সেটা যে website থেকে আনছেন, তাদের Terms of Service এবং local privacy laws (GDPR, etc.) মেনে use করেন। Spam-এর জন্য ব্যবহার করবেন না।
