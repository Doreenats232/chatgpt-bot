// ============================================
//  NOVA API GATEWAY v3
//  Universal AI Gateway with Browser View
// ============================================

const express = require('express');
const { firefox } = require('playwright');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// ====== PROVIDERS ======
const PROVIDERS = {
  chatgpt:    { name: 'ChatGPT',    company: 'OpenAI GPT-4o',       color: '#10a37f', icon: 'G',  url: 'https://chatgpt.com' },
  claude:     { name: 'Claude',     company: 'Anthropic Claude 3.5', color: '#d97706', icon: 'C',  url: 'https://claude.ai/new' },
  gemini:     { name: 'Gemini',     company: 'Google Gemini Pro',    color: '#4285f4', icon: 'Ge', url: 'https://gemini.google.com/app' },
  perplexity: { name: 'Perplexity', company: 'Perplexity AI',        color: '#20b2aa', icon: 'P',  url: 'https://www.perplexity.ai' }
};

// ====== STATE ======
let browser = null;
const pages = {};
const apiKeys = {};
const stats = { totalRequests: 0, providers: {} };
Object.keys(PROVIDERS).forEach(id => {
  stats.providers[id] = { requests: 0, lastUsed: null, status: 'disconnected' };
});

// ====== SESSIONS ======
function loadSession(id) {
  try {
    const f = path.join(SESSIONS_DIR, id + '.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch (e) { return null; }
}
function saveSession(id, state) {
  try { fs.writeFileSync(path.join(SESSIONS_DIR, id + '.json'), JSON.stringify(state)); } catch (e) {}
}

// ====== BROWSER ======
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('Launching Firefox...');
  browser = await firefox.launch({ headless: true, args: ['--no-sandbox'] });
  browser.on('disconnected', () => {
    browser = null;
    Object.keys(pages).forEach(id => { pages[id] = null; });
    console.log('Browser disconnected');
  });
  console.log('Firefox launched');
  return browser;
}

async function initProvider(id) {
  const config = PROVIDERS[id];
  if (!config) throw new Error('Unknown provider');
  if (pages[id]) { try { await pages[id].context.close(); } catch (e) {} }
  const b = await getBrowser();
  const saved = loadSession(id);
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ...(saved ? { storageState: saved } : {})
  });
  const page = await ctx.newPage();
  try { await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch (e) {}
  await page.waitForTimeout(3000);
  pages[id] = { page, context: ctx, loggedIn: false };
  const state = await detectState(id);
  pages[id].loggedIn = state.state === 'connected';
  if (pages[id].loggedIn) { saveSession(id, await ctx.storageState()); stats.providers[id].status = 'connected'; }
  return { ...state, screenshot: await getScreenshot(id) };
}

