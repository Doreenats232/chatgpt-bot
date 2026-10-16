// Nova API Gateway v2 — Playwright + Firefox
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
const apiKeys = new Map();
const stats = { startedAt: Date.now(), errors: 0 };
const COOKIES_DIR = path.join(__dirname, 'cookies');
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR, { recursive: true });

// ═══════════════════════════════════════
// PROVIDERS
// ═══════════════════════════════════════
const PROVIDERS = {
    chatgpt:    { name: 'ChatGPT',     url: 'https://chatgpt.com/',               color: '#10a37f', icon: 'G',  desc: 'OpenAI GPT-4o' },
    claude:     { name: 'Claude',      url: 'https://claude.ai/new',               color: '#d97706', icon: 'C',  desc: 'Anthropic Claude 3.5' },
    gemini:     { name: 'Gemini',      url: 'https://gemini.google.com/app',       color: '#4285f4', icon: 'Ge', desc: 'Google Gemini Pro' },
    perplexity: { name: 'Perplexity',  url: 'https://www.perplexity.ai/',           color: '#20b2aa', icon: 'P',  desc: 'Perplexity AI' }
};

const contexts = {};
const pages = {};
const busy = {};
const pState = {};
Object.keys(PROVIDERS).forEach(id => {
    pState[id] = { connectedAt: null, requests: 0 };
    busy[id] = false;
});

let playwright;
let firefox;

// ═══════════════════════════════════════
// BROWSER LAUNCH — Firefox (lighter)
// ═══════════════════════════════════════
async function launchProvider(provider) {
    if (contexts[provider]) return;

    if (!playwright) {
        playwright = require('playwright');
        firefox = playwright.firefox;
    }

    console.log('[*] Launching Firefox for: ' + provider);

    const cookieFile = path.join(COOKIES_DIR, provider + '.json');
    let storageState;
    if (fs.existsSync(cookieFile)) {
        try { storageState = JSON.parse(fs.readFileSync(cookieFile, 'utf8')); } catch {}
    }

    contexts[provider] = await firefox.launchPersistentContext(
        path.join(COOKIES_DIR, provider + '-profile'),
        {
            headless: true,
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
            locale: 'en-US',
            timezoneId: 'America/New_York',
            args: [
                '--disable-extensions',
                '--disable-background-networking'
            ],
            ...(storageState ? {} : {})
        }
    );

    const page = contexts[provider].pages()[0] || await contexts[provider].newPage();
    pages[provider] = page;

    // Load cookies if we have them
    if (storageState && storageState.cookies) {
        try {
            const browserCtx = contexts[provider];
            await browserCtx.addCookies(storageState.cookies);
        } catch {}
    }

    await page.goto(PROVIDERS[provider].url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    pState[provider].connectedAt = Date.now();
    await saveCookies(provider);
    console.log('[*] ' + provider + ' ready');
}

async function saveCookies(provider) {
    try {
        if (!contexts[provider]) return;
        const cookies = await contexts[provider].cookies();
        fs.writeFileSync(
            path.join(COOKIES_DIR, provider + '.json'),
            JSON.stringify({ cookies }, null, 2)
        );
    } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════
// HUMAN TYPING
// ═══════════════════════════════════════
async function humanType(page, text) {
    const sel = '#prompt-textarea, div[contenteditable="true"], textarea, [role="textbox"]';
    const el = await page.waitForSelector(sel, { timeout: 10000 });
    await el.click();
    await sleep(300 + Math.random() * 500);
    for (const c of text) {
        await page.keyboard.type(c, { delay: 25 + Math.random() * 100 });
        if (Math.random() < 0.03) await sleep(150 + Math.random() * 300);
    }
}

// ═══════════════════════════════════════
// WAIT FOR RESPONSE TO STABILIZE
// ═══════════════════════════════════════
async function waitForStable(page, getText, maxWait) {
    let last = '', stable = 0, waited = 0;
    const limit = maxWait || 90;
    while (stable < 4 && waited < limit) {
        await sleep(1500);
        waited += 1.5;
        try {
            const t = await getText();
            const stop = await page.$('button[aria-label="Stop generating"], button[aria-label="Stop"]');
            if (t === last && !stop && t.length > 0) stable++;
            else stable = 0;
            last = t;
        } catch { stable = 0; }
    }
    return last;
}

// ═══════════════════════════════════════
// PROVIDER SEND FUNCTIONS
// ═══════════════════════════════════════
async function sendChatGPT(page, msg) {
    const before = await page.evaluate(() => document.querySelectorAll('div[data-message-author-role="assistant"]').length);
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try {
        const btn = await page.waitForSelector('button[data-testid="send-button"], button[aria-label="Send prompt"]', { timeout: 3000 });
        await btn.click();
    } catch { await page.keyboard.press('Enter'); }
    await page.waitForFunction(c => document.querySelectorAll('div[data-message-author-role="assistant"]').length > c, { timeout: 120000 }, before);
    return await waitForStable(page, () => page.evaluate(() => {
        const m = document.querySelectorAll('div[data-message-author-role="assistant"]');
        const l = m[m.length - 1];
        return l ? l.innerText.trim() : '';
    }));
}

async function sendClaude(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try {
        const btn = await page.waitForSelector('button[aria-label="Send Message"], button[aria-label="Send"]', { timeout: 3000 });
        await btn.click();
    } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => {
        const m = document.querySelectorAll('div[class*="Message"]');
        const l = m[m.length - 1];
        return l ? l.innerText.trim() : '';
    }));
}

