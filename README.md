# Google Maps Lead Scraper

A free Chrome extension that collects business leads (name, phone, website, address, rating, etc.) from **Google Maps** automatically.

No proxy. No API key. No login. Works on your own browser session.

---

## ✨ Features

- **Bulk search** — multiple keywords × locations in one campaign
- **Auto-scroll** — loads more results until end of list
- **Auto-click each profile** — opens every business detail panel and extracts data
- **Real Google Maps page** — you can watch the scraping happen in your tab
- **Pause / Resume / Stop** — full control any time
- **Export** — CSV, TSV (Google Sheets), or copy-paste directly to Sheets
- **Filters** — only with phone, only with address, only with website
- **Auto-resume** — survives page reloads
- **No CAPTCHA bypass** — only public/visible information

---

## 🚀 Install

1. Download or clone this repo
   - GitHub: **Code → Download ZIP** → extract
   - Or `git clone https://github.com/rh7282991-droid/google-scrape-.git`
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the folder that contains `manifest.json`

---

## 📋 How to use

1. Click the extension icon to open the popup
2. **Campaign Setup**:
   - **Business Keywords** — one per line (e.g. `cafe`, `restaurant`)
   - **Locations** — one per line (e.g. `dhaka`, `chittagong`)
   - **Target Leads** — total leads you want
   - **Profile Wait** — pause time per profile (5 sec is balanced; 7+ is safer)
3. Click **Start Profile Collection**
4. The extension opens Google Maps in your active tab and starts collecting
5. Watch the live progress in the popup. You can **Pause / Resume / Stop** any time
6. When done, click **Download Excel CSV** or **Copy to Google Sheets**

### Tips

- More **profile wait** = safer (less chance of Google rate-limiting you)
- Use specific keywords + cities (e.g. `vegan cafe in dhanmondi`) for better leads
- The extension dedupes by business name + phone

---

## 📂 Files

| File | Purpose |
|------|---------|
| `manifest.json` | Chrome extension manifest (MV3) |
| `popup.html` / `popup.css` / `popup.js` | UI |
| `content.js` | Engine — runs on Google Maps, scrolls, clicks, extracts |
| `background.js` | Service worker — initializes state, keeps content.js alive |
| `assets/logo.svg` | Extension icon |

---

## ⚠️ Disclaimer

Use responsibly. This tool only reads **public** Google Maps data the same way a human user could. Respect Google's Terms of Service and any local laws regarding contacting businesses. Don't spam.