async function detectState(id) {
  const p = pages[id];
  if (!p) return { state: 'disconnected', message: 'Not connected' };
  const page = p.page;
  const url = page.url();
  try {
    const hasEmail = await page.$('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
    const hasPass = await page.$('input[type="password"]');
    const hasCode = await page.$('input[name="code"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    const hasChat = await page.$('textarea:not([aria-hidden="true"]), [contenteditable="true"][role="textbox"], #prompt-textarea');
    if (hasCode) return { state: 'needs_code', message: 'A verification code was sent to your email. Enter it below.' };
    if (hasPass && !hasChat) return { state: 'needs_password', message: 'Enter your password below.' };
    if (hasEmail && !hasChat) return { state: 'needs_email', message: 'Enter your email below to log in.' };
    if (hasChat) return { state: 'connected', message: 'Logged in! Ready to chat.' };
    if (url.includes('login') || url.includes('auth') || url.includes('signin'))
      return { state: 'login', message: 'Login page detected. Click on the fields in the browser view or use the input below.' };
  } catch (e) {}
  return { state: 'viewing', message: 'Page loaded. Interact with the browser view below.' };
}

async function getScreenshot(id) {
  const p = pages[id];
  if (!p) return null;
  try { return (await p.page.screenshot({ type: 'jpeg', quality: 45 })).toString('base64'); } catch (e) { return null; }
}

async function clickAt(id, x, y) {
  const p = pages[id]; if (!p) throw new Error('Not connected');
  await p.page.mouse.click(x, y);
  await p.page.waitForTimeout(1000);
  const state = await detectState(id);
  p.loggedIn = state.state === 'connected';
  if (p.loggedIn) { saveSession(id, await p.context.storageState()); stats.providers[id].status = 'connected'; }
  return { ...state, screenshot: await getScreenshot(id) };
}

async function typeText(id, text) {
  const p = pages[id]; if (!p) throw new Error('Not connected');
  await p.page.keyboard.type(text, { delay: 25 });
  return { screenshot: await getScreenshot(id) };
}

async function pressKey(id, key) {
  const p = pages[id]; if (!p) throw new Error('Not connected');
  await p.page.keyboard.press(key);
  await p.page.waitForTimeout(1500);
  const state = await detectState(id);
  p.loggedIn = state.state === 'connected';
  if (p.loggedIn) { saveSession(id, await p.context.storageState()); stats.providers[id].status = 'connected'; }
  return { ...state, screenshot: await getScreenshot(id) };
}

async function fillLogin(id, fieldType, value) {
  const p = pages[id]; if (!p) throw new Error('Not connected');
  const page = p.page;
  const sel = fieldType === 'email' ? 'input[type="email"], input[name="email"], input[name="username"]'
    : fieldType === 'password' ? 'input[type="password"]'
    : 'input[name="code"], input[inputmode="numeric"], input[autocomplete="one-time-code"], input[type="tel"]';
  const input = await page.waitForSelector(sel, { timeout: 8000 });
  await input.click();
  await input.fill(value);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  const state = await detectState(id);
  p.loggedIn = state.state === 'connected';
  if (p.loggedIn) { saveSession(id, await p.context.storageState()); stats.providers[id].status = 'connected'; }
  return { ...state, screenshot: await getScreenshot(id) };
}

async function sendChatMessage(id, message) {
  const p = pages[id]; if (!p) throw new Error('Not connected');
  if (!p.loggedIn) throw new Error('Not logged in — connect and log in first.');
  const page = p.page;

  // Navigate to new chat if possible
  try {
    const newChat = await page.$('a[href="/"], a[href="/new"], a[href="/app"], nav a:first-child');
    if (newChat) { await newChat.click(); await page.waitForTimeout(2000); }
  } catch (e) {}

  // Find and focus input
  const input = await page.locator('textarea, [contenteditable="true"][role="textbox"], #prompt-textarea').first();
  await input.click();
  await page.waitForTimeout(300);

  // Type message
  try { await input.fill(message); } catch (e) { await page.keyboard.type(message, { delay: 15 }); }
  await page.waitForTimeout(500);

  // Count existing responses
  const before = await page.evaluate(() =>
    document.querySelectorAll('[data-message-author-role="assistant"], .font-claude-message, .response-content, .prose').length
  );

  // Send
  try { await page.keyboard.press('Enter'); } catch (e) {}
  const deadline = Date.now() + 90000;
  let response = '';

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const texts = await page.evaluate(() => {
      const els = document.querySelectorAll('[data-message-author-role="assistant"], .font-claude-message, .response-content, .prose');
      return Array.from(els).map(e => e.innerText);
    });
    if (texts.length > before && texts[texts.length - 1].length > 10) {
      let last = texts[texts.length - 1];
      let stable = 0;
      while (stable < 2 && Date.now() < deadline) {
        await page.waitForTimeout(2000);
        const cur = await page.evaluate(() => {
          const els = document.querySelectorAll('[data-message-author-role="assistant"], .font-claude-message, .response-content, .prose');
          const a = Array.from(els);
          return a.length > 0 ? a[a.length - 1].innerText : '';
        });
        if (cur === last) stable++; else { stable = 0; last = cur; }
      }
      response = last;
      break;
    }
  }

  if (!response) response = 'No response received — the AI may still be processing or the page layout changed.';
  stats.totalRequests++;
  stats.providers[id].requests++;
  stats.providers[id].lastUsed = new Date().toISOString();
  try { saveSession(id, await p.context.storageState()); } catch (e) {}
  return response;
}

async function closeProvider(id) {
  if (pages[id]) { try { await pages[id].context.close(); } catch (e) {} pages[id] = null; }
  stats.providers[id].status = 'disconnected';
}

// ====== ROUTES ======
app.get('/v1/providers', (req, res) => {
  res.json(Object.entries(PROVIDERS).map(([id, c]) => ({
    id, ...c,
    status: pages[id]?.loggedIn ? 'connected' : pages[id] ? 'connecting' : 'disconnected',
    requests: stats.providers[id]?.requests || 0
  })));
});
app.post('/v1/providers/:id/init', async (req, res) => {
  try { res.json(await initProvider(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/v1/providers/:id', async (req, res) => {
  try { await closeProvider(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/v1/providers/:id/screenshot', async (req, res) => {
  try { const s = await getScreenshot(req.params.id); s ? res.json({ screenshot: s }) : res.status(404).json({ error: 'No screenshot' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/providers/:id/click', async (req, res) => {
  try { res.json(await clickAt(req.params.id, req.body.x, req.body.y)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/providers/:id/type', async (req, res) => {
  try { res.json(await typeText(req.params.id, req.body.text)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/providers/:id/key', async (req, res) => {
  try { res.json(await pressKey(req.params.id, req.body.key)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/providers/:id/login', async (req, res) => {
  try { res.json(await fillLogin(req.params.id, req.body.fieldType, req.body.value)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/chat/:provider', async (req, res) => {
  try {
    const response = await sendChatMessage(req.params.provider, req.body.message);
    res.json({ id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'), object: 'chat.completion',
      model: PROVIDERS[req.params.provider]?.name, choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/v1/keys', (req, res) => { res.json(Object.entries(apiKeys).map(([k, d]) => ({ key: k.slice(0, 8) + '...' + k.slice(-4), fullKey: k, ...d }))); });
app.post('/v1/keys', (req, res) => {
  const key = 'nva-' + crypto.randomBytes(24).toString('hex');
  apiKeys[key] = { name: req.body.name || 'Unnamed', created: new Date().toISOString(), requests: 0 };
  res.json({ key, ...apiKeys[key] });
});
app.delete('/v1/keys/:key', (req, res) => {
  if (apiKeys[req.params.key]) { delete apiKeys[req.params.key]; res.json({ ok: true }); } else res.status(404).json({ error: 'Not found' });
});
app.get('/v1/stats', (req, res) => { res.json(stats); });
app.get('/health', (req, res) => { res.json({ status: 'ok', uptime: process.uptime() }); });

// ====== FRONTEND ======
app.get('/', (req, res) => { res.send(HTML); });

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Nova API</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06060f;--surface:#0c0c18;--card:#111122;--border:#1a1a30;--text:#e0e0f0;--dim:#7070a0;--accent:#6366f1;--accent2:#a855f7;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--grad:linear-gradient(135deg,#6366f1,#a855f7)}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
.app{display:flex;min-height:100vh}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;z-index:100}
.logo{padding:0 20px 24px;font-size:20px;font-weight:700;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);cursor:pointer;font-size:14px;transition:.2s;border-left:3px solid transparent}
.nav-item:hover,.nav-item.active{color:var(--text);background:rgba(99,102,241,.08);border-left-color:var(--accent)}
.nav-section{padding:16px 20px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
.main{margin-left:220px;flex:1;padding:28px 32px;min-height:100vh}
.page{display:none}.page.active{display:block}
h1{font-size:24px;margin-bottom:20px}
h2{font-size:18px;margin-bottom:16px;color:var(--dim)}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}
.stat-label{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}
.stat-value{font-size:28px;font-weight:700;margin-top:4px}
.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.provider-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;transition:.2s}
.provider-card:hover{border-color:var(--accent);transform:translateY(-2px)}
.provider-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}
.provider-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff}
.provider-name{font-size:16px;font-weight:600}
.provider-company{font-size:12px;color:var(--dim)}
.provider-status{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:14px}
.dot{width:8px;height:8px;border-radius:50%}
.dot.green{background:var(--green)}.dot.yellow{background:var(--yellow)}.dot.gray{background:#555}
.provider-reqs{font-size:12px;color:var(--dim);margin-bottom:14px}
.btn{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:6px}
.btn-primary{background:var(--grad);color:#fff}.btn-primary:hover{opacity:.85}
.btn-danger{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}.btn-danger:hover{background:rgba(239,68,68,.25)}
.btn-secondary{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{background:rgba(255,255,255,.1)}
.btn-sm{padding:6px 12px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.keys-table{width:100%;border-collapse:collapse;margin-top:16px}
.keys-table th,.keys-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);font-size:13px}
.keys-table th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.key-value{font-family:monospace;font-size:12px;background:rgba(255,255,255,.04);padding:4px 8px;border-radius:4px}
.playground-area{display:flex;flex-direction:column;height:calc(100vh - 140px)}
.pg-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}
select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}
select:focus{outline:none;border-color:var(--accent)}
.chat-messages{flex:1;overflow-y:auto;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:12px}
.msg{margin-bottom:12px;max-width:80%}
.msg.user{margin-left:auto;text-align:right}
.msg .bubble{display:inline-block;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5}
.msg.user .bubble{background:var(--accent);color:#fff}
.msg.ai .bubble{background:rgba(255,255,255,.06);border:1px solid var(--border)}
.msg .label{font-size:11px;color:var(--dim);margin-bottom:4px}
.chat-input-row{display:flex;gap:8px}
.chat-input-row input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:14px}
.chat-input-row input:focus{outline:none;border-color:var(--accent)}
.docs-content{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;font-size:14px;line-height:1.8}
.docs-content code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:13px}
.docs-content pre{background:rgba(0,0,0,.3);padding:16px;border-radius:8px;overflow-x:auto;margin:12px 0;font-size:13px}
.endpoint{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}
.method{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;min-width:50px;text-align:center}
.method.get{background:rgba(34,197,94,.15);color:var(--green)}.method.post{background:rgba(99,102,241,.15);color:var(--accent)}.method.delete{background:rgba(239,68,68,.15);color:var(--red)}
.ep-path{font-family:monospace;font-size:13px}

/* Browser View Modal */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.8);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:95%;max-width:1000px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}
.modal-top{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}
.modal-top h3{font-size:15px;font-weight:600}
.close-btn{background:none;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:4px 8px}.close-btn:hover{color:var(--text)}
.bv-screen{position:relative;background:#000;border-radius:8px;overflow:hidden;margin:16px 20px 0;cursor:crosshair}
.bv-screen img{width:100%;display:block;pointer-events:none}
.bv-screen .click-ring{position:absolute;width:20px;height:20px;border:2px solid var(--accent);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;animation:ping .4s ease-out forwards}
@keyframes ping{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(2)}}
.bv-status{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px}
.bv-status .dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.bv-controls{display:flex;gap:8px;padding:0 20px 16px}
.bv-controls input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px}
.bv-controls input:focus{outline:none;border-color:var(--accent)}
.bv-hint{padding:0 20px 14px;font-size:11px;color:var(--dim)}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dim);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.hidden{display:none!important}
</style>
</head>
<body>
<div class="app">
<nav class="sidebar">
<div class="logo">Nova API</div>
<div class="nav-item active" onclick="nav('overview')">Overview</div>
<div class="nav-section">Dashboard</div>
<div class="nav-item" onclick="nav('providers')">Providers</div>
<div class="nav-section">Management</div>
<div class="nav-item" onclick="nav('keys')">API Keys</div>
<div class="nav-section">Tools</div>
<div class="nav-item" onclick="nav('playground')">Playground</div>
<div class="nav-item" onclick="nav('docs')">API Docs</div>
</nav>
<div class="main">

<!-- OVERVIEW -->
<div class="page active" id="page-overview">
<h1>Overview</h1>
<div class="stats-row">
<div class="stat-card"><div class="stat-label">Connected</div><div class="stat-value" id="ov-connected">0</div></div>
<div class="stat-card"><div class="stat-label">Total Requests</div><div class="stat-value" id="ov-requests">0</div></div>
<div class="stat-card"><div class="stat-label">API Keys</div><div class="stat-value" id="ov-keys">0</div></div>
</div>
<h2>Providers</h2>
<div class="providers-grid" id="ov-providers"></div>
</div>

<!-- PROVIDERS -->
<div class="page" id="page-providers">
<h1>Providers</h1>
<div class="providers-grid" id="pv-grid"></div>
</div>

<!-- KEYS -->
<div class="page" id="page-keys">
<div style="display:flex;align-items:center;justify-content:space-between">
<h1>API Keys</h1>
<button class="btn btn-primary" onclick="genKey()">+ Generate Key</button>
</div>
<table class="keys-table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Requests</th><th></th></tr></thead><tbody id="keys-body"></tbody></table>
</div>

<!-- PLAYGROUND -->
<div class="page" id="page-playground">
<h1>Playground</h1>
<div class="playground-area">
<div class="pg-header">
<select id="pg-provider"><option value="">Select provider...</option></select>
<button class="btn btn-secondary btn-sm" onclick="clearChat()">Clear</button>
</div>
<div class="chat-messages" id="chat-msgs"></div>
<div class="chat-input-row">
<input id="chat-input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendMsg()">
<button class="btn btn-primary" onclick="sendMsg()">Send</button>
</div>
</div>
</div>

<!-- DOCS -->
<div class="page" id="page-docs">
<h1>API Docs</h1>
<div class="docs-content">
<h2>Endpoints</h2>
<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/init</span></div>
<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/providers/:id</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers/:id/screenshot</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/click</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/type</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/key</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/login</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/chat/:provider</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/keys</span></div>
<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/keys</span></div>
<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/keys/:key</span></div>
<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/stats</span></div>
<br>
<h2>Usage</h2>
<pre>curl -X POST /v1/chat/chatgpt \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!"}'</pre>
<p>Responses follow OpenAI-compatible format.</p>
</div>
</div>

</div>
</div>

<!-- BROWSER VIEW MODAL -->
<div class="modal-overlay" id="bv-modal">
<div class="modal-box">
<div class="modal-top">
<h3 id="bv-title">Provider</h3>
<button class="close-btn" onclick="closeBV()">&times;</button>
</div>
<div class="bv-screen" id="bv-screen" onclick="bvClick(event)">
<img id="bv-img" src="">
</div>
<div class="bv-status"><span class="dot gray" id="bv-dot"></span><span id="bv-msg">Loading...</span></div>
<div class="bv-controls">
<input id="bv-input" type="text" placeholder="Type here and press Enter..." onkeydown="if(event.key==='Enter'){bvSubmit();event.preventDefault()}">
<button class="btn btn-primary btn-sm" onclick="bvSubmit()">Submit</button>
<button class="btn btn-secondary btn-sm" onclick="bvSendKey('Enter')">Enter</button>
<button class="btn btn-secondary btn-sm" onclick="bvSendKey('Tab')">Tab</button>
</div>
<div class="bv-hint">Click anywhere on the browser image to interact. Type in the field below to enter text. Use Enter/Tab buttons for special keys.</div>
</div>
</div>

<script>
let bvProvider = null;
let bvPolling = null;
let providers = [];

function nav(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  event.target.classList.add('active');
  if (page === 'providers' || page === 'overview') loadProviders();
  if (page === 'keys') loadKeys();
  if (page === 'playground') loadProviders();
  if (page === 'overview') loadStats();
}

async function loadProviders() {
  try {
    const r = await fetch('/v1/providers');
    providers = await r.json();
    renderProviders();
    updateOverview();
    updatePgSelect();
  } catch (e) { console.error(e); }
}

function renderProviders() {
  ['ov-providers', 'pv-grid'].forEach(containerId => {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = providers.map(p => {
      const dotClass = p.status === 'connected' ? 'green' : p.status === 'connecting' ? 'yellow' : 'gray';
      const statusText = p.status === 'connected' ? 'Connected' : p.status === 'connecting' ? 'Connecting...' : 'Disconnected';
      const connectBtn = p.status === 'connected'
        ? '<button class="btn btn-secondary btn-sm" onclick="openBV(\\'' + p.id + '\\')">View Browser</button> <button class="btn btn-danger btn-sm" onclick="disconnectP(\\'' + p.id + '\\')">Disconnect</button>'
        : p.status === 'connecting'
        ? '<button class="btn btn-secondary btn-sm" onclick="openBV(\\'' + p.id + '\\')">View Browser</button>'
        : '<button class="btn btn-primary btn-sm" onclick="connectP(\\'' + p.id + '\\')">Connect</button>';
      return '<div class="provider-card">' +
        '<div class="provider-header"><div class="provider-icon" style="background:' + p.color + '">' + p.icon + '</div>' +
        '<div><div class="provider-name">' + p.name + '</div><div class="provider-company">' + p.company + '</div></div></div>' +
        '<div class="provider-status"><span class="dot ' + dotClass + '"></span>' + statusText + '</div>' +
        '<div class="provider-reqs">' + p.requests + ' requests</div>' +
        connectBtn + '</div>';
    }).join('');
  });
}

function updateOverview() {
  const connected = providers.filter(p => p.status === 'connected').length;
  document.getElementById('ov-connected').textContent = connected;
  document.getElementById('ov-keys').textContent = '0';
}

function updatePgSelect() {
  const sel = document.getElementById('pg-provider');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select provider...</option>' +
    providers.filter(p => p.status === 'connected').map(p =>
      '<option value="' + p.id + '">' + p.name + '</option>'
    ).join('');
  if (cur) sel.value = cur;
}

async function connectP(id) {
  try {
    const r = await fetch('/v1/providers/' + id + '/init', { method: 'POST' });
    const data = await r.json();
    if (data.error) { alert('Error: ' + data.error); return; }
    openBV(id);
    loadProviders();
  } catch (e) { alert('Connection failed: ' + e.message); }
}

async function disconnectP(id) {
  try {
    await fetch('/v1/providers/' + id, { method: 'DELETE' });
    loadProviders();
  } catch (e) { alert(e.message); }
}

// ====== BROWSER VIEW ======
function openBV(id) {
  bvProvider = id;
  const p = providers.find(x => x.id === id);
  document.getElementById('bv-title').textContent = p ? p.name + ' — Browser View' : id;
  document.getElementById('bv-modal').classList.add('show');
  document.getElementById('bv-msg').textContent = 'Loading...';
  document.getElementById('bv-dot').className = 'dot yellow';
  document.getElementById('bv-input').value = '';
  bvStartPolling();
}

function closeBV() {
  document.getElementById('bv-modal').classList.remove('show');
  bvStopPolling();
  bvProvider = null;
}

function bvStartPolling() {
  bvStopPolling();
  bvPollTick();
  bvPolling = setInterval(bvPollTick, 2000);
}

function bvStopPolling() { if (bvPolling) { clearInterval(bvPolling); bvPolling = null; } }

async function bvPollTick() {
  if (!bvProvider) return;
  try {
    const r = await fetch('/v1/providers/' + bvProvider + '/screenshot');
    if (r.ok) {
      const d = await r.json();
      if (d.screenshot) document.getElementById('bv-img').src = 'data:image/jpeg;base64,' + d.screenshot;
    }
    // Also detect state
    const s = await fetch('/v1/providers');
    const all = await s.json();
    const p = all.find(x => x.id === bvProvider);
    if (p) {
      providers = all;
      if (p.status === 'connected') {
        document.getElementById('bv-msg').textContent = 'Connected! You can close this and use the Playground.';
        document.getElementById('bv-dot').className = 'dot green';
      }
    }
  } catch (e) {}
}

async function bvClick(event) {
  if (!bvProvider) return;
  const img = document.getElementById('bv-img');
  const rect = img.getBoundingClientRect();
  const x = Math.round((event.clientX - rect.left) / rect.width * 1280);
  const y = Math.round((event.clientY - rect.top) / rect.height * 800);

  // Show click ring
  const ring = document.createElement('div');
  ring.className = 'click-ring';
  ring.style.left = (event.clientX - rect.left) + 'px';
  ring.style.top = (event.clientY - rect.top) + 'px';
  document.getElementById('bv-screen').appendChild(ring);
  setTimeout(() => ring.remove(), 500);

  try {
    const r = await fetch('/v1/providers/' + bvProvider + '/click', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x, y })
    });
    const d = await r.json();
    if (d.screenshot) document.getElementById('bv-img').src = 'data:image/jpeg;base64,' + d.screenshot;
    if (d.message) document.getElementById('bv-msg').textContent = d.message;
    if (d.state === 'connected') {
      document.getElementById('bv-dot').className = 'dot green';
      loadProviders();
    } else {
      document.getElementById('bv-dot').className = 'dot yellow';
    }
  } catch (e) { document.getElementById('bv-msg').textContent = 'Error: ' + e.message; }
}

async function bvSubmit() {
  if (!bvProvider) return;
  const input = document.getElementById('bv-input');
  const val = input.value.trim();
  if (!val) return;

  // Detect what type of field we're filling
  const msg = document.getElementById('bv-msg').textContent.toLowerCase();
  let fieldType = 'text';
  if (msg.includes('email')) fieldType = 'email';
  else if (msg.includes('password')) fieldType = 'password';
  else if (msg.includes('code') || msg.includes('verification')) fieldType = 'code';

  try {
    if (fieldType !== 'text') {
      // Use login endpoint
      const r = await fetch('/v1/providers/' + bvProvider + '/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType, value: val })
      });
      const d = await r.json();
      if (d.screenshot) document.getElementById('bv-img').src = 'data:image/jpeg;base64,' + d.screenshot;
      if (d.message) document.getElementById('bv-msg').textContent = d.message;
      if (d.state === 'connected') {
        document.getElementById('bv-dot').className = 'dot green';
        loadProviders();
      } else {
        document.getElementById('bv-dot').className = 'dot yellow';
      }
    } else {
      // Use type endpoint
      const r = await fetch('/v1/providers/' + bvProvider + '/type', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: val })
      });
      const d = await r.json();
      if (d.screenshot) document.getElementById('bv-img').src = 'data:image/jpeg;base64,' + d.screenshot;
    }
    input.value = '';
  } catch (e) { document.getElementById('bv-msg').textContent = 'Error: ' + e.message; }
}

async function bvSendKey(key) {
  if (!bvProvider) return;
  try {
    const r = await fetch('/v1/providers/' + bvProvider + '/key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const d = await r.json();
    if (d.screenshot) document.getElementById('bv-img').src = 'data:image/jpeg;base64,' + d.screenshot;
    if (d.message) document.getElementById('bv-msg').textContent = d.message;
    if (d.state === 'connected') {
      document.getElementById('bv-dot').className = 'dot green';
      loadProviders();
    }
  } catch (e) { document.getElementById('bv-msg').textContent = 'Error: ' + e.message; }
}

// ====== CHAT ======
async function sendMsg() {
  const input = document.getElementById('chat-input');
  const provider = document.getElementById('pg-provider').value;
  const msg = input.value.trim();
  if (!msg || !provider) return;

  const msgs = document.getElementById('chat-msgs');
  msgs.innerHTML += '<div class="msg user"><div class="label">You</div><div class="bubble">' + escHtml(msg) + '</div></div>';
  msgs.innerHTML += '<div class="msg ai" id="thinking"><div class="label">' + provider + '</div><div class="bubble"><span class="spinner"></span> Thinking...</div></div>';
  msgs.scrollTop = msgs.scrollHeight;
  input.value = '';

  try {
    const r = await fetch('/v1/chat/' + provider, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    const d = await r.json();
    const thinking = document.getElementById('thinking');
    if (thinking) thinking.remove();
    const reply = d.error ? 'Error: ' + d.error : (d.choices && d.choices[0] ? d.choices[0].message.content : 'No response');
    msgs.innerHTML += '<div class="msg ai"><div class="label">' + provider + '</div><div class="bubble">' + escHtml(reply) + '</div></div>';
  } catch (e) {
    const thinking = document.getElementById('thinking');
    if (thinking) thinking.remove();
    msgs.innerHTML += '<div class="msg ai"><div class="label">Error</div><div class="bubble" style="color:var(--red)">' + escHtml(e.message) + '</div></div>';
  }
  msgs.scrollTop = msgs.scrollHeight;
  loadProviders();
}

function clearChat() { document.getElementById('chat-msgs').innerHTML = ''; }

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ====== KEYS ======
async function loadKeys() {
  try {
    const r = await fetch('/v1/keys');
    const keys = await r.json();
    const body = document.getElementById('keys-body');
    body.innerHTML = keys.length ? keys.map(k =>
      '<tr><td>' + escHtml(k.name) + '</td><td><span class="key-value">' + k.key + '</span></td><td>' + new Date(k.created).toLocaleDateString() + '</td><td>' + k.requests + '</td><td><button class="btn btn-danger btn-sm" onclick="revokeKey(\\'' + k.fullKey + '\\')">Revoke</button></td></tr>'
    ).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--dim);padding:30px">No API keys yet. Click "Generate Key" to create one.</td></tr>';
    document.getElementById('ov-keys').textContent = keys.length;
  } catch (e) {}
}

async function genKey() {
  const name = prompt('Key name:');
  if (!name) return;
  try {
    const r = await fetch('/v1/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const d = await r.json();
    alert('Key created: ' + d.key + '\\n\\nSave it now — it won\\'t be shown in full again.');
    loadKeys();
  } catch (e) { alert(e.message); }
}

async function revokeKey(key) {
  if (!confirm('Revoke this key?')) return;
  try { await fetch('/v1/keys/' + encodeURIComponent(key), { method: 'DELETE' }); loadKeys(); } catch (e) { alert(e.message); }
}

// ====== STATS ======
async function loadStats() {
  try {
    const r = await fetch('/v1/stats');
    const s = await r.json();
    document.getElementById('ov-requests').textContent = s.totalRequests;
  } catch (e) {}
}

// ====== INIT ======
loadProviders();
setInterval(loadProviders, 15000);
</script>
</body>
</html>`;

// ====== START ======
app.listen(PORT, () => { console.log('Nova API Gateway v3 on port ' + PORT); });

process.on('SIGTERM', async () => { if (browser) await browser.close().catch(() => {}); process.exit(0); });
