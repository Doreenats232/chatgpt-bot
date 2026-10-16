// chatgpt-bot.js
// Universal AI API Gateway — browser-automates free AI sites and exposes them as APIs
// npm install express puppeteer-extra puppeteer-extra-plugin-stealth puppeteer

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
const COOKIES_DIR = path.join(__dirname, 'cookies');
if (!fs.existsSync(COOKIES_DIR)) fs.mkdirSync(COOKIES_DIR);

// ============================================================
// PROVIDER CONFIG
// ============================================================
const PROVIDERS = {
    chatgpt: {
        name: 'ChatGPT',
        url: 'https://chatgpt.com/',
        color: '#10a37f',
        icon: 'G'
    },
    claude: {
        name: 'Claude',
        url: 'https://claude.ai/new',
        color: '#d97706',
        icon: 'C'
    },
    gemini: {
        name: 'Gemini',
        url: 'https://gemini.google.com/app',
        color: '#4285f4',
        icon: 'Ge'
    },
    perplexity: {
        name: 'Perplexity',
        url: 'https://www.perplexity.ai/',
        color: '#20b2aa',
        icon: 'P'
    }
};

// ============================================================
// API KEY MANAGEMENT
// ============================================================
function generateKey() {
    const key = 'sk-nova-' + crypto.randomBytes(24).toString('hex');
    apiKeys.set(key, {
        created: new Date().toISOString(),
        calls: 0,
        providers: []
    });
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
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--window-size=1280,900'
        ],
        defaultViewport: { width: 1280, height: 900 }
    });

    const page = await browsers[provider].newPage();

    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    const cookieFile = path.join(COOKIES_DIR, provider + '.json');
    if (fs.existsSync(cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(cookieFile));
        await page.setCookie(...cookies);
        console.log('[*] Loaded cookies for ' + provider);
    }

    await page.goto(PROVIDERS[provider].url, { waitUntil: 'networkidle2', timeout: 60000 });
    pages[provider] = page;
    busy[provider] = false;

    await saveCookies(provider);
    console.log('[*] ' + provider + ' browser ready');
}

