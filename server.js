import express from 'express';
import puppeteer from 'puppeteer';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const cache = new NodeCache({ stdTTL: 60*30 }); // cache 30 minutes
const PORT = process.env.PORT || 3000;

app.use(rateLimit({ windowMs: 60*1000, max: 30 })); // 30 requests/min per IP

function parsePrice(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/[^\d.,]/g,'').replace(/,/g,'');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

// Simple scraper for Amazon (example)
async function scrapeAmazon(page, query) {
  const url = `https://www.amazon.in/s?k=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // select first result
  const item = await page.$('div.s-main-slot div[data-component-type="s-search-result"]');
  if (!item) return null;
  const title = await item.$eval('h2 a span', el => el.innerText).catch(()=>null);
  const priceWhole = await item.$eval('.a-price-whole', el => el.innerText).catch(()=>null);
  const priceFrac = await item.$eval('.a-price-fraction', el => el.innerText).catch(()=>'');
  const price = priceWhole ? priceWhole + priceFrac : null;
  const link = await item.$eval('h2 a', a => a.href).catch(()=>url);
  return {
    retailer: 'Amazon.in',
    title,
    price: parsePrice(price),
    shipping: 0,
    totalCost: parsePrice(price),
    available: !!price,
    link
  };
}

// Scraper for Flipkart
async function scrapeFlipkart(page, query) {
  const url = `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const item = await page.$('div[data-id]');
  if (!item) return null;
  const title = await item.$eval('a[title]', el => el.title).catch(()=>null);
  const price = await item.$eval('div._30jeq3', el => el.innerText).catch(()=>null);
  const link = await item.$eval('a[title]', a => a.href).catch(()=>url);
  return {
    retailer: 'Flipkart',
    title,
    price: parsePrice(price),
    shipping: 599,
    totalCost: parsePrice(price) ,
    available: !!price,
    link,
    deliveryDays: 2
  };
}

// Scraper for Reliance Digital
async function scrapeReliance(page, query) {
  const url = `https://www.reliancedigital.in/search?q=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const item = await page.$('div.sp__product');
  if (!item) return null;
  const title = await item.$eval('p.sp__name', el => el.innerText).catch(()=>null);
  const price = await item.$eval('span.TextWeb__Text-sc-1cyx778-0', el => el.innerText).catch(()=>null);
  const link = await item.$eval('a', a => a.href).catch(()=>url);
  return {
    retailer: 'Reliance Digital',
    title,
    price: parsePrice(price),
    shipping: 499,
    totalCost: parsePrice(price) ,
    available: !!price,
    link,
    deliveryDays: 3
  };
}

// Scraper for Croma
async function scrapeCroma(page, query) {
  const url = `https://www.croma.com/search/?text=${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const item = await page.$('li.product-item');
  if (!item) return null;
  const title = await item.$eval('a.product__list--name', el => el.innerText).catch(()=>null);
  const price = await item.$eval('span.amount', el => el.innerText).catch(()=>null);
  const link = await item.$eval('a.product__list--name', a => a.href).catch(()=>url);
  return {
    retailer: 'Croma',
    title,
    price: parsePrice(price),
    shipping: 799,
    totalCost: parsePrice(price) ,
    available: !!price,
    link,
    deliveryDays: 4
  };
}

// Scraper for Official Store (Google search fallback)
async function scrapeOfficial(page, query) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query + ' official site')}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const result = await page.$('div.g a');
  if (!result) return null;
  const link = await page.evaluate(el => el.href, result);
  // For official, we can't scrape price easily, so simulate or skip
  return {
    retailer: 'Official Store',
    title: query,
    price: null, // No price
    shipping: 0,
    totalCost: 0,
    available: false,
    link,
    deliveryDays: 5
  };
}

app.get('/api/compare', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q param' });

  const cacheKey = `compare:${q.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ source: 'cache', data: cached });

  const browser = await puppeteer.launch({ headless: "new", args:['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const results = [];
    const scrapers = [
      scrapeAmazon,
      scrapeFlipkart,
      scrapeReliance,
      scrapeCroma,
      scrapeOfficial
    ];

    for (const scraper of scrapers) {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/117.0 Safari/537.36');
      await page.setViewport({ width: 1200, height: 800 });
      try {
        const result = await scraper(page, q);
        if (result && result.available) results.push(result);
      } catch (e) {
        console.warn(scraper.name, e);
      } finally {
        await page.close();
      }
    }

    // Sort by lowest total cost
    results.sort((a, b) => a.totalCost - b.totalCost);

    // Normalize results
    const normalized = results.map(r => ({
      retailer: r.retailer,
      price: r.price || 0,
      shipping: r.shipping || 0,
      totalCost: r.totalCost || 0,
      available: r.available,
      link: r.link,
      linkText: 'Open',
      deliveryDays: r.deliveryDays || null
    }));

    cache.set(cacheKey, normalized);
    res.json({ source: 'live', data: normalized });
  } catch (err) {
    console.error('compare error', err);
    res.status(500).json({ error: 'internal' });
  } finally {
    await browser.close();
  }
});

app.listen(PORT, ()=>console.log('listening',PORT));
