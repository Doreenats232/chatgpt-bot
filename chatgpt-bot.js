// chatgpt-bot.js
// Nova API Gateway — Universal AI API Platform

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

// ============================================================
// STATE
// ============================================================
const apiKeys = new Map();
const browsers = {};
const pages = {};
const busy = {};
const stats = { totalCalls: 0, startedAt: Date.now(), errors: 0 };
const COOKIES_DIR = path.join(__dirname, 'cookies');
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR);

// ============================================================
// PROVIDER CONFIG
// ============================================================
const PROVIDERS = {
    chatgpt:     { name: 'ChatGPT',     url: 'https://chatgpt.com/',               color: '#10a37f', icon: 'G',  desc: 'OpenAI GPT-4o' },
    claude:      { name: 'Claude',      url: 'https://claude.ai/new',               color: '#d97706', icon: 'C',  desc: 'Anthropic Claude 3.5' },
    gemini:      { name: 'Gemini',      url: 'https://gemini.google.com/app',       color: '#4285f4', icon: 'Ge', desc: 'Google Gemini Pro' },
    perplexity:  { name: 'Perplexity',  url: 'https://www.perplexity.ai/',           color: '#20b2aa', icon: 'P',  desc: 'Perplexity AI' }
};

// ============================================================
// API KEY MANAGEMENT
// ============================================================
function generateKey() {
    const key = 'sk-nova-' + crypto.randomBytes(24).toString('hex');
    apiKeys.set(key, { created: Date.now(), calls: 0, providers: [], revoked: false });
    return key;
}

// ============================================================
// BROWSER MANAGEMENT
// ============================================================
async function launchBrowser(provider) {
    if (browsers[provider]) return;
    console.log('[*] Launching browser for: ' + provider);
    browsers[provider] = await puppeteer.launch({
        headless: false,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-blink-features=AutomationControlled','--disable-dev-shm-usage','--window-size=1280,900'],
        defaultViewport: { width: 1280, height: 900 }
    });
    const page = await browsers[provider].newPage();
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator,'webdriver',{get:()=>false});
        Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});
        Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
        window.chrome={runtime:{}};
    });
    const cookieFile = path.join(COOKIES_DIR, provider + '.json');
    if (fs.existsSync(cookieFile)) {
        await page.setCookie(...JSON.parse(fs.readFileSync(cookieFile)));
    }
    await page.goto(PROVIDERS[provider].url, { waitUntil: 'networkidle2', timeout: 60000 });
    pages[provider] = page;
    busy[provider] = false;
    PROVIDERS[provider].connectedAt = Date.now();
    await saveCookies(provider);
    console.log('[*] ' + provider + ' ready');
}

async function saveCookies(provider) {
    if (!pages[provider]) return;
    const cookies = await pages[provider].cookies();
    fs.writeFileSync(path.join(COOKIES_DIR, provider + '.json'), JSON.stringify(cookies, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// HUMAN TYPING
// ============================================================
async function humanType(page, text) {
    const el = await page.waitForSelector('#prompt-textarea, div[contenteditable="true"], textarea, [role="textbox"]', { timeout: 10000 });
    await el.click();
    await sleep(300 + Math.random() * 500);
    for (const c of text) {
        await page.keyboard.type(c, { delay: 25 + Math.random() * 100 });
        if (Math.random() < 0.03) await sleep(150 + Math.random() * 300);
    }
}

// ============================================================
// PROVIDER SENDERS
// ============================================================
async function sendChatGPT(page, msg) {
    const before = await page.evaluate(() => document.querySelectorAll('div[data-message-author-role="assistant"]').length);
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try { const btn = await page.waitForSelector('button[data-testid="send-button"], button[aria-label="Send prompt"]', { timeout: 3000 }); await btn.click(); } catch { await page.keyboard.press('Enter'); }
    await page.waitForFunction(c => document.querySelectorAll('div[data-message-author-role="assistant"]').length > c, { timeout: 120000 }, before);
    return await waitForStable(page, () => page.evaluate(() => { const m = document.querySelectorAll('div[data-message-author-role="assistant"]'); const l = m[m.length-1]; return l ? l.innerText.trim() : ''; }));
}

async function sendClaude(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try { const btn = await page.waitForSelector('button[aria-label="Send Message"], button[aria-label="Send"]', { timeout: 3000 }); await btn.click(); } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => { const m = document.querySelectorAll('div[class*="Message"]'); const l = m[m.length-1]; return l ? l.innerText.trim() : ''; }));
}

async function sendGemini(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try { const btn = await page.waitForSelector('button[aria-label="Send message"], .send-button', { timeout: 3000 }); await btn.click(); } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => { const m = document.querySelectorAll('.model-response-text, [class*="response"]'); const l = m[m.length-1]; return l ? l.innerText.trim() : ''; }));
}