async function saveCookies(provider) {
    if (!pages[provider]) return;
    const cookies = await pages[provider].cookies();
    const cookieFile = path.join(COOKIES_DIR, provider + '.json');
    fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// HUMAN-LIKE TYPING
// ============================================================
async function humanType(page, text) {
    const editor = await page.waitForSelector(
        '#prompt-textarea, div[contenteditable="true"], textarea, [role="textbox"]',
        { timeout: 10000 }
    );
    await editor.click();
    await sleep(300 + Math.random() * 500);

    for (const char of text) {
        await page.keyboard.type(char, { delay: 25 + Math.random() * 100 });
        if (Math.random() < 0.03) await sleep(150 + Math.random() * 300);
    }
}

// ============================================================
// PROVIDER-SPECIFIC SEND & RECEIVE
// ============================================================

async function sendChatGPT(page, message) {
    const beforeCount = await page.evaluate(() => {
        return document.querySelectorAll('div[data-message-author-role="assistant"]').length;
    });

    await humanType(page, message);
    await sleep(200 + Math.random() * 300);

    try {
        const sendBtn = await page.waitForSelector(
            'button[data-testid="send-button"], button[aria-label="Send prompt"]',
            { timeout: 3000 }
        );
        await sendBtn.click();
    } catch {
        await page.keyboard.press('Enter');
    }

    await page.waitForFunction(
        (count) => document.querySelectorAll('div[data-message-author-role="assistant"]').length > count,
        { timeout: 120000 },
        beforeCount
    );

    return await waitForStableResponse(page, () => {
        return page.evaluate(() => {
            const msgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
            const last = msgs[msgs.length - 1];
            return last ? last.innerText.trim() : '';
        });
    });
}

async function sendClaude(page, message) {
    await humanType(page, message);
    await sleep(200 + Math.random() * 300);

    try {
        const sendBtn = await page.waitForSelector(
            'button[aria-label="Send Message"], button[aria-label="Send"], button:has(svg)',
            { timeout: 3000 }
        );
        await sendBtn.click();
    } catch {
        await page.keyboard.press('Enter');
    }

    await sleep(3000);

    return await waitForStableResponse(page, () => {
        return page.evaluate(() => {
            const msgs = document.querySelectorAll('[data-is-streaming], .font-claude-message, [class*="message"]');
            const all = document.querySelectorAll('div[class*="Message"]');
            const last = all[all.length - 1];
            return last ? last.innerText.trim() : '';
        });
    });
}

async function sendGemini(page, message) {
    await humanType(page, message);
    await sleep(200 + Math.random() * 300);

    try {
        const sendBtn = await page.waitForSelector(
            'button[aria-label="Send message"], .send-button, button.send',
            { timeout: 3000 }
        );
        await sendBtn.click();
    } catch {
        await page.keyboard.press('Enter');
    }

    await sleep(3000);

    return await waitForStableResponse(page, () => {
        return page.evaluate(() => {
            const msgs = document.querySelectorAll('message-content, .model-response-text, [class*="response"]');
            const last = msgs[msgs.length - 1];
            return last ? last.innerText.trim() : '';
        });
    });
}

async function sendPerplexity(page, message) {
    await humanType(page, message);
    await sleep(200 + Math.random() * 300);

    try {
        const sendBtn = await page.waitForSelector(
            'button[aria-label="Submit"], button[type="submit"]',
            { timeout: 3000 }
        );
        await sendBtn.click();
    } catch {
        await page.keyboard.press('Enter');
    }

    await sleep(3000);

    return await waitForStableResponse(page, () => {
        return page.evaluate(() => {
            const msgs = document.querySelectorAll('.prose, [class*="answer"], [class*="response"]');
            const last = msgs[msgs.length - 1];
            return last ? last.innerText.trim() : '';
        });
    });
}

// Wait for response to stabilize (no more streaming)
async function waitForStableResponse(page, getText) {
    let lastText = '';
    let stableCount = 0;

    while (stableCount < 3) {
        await sleep(1000);
        try {
            const currentText = await getText();
            const stopBtn = await page.$(
                'button[aria-label="Stop generating"], button[aria-label="Stop"], [data-testid="stop-button"]'
            );

            if (currentText === lastText && !stopBtn && currentText.length > 0) {
                stableCount++;
            } else {
                stableCount = 0;
            }
            lastText = currentText;
        } catch {
            stableCount = 0;
        }
    }
    return lastText;
}

// Router to correct provider sender
const SENDERS = {
    chatgpt: sendChatGPT,
    claude: sendClaude,
    gemini: sendGemini,
    perplexity: sendPerplexity
};

// ============================================================
// ROUTES
// ============================================================

// Landing page
app.get('/', (req, res) => {
    res.send(HTML);
});

// List providers
app.get('/v1/providers', (req, res) => {
    const list = {};
    for (const [k, v] of Object.entries(PROVIDERS)) {
        list[k] = {
            name: v.name,
            status: pages[k] ? 'connected' : 'disconnected',
            color: v.color
        };
    }
    res.json(list);
});

// Generate API key
app.post('/v1/keys', (req, res) => {
    const key = generateKey();
    res.json({
        key: key,
        message: 'Save this key — it wont be shown again.',
        usage: 'Authorization: Bearer ' + key
    });
});

// Validate API key
app.get('/v1/keys/validate', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing API key' });
    }
    const key = auth.replace('Bearer ', '');
    const data = apiKeys.get(key);
    if (!data) return res.status(403).json({ error: 'Invalid API key' });
    res.json({ valid: true, calls: data.calls, created: data.created });
});

// Chat endpoint — the main one users hit
app.post('/v1/chat/:provider', async (req, res) => {
    const { provider } = req.params;
    const { message } = req.body;

    // Validate API key
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing API key. Generate one at /' });
    }
    const key = auth.replace('Bearer ', '');
    const keyData = apiKeys.get(key);
    if (!keyData) return res.status(403).json({ error: 'Invalid API key' });

    // Validate provider
    if (!PROVIDERS[provider]) {
        return res.status(400).json({
            error: 'Unknown provider',
            available: Object.keys(PROVIDERS)
        });
    }

    // Check if browser is running
    if (!pages[provider]) {
        return res.status(503).json({
            error: provider + ' is not connected. Visit / to initialize it.'
        });
    }

    // Check if busy
    if (busy[provider]) {
        return res.status(429).json({
            error: provider + ' is busy. Try again in a moment.'
        });
    }

    if (!message) return res.status(400).json({ error: 'No message provided.' });

    busy[provider] = true;
    try {
        const reply = await SENDERS[provider](pages[provider], message);
        await saveCookies(provider);

        keyData.calls++;
        if (!keyData.providers.includes(provider)) keyData.providers.push(provider);

        res.json({
            provider: provider,
            model: PROVIDERS[provider].name,
            reply: reply,
            usage: { key_calls: keyData.calls }
        });
    } catch (err) {
        console.error('[!] ' + provider + ' error:', err.message);
        res.status(500).json({ error: err.message });
    } finally {
        busy[provider] = false;
    }
});

