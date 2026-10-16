// chatgpt-bot.js
// npm init -y && npm install express puppeteer-extra puppeteer-extra-plugin-stealth puppeteer

const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

let browser = null;
let page = null;
let busy = false;
const COOKIE_FILE = path.join(__dirname, 'cookies.json');

// ============================================================
// BROWSER MANAGEMENT
// ============================================================

async function launchBrowser() {
    browser = await puppeteer.launch({
        headless: false, // set to 'new' after first login
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1280,900'
        ],
        defaultViewport: { width: 1280, height: 900 }
    });

    page = await browser.newPage();

    // Extra stealth
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = { runtime: {} };
    });

    // Load cookies if saved
    if (fs.existsSync(COOKIE_FILE)) {
        const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE));
        await page.setCookie(...cookies);
        console.log('[*] Loaded saved cookies');
    }

    await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[*] ChatGPT loaded. If not logged in, log in manually in the browser window.');

    // Save cookies after navigation
    await saveCookies();
}

async function saveCookies() {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
}

// ============================================================
// HUMAN-LIKE TYPING
// ============================================================

async function humanType(text) {
    // Find the contenteditable div (ChatGPT's ProseMirror editor)
    const editor = await page.waitForSelector('#prompt-textarea, div[contenteditable="true"]', { timeout: 10000 });
    await editor.click();
    await sleep(300 + Math.random() * 500);

    for (const char of text) {
        await page.keyboard.type(char, { delay: 30 + Math.random() * 120 });
        // Occasional pause like a human thinking
        if (Math.random() < 0.03) await sleep(200 + Math.random() * 400);
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// SEND MESSAGE & SCRAPE RESPONSE
// ============================================================

async function sendAndReceive(message) {
    // Count current assistant messages
    const beforeCount = await page.evaluate(() => {
        return document.querySelectorAll('div[data-message-author-role="assistant"]').length;
    });

    // Type the message
    await humanType(message);
    await sleep(200 + Math.random() * 300);

    // Click send button or press Enter
    try {
        const sendBtn = await page.waitForSelector(
            'button[data-testid="send-button"], button[aria-label="Send prompt"]',
            { timeout: 3000 }
        );
        await sendBtn.click();
    } catch {
        await page.keyboard.press('Enter');
    }

    console.log('[*] Message sent, waiting for response...');

    // Wait for new assistant message to appear
    await page.waitForFunction(
        (count) => {
            return document.querySelectorAll('div[data-message-author-role="assistant"]').length > count;
        },
        { timeout: 120000 },
        beforeCount
    );

    // Wait for response to finish streaming
    // Detect completion: no more "stop" button + text stabilizes
    let lastText = '';
    let stableCount = 0;

    while (stableCount < 3) {
        await sleep(800);

        const currentText = await page.evaluate(() => {
            const msgs = document.querySelectorAll('div[data-message-author-role="assistant"]');
            const last = msgs[msgs.length - 1];
            return last ? last.innerText.trim() : '';
        });

        // Check if stop button is gone (streaming finished)
        const stopBtn = await page.$('button[aria-label="Stop generating"], button[data-testid="stop-button"]');

        if (currentText === lastText && !stopBtn && currentText.length > 0) {
            stableCount++;
        } else {
            stableCount = 0;
        }

        lastText = currentText;
    }

    // Save cookies after interaction
    await saveCookies();

    return lastText;
}

// ============================================================
// HTML FRONTEND
// ============================================================

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChatGPT Bridge</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d0d0d;
    color: #e0e0e0;
    height: 100vh;
    display: flex;
    flex-direction: column;
}
header {
    background: linear-gradient(135deg, #1a1a2e, #16213e);
    padding: 16px 24px;
    border-bottom: 1px solid #2a2a4a;
    display: flex;
    align-items: center;
    gap: 12px;
}
header .logo {
    width: 32px; height: 32px;
    background: linear-gradient(135deg, #10a37f, #1a7f5a);
    border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 16px; color: #fff;
}
header h1 { font-size: 18px; font-weight: 600; }
header .status {
    margin-left: auto;
    padding: 4px 12px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
}
.status.ready { background: #10a37f22; color: #10a37f; }
.status.busy { background: #f59e0b22; color: #f59e0b; }
.status.error { background: #ef444422; color: #ef4444; }

#chat {
    flex: 1;
    overflow-y: auto;
    padding: 24px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.msg {
    max-width: 75%;
    padding: 12px 16px;
    border-radius: 16px;
    line-height: 1.6;
    font-size: 14px;
    white-space: pre-wrap;
    word-wrap: break-word;
}
.msg.user {
    align-self: flex-end;
    background: linear-gradient(135deg, #2563eb, #3b82f6);
    color: #fff;
    border-bottom-right-radius: 4px;
}
.msg.bot {
    align-self: flex-start;
    background: #1e1e2e;
    border: 1px solid #2a2a3a;
    border-bottom-left-radius: 4px;
}
.msg.system {
    align-self: center;
    background: none;
    color: #666;
    font-size: 12px;
    font-style: italic;
}
.msg.error {
    align-self: center;
    background: #ef444422;
    color: #ef4444;
    border: 1px solid #ef444444;
}

#input-area {
    padding: 16px 24px;
    background: #111;
    border-top: 1px solid #2a2a2a;
    display: flex;
    gap: 12px;
}
#input-area textarea {
    flex: 1;
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 12px;
    padding: 12px 16px;
    color: #e0e0e0;
    font-size: 14px;
    font-family: inherit;
    resize: none;
    height: 48px;
    outline: none;
    transition: border-color 0.2s;
}
#input-area textarea:focus {
    border-color: #10a37f;
}
#input-area button {
    background: linear-gradient(135deg, #10a37f, #1a7f5a);
    border: none;
    border-radius: 12px;
    color: #fff;
    padding: 0 24px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s;
}
#input-area button:hover { opacity: 0.85; }
#input-area button:disabled { opacity: 0.4; cursor: not-allowed; }

.spinner {
    display: inline-block;
    width: 16px; height: 16px;
    border: 2px solid #10a37f44;
    border-top: 2px solid #10a37f;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin-right: 8px;
    vertical-align: middle;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<header>
    <div class="logo">G</div>
    <h1>ChatGPT Bridge</h1>
    <span class="status ready" id="status">Ready</span>
</header>

<div id="chat">
    <div class="msg system">Messages sent through this bridge go to the real ChatGPT website via browser automation.</div>
</div>

<div id="input-area">
    <textarea id="msg" placeholder="Type a message..." rows="1"></textarea>
    <button id="send" onclick="send()">Send</button>
</div>

<script>
const chat = document.getElementById('chat');
const msgInput = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const statusEl = document.getElementById('status');

msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
    }
});

msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
});