async function sendGemini(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try {
        const btn = await page.waitForSelector('button[aria-label="Send message"], .send-button', { timeout: 3000 });
        await btn.click();
    } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => {
        const m = document.querySelectorAll('.model-response-text, [class*="response"]');
        const l = m[m.length - 1];
        return l ? l.innerText.trim() : '';
    }));
}

async function sendPerplexity(page, msg) {
    await humanType(page, msg);
    await sleep(200 + Math.random() * 300);
    try {
        const btn = await page.waitForSelector('button[aria-label="Submit"], button[type="submit"]', { timeout: 3000 });
        await btn.click();
    } catch { await page.keyboard.press('Enter'); }
    await sleep(3000);
    return await waitForStable(page, () => page.evaluate(() => {
        const m = document.querySelectorAll('.prose, [class*="answer"]');
        const l = m[m.length - 1];
        return l ? l.innerText.trim() : '';
    }));
}

const SENDERS = { chatgpt: sendChatGPT, claude: sendClaude, gemini: sendGemini, perplexity: sendPerplexity };

// ═══════════════════════════════════════
// API KEY MANAGEMENT
// ═══════════════════════════════════════
function makeKey() {
    const key = 'sk-nova-' + crypto.randomBytes(24).toString('hex');
    apiKeys.set(key, { created: Date.now(), calls: 0, providers: [], revoked: false });
    return key;
}

// ═══════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════

app.get('/', (_, res) => res.send(HTML()));

app.get('/v1/providers', (_, res) => {
    const out = {};
    for (const [id, p] of Object.entries(PROVIDERS)) {
        out[id] = {
            name: p.name, desc: p.desc, color: p.color, icon: p.icon,
            connected: !!pages[id],
            uptime: pState[id].connectedAt ? Math.floor((Date.now() - pState[id].connectedAt) / 1000) : 0,
            requests: pState[id].requests
        };
    }
    res.json(out);
});

app.post('/v1/providers/:id/init', async (req, res) => {
    const { id } = req.params;
    if (!PROVIDERS[id]) return res.status(400).json({ error: 'Unknown provider' });
    try {
        await launchProvider(id);
        res.json({ status: 'connected', provider: id, name: PROVIDERS[id].name });
    } catch (err) {
        stats.errors++;
        res.status(500).json({ error: err.message });
    }
});