// Initialize a provider browser
app.post('/v1/providers/:provider/init', async (req, res) => {
    const { provider } = req.params;
    if (!PROVIDERS[provider]) {
        return res.status(400).json({ error: 'Unknown provider' });
    }
    try {
        await launchBrowser(provider);
        res.json({ status: 'connected', provider: provider });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// New chat for a provider
app.post('/v1/providers/:provider/newchat', async (req, res) => {
    const { provider } = req.params;
    if (!pages[provider]) return res.status(503).json({ error: 'Not connected' });
    try {
        await pages[provider].goto(PROVIDERS[provider].url, { waitUntil: 'networkidle2', timeout: 30000 });
        res.json({ ok: true });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ============================================================
// HTML FRONTEND
// ============================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova API — Universal AI Gateway</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#08080c;color:#e0e0e0;min-height:100vh}
a{color:#1CB7FF;text-decoration:none}

/* NAV */
nav{background:#0c0c12;border-bottom:1px solid #1a1a2a;padding:14px 32px;display:flex;align-items:center;gap:12px}
nav .logo{width:36px;height:36px;background:linear-gradient(135deg,#1CB7FF,#2FF58B);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:18px;color:#08080c}
nav h1{font-size:20px;font-weight:700;background:linear-gradient(90deg,#1CB7FF,#2FF58B);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
nav .links{margin-left:auto;display:flex;gap:20px}
nav .links a{font-size:14px;color:#888;transition:color .2s}
nav .links a:hover{color:#fff}

/* HERO */
.hero{text-align:center;padding:80px 24px 40px;max-width:700px;margin:0 auto}
.hero h2{font-size:42px;font-weight:800;line-height:1.15;background:linear-gradient(90deg,#fff,#aaa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:16px}
.hero p{font-size:17px;color:#777;line-height:1.6}

/* PROVIDERS GRID */
.providers-section{max-width:900px;margin:40px auto;padding:0 24px}
.providers-section h3{font-size:22px;font-weight:700;margin-bottom:20px}
.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}
.provider-card{background:#111118;border:1px solid #1f1f2e;border-radius:16px;padding:24px;text-align:center;cursor:pointer;transition:all .25s}
.provider-card:hover{border-color:#2a2a4a;transform:translateY(-3px)}
.provider-card .icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:20px;color:#000;margin:0 auto 12px}
.provider-card .name{font-size:16px;font-weight:600;margin-bottom:6px}
.provider-card .status{font-size:12px;padding:3px 10px;border-radius:8px;display:inline-block}
.status-connected{background:#10a37f22;color:#10a37f}
.status-disconnected{background:#ef444422;color:#ef4444}

/* API KEY SECTION */
.key-section{max-width:600px;margin:40px auto;padding:0 24px;text-align:center}
.key-section h3{font-size:22px;font-weight:700;margin-bottom:12px}
.key-section p{font-size:14px;color:#666;margin-bottom:20px}
.key-box{background:#111118;border:1px solid #1f1f2e;border-radius:12px;padding:16px;font-family:monospace;font-size:13px;word-break:break-all;margin-bottom:16px;min-height:50px;display:flex;align-items:center;justify-content:center;color:#555}
.key-box.has-key{color:#2FF58B;border-color:#2FF58B33}
.btn{padding:12px 28px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:linear-gradient(135deg,#1CB7FF,#2FF58B);color:#000}
.btn-primary:hover{opacity:.85}
.btn-sm{padding:8px 16px;font-size:12px;border-radius:8px}
.btn-outline{background:transparent;border:1px solid #2a2a4a;color:#ccc}
.btn-outline:hover{border-color:#1CB7FF;color:#1CB7FF}

/* PLAYGROUND */
.playground{max-width:800px;margin:40px auto;padding:0 24px}
.playground h3{font-size:22px;font-weight:700;margin-bottom:20px}
.pg-bar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
.pg-bar select{background:#111118;border:1px solid #1f1f2e;color:#e0e0e0;padding:10px 14px;border-radius:10px;font-size:14px;outline:none;cursor:pointer}
.chat-box{background:#0e0e14;border:1px solid #1f1f2e;border-radius:16px;min-height:300px;max-height:500px;overflow-y:auto;padding:20px;margin-bottom:16px}
.msg{margin-bottom:14px;max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word}
.msg-user{background:linear-gradient(135deg,#1CB7FF22,#2FF58B11);border:1px solid #1CB7FF33;margin-left:auto;text-align:right;border-bottom-right-radius:4px}
.msg-bot{background:#15151f;border:1px solid #1f1f2e;border-bottom-left-radius:4px}
.msg-system{text-align:center;color:#555;font-size:12px;font-style:italic;max-width:100%}
.msg-error{text-align:center;color:#ef4444;font-size:13px;max-width:100%}
.input-row{display:flex;gap:10px}
.input-row textarea{flex:1;background:#111118;border:1px solid #1f1f2e;border-radius:12px;padding:12px 16px;color:#e0e0e0;font-size:14px;font-family:inherit;resize:none;height:48px;outline:none;transition:border-color .2s}
.input-row textarea:focus{border-color:#1CB7FF}

/* API DOCS */
.docs{max-width:800px;margin:60px auto;padding:0 24px 80px}
.docs h3{font-size:22px;font-weight:700;margin-bottom:20px}
.endpoint{background:#111118;border:1px solid #1f1f2e;border-radius:12px;padding:16px;margin-bottom:12px;font-size:13px;line-height:1.8}
.endpoint .method{display:inline-block;padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px;margin-right:8px}
.method-get{background:#10a37f22;color:#10a37f}
.method-post{background:#2563eb22;color:#60a5fa}
.endpoint code{background:#1a1a28;padding:2px 6px;border-radius:4px;font-size:12px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid #1CB7FF44;border-top:2px solid #1CB7FF;border-radius:50%;animation:spin .7s linear infinite;margin-right:6px;vertical-align:middle}
@keyframes spin{to{transform:rotate(360deg)}}

@media(max-width:600px){
.hero h2{font-size:28px}
.providers-grid{grid-template-columns:1fr 1fr}
nav .links{display:none}
}
</style>
</head>
<body>

<nav>
    <div class="logo">N</div>
    <h1>Nova API</h1>
    <div class="links">
        <a href="#providers">Providers</a>
        <a href="#playground">Playground</a>
        <a href="#docs">API Docs</a>
    </div>
</nav>

<section class="hero">
    <h2>One API Key. Every AI.</h2>
    <p>Connect to ChatGPT, Claude, Gemini, and Perplexity through a single unified API. No subscriptions needed — we run the browsers, you get the API.</p>
</section>

<section class="providers-section" id="providers">
    <h3>AI Providers</h3>
    <div class="providers-grid" id="providersGrid"></div>
</section>

<section class="key-section">
    <h3>Your API Key</h3>
    <p>Generate a key to start making API calls</p>
    <div class="key-box" id="keyBox">No key generated yet</div>
    <button class="btn btn-primary" onclick="generateKey()">Generate API Key</button>
</section>

<section class="playground" id="playground">
    <h3>Playground</h3>
    <div class="pg-bar">
        <select id="providerSelect"></select>
        <button class="btn btn-outline btn-sm" onclick="newChat()">New Chat</button>
    </div>
    <div class="chat-box" id="chatBox">
        <div class="msg msg-system">Select a provider and start chatting. This runs through the actual AI website.</div>
    </div>
    <div class="input-row">
        <textarea id="msgInput" placeholder="Type a message..." rows="1"></textarea>
        <button class="btn btn-primary" id="sendBtn" onclick="sendMsg()">Send</button>
    </div>
</section>

<section class="docs" id="docs">
    <h3>API Documentation</h3>

    <div class="endpoint">
        <span class="method method-get">GET</span> <code>/v1/providers</code><br>
        List all available AI providers and their connection status
    </div>

    <div class="endpoint">
        <span class="method method-post">POST</span> <code>/v1/providers/:provider/init</code><br>
        Initialize a provider's browser (connect it). Replace <code>:provider</code> with chatgpt, claude, gemini, or perplexity
    </div>

    <div class="endpoint">
        <span class="method method-post">POST</span> <code>/v1/keys</code><br>
        Generate a new API key
    </div>

    <div class="endpoint">
        <span class="method method-post">POST</span> <code>/v1/chat/:provider</code><br>
        Send a message. Header: <code>Authorization: Bearer YOUR_KEY</code><br>
        Body: <code>{"message": "Hello"}</code><br>
        Returns: <code>{"provider": "chatgpt", "reply": "..."}</code>
    </div>

    <div class="endpoint">
        <span class="method method-post">POST</span> <code>/v1/providers/:provider/newchat</code><br>
        Start a fresh conversation on a provider
    </div>
</section>

<script>
// STATE
let myKey = localStorage.getItem('nova_key') || '';
if (myKey) {
    document.getElementById('keyBox').textContent = myKey;
    document.getElementById('keyBox').classList.add('has-key');
}

// LOAD PROVIDERS
async function loadProviders() {
    try {
        const res = await fetch('/v1/providers');
        const data = await res.json();
        const grid = document.getElementById('providersGrid');
        const select = document.getElementById('providerSelect');
        grid.innerHTML = '';
        select.innerHTML = '';

        for (const [id, p] of Object.entries(data)) {
            const card = document.createElement('div');
            card.className = 'provider-card';
            card.onclick = () => initProvider(id);
            card.innerHTML = '<div class="icon" style="background:' + p.color + '">' + p.name[0] + '</div>' +
                '<div class="name">' + p.name + '</div>' +
                '<span class="status ' + (p.status === 'connected' ? 'status-connected' : 'status-disconnected') + '">' +
                p.status + '</span>';
            grid.appendChild(card);

            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = p.name;
            select.appendChild(opt);
        }
    } catch(e) {
        console.error(e);
    }
}

async function initProvider(id) {
    const grid = document.getElementById('providersGrid');
    const cards = grid.querySelectorAll('.provider-card');
    for (const c of cards) {
        if (c.querySelector('.name').textContent.toLowerCase().replace(/[^a-z]/g,'') === id ||
            c.onclick.toString().includes(id)) {
            c.querySelector('.status').textContent = 'connecting...';
            c.querySelector('.status').className = 'status status-disconnected';
        }
    }

    try {
        const res = await fetch('/v1/providers/' + id + '/init', { method: 'POST' });
        const data = await res.json();
        if (data.error) {
            alert('Error: ' + data.error);
        } else {
            alert(id + ' connected! Browser window opened — log in if needed.');
        }
    } catch(e) {
        alert('Failed: ' + e.message);
    }
    loadProviders();
}

// API KEY
async function generateKey() {
    const res = await fetch('/v1/keys', { method: 'POST' });
    const data = await res.json();
    myKey = data.key;
    localStorage.setItem('nova_key', myKey);
    const box = document.getElementById('keyBox');
    box.textContent = myKey;
    box.classList.add('has-key');
}

// PLAYGROUND
const chatBox = document.getElementById('chatBox');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');

msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});
msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});

function addMsg(text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    chatBox.appendChild(div);
    chatBox.scrollTop = chatBox.scrollHeight;
    return div;
}

async function sendMsg() {
    if (!myKey) { alert('Generate an API key first'); return; }
    const text = msgInput.value.trim();
    if (!text) return;

    const provider = document.getElementById('providerSelect').value;
    addMsg(text, 'msg-user');
    msgInput.value = '';
    msgInput.style.height = '48px';

    sendBtn.disabled = true;
    const thinking = addMsg('', 'msg-bot');
    thinking.innerHTML = '<span class="spinner"></span> Querying ' + provider + '...';

    try {
        const res = await fetch('/v1/chat/' + provider, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + myKey
            },
            body: JSON.stringify({ message: text })
        });
        const data = await res.json();
        if (data.error) {
            thinking.className = 'msg msg-error';
            thinking.textContent = 'Error: ' + data.error;
        } else {
            thinking.className = 'msg msg-bot';
            thinking.textContent = data.reply || 'No response.';
        }
    } catch(e) {
        thinking.className = 'msg msg-error';
        thinking.textContent = 'Error: ' + e.message;
    }

    sendBtn.disabled = false;
    msgInput.focus();
}

async function newChat() {
    const provider = document.getElementById('providerSelect').value;
    await fetch('/v1/providers/' + provider + '/newchat', { method: 'POST' });
    chatBox.innerHTML = '<div class="msg msg-system">New conversation started on ' + provider + '</div>';
}

loadProviders();
setInterval(loadProviders, 30000);
</script>
</body>
</html>`;

// ============================================================
// START
// ============================================================

const PORT = 3000;

app.listen(PORT, () => {
    console.log('');
    console.log('==========================================');
    console.log('  Nova API Gateway — port ' + PORT);
    console.log('  Open http://localhost:' + PORT);
    console.log('==========================================');
    console.log('');
});
