const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- 1. THE QUEUE SYSTEM ---
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
        processQueue();
    }
}

function queueScrape(url) {
    return new Promise((resolve, reject) => {
        queue.push({ url, resolve, reject });
        processQueue();
    });
}

// --- 2. THE HEURISTIC BRAIN ---
function analyzeData(jsonArray, text) {
    let detectedType = "Unknown";
    let extractedData = null;
    let highestScore = 0;

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
    return { detectedType, extractedData };
}

// --- 3. THE DUAL-ENGINE SCRAPER ---
async function runScrape(targetUrl) {
    let browser;
    let interceptedApis = [];
    let mediaLinks = [];
    let html = "";
    let text = "";

    try {
        // STAGE 1: TRY PLAYWRIGHT (For JS sites)
        console.log(`[Engine 1] Trying Playwright for: ${targetUrl}`);
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        });

        const page = await context.newPage();
        
        // Block images/fonts to save RAM
        await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'font', 'stylesheet'].includes(type)) route.abort();
            else route.continue();
        });

        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';
            if (url.match(/\.(mp4|m3u8|mp3|m4a|webm)/i)) { if (!mediaLinks.includes(url)) mediaLinks.push(url); }
            if (contentType.includes('application/json') && response.status() === 200) {
                try { const json = await response.json(); if (JSON.stringify(json).length > 100) interceptedApis.push(json); } catch (e) {}
            }
        });

        // Strict 20-second timeout for Playwright
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        
        html = await page.content();
        text = await page.evaluate(() => document.body.innerText);
        await browser.close();

    } catch (playwrightError) {
        // STAGE 2: FALLBACK TO AXIOS (For APIs & Blocked Sites)
        console.log(`[Engine 1 Failed] Switching to Axios for: ${targetUrl}`);
        if (browser) await browser.close();
        
        try {
            const response = await axios.get(targetUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                timeout: 15000
            });
            
            // If it's JSON, save it directly as an API
            if (typeof response.data === 'object') {
                interceptedApis.push(response.data);
                text = JSON.stringify(response.data, null, 2);
                html = `<pre>${text}</pre>`;
            } else {
                text = response.data;
                html = response.data;
            }
        } catch (axiosError) {
            throw new Error(`Both engines failed. Playwright: ${playwrightError.message}. Axios: ${axiosError.message}`);
        }
    }

    // Run the analysis
    let domSmartData = null;
    if (interceptedApis.length === 0 && text) {
        // Try to extract JSON from text if it's raw JSON
        try { domSmartData = JSON.parse(text); } catch(e) {}
    }

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
}

// --- 4. THE API ENDPOINT ---
app.get('/api/scrape', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "URL required" });

    try {
        const result = await queueScrape(targetUrl);
        res.json(result);
    } catch (error) {
        // Send the REAL error message to the frontend instead of a generic one
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => res.send('🕷️ Lenzo Dual-Engine Scraper is running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🕷️ Scraper running on port ${PORT}`));