async function sendPerplexity(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try { const btn = await page.waitForSelector('button[aria-label="Submit"], button[type="submit"]', { timeout: 3000 }); await btn.click(); } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => { const m = document.querySelectorAll('.prose, [class*="answer"]'); const l = m[m.length-1]; return l ? l.innerText.trim() : ''; }));
}

async function waitForStable(page, getText) {
    let last = '', stable = 0;
    while (stable < 3) {
        await sleep(1000);
        try {
            const t = await getText();
            const stop = await page.$('button[aria-label="Stop generating"], button[aria-label="Stop"]');
            if (t === last && !stop && t.length > 0) stable++; else stable = 0;
            last = t;
        } catch { stable = 0; }
    }
    return last;
}

const SENDERS = { chatgpt: sendChatGPT, claude: sendClaude, gemini: sendGemini, perplexity: sendPerplexity };

// ============================================================
// ROUTES
// ============================================================

app.get('/', (_, res) => res.send(HTML));

app.get('/v1/providers', (_, res) => {
    const out = {};
    for (const [k, v] of Object.entries(PROVIDERS)) {
        out[k] = { name: v.name, status: pages[k] ? 'connected' : 'disconnected', color: v.color, icon: v.icon, desc: v.desc, uptime: v.connectedAt ? Math.floor((Date.now() - v.connectedAt) / 1000) : 0 };
    }
    res.json(out);
});

app.post('/v1/keys', (_, res) => {
    const key = generateKey();
    res.json({ key, message: 'Save this key. It will not be shown again.' });
});

app.get('/v1/keys', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Missing auth' });
    const out = [];
    for (const [k, v] of apiKeys.entries()) {
        out.push({ key: k.slice(0, 12) + '...' + k.slice(-4), full: k, created: new Date(v.created).toISOString(), calls: v.calls, providers: v.providers, revoked: v.revoked });
    }
    res.json(out);
});

app.delete('/v1/keys/:key', (req, res) => {
    const k = req.params.key;
    if (!apiKeys.has(k)) return res.status(404).json({ error: 'Key not found' });
    apiKeys.get(k).revoked = true;
    res.json({ ok: true, message: 'Key revoked' });
});

app.get('/v1/stats', (_, res) => {
    let totalCalls = 0;
    for (const v of apiKeys.values()) totalCalls += v.calls;
    res.json({ totalCalls, totalKeys: apiKeys.size, activeKeys: [...apiKeys.values()].filter(v => !v.revoked).length, connectedProviders: Object.keys(PROVIDERS).filter(k => pages[k]).length, uptime: Math.floor((Date.now() - stats.startedAt) / 1000), errors: stats.errors });
});

app.post('/v1/chat/:provider', async (req, res) => {
    const { provider } = req.params;
    const { message } = req.body;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing API key. Generate one first.' });
    const key = auth.replace('Bearer ', '');
    const kd = apiKeys.get(key);
    if (!kd || kd.revoked) return res.status(403).json({ error: 'Invalid or revoked API key' });
    if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider', available: Object.keys(PROVIDERS) });
    if (!pages[provider]) return res.status(503).json({ error: provider + ' not connected. Initialize it first.' });
    if (busy[provider]) return res.status(429).json({ error: provider + ' is busy. Try again shortly.' });
    if (!message) return res.status(400).json({ error: 'No message provided' });

    busy[provider] = true;
    const start = Date.now();
    try {
        const reply = await SENDERS[provider](pages[provider], message);
        await saveCookies(provider);
        kd.calls++;
        stats.totalCalls++;
        if (!kd.providers.includes(provider)) kd.providers.push(provider);
        res.json({ provider, model: PROVIDERS[provider].name, reply, latency: Date.now() - start + 'ms' });
    } catch (err) {
        stats.errors++;
        res.status(500).json({ error: err.message });
    } finally { busy[provider] = false; }
});