app.post('/v1/providers/:id/newchat', async (req, res) => {
    const { id } = req.params;
    if (!pages[id]) return res.status(503).json({ error: 'Not connected' });
    try {
        await pages[id].goto(PROVIDERS[id].url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await pages[id].waitForTimeout(2000);
        res.json({ ok: true });
    } catch (err) { res.json({ error: err.message }); }
});

app.post('/v1/keys', (_, res) => {
    const key = makeKey();
    res.json({ key, message: 'Save this key. It will not be shown again.' });
});

app.get('/v1/keys', (_, res) => {
    const out = [];
    apiKeys.forEach((v, k) => {
        out.push({
            key: k.slice(0, 12) + '...' + k.slice(-4), full: k,
            created: new Date(v.created).toISOString(),
            calls: v.calls, providers: v.providers, revoked: v.revoked
        });
    });
    res.json(out);
});

app.delete('/v1/keys/:key', (req, res) => {
    if (!apiKeys.has(req.params.key)) return res.status(404).json({ error: 'Not found' });
    apiKeys.get(req.params.key).revoked = true;
    res.json({ ok: true });
});

app.get('/v1/stats', (_, res) => {
    let totalCalls = 0;
    apiKeys.forEach(v => totalCalls += v.calls);
    res.json({
        totalCalls, totalKeys: apiKeys.size,
        activeKeys: [...apiKeys.values()].filter(v => !v.revoked).length,
        connectedProviders: Object.keys(PROVIDERS).filter(k => pages[k]).length,
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        errors: stats.errors
    });
});

app.post('/v1/chat/:provider', async (req, res) => {
    const { provider } = req.params;
    const { message } = req.body;
    const auth = req.headers.authorization;

    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing API key' });
    const key = auth.replace('Bearer ', '');
    const kd = apiKeys.get(key);
    if (!kd || kd.revoked) return res.status(403).json({ error: 'Invalid or revoked key' });
    if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider', available: Object.keys(PROVIDERS) });
    if (!pages[provider]) return res.status(503).json({ error: provider + ' not connected. Initialize first.' });
    if (busy[provider]) return res.status(429).json({ error: provider + ' is busy. Try again.' });
    if (!message) return res.status(400).json({ error: 'No message' });

    busy[provider] = true;
    const start = Date.now();
    try {
        const reply = await SENDERS[provider](pages[provider], message);
        await saveCookies(provider);
        kd.calls++;
        if (!kd.providers.includes(provider)) kd.providers.push(provider);
        pState[provider].requests++;
        res.json({ provider, model: PROVIDERS[provider].name, reply, latency: (Date.now() - start) + 'ms' });
    } catch (err) {
        stats.errors++;
        res.status(500).json({ error: err.message });
    } finally { busy[provider] = false; }
});

// ═══════════════════════════════════════
// HTML DASHBOARD
// ═══════════════════════════════════════

function HTML() {
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>Nova API — Dashboard</title>\n' +
    '<style>\n' +
    '*{margin:0;padding:0;box-sizing:border-box}\n' +
    ':root{--bg:#08080c;--surface:#0e0e14;--card:#111118;--border:#1a1a2e;--border2:#252540;--text:#e0e0e0;--muted:#666;--blue:#1CB7FF;--green:#2FF58B;--red:#ef4444;--amber:#f59e0b}\n' +
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}\n' +
    '.app{display:flex;min-height:100vh}\n' +
    '.sidebar{width:240px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;position:fixed;height:100vh;display:flex;flex-direction:column;z-index:100}\n' +
    '.main{margin-left:240px;flex:1}\n' +
    '.sb-logo{display:flex;align-items:center;gap:10px;padding:0 20px 24px;border-bottom:1px solid var(--border);margin-bottom:16px}\n' +
    '.sb-logo .icon{width:34px;height:34px;background:linear-gradient(135deg,var(--blue),var(--green));border-radius:9px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#000}\n' +
    '.sb-logo span{font-size:18px;font-weight:700;background:linear-gradient(90deg,var(--blue),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent}\n' +
    '.sb-nav{flex:1;overflow-y:auto;padding:0 10px}\n' +
    '.sb-section{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--muted);padding:16px 10px 6px;font-weight:600}\n' +
    '.sb-link{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:#888;font-size:13.5px;cursor:pointer;transition:all .15s;text-decoration:none;font-weight:500}\n' +
    '.sb-link:hover{background:#1a1a2e;color:#ccc}\n' +
    '.sb-link.active{background:linear-gradient(135deg,#1CB7FF11,#2FF58B08);color:#fff;border:1px solid #1CB7FF22}\n' +
    '.sb-link .badge{margin-left:auto;background:var(--green);color:#000;font-size:10px;padding:1px 6px;border-radius:10px;font-weight:700}\n' +
    '.topbar{display:flex;align-items:center;justify-content:space-between;padding:16px 28px;border-bottom:1px solid var(--border);background:var(--surface);position:sticky;top:0;z-index:50}\n' +
    '.topbar h2{font-size:18px;font-weight:700}\n' +
    '.topbar-right{display:flex;align-items:center;gap:12px}\n' +
    '.pill{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:600;background:#10a37f18;color:#10a37f;border:1px solid #10a37f33}\n' +
    '.pill .dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 2s infinite}\n' +
    '@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}\n' +
    '.btn{padding:9px 18px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit}\n' +
    '.btn-primary{background:linear-gradient(135deg,var(--blue),var(--green));color:#000}\n' +
    '.btn-primary:hover{opacity:.85}\n' +
    '.btn-danger{background:#ef444422;color:#ef4444;border:1px solid #ef444433}\n' +
    '.btn-danger:hover{background:#ef444433}\n' +
    '.btn-outline{background:transparent;border:1px solid var(--border2);color:#aaa}\n' +
    '.btn-outline:hover{border-color:var(--blue);color:var(--blue)}\n' +
    '.btn-sm{padding:6px 12px;font-size:11.5px}\n' +
    '.btn-xs{padding:4px 8px;font-size:10.5px;border-radius:6px}\n' +
    '.btn:disabled{opacity:.4;cursor:not-allowed}\n' +
    '.content{padding:24px 28px}\n' +
    '.page{display:none}\n' +
    '.page.active{display:block}\n' +
    '.stats-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:24px}\n' +
    '.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}\n' +
    '.stat-card .label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px;font-weight:600}\n' +
    '.stat-card .value{font-size:28px;font-weight:800;background:linear-gradient(90deg,var(--blue),var(--green));-webkit-background-clip:text;-webkit-text-fill-color:transparent}\n' +
    '.stat-card .sub{font-size:11px;color:#555;margin-top:4px}\n' +
    '.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}\n' +
    '.section-head h3{font-size:16px;font-weight:700}\n' +
    '.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:24px}\n' +
    '.p-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;transition:all .2s}\n' +
    '.p-card:hover{border-color:var(--border2);transform:translateY(-2px)}\n' +
    '.p-card-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}\n' +
    '.p-card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#000;flex-shrink:0}\n' +
    '.p-card-name{font-size:15px;font-weight:700}\n' +
    '.p-card-desc{font-size:12px;color:var(--muted)}\n' +
    '.p-card-status{display:flex;align-items:center;gap:6px;font-size:12px;margin:12px 0;font-weight:500}\n' +
    '.p-card-status.connected{color:var(--green)}\n' +
    '.p-card-status.disconnected{color:#666}\n' +
    '.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}\n' +
    '.status-dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}\n' +
    '.status-dot.off{background:#555}\n' +
    '.p-card-meta{font-size:11px;color:#444;margin-bottom:12px}\n' +
    '.p-card-actions{display:flex;gap:8px;flex-wrap:wrap}\n' +
    '.p-card-actions .btn:disabled{opacity:.5}\n' +
    '.table-wrap{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:24px}\n' +
    'table{width:100%;border-collapse:collapse}\n' +
    'th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);font-weight:600;padding:12px 16px;border-bottom:1px solid var(--border);background:#0c0c14}\n' +
    'td{padding:11px 16px;font-size:13px;border-bottom:1px solid #111120}\n' +
    'tr:last-child td{border-bottom:none}\n' +
    '.mono{font-family:SF Mono,Monaco,Consolas,monospace;font-size:12px}\n' +
    '.copy-btn{background:none;border:none;color:#555;cursor:pointer;padding:4px;font-size:13px;transition:color .15s;vertical-align:middle}\n' +
    '.copy-btn:hover{color:var(--blue)}\n' +
    '.copy-btn.copied{color:var(--green)}\n' +
    '.chat-container{display:flex;flex-direction:column;height:calc(100vh - 140px)}\n' +
    '.chat-header{display:flex;align-items:center;gap:12px;padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:16px;flex-shrink:0;flex-wrap:wrap}\n' +
    '.chat-header select{background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;font-size:13px;outline:none;cursor:pointer}\n' +
    '.chat-messages{flex:1;overflow-y:auto;padding-right:8px}\n' +
    '.msg{margin-bottom:12px;max-width:80%;padding:10px 14px;border-radius:12px;font-size:13.5px;line-height:1.65;white-space:pre-wrap;word-wrap:break-word;position:relative}\n' +
    '.msg-user{background:linear-gradient(135deg,#1CB7FF15,#2FF58B08);border:1px solid #1CB7FF20;margin-left:auto;text-align:right;border-bottom-right-radius:4px}\n' +
    '.msg-bot{background:var(--card);border:1px solid var(--border);border-bottom-left-radius:4px}\n' +
    '.msg-system{text-align:center;color:#555;font-size:12px;font-style:italic;max-width:100%}\n' +
    '.msg-error{text-align:center;color:var(--red);font-size:12.5px;max-width:100%;background:#ef444411;border:1px solid #ef444422;border-radius:8px;padding:8px 14px}\n' +
    '.msg-meta{font-size:10px;color:#444;margin-top:4px}\n' +
    '.msg-copy{position:absolute;top:8px;right:8px;opacity:0;transition:opacity .15s}\n' +
    '.msg:hover .msg-copy{opacity:1}\n' +
    '.chat-input-wrap{display:flex;gap:10px;padding-top:16px;border-top:1px solid var(--border);flex-shrink:0}\n' +
    '.chat-input-wrap textarea{flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:11px 14px;color:var(--text);font-size:13.5px;font-family:inherit;resize:none;height:44px;outline:none;transition:border-color .15s}\n' +
    '.chat-input-wrap textarea:focus{border-color:var(--blue)}\n' +
    '.spinner{display:inline-block;width:13px;height:13px;border:2px solid #1CB7FF44;border-top:2px solid var(--blue);border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}\n' +
    '@keyframes spin{to{transform:rotate(360deg)}}\n' +
    '.loading-btn{pointer-events:none;opacity:.6}\n' +
    '.doc-block{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:12px}\n' +
    '.doc-block .endpoint{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}\n' +
    '.method{padding:3px 10px;border-radius:5px;font-weight:700;font-size:11px;letter-spacing:.5px}\n' +
    '.m-get{background:#10a37f22;color:#10a37f}\n' +
    '.m-post{background:#2563eb22;color:#60a5fa}\n' +
    '.m-delete{background:#ef444422;color:#ef4444}\n' +
    '.doc-block code{background:#1a1a28;padding:3px 7px;border-radius:5px;font-size:12px;font-family:monospace;color:#ccc}\n' +
    '.doc-block .desc{font-size:13px;color:#888;line-height:1.6}\n' +
    '.doc-block .example{background:#0a0a10;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:10px;font-family:monospace;font-size:12px;color:#aaa;line-height:1.7;white-space:pre;overflow-x:auto}\n' +
    '.toast{position:fixed;bottom:24px;right:24px;background:var(--card);border:1px solid var(--border2);border-radius:10px;padding:10px 18px;font-size:13px;display:none;z-index:999;animation:fadeIn .2s;max-width:400px;word-wrap:break-word}\n' +
    '@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}\n' +
    '@media(max-width:768px){.sidebar{width:60px;padding:12px 0}.sb-logo span,.sb-link span,.sb-section{display:none}.sb-link{justify-content:center;padding:10px}.sb-link .badge{display:none}.main{margin-left:60px}.stats-row{grid-template-columns:1fr 1fr}.provider-grid{grid-template-columns:1fr}}\n' +
    '</style>\n</head>\n<body>\n' +
    '<div class="app">\n' +

    // SIDEBAR
    '<div class="sidebar">\n' +
    '  <div class="sb-logo"><div class="icon">N</div><span>Nova API</span></div>\n' +
    '  <div class="sb-nav">\n' +
    '    <div class="sb-section">Overview</div>\n' +
    '    <a class="sb-link active" data-page="dashboard" onclick="switchPage(\'dashboard\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>\n' +
    '      <span>Dashboard</span>\n' +
    '    </a>\n' +
    '    <a class="sb-link" data-page="providers" onclick="switchPage(\'providers\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v6m0 6v6m-7-7H1m22 0h-4m-1.5-7.5L15 7m-6 10l-2.5 2.5M19.5 19.5L17 17M5 5l2.5 2.5"/></svg>\n' +
    '      <span>Providers</span>\n' +
    '      <span class="badge" id="connBadge">0</span>\n' +
    '    </a>\n' +
    '    <div class="sb-section">Management</div>\n' +
    '    <a class="sb-link" data-page="keys" onclick="switchPage(\'keys\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>\n' +
    '      <span>API Keys</span>\n' +
    '    </a>\n' +
    '    <div class="sb-section">Tools</div>\n' +
    '    <a class="sb-link" data-page="playground" onclick="switchPage(\'playground\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>\n' +
    '      <span>Playground</span>\n' +
    '    </a>\n' +
    '    <a class="sb-link" data-page="docs" onclick="switchPage(\'docs\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>\n' +
    '      <span>API Docs</span>\n' +
    '    </a>\n' +
    '  </div>\n' +
    '</div>\n' +

    // MAIN
    '<div class="main">\n' +
    '  <div class="topbar">\n' +
    '    <h2 id="pageTitle">Dashboard</h2>\n' +
    '    <div class="topbar-right">\n' +
    '      <div class="pill"><span class="dot"></span><span id="connCount">0</span> Connected</div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="content">\n' +

    // DASHBOARD
    '    <div class="page active" id="page-dashboard">\n' +
    '      <div class="stats-row" id="statsRow"></div>\n' +
    '      <div class="section-head"><h3>Provider Status</h3></div>\n' +
    '      <div class="provider-grid" id="dashProviders"></div>\n' +
    '    </div>\n' +

    // PROVIDERS
    '    <div class="page" id="page-providers">\n' +
    '      <div class="section-head"><h3>AI Providers</h3><span id="provCountLabel" style="font-size:12px;color:var(--muted)"></span></div>\n' +
    '      <div class="provider-grid" id="providerGrid"></div>\n' +
    '    </div>\n' +

    // KEYS
    '    <div class="page" id="page-keys">\n' +
    '      <div class="section-head"><h3>API Keys</h3><button class="btn btn-primary btn-sm" onclick="generateKey()">+ New Key</button></div>\n' +
    '      <div class="table-wrap"><table><thead><tr><th>Key</th><th>Created</th><th>Calls</th><th>Providers</th><th>Status</th><th>Actions</th></tr></thead>\n' +
    '      <tbody id="keysBody"><tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet.</td></tr></tbody></table></div>\n' +
    '    </div>\n' +

    // PLAYGROUND
    '    <div class="page" id="page-playground">\n' +
    '      <div class="chat-container">\n' +
    '        <div class="chat-header">\n' +
    '          <select id="chatProv"></select>\n' +
    '          <button class="btn btn-outline btn-sm" onclick="newChat()">New Chat</button>\n' +
    '          <button class="btn btn-outline btn-sm" onclick="clearChat()">Clear</button>\n' +
    '        </div>\n' +
    '        <div class="chat-messages" id="chatBox"><div class="msg msg-system">Select a connected provider and start chatting.</div></div>\n' +
    '        <div class="chat-input-wrap">\n' +
    '          <textarea id="chatInput" placeholder="Type a message..." rows="1"></textarea>\n' +
    '          <button class="btn btn-primary" id="sendBtn" onclick="sendMsg()">Send</button>\n' +
    '        </div>\n' +
    '      </div>\n' +
    '    </div>\n' +

    // DOCS
    '    <div class="page" id="page-docs">\n' +
    '      <div class="section-head"><h3>API Reference</h3></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/keys</code></div><div class="desc">Generate a new API key.</div><div class="example">curl -X POST https://your-app.onrender.com/v1/keys</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-get">GET</span> <code>/v1/providers</code></div><div class="desc">List providers with connection status and uptime.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/init</code></div><div class="desc">Connect to a provider (launches browser). Providers: chatgpt, claude, gemini, perplexity.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/chat/:provider</code></div><div class="desc">Send a message. Requires Authorization header.</div><div class="example">curl -X POST https://your-app.onrender.com/v1/chat/chatgpt \\\n  -H "Authorization: Bearer sk-nova-YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"message": "Hello!"}\'\n\n// Response:\n{ "provider": "chatgpt", "model": "ChatGPT",\n  "reply": "Hi there!", "latency": "3200ms" }</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/newchat</code></div><div class="desc">Start a fresh conversation.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-delete">DELETE</span> <code>/v1/keys/:key</code></div><div class="desc">Revoke an API key.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-get">GET</span> <code>/v1/stats</code></div><div class="desc">Platform statistics.</div></div>\n' +
    '    </div>\n' +

    '  </div>\n</div>\n</div>\n' +
    '<div class="toast" id="toast"></div>\n' +

    // JS
    '<script>\n' +
    'var myKey=localStorage.getItem("nova_key")||"",providers={},keys=[];\n' +
    'var titles={dashboard:"Dashboard",providers:"Providers",keys:"API Keys",playground:"Playground",docs:"API Documentation"};\n' +

    'function switchPage(p){\n' +
    '  document.querySelectorAll(".page").forEach(function(e){e.classList.remove("active")});\n' +
    '  document.getElementById("page-"+p).classList.add("active");\n' +
    '  document.querySelectorAll(".sb-link").forEach(function(e){e.classList.remove("active")});\n' +
    '  var l=document.querySelector("[data-page=\\""+p+"\\"]");\n' +
    '  if(l)l.classList.add("active");\n' +
    '  document.getElementById("pageTitle").textContent=titles[p];\n' +
    '  if(p==="keys")loadKeys();\n' +
    '  if(p==="providers"||p==="dashboard")loadProviders();\n' +
    '}\n' +

    'function showToast(m,c){var t=document.getElementById("toast");t.textContent=m;t.style.color=c||"var(--green)";t.style.display="block";clearTimeout(t._t);t._t=setTimeout(function(){t.style.display="none"},3000)}\n' +

    'function copyText(text,btn){navigator.clipboard.writeText(text).then(function(){if(btn){btn.classList.add("copied");btn.textContent="\\u2713";setTimeout(function(){btn.classList.remove("copied");btn.textContent="\\ud83d\\udccb"},1500)}showToast("Copied")}).catch(function(){showToast("Copy failed","var(--red)")})}\n' +

    'function fmtUptime(s){if(s<60)return s+"s";if(s<3600)return Math.floor(s/60)+"m "+(s%60)+"s";return Math.floor(s/3600)+"h "+Math.floor((s%3600)/60)+"m"}\n' +
    'function fmtDate(ts){var d=new Date(ts);return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"})}\n' +

    // LOAD PROVIDERS
    'async function loadProviders(){\n' +
    '  try{\n' +
    '    var res=await fetch("/v1/providers");\n' +
    '    providers=await res.json();\n' +
    '    var conn=0;Object.keys(providers).forEach(function(id){if(providers[id].connected)conn++});\n' +
    '    document.getElementById("connCount").textContent=conn;\n' +
    '    document.getElementById("connBadge").textContent=conn;\n' +
    '    renderCards("dashProviders",true);\n' +
    '    renderCards("providerGrid",false);\n' +
    '    var sel=document.getElementById("chatProv"),cur=sel.value;\n' +
    '    sel.innerHTML="";\n' +
    '    Object.keys(providers).forEach(function(id){var o=document.createElement("option");o.value=id;o.textContent=providers[id].name+(providers[id].connected?" \\u2713":"");sel.appendChild(o)});\n' +
    '    if(cur)sel.value=cur;\n' +
    '  }catch(e){}\n' +
    '}\n' +

    'function renderCards(cid,compact){\n' +
    '  var g=document.getElementById(cid);if(!g)return;\n' +
    '  g.innerHTML="";\n' +
    '  Object.keys(providers).forEach(function(id){\n' +
    '    var p=providers[id],c=document.createElement("div");\n' +
    '    c.className="p-card";\n' +
    '    var isC=p.connected;\n' +
    '    var sClass=isC?"connected":"disconnected";\n' +
    '    var sText=isC?"Connected \\u2022 up "+fmtUptime(p.uptime):"Disconnected";\n' +
    '    c.innerHTML=\'<div class="p-card-head"><div class="p-card-icon" style="background:\'+p.color+\'">\'+p.icon+\'</div><div><div class="p-card-name">\'+p.name+\'</div><div class="p-card-desc">\'+p.desc+\'</div></div></div>\'+\n' +
    '      \'<div class="p-card-status \'+sClass+\'"><span class="status-dot \'+(isC?"on":"off")+\'"></span>\'+sText+\'</div>\'+\n' +
    '      (compact?\'\':\'<div class="p-card-meta">\'+p.requests+\' requests</div><div class="p-card-actions">\'+\n' +
    '        (isC?\'<button class="btn btn-outline btn-sm" onclick="initProv(\\\'\'+id+\'\\\')">Reconnect</button><button class="btn btn-outline btn-sm" onclick="switchPage(\\\'playground\\\')">Chat</button>\':\'<button class="btn btn-primary btn-sm" onclick="initProv(\\\'\'+id+\'\\\')">Connect</button>\')+\'</div>\');\n' +
    '    g.appendChild(c);\n' +
    '  });\n' +
    '  var l=document.getElementById("provCountLabel");if(l)l.textContent=Object.keys(providers).length+" providers";\n' +
    '}\n' +

    // INIT PROVIDER
    'async function initProv(id){\n' +
    '  showToast("Connecting to "+id+"... this may take 15-30s","var(--amber)");\n' +
    '  try{\n' +
    '    var res=await fetch("/v1/providers/"+id+"/init",{method:"POST"});\n' +
    '    var d=await res.json();\n' +
    '    if(d.error)showToast("Error: "+d.error,"var(--red)");\n' +
    '    else showToast(id+" connected!");\n' +
    '  }catch(e){showToast("Failed: "+e.message,"var(--red)")}\n' +
    '  loadProviders();loadStats();\n' +
    '}\n' +

    // STATS
    'async function loadStats(){\n' +
    '  try{\n' +
    '    var res=await fetch("/v1/stats");\n' +
    '    var s=await res.json();\n' +
    '    document.getElementById("statsRow").innerHTML=\n' +
    '      \'<div class="stat-card"><div class="label">Total Requests</div><div class="value">\'+s.totalCalls+\'</div><div class="sub">All time</div></div>\'+\n' +
    '      \'<div class="stat-card"><div class="label">Active Keys</div><div class="value">\'+s.activeKeys+\'</div><div class="sub">\'+s.totalKeys+\' total</div></div>\'+\n' +
    '      \'<div class="stat-card"><div class="label">Connected</div><div class="value">\'+s.connectedProviders+\'</div><div class="sub">of 4 providers</div></div>\'+\n' +
    '      \'<div class="stat-card"><div class="label">Uptime</div><div class="value">\'+fmtUptime(s.uptime)+\'</div><div class="sub">\'+s.errors+\' errors</div></div>\';\n' +
    '  }catch(e){}\n' +
    '}\n' +

    // KEYS
    'async function generateKey(){var r=await fetch("/v1/keys",{method:"POST"});var d=await r.json();myKey=d.key;localStorage.setItem("nova_key",myKey);showToast("Key generated!");loadKeys()}\n' +

    'async function loadKeys(){\n' +
    '  try{\n' +
    '    var res=await fetch("/v1/keys");\n' +
    '    keys=await res.json();\n' +
    '    var b=document.getElementById("keysBody");\n' +
    '    if(!keys.length){b.innerHTML=\'<tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet.</td></tr>\';return}\n' +
    '    b.innerHTML="";\n' +
    '    keys.forEach(function(k){\n' +
    '      var tr=document.createElement("tr");\n' +
    '      var tags=k.providers.map(function(p){var col=providers[p]?providers[p].color:"#555";return \'<span style="background:\'+col+\'22;color:\'+col+\';padding:2px 7px;border-radius:4px;font-size:10px;margin-right:4px">\'+p+\'</span>\'}).join("")||\'<span style="color:#444">\\u2014</span>\';\n' +
    '      tr.innerHTML=\'<td><span class="mono">\'+k.key+\'</span> <button class="copy-btn" onclick="copyText(\\\'\'+k.full+\'\\\',this)">\\ud83d\\udccb</button></td>\'+\n' +
    '        \'<td>\'+fmtDate(new Date(k.created).getTime())+\'</td>\'+\n' +
    '        \'<td style="font-weight:600">\'+k.calls+\'</td>\'+\n' +
    '        \'<td>\'+tags+\'</td>\'+\n' +
    '        \'<td>\'+(k.revoked?\'<span style="color:var(--red)">Revoked</span>\':\'<span style="color:var(--green)">Active</span>\')+\'</td>\'+\n' +
    '        \'<td>\'+(k.revoked?\'\\u2014\':\'<button class="btn btn-danger btn-xs" onclick="revokeKey(\\\'\'+k.full+\'\\\')">Revoke</button>\')+\'</td>\';\n' +
    '      b.appendChild(tr);\n' +
    '    });\n' +
    '  }catch(e){}\n' +
    '}\n' +

    'async function revokeKey(k){if(!confirm("Revoke this key?"))return;await fetch("/v1/keys/"+k,{method:"DELETE"});showToast("Revoked");loadKeys();loadStats()}\n' +

    // PLAYGROUND
    'var chatBox,chatInput,sendBtn;\n' +
    'document.addEventListener("DOMContentLoaded",function(){\n' +
    '  chatBox=document.getElementById("chatBox");\n' +
    '  chatInput=document.getElementById("chatInput");\n' +
    '  sendBtn=document.getElementById("sendBtn");\n' +
    '  chatInput.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg()}});\n' +
    '  chatInput.addEventListener("input",function(){chatInput.style.height="auto";chatInput.style.height=Math.min(chatInput.scrollHeight,120)+"px"});\n' +
    '});\n' +

    'function addMsg(text,cls,meta){\n' +
    '  var d=document.createElement("div");d.className="msg "+cls;\n' +
    '  if(cls==="msg-bot"||cls==="msg-user"){\n' +
    '    d.innerHTML=text.replace(/</g,"&lt;").replace(/>/g,"&gt;")+\' <button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button>\'+(meta?\'<div class="msg-meta">\'+meta+\'</div>\':\'\');\n' +
    '  }else{d.textContent=text}\n' +
    '  chatBox.appendChild(d);chatBox.scrollTop=chatBox.scrollHeight;return d;\n' +
    '}\n' +

    'async function sendMsg(){\n' +
    '  if(!myKey){showToast("Generate an API key first","var(--red)");switchPage("keys");return}\n' +
    '  var text=chatInput.value.trim();if(!text)return;\n' +
    '  var prov=document.getElementById("chatProv").value;\n' +
    '  addMsg(text,"msg-user");chatInput.value="";chatInput.style.height="44px";\n' +
    '  sendBtn.disabled=true;\n' +
    '  var think=addMsg("","msg-bot");\n' +
    '  think.innerHTML=\'<span class="spinner"></span> Querying \'+prov+\'...\';\n' +
    '  try{\n' +
    '    var res=await fetch("/v1/chat/"+prov,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+myKey},body:JSON.stringify({message:text})});\n' +
    '    var d=await res.json();\n' +
    '    if(d.error){\n' +
    '      think.className="msg msg-error";\n' +
    '      think.innerHTML="Error: "+d.error.replace(/</g,"&lt;")+\' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button>\';\n' +
    '    }else{\n' +
    '      think.className="msg msg-bot";\n' +
    '      think.innerHTML=d.reply.replace(/</g,"&lt;").replace(/>/g,"&gt;")+\' <button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button><div class="msg-meta">\'+d.model+" \\u00b7 "+d.latency+\'</div>\';\n' +
    '    }\n' +
    '  }catch(e){think.className="msg msg-error";think.innerHTML="Network error: "+e.message+\' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button>\'}\n' +
    '  sendBtn.disabled=false;chatInput.focus();loadStats();\n' +
    '}\n' +

    'async function newChat(){var p=document.getElementById("chatProv").value;await fetch("/v1/providers/"+p+"/newchat",{method:"POST"});clearChat();addMsg("New chat on "+p,"msg-system")}\n' +
    'function clearChat(){chatBox.innerHTML=""}\n' +

    'loadProviders();loadStats();loadKeys();setInterval(function(){loadProviders();loadStats()},15000);\n' +
    '</script>\n</body>\n</html>';
}

// ═══════════════════════════════════════
// START
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('');
    console.log('  Nova API Gateway v2.0 (Playwright + Firefox)');
    console.log('  http://localhost:' + PORT);
    console.log('  Providers: ' + Object.keys(PROVIDERS).join(', '));
    console.log('');
});
