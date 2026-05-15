# Google Lead Scraper

Free Chrome extension to collect business leads from Google Maps.

## Features
- Extracts business name, phone, website, address, rating
- Works on any Google Maps search
- Export to CSV or JSON
- No API, no proxy, no paid service needed

## Install

1. Download this folder
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select this folder (where `manifest.json` is)

## How to Use

1. Open [Google Maps](https://www.google.com/maps)
2. Search for businesses (e.g. "restaurants in dhaka")
3. Scroll down in the results panel to load more businesses
4. Click the extension icon → **Collect Leads from This Page**
5. For more detail (phone numbers), click on individual businesses first
6. Click **Export CSV** to download

## Tips for Getting Phone Numbers

Google Maps shows phone numbers only when you **click on a business** to open its detail panel. To collect phones:

1. Search for businesses
2. Click on the first result (opens detail panel with phone)
3. Click **Collect Leads** → captures that business with phone
4. Go back, click next business, repeat
5. Or use MapLeadly-style: just collect all names first, then deep-scrape later