function addMsg(text, cls) {
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
}

function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'status ' + cls;
}

async function send() {
    const text = msgInput.value.trim();
    if (!text) return;

    addMsg(text, 'user');
    msgInput.value = '';
    msgInput.style.height = '48px';

    sendBtn.disabled = true;
    setStatus('Generating...', 'busy');

    const thinking = addMsg('Thinking...', 'bot');
    thinking.innerHTML = '<span class="spinner"></span> Thinking...';

    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text })
        });

        const data = await res.json();

        if (data.error) {
            thinking.className = 'msg error';
            thinking.textContent = 'Error: ' + data.error;
        } else {
            thinking.className = 'msg bot';
            thinking.textContent = data.reply || 'No response received.';
        }
    } catch (err) {
        thinking.className = 'msg error';
        thinking.textContent = 'Network error: ' + err.message;
    }

    setStatus('Ready', 'ready');
    sendBtn.disabled = false;
    msgInput.focus();
}
</script>
</body>
</html>`;

// ============================================================
// ROUTES
// ============================================================

app.get('/', (req, res) => {
    res.send(HTML);
});

// Check if browser is logged in
app.get('/api/status', async (req, res) => {
    if (!page) return res.json({ status: 'not_started' });
    try {
        const url = page.url();
        const loggedIn = !url.includes('/auth/login') && !url.includes('auth0');
        res.json({ status: loggedIn ? 'ready' : 'needs_login', url });
    } catch {
        res.json({ status: 'error' });
    }
});

// Send a message
app.post('/api/chat', async (req, res) => {
    if (busy) return res.json({ error: 'Bot is busy, wait for current response.' });
    if (!page) return res.json({ error: 'Browser not started. Visit /api/init first.' });

    const { message } = req.body;
    if (!message) return res.json({ error: 'No message provided.' });

    busy = true;
    try {
        const reply = await sendAndReceive(message);
        res.json({ reply });
    } catch (err) {
        console.error('[!] Error:', err.message);
        res.json({ error: err.message });
    } finally {
        busy = false;
    }
});

// New chat
app.get('/api/newchat', async (req, res) => {
    if (!page) return res.json({ error: 'Browser not started.' });
    try {
        await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 30000 });
        res.json({ ok: true });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ============================================================
// START
// ============================================================

const PORT = 3000;

app.listen(PORT, async () => {
    console.log(`\n========================================`);
    console.log(`  ChatGPT Bridge running on port ${PORT}`);
    console.log(`  Open http://localhost:${PORT}`);
    console.log(`========================================\n`);

    console.log('[*] Launching browser...');
    try {
        await launchBrowser();
        console.log('[*] Browser ready. Log into ChatGPT if needed.');
        console.log('[*] Once logged in, start chatting from the web UI.\n');
    } catch (err) {
        console.error('[!] Failed to launch browser:', err.message);
    }
});
