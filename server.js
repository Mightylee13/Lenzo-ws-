const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 1. THE QUEUE SYSTEM (Prevents Render crashes) ---
let isScraping = false;
const queue = [];

async function processQueue() {
    if (isScraping || queue.length === 0) return;
    isScraping = true;
    const { url, resolve, reject } = queue.shift();
    try {
        const result = await runScrape(url);
        resolve(result);
    } catch (error) {
        reject(error);
    } finally {
        isScraping = false;
        processQueue(); // Process next in line
    }
}

function queueScrape(url) {
    return new Promise((resolve, reject) => {
        queue.push({ url, resolve, reject });
        processQueue();
    });
}

// --- 2. THE HEURISTIC BRAIN (Auto-Detects Site Type) ---
function analyzeData(jsonArray, text) {
    let detectedType = "Unknown";
    let extractedData = null;
    let highestScore = 0;

    // Analyze JSON APIs
    for (const item of jsonArray) {
        const jsonString = JSON.stringify(item).toLowerCase();
        let currentScore = 0;
        let type = "Unknown";

        if (jsonString.includes('hometeam') || jsonString.includes('awayscore') || jsonString.includes('team')) { currentScore += 50; type = "Sports"; }
        if (jsonString.includes('artist') || jsonString.includes('track') || jsonString.includes('album')) { currentScore += 40; type = "Music"; }
        if (jsonString.includes('.mp4') || jsonString.includes('.m3u8') || jsonString.includes('stream_url')) { currentScore += 30; type = "Movies/Video"; }
        if (jsonString.includes('price') || jsonString.includes('product') || jsonString.includes('cart')) { currentScore += 20; type = "E-commerce"; }

        if (currentScore > highestScore) {
            highestScore = currentScore;
            detectedType = type;
            extractedData = item;
        }
    }

    // Fallback: Analyze text if JSON fails
    if (detectedType === "Unknown" && text) {
        const lowerText = text.toLowerCase();
        if (lowerText.includes('vs') && lowerText.includes('score')) detectedType = "Sports (Text)";
        if (lowerText.includes('listen') && lowerText.includes('album')) detectedType = "Music (Text)";
    }

    return { detectedType, extractedData };
}

// --- 3. THE SCRAPER ENGINE ---
async function runScrape(targetUrl) {
    let browser;
    try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1440, height: 900 },
        });

        const page = await context.newPage();
        const interceptedApis = [];
        const mediaLinks = [];

        // Block images/fonts to save RAM on Render
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'font', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        // Network Sniffer
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';

            if (url.match(/\.(mp4|m3u8|mp3|m4a|webm)/i) || contentType.includes('video')) {
                if (!mediaLinks.includes(url)) mediaLinks.push(url);
            }

            if (contentType.includes('application/json') && response.status() === 200) {
                try {
                    const json = await response.json();
                    if (JSON.stringify(json).length > 100) interceptedApis.push(json);
                } catch (e) {}
            }
        });

        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        // Auto-scroll for lazy-loaded content
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 400;
                const timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= 3000 || totalHeight >= document.body.scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 200);
            });
        });

        await page.waitForTimeout(3000); // Let APIs finish loading

        const html = await page.content();
        const text = await page.evaluate(() => document.body.innerText);
        
        let domSmartData = null;
        if (interceptedApis.length === 0) {
            domSmartData = await page.evaluate(() => {
                const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                return scripts.map(s => { try { return JSON.parse(s.innerText); } catch(e) { return null; } }).filter(Boolean);
            });
        }

        await browser.close();

        const analysis = analyzeData(interceptedApis, text);

        return {
            status: 200,
            target: targetUrl,
            detectedCategory: analysis.detectedType,
            smartData: interceptedApis.length > 0 ? analysis.extractedData : domSmartData,
            mediaLinks: mediaLinks,
            allApisFound: interceptedApis.length,
            rawText: text.substring(0, 5000)
        };

    } catch (error) {
        if (browser) await browser.close();
        throw new Error("Failed to render. Site might have CAPTCHA or Cloudflare block.");
    }
}

// --- 4. THE API ENDPOINT ---
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "URL required" });

    try {
        const result = await queueScrape(targetUrl);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.send('🕷️ Lenzo Universal Scraper is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🕷️ Scraper running on port ${PORT}`));