app.post('/v1/providers/:provider/init', async (req, res) => {
    const { provider } = req.params;
    if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider' });
    try { await launchBrowser(provider); res.json({ status: 'connected', provider }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/v1/providers/:provider/newchat', async (req, res) => {
    const { provider } = req.params;
    if (!pages[provider]) return res.status(503).json({ error: 'Not connected' });
    try { await pages[provider].goto(PROVIDERS[provider].url, { waitUntil: 'networkidle2', timeout: 30000 }); res.json({ ok: true }); }
    catch (err) { res.json({ error: err.message }); }
});

// ============================================================
// HTML — PREMIUM DASHBOARD
// ============================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova API — Dashboard</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#08080c;--surface:#0e0e14;--card:#111118;--border:#1a1a2e;--border2:#252540;--text:#e0e0e0;--muted:#666;--blue:#1CB7FF;--green:#2FF58B;--red:#ef4444;--amber:#f59e0b}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}

/* LAYOUT */
.app{display:flex;min-height:100vh}
.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;position:fixed;height:100vh;display:flex;flex-direction:column;z-index:100}
.main{margin-left:240px;flex:1;padding:0}

/* SIDEBAR */
.sb-logo{display:flex;align-items:center;gap:10px;padding:0 20px 24px;border-bottom:1px solid var(--border);margin-bottom:16px}
.sb-logo .icon{width:34px;height:34px;background:linear-gradient(135deg,var(--blue),var(--green));border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#000}
.sb-logo span{font-size:18px;font-weight:700;background:linear-gradient(90deg,var(--blue),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sb-nav{flex:1;overflow-y:auto;padding:0 10px}
.sb-section{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);padding:16px 10px 6px;font-weight:600}
.sb-link{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:#888;font-size:13.5px;cursor:pointer;transition:all .15s;text-decoration:none;font-weight:500}
.sb-link:hover{background:#1a1a2e;color:#ccc}
.sb-link.active{background:linear-gradient(135deg,#1CB7FF11,#2FF58B08);color:#fff;border:1px solid #1CB7FF22}
.sb-link .dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.sb-link .badge{margin-left:auto;background:var(--red);color:#fff;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:700}

/* TOP BAR */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:50}
.topbar h2{font-size:18px;font-weight:700}
.topbar-right{display:flex;align-items:center;gap:12px}
.pill{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#10a37f18;color:#10a37f;border:1px solid #10a37f33}
.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}
.btn-primary{background:linear-gradient(135deg,var(--blue),var(--green));color:#000}
.btn-primary:hover{opacity:.85}
.btn-danger{background:#ef444422;color:#ef4444;border:1px solid #ef444433}
.btn-danger:hover{background:#ef444433}
.btn-outline{background:transparent;border:1px solid var(--border2);color:#aaa}
.btn-outline:hover{border-color:var(--blue);color:var(--blue)}
.btn-sm{padding:6px 12px;font-size:11.5px}
.btn-xs{padding:4px 8px;font-size:10.5px;border-radius:6px}
.btn-icon{padding:6px;background:transparent;border:1px solid var(--border);color:#888;border-radius:6px;cursor:pointer;font-size:13px;transition:all .15s}
.btn-icon:hover{border-color:var(--blue);color:var(--blue)}

/* CONTENT */
.content{padding:24px 28px}
.page{display:none}
.page.active{display:block}

/* STATS ROW */
.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
.stat-card .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;font-weight:600}
.stat-card .value{font-size:28px;font-weight:800;background:linear-gradient(90deg,var(--blue),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.stat-card .sub{font-size:11px;color:#555;margin-top:4px}

/* SECTION HEADER */
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.section-head h3{font-size:16px;font-weight:700}
.section-head .count{font-size:12px;color:var(--muted)}

/* TABLE */
.table-wrap{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:24px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:600;padding:12px 16px;border-bottom:1px solid var(--border);background:#0c0c14}
td{padding:11px 16px;font-size:13px;border-bottom:1px solid #111120}
tr:last-child td{border-bottom:none}
.mono{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px}
.copy-btn{background:none;border:none;color:#555;cursor:pointer;padding:4px;font-size:13px;transition:color .15s;vertical-align:middle}
.copy-btn:hover{color:var(--blue)}
.copy-btn.copied{color:var(--green)}

/* STATUS DOTS */
.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
.status-dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
.status-dot.off{background:#555}

/* PROVIDER CARDS */
.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;margin-bottom:24px}
.p-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;transition:all .2s}
.p-card:hover{border-color:var(--border2);transform:translateY(-2px)}
.p-card-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.p-card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#000}
.p-card-name{font-size:15px;font-weight:700}
.p-card-desc{font-size:12px;color:var(--muted)}
.p-card-status{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:12px;font-weight:500}
.p-card-status.connected{color:var(--green)}
.p-card-status.disconnected{color:#666}
.p-card-actions{display:flex;gap:8px}

/* CHAT */
.chat-container{display:flex;flex-direction:column;height:calc(100vh - 140px)}
.chat-header{display:flex;align-items:center;gap:12px;padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-shrink:0}
.chat-header select{background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;font-size:13px;outline:none;cursor:pointer;font-family:inherit}
.chat-messages{flex:1;overflow-y:auto;padding-right:8px}
.msg{margin-bottom:12px;max-width:80%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.65;white-space:pre-wrap;word-wrap:break-word;position:relative}
.msg-user{background:linear-gradient(135deg,#1CB7FF15,#2FF58B08);border:1px solid #1CB7FF20;margin-left:auto;text-align:right;border-bottom-right-radius:4px}
.msg-bot{background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}
.msg-system{text-align:center;color:#555;font-size:12px;font-style:italic;max-width:100%}
.msg-error{text-align:center;color:var(--red);font-size:12.5px;max-width:100%;background:#ef444411;border:1px solid #ef444422;border-radius:8px;padding:8px 14px}
.msg-meta{font-size:10px;color:#444;margin-top:4px}
.msg-copy{position:absolute;top:8px;right:8px;opacity:0;transition:opacity .15s}
.msg:hover .msg-copy{opacity:1}
.chat-input-wrap{display:flex;gap:10px;padding-top:16px;border-top:1px solid var(--border);flex-shrink:0}
.chat-input-wrap textarea{flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:13.5px;font-family:inherit;resize:none;height:44px;outline:none;transition:border-color .15s}
.chat-input-wrap textarea:focus{border-color:var(--blue)}
.spinner{display:inline-block;width:13px;height:13px;border:2px solid #1CB7FF44;border-top:2px solid var(--blue);border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

/* API DOCS */
.doc-block{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:12px}
.doc-block .endpoint{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.method{padding:3px 10px;border-radius:5px;font-weight:700;font-size:11px;letter-spacing:.5px}
.m-get{background:#10a37f22;color:#10a37f}
.m-post{background:#2563eb22;color:#60a5fa}
.m-delete{background:#ef444422;color:#ef4444}
.doc-block code{background:#1a1a28;padding:3px 7px;border-radius:5px;font-size:12px;font-family:'SF Mono',Monaco,Consolas,monospace;color:#ccc}
.doc-block .desc{font-size:13px;color:#888;line-height:1.6}
.doc-block .example{background:#0a0a10;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:10px;font-family:'SF Mono',Monaco,Consolas,monospace;font-size:12px;color:#aaa;line-height:1.7;position:relative;white-space:pre;overflow-x:auto}

/* TOAST */
.toast{position:fixed;bottom:24px;right:24px;background:var(--card);border:1px solid var(--border2);border-radius:10px;padding:10px 18px;font-size:13px;color:var(--green);display:none;z-index:999;animation:fadeIn .2s}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}

/* RESPONSIVE */
@media(max-width:768px){
.sidebar{width:60px;padding:12px 0}
.sb-logo span,.sb-link span,.sb-section{display:none}
.sb-link{justify-content:center;padding:10px}
.sb-link .badge{display:none}
.main{margin-left:60px}
.stats-row{grid-template-columns:1fr 1fr}
.provider-grid{grid-template-columns:1fr}
.topbar h2{font-size:15px}
}
</style>
</head>
<body>
<div class="app">

<!-- SIDEBAR -->
<div class="sidebar">
    <div class="sb-logo">
        <div class="icon">N</div>
        <span>Nova API</span>
    </div>
    <div class="sb-nav">
        <div class="sb-section">Overview</div>
        <a class="sb-link active" data-page="dashboard" onclick="switchPage('dashboard')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            <span>Dashboard</span>
        </a>
        <a class="sb-link" data-page="providers" onclick="switchPage('providers')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6m-7-7H1m22 0h-4m-1.5-7.5L15 7m-6 10l-2.5 2.5M19.5 19.5L17 17M5 5l2.5 2.5"/></svg>
            <span>Providers</span>
            <span class="badge" id="providerBadge">0</span>
        </a>
        <div class="sb-section">Management</div>
        <a class="sb-link" data-page="keys" onclick="switchPage('keys')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <span>API Keys</span>
        </a>
        <div class="sb-section">Tools</div>
        <a class="sb-link" data-page="playground" onclick="switchPage('playground')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Playground</span>
        </a>
        <a class="sb-link" data-page="docs" onclick="switchPage('docs')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <span>API Docs</span>
        </a>
    </div>
</div>

<!-- MAIN -->
<div class="main">
    <div class="topbar">
        <h2 id="pageTitle">Dashboard</h2>
        <div class="topbar-right">
            <div class="pill"><span class="dot"></span><span id="connectedCount">0</span> Connected</div>
        </div>
    </div>

    <div class="content">

        <!-- DASHBOARD PAGE -->
        <div class="page active" id="page-dashboard">
            <div class="stats-row" id="statsRow"></div>
            <div class="section-head"><h3>Provider Status</h3></div>
            <div class="provider-grid" id="dashProviders"></div>
        </div>

        <!-- PROVIDERS PAGE -->
        <div class="page" id="page-providers">
            <div class="section-head"><h3>AI Providers</h3><span class="count" id="providerCountLabel">0 available</span></div>
            <div class="provider-grid" id="providerGrid"></div>
        </div>

        <!-- KEYS PAGE -->
        <div class="page" id="page-keys">
            <div class="section-head">
                <h3>API Keys</h3>
                <button class="btn btn-primary btn-sm" onclick="generateKey()">+ New Key</button>
            </div>
            <div class="table-wrap">
                <table>
                    <thead><tr><th>Key</th><th>Created</th><th>Calls</th><th>Providers</th><th>Status</th><th>Actions</th></tr></thead>
                    <tbody id="keysTableBody"><tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet. Generate one to get started.</td></tr></tbody>
                </table>
            </div>
        </div>

        <!-- PLAYGROUND PAGE -->
        <div class="page" id="page-playground">
            <div class="chat-container">
                <div class="chat-header">
                    <select id="chatProvider"></select>
                    <button class="btn btn-outline btn-sm" onclick="newChat()">New Chat</button>
                    <button class="btn btn-outline btn-sm" onclick="clearChat()">Clear</button>
                </div>
                <div class="chat-messages" id="chatBox">
                    <div class="msg msg-system">Select a provider and start chatting. Responses come directly from the AI website.</div>
                </div>
                <div class="chat-input-wrap">
                    <textarea id="chatInput" placeholder="Type a message..." rows="1"></textarea>
                    <button class="btn btn-primary" id="sendBtn" onclick="sendMsg()">Send</button>
                </div>
            </div>
        </div>

        <!-- DOCS PAGE -->
        <div class="page" id="page-docs">
            <div class="section-head"><h3>API Reference</h3></div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-post">POST</span> <code>/v1/keys</code></div>
                <div class="desc">Generate a new API key. Save it — it will not be shown again.</div>
                <div class="example" id="doc1">curl -X POST https://your-app.onrender.com/v1/keys
<span style="color:#555"># Response:</span>
{ "key": "sk-nova-a1b2c3..." }</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-get">GET</span> <code>/v1/providers</code></div>
                <div class="desc">List all providers with connection status and uptime.</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/init</code></div>
                <div class="desc">Initialize a provider browser. Required before sending messages. Replace <code>:provider</code> with <code>chatgpt</code>, <code>claude</code>, <code>gemini</code>, or <code>perplexity</code>.</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-post">POST</span> <code>/v1/chat/:provider</code></div>
                <div class="desc">Send a message to an AI provider. Requires Authorization header.</div>
                <div class="example">curl -X POST https://your-app.onrender.com/v1/chat/chatgpt \\
  -H "Authorization: Bearer sk-nova-YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!"}'

<span style="color:#555"># Response:</span>
{ "provider": "chatgpt", "model": "ChatGPT", "reply": "Hi! How can I help?", "latency": "3200ms" }</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/newchat</code></div>
                <div class="desc">Reset conversation — start a fresh chat on the provider.</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-delete">DELETE</span> <code>/v1/keys/:key</code></div>
                <div class="desc">Revoke an API key. Calls using this key will be rejected.</div>
            </div>

            <div class="doc-block">
                <div class="endpoint"><span class="method m-get">GET</span> <code>/v1/stats</code></div>
                <div class="desc">Platform statistics — total calls, active keys, connected providers, uptime.</div>
            </div>
        </div>

    </div>
</div>
</div>

<div class="toast" id="toast"></div>

<script>
// ============================================================
// STATE
// ============================================================
let myKey = localStorage.getItem('nova_key') || '';
let providers = {};
let keys = [];

// ============================================================
// NAVIGATION
// ============================================================
const pageTitles = { dashboard:'Dashboard', providers:'Providers', keys:'API Keys', playground:'Playground', docs:'API Documentation' };

function switchPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    document.querySelectorAll('.sb-link').forEach(l => l.classList.remove('active'));
    document.querySelector('.sb-link[data-page="'+page+'"]').classList.add('active');
    document.getElementById('pageTitle').textContent = pageTitles[page];
    if (page === 'keys') loadKeys();
    if (page === 'providers' || page === 'dashboard') loadProviders();
}

// ============================================================
// TOAST
// ============================================================
function showToast(msg, color) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.color = color || 'var(--green)';
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.style.display = 'none', 2500);
}

// ============================================================
// COPY UTILITY
// ============================================================
function copyText(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        if (btn) {
            btn.classList.add('copied');
            btn.textContent = '✓';
            setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋'; }, 1500);
        }
        showToast('Copied to clipboard');
    }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        if (btn) {
            btn.classList.add('copied');
            btn.textContent = '✓';
            setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '📋'; }, 1500);
        }
        showToast('Copied to clipboard');
    });
}

// ============================================================
// TIME FORMATTING
// ============================================================
function fmtUptime(sec) {
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec/60) + 'm ' + (sec%60) + 's';
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
    return h + 'h ' + m + 'm';
}

function fmtDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
}

// ============================================================
// LOAD PROVIDERS
// ============================================================
async function loadProviders() {
    try {
        const res = await fetch('/v1/providers');
        providers = await res.json();

        let connected = 0;
        for (const [id, p] of Object.entries(providers)) {
            if (p.status === 'connected') connected++;
        }
        document.getElementById('connectedCount').textContent = connected;
        document.getElementById('providerBadge').textContent = connected;

        // Dashboard provider cards
        renderProviderCards('dashProviders', true);
        renderProviderCards('providerGrid', false);

        // Chat provider select
        const sel = document.getElementById('chatProvider');
        const cur = sel.value;
        sel.innerHTML = '';
        for (const [id, p] of Object.entries(providers)) {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = p.name + (p.status === 'connected' ? ' ✓' : '');
            sel.appendChild(opt);
        }
        if (cur) sel.value = cur;
    } catch(e) { console.error(e); }
}

function renderProviderCards(containerId, compact) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = '';
    for (const [id, p] of Object.entries(providers)) {
        const card = document.createElement('div');
        card.className = 'p-card';
        const isConnected = p.status === 'connected';
        card.innerHTML =
            '<div class="p-card-head">' +
                '<div class="p-card-icon" style="background:' + p.color + '">' + (p.icon || p.name[0]) + '</div>' +
                '<div><div class="p-card-name">' + p.name + '</div><div class="p-card-desc">' + (p.desc || '') + '</div></div>' +
            '</div>' +
            '<div class="p-card-status ' + (isConnected ? 'connected' : 'disconnected') + '">' +
                '<span class="status-dot ' + (isConnected ? 'on' : 'off') + '"></span>' +
                (isConnected ? 'Connected — up ' + fmtUptime(p.uptime || 0) : 'Disconnected') +
            '</div>' +
            (compact ? '' :
                '<div class="p-card-actions">' +
                    '<button class="btn btn-primary btn-sm" onclick="initProvider(\\'' + id + '\\')">Connect</button>' +
                    (isConnected ? '<button class="btn btn-outline btn-sm" onclick="newChatFor(\\'' + id + '\\')">New Chat</button>' : '') +
                '</div>'
            );
        grid.appendChild(card);
    }
    document.getElementById('providerCountLabel').textContent = Object.keys(providers).length + ' available';
}

// ============================================================
// INIT PROVIDER
// ============================================================
async function initProvider(id) {
    showToast('Connecting to ' + id + '...', 'var(--amber)');
    try {
        const res = await fetch('/v1/providers/' + id + '/init', { method: 'POST' });
        const data = await res.json();
        if (data.error) showToast('Error: ' + data.error, 'var(--red)');
        else showToast(id + ' connected successfully');
    } catch(e) {
        showToast('Connection failed: ' + e.message, 'var(--red)');
    }
    loadProviders();
}

// ============================================================
// LOAD STATS
// ============================================================
async function loadStats() {
    try {
        const res = await fetch('/v1/stats');
        const s = await res.json();
        document.getElementById('statsRow').innerHTML =
            '<div class="stat-card"><div class="label">Total Requests</div><div class="value">' + s.totalCalls + '</div><div class="sub">All time</div></div>' +
            '<div class="stat-card"><div class="label">Active Keys</div><div class="value">' + s.activeKeys + '</div><div class="sub">' + s.totalKeys + ' total generated</div></div>' +
            '<div class="stat-card"><div class="label">Connected Providers</div><div class="value">' + s.connectedProviders + '</div><div class="sub">of ' + Object.keys(providers).length + ' available</div></div>' +
            '<div class="stat-card"><div class="label">Uptime</div><div class="value">' + fmtUptime(s.uptime) + '</div><div class="sub">' + s.errors + ' errors</div></div>';
    } catch(e) { console.error(e); }
}

// ============================================================
// KEYS MANAGEMENT
// ============================================================
async function generateKey() {
    const res = await fetch('/v1/keys', { method: 'POST' });
    const data = await res.json();
    myKey = data.key;
    localStorage.setItem('nova_key', myKey);
    showToast('API key generated — save it now!');
    loadKeys();
}

async function loadKeys() {
    try {
        const res = await fetch('/v1/keys');
        keys = await res.json();
        const tbody = document.getElementById('keysTableBody');
        if (!keys.length) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet. Click "+ New Key" to generate one.</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        for (const k of keys) {
            const tr = document.createElement('tr');
            const provTags = k.providers.map(p => '<span style="background:' + (providers[p]?.color || '#555') + '22;color:' + (providers[p]?.color || '#aaa') + ';padding:2px 7px;border-radius:4px;font-size:10px;margin-right:4px">' + p + '</span>').join('') || '<span style="color:#444">—</span>';
            tr.innerHTML =
                '<td><span class="mono">' + k.key + '</span> <button class="copy-btn" onclick="copyText(\\'' + k.full + '\\', this)" title="Copy full key">📋</button></td>' +
                '<td>' + fmtDate(new Date(k.created).getTime()) + '</td>' +
                '<td style="font-weight:600">' + k.calls + '</td>' +
                '<td>' + provTags + '</td>' +
                '<td>' + (k.revoked ? '<span style="color:var(--red)">Revoked</span>' : '<span style="color:var(--green)">Active</span>') + '</td>' +
                '<td>' + (k.revoked ? '—' : '<button class="btn btn-danger btn-xs" onclick="revokeKey(\\'' + k.full + '\\')">Revoke</button>') + '</td>';
            tbody.appendChild(tr);
        }
    } catch(e) { console.error(e); }
}

async function revokeKey(key) {
    if (!confirm('Revoke this key? Calls using it will be rejected.')) return;
    try {
        await fetch('/v1/keys/' + key, { method: 'DELETE' });
        showToast('Key revoked');
        loadKeys();
        loadStats();
    } catch(e) {
        showToast('Failed to revoke', 'var(--red)');
    }
}

// ============================================================
// PLAYGROUND
// ============================================================
const chatBox = document.getElementById('chatBox');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');

chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } });
chatInput.addEventListener('input', () => { chatInput.style.height = 'auto'; chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px'; });

function addMsg(text, cls, meta) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (cls === 'msg-bot' || cls === 'msg-user') {
        div.innerHTML = text.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
            '<button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.replace(\\'📋\\',\\'\\').trim(), this)">📋</button>' +
            (meta ? '<div class="msg-meta">' + meta + '</div>' : '');
    } else {
        div.textContent = text;
    }
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
    return div;
}

async function sendMsg() {
    if (!myKey) { showToast('Generate an API key first (Keys tab)', 'var(--red)'); switchPage('keys'); return; }
    const text = chatInput.value.trim();
    if (!text) return;
    const provider = document.getElementById('chatProvider').value;

    addMsg(text, 'msg-user');
    chatInput.value = '';
    chatInput.style.height = '44px';

    sendBtn.disabled = true;
    const thinking = addMsg('', 'msg-bot');
    thinking.innerHTML = '<span class="spinner"></span> Querying ' + provider + '...';

    try {
        const res = await fetch('/v1/chat/' + provider, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + myKey },
            body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        if (data.error) {
            thinking.className = 'msg msg-error';
            thinking.innerHTML = 'Error: ' + data.error.replace(/</g,'&lt;') + ' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.replace(\\'📋\\',\\'\\').trim(), this)">📋</button>';
        } else {
            thinking.className = 'msg msg-bot';
            thinking.innerHTML = data.reply.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
                '<button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.replace(\\'📋\\',\\'\\').trim(), this)">📋</button>' +
                '<div class="msg-meta">' + data.model + ' · ' + data.latency + '</div>';
        }
    } catch(e) {
        thinking.className = 'msg msg-error';
        thinking.innerHTML = 'Network error: ' + e.message + ' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.replace(\\'📋\\',\\'\\').trim(), this)">📋</button>';
    }
    sendBtn.disabled = false;
    chatInput.focus();
    loadStats();
}

async function newChat() {
    const provider = document.getElementById('chatProvider').value;
    await fetch('/v1/providers/' + provider + '/newchat', { method: 'POST' });
    clearChat();
    addMsg('New conversation started on ' + provider, 'msg-system');
}

async function newChatFor(id) {
    await fetch('/v1/providers/' + id + '/newchat', { method: 'POST' });
    showToast('New chat started on ' + id);
}

function clearChat() {
    chatBox.innerHTML = '';
}

// ============================================================
// INIT
// ============================================================
loadProviders();
loadStats();
loadKeys();
setInterval(() => { loadProviders(); loadStats(); }, 15000);
</script>
</body>
</html>`;

// ============================================================
// START
// ============================================================
const PORT = 3000;
app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   Nova API Gateway                   ║');
    console.log('  ║   http://localhost:' + PORT + '               ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
});
