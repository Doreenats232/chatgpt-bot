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

const PROVIDERS = {
  chatgpt:    { name: 'ChatGPT',    company: 'OpenAI GPT-4o',       color: '#10a37f', icon: 'G',  url: 'https://chatgpt.com' },
  claude:     { name: 'Claude',     company: 'Anthropic Claude 3.5', color: '#d97706', icon: 'C',  url: 'https://claude.ai/new' },
  gemini:     { name: 'Gemini',     company: 'Google Gemini Pro',    color: '#4285f4', icon: 'Ge', url: 'https://gemini.google.com/app' },
  perplexity: { name: 'Perplexity', company: 'Perplexity AI',        color: '#20b2aa', icon: 'P',  url: 'https://www.perplexity.ai' }
};

let browser = null;
let activeProvider = null;
const providers = {};
const apiKeys = {};
const stats = { totalRequests: 0 };
Object.keys(PROVIDERS).forEach(function(id) { providers[id] = { status: 'disconnected', requests: 0, lastUsed: null, error: null }; });

function loadSession(id) { try { var f = path.join(SESSIONS_DIR, id + '.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch (e) { return null; } }
function saveSession(id, state) { try { fs.writeFileSync(path.join(SESSIONS_DIR, id + '.json'), JSON.stringify(state)); } catch (e) {} }

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('[Browser] Launching Firefox...');
  browser = await firefox.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  browser.on('disconnected', function() { browser = null; if (activeProvider) { providers[activeProvider].status = 'disconnected'; activeProvider = null; } console.log('[Browser] Disconnected'); });
  return browser;
}

async function closeActiveProvider() {
  if (activeProvider && providers[activeProvider]) {
    try { await providers[activeProvider].context.close(); } catch (e) {}
    providers[activeProvider] = { ...providers[activeProvider], status: 'disconnected', context: null, page: null };
    activeProvider = null;
  }
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}

async function initProvider(id) {
  if (!PROVIDERS[id]) throw new Error('Unknown provider');
  if (activeProvider && activeProvider !== id) {
    providers[activeProvider].status = 'disconnected';
    if (providers[activeProvider].context) try { await providers[activeProvider].context.close(); } catch (e) {}
    providers[activeProvider].context = null; providers[activeProvider].page = null;
    if (browser) try { await browser.close(); } catch (e) {} browser = null;
  }
  providers[id].status = 'connecting'; providers[id].error = null;
  try {
    var b = await getBrowser();
    var saved = loadSession(id);
    var ctx = await b.newContext({ viewport: { width: 1024, height: 700 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', ...(saved ? { storageState: saved } : {}) });
    var page = await ctx.newPage();
    await page.goto(PROVIDERS[id].url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    providers[id] = { ...providers[id], context: ctx, page, status: 'viewing' };
    activeProvider = id;
    var state = await detectState(id);
    if (state.state === 'connected') { providers[id].status = 'connected'; saveSession(id, await ctx.storageState()); }
    return { ...state, screenshot: await getScreenshot(id) };
  } catch (e) { providers[id].status = 'disconnected'; providers[id].error = e.message; throw e; }
}

async function detectState(id) {
  var p = providers[id]; if (!p || !p.page) return { state: 'disconnected', message: 'Not connected' };
  var page = p.page;
  try {
    var hasEmail = await page.$('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
    var hasPass = await page.$('input[type="password"]');
    var hasCode = await page.$('input[name="code"], input[autocomplete="one-time-code"]');
    var hasChat = await page.$('textarea:not([aria-hidden="true"]), [contenteditable="true"][role="textbox"], #prompt-textarea, [id*="prompt"], form textarea, div[contenteditable="true"]');
    if (hasCode) return { state: 'needs_code', message: 'Verification code required' };
    if (hasPass && !hasChat) return { state: 'needs_password', message: 'Password required' };
    if (hasEmail && !hasChat) return { state: 'needs_email', message: 'Email required' };
    if (hasChat) { providers[id].status = 'connected'; saveSession(id, await p.context.storageState()); return { state: 'connected', message: 'Logged in! Ready to chat.' }; }
  } catch (e) {}
  return { state: 'viewing', message: 'Page loaded' };
}

async function getScreenshot(id) {
  var p = providers[id]; if (!p || !p.page) return null;
  try { return (await p.page.screenshot({ type: 'jpeg', quality: 40 })).toString('base64'); } catch (e) { return null; }
}

async function clickAt(id, x, y) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.mouse.click(x, y); await p.page.waitForTimeout(1500);
  var state = await detectState(id);
  return { ...state, screenshot: await getScreenshot(id) };
}

async function typeText(id, text) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.keyboard.type(text, { delay: 20 });
  return { screenshot: await getScreenshot(id) };
}

async function pressKey(id, key) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.keyboard.press(key); await p.page.waitForTimeout(2000);
  var state = await detectState(id);
  return { ...state, screenshot: await getScreenshot(id) };
}

async function fillField(id, fieldType, value) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  var sel = fieldType === 'email' ? 'input[type="email"], input[name="email"], input[name="username"]' : fieldType === 'password' ? 'input[type="password"]' : 'input[name="code"], input[autocomplete="one-time-code"], input[type="tel"]';
  var input = await p.page.waitForSelector(sel, { timeout: 8000 });
  await input.click(); await input.fill(value); await p.page.waitForTimeout(300);
  await p.page.keyboard.press('Enter'); await p.page.waitForTimeout(4000);
  var state = await detectState(id);
  return { ...state, screenshot: await getScreenshot(id) };
}

async function sendChatMessage(id, message) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  if (p.status !== 'connected' && p.status !== 'viewing') throw new Error('Not logged in yet');
  var page = p.page;
  console.log('[Chat] Sending to', id, ':', message.substring(0, 60));

  // Navigate to new chat
  try { var nav = await page.$('a[href="/"], a[href="/new"]'); if (nav) { await nav.click(); await page.waitForTimeout(2000); } } catch (e) {}

  // Find input
  var inputSelectors = ['#prompt-textarea', 'textarea[data-id="root"]', 'textarea[placeholder]', 'textarea', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', '[contenteditable="true"]'];
  var input = null;
  for (var i = 0; i < inputSelectors.length; i++) { input = await page.$(inputSelectors[i]); if (input) { console.log('[Chat] Found input:', inputSelectors[i]); break; } }
  if (!input) throw new Error('Cannot find chat input on page');

  await input.click(); await page.waitForTimeout(300);
  try { await input.fill(message); } catch (e) { console.log('[Chat] fill() failed, typing'); await page.keyboard.type(message, { delay: 15 }); }
  await page.waitForTimeout(500);

  // Count existing assistant messages
  var beforeCount = await page.evaluate(function() { return document.querySelectorAll('[data-message-author-role="assistant"]').length; });
  console.log('[Chat] Assistant messages before:', beforeCount);

  // Send
  var sent = false;
  try { var sendBtn = await page.$('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], button[aria-label*="send"]'); if (sendBtn) { await sendBtn.click(); sent = true; } } catch (e) {}
  if (!sent) await page.keyboard.press('Enter');
  console.log('[Chat] Message sent');
  await page.waitForTimeout(3000);

  // Wait for response
  console.log('[Chat] Waiting for response...');
  var deadline = Date.now() + 120000;
  var response = '';

  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);

    var result = await page.evaluate(function(bc) {
      var strategies = [
        { name: 'dataMsgRole', fn: function() { return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); } },
        { name: 'testId', fn: function() { return Array.from(document.querySelectorAll('[data-testid*="conversation-turn"], [data-testid*="assistant"], [data-testid*="bot-turn"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); } },
        { name: 'markdown', fn: function() { return Array.from(document.querySelectorAll('.markdown.prose, .prose, .markdown')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); } },
        { name: 'broadClass', fn: function() { return Array.from(document.querySelectorAll('.agent-turn, .response-content, [class*="Message_message"], [class*="assistant"], [class*="markdown"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); } },
        { name: 'articles', fn: function() { return Array.from(document.querySelectorAll('article, section[class*="message"], div[class*="Turn"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); } },
      ];
      var found = [];
      for (var i = 0; i < strategies.length; i++) {
        try {
          var texts = strategies[i].fn();
          if (texts.length > bc) { found = texts; return { name: strategies[i].name, texts: texts, last: texts[texts.length - 1] }; }
        } catch (e) {}
      }
      // Fallback: scan for new large text blocks
      try {
        var all = document.querySelectorAll('div');
        var big = [];
        all.forEach(function(d) { var t = d.innerText.trim(); if (t.length > 50 && t.length < 5000 && d.children.length < 6) { var r = d.getBoundingClientRect(); if (r.top > 150 && r.width > 300) big.push(t); } });
        if (big.length > 0) { var last = big[big.length - 1]; return { name: 'divScan', texts: big, last: last }; }
      } catch (e) {}
      return { name: 'none', texts: [], last: '' };
    }, beforeCount);

    console.log('[Chat] Strategy:', result.name, 'texts:', result.texts.length);

    if (result.last && result.last.length > 10) {
      var last = result.last;
      var stable = 0;
      while (stable < 3 && Date.now() < deadline) {
        await page.waitForTimeout(2500);
        var check = await page.evaluate(function() {
          var strategies = [
            function() { return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); },
            function() { return Array.from(document.querySelectorAll('.markdown.prose, .prose, .markdown')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); },
            function() { return Array.from(document.querySelectorAll('[data-testid*="conversation-turn"]')).map(function(e) { return e.innerText; }).filter(function(t) { return t.length > 5; }); },
          ];
          for (var i = 0; i < strategies.length; i++) { try { var t = strategies[i](); if (t.length > 0) return t[t.length - 1]; } catch (e) {} }
          return '';
        });
        if (check && check.length > 5) {
          if (check === last) { stable++; console.log('[Chat] Stable', stable, '/3'); }
          else { stable = 0; last = check; console.log('[Chat] Growing, len:', last.length); }
        } else { stable++; }
      }
      response = last;
      console.log('[Chat] Got response, len:', response.length);
      break;
    }
  }

  if (!response) response = 'No response received.';

  stats.totalRequests++;
  providers[id].requests++;
  providers[id].lastUsed = new Date().toISOString();
  try { saveSession(id, await p.context.storageState()); } catch (e) {}
  return response;
}

// Debug endpoint
app.get('/v1/providers/:id/debug', async function(req, res) {
  var p = providers[req.params.id];
  if (!p || !p.page) return res.json({ error: 'Not connected' });
  try {
    var info = await p.page.evaluate(function() {
      var r = { url: window.location.href, title: document.title };
      var sels = { 'dataMsgRole': '[data-message-author-role]', 'testId': '[data-testid*="assistant"]', 'markdown': '.markdown.prose, .prose', 'promptArea': '#prompt-textarea', 'textarea': 'textarea', 'contenteditable': '[contenteditable="true"]' };
      r.selectors = {};
      for (var k in sels) { var els = document.querySelectorAll(sels[k]); r.selectors[k] = { count: els.length, samples: Array.from(els).slice(0, 2).map(function(e) { return { tag: e.tagName, cls: (e.className || '').substring(0, 150), text: (e.innerText || '').substring(0, 300) }; }) }; }
      return r;
    });
    res.json(info);
  } catch (e) { res.json({ error: e.message }); }
});

// Routes
app.get('/favicon.ico', function(req, res) { res.status(204).end(); });
app.get('/v1/providers', function(req, res) { res.json(Object.entries(PROVIDERS).map(function(x) { var id = x[0], c = x[1]; return { id: id, name: c.name, company: c.company, color: c.color, icon: c.icon, url: c.url, status: providers[id].status, requests: providers[id].requests, error: providers[id].error || null }; })); });
app.post('/v1/providers/:id/init', async function(req, res) { try { res.json(await initProvider(req.params.id)); } catch (e) { console.error('[Init]', req.params.id, e.message); res.status(500).json({ error: e.message }); } });
app.delete('/v1/providers/:id', async function(req, res) { try { if (activeProvider === req.params.id) await closeActiveProvider(); else if (providers[req.params.id]) providers[req.params.id].status = 'disconnected'; res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/v1/providers/:id/screenshot', async function(req, res) { try { var s = await getScreenshot(req.params.id); s ? res.json({ screenshot: s }) : res.status(404).json({ error: 'No screenshot' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/v1/providers/:id/click', async function(req, res) { try { res.json(await clickAt(req.params.id, req.body.x, req.body.y)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/v1/providers/:id/type', async function(req, res) { try { res.json(await typeText(req.params.id, req.body.text)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/v1/providers/:id/key', async function(req, res) { try { res.json(await pressKey(req.params.id, req.body.key)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/v1/providers/:id/login', async function(req, res) { try { res.json(await fillField(req.params.id, req.body.fieldType, req.body.value)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/v1/chat/:provider', async function(req, res) { try { var response = await sendChatMessage(req.params.provider, req.body.message); res.json({ id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'), object: 'chat.completion', model: PROVIDERS[req.params.provider] ? PROVIDERS[req.params.provider].name : req.params.provider, choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }] }); } catch (e) { console.error('[Chat]', req.params.provider, e.message); res.status(500).json({ error: e.message }); } });
app.get('/v1/keys', function(req, res) { res.json(Object.entries(apiKeys).map(function(x) { return { key: x[0].slice(0, 8) + '...' + x[0].slice(-4), fullKey: x[0], name: x[1].name, created: x[1].created, requests: x[1].requests }; })); });
app.post('/v1/keys', function(req, res) { var key = 'nva-' + crypto.randomBytes(24).toString('hex'); apiKeys[key] = { name: req.body.name || 'Unnamed', created: new Date().toISOString(), requests: 0 }; res.json({ key: key, ...apiKeys[key] }); });
app.delete('/v1/keys/:key', function(req, res) { if (apiKeys[req.params.key]) { delete apiKeys[req.params.key]; res.json({ ok: true }); } else res.status(404).json({ error: 'Not found' }); });
app.get('/v1/stats', function(req, res) { res.json(stats); });
app.get('/health', function(req, res) { res.json({ status: 'ok', memory: process.memoryUsage().rss, active: activeProvider }); });

// Frontend
app.get('/', function(req, res) { res.send(HTML); });

var HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="UTF-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1.0">',
'<title>Nova API</title>',
'<style>',
'*{margin:0;padding:0;box-sizing:border-box}',
':root{--bg:#06060f;--surface:#0c0c18;--card:#111122;--border:#1a1a30;--text:#e0e0f0;--dim:#7070a0;--accent:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--grad:linear-gradient(135deg,#6366f1,#a855f7)}',
'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}',
'.app{display:flex;min-height:100vh}',
'.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;z-index:100}',
'.logo{padding:0 20px 24px;font-size:20px;font-weight:700;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}',
'.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);cursor:pointer;font-size:14px;transition:.2s;border-left:3px solid transparent}',
'.nav-item:hover,.nav-item.active{color:var(--text);background:rgba(99,102,241,.08);border-left-color:var(--accent)}',
'.nav-section{padding:16px 20px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}',
'.main{margin-left:220px;flex:1;padding:28px 32px;min-height:100vh}',
'.page{display:none}.page.active{display:block}',
'h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;margin-bottom:16px;color:var(--dim)}',
'.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}',
'.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}',
'.stat-label{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}.stat-value{font-size:28px;font-weight:700;margin-top:4px}',
'.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}',
'.provider-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;transition:.2s}',
'.provider-card:hover{border-color:var(--accent);transform:translateY(-2px)}',
'.provider-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}',
'.provider-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff}',
'.provider-name{font-size:16px;font-weight:600}.provider-company{font-size:12px;color:var(--dim)}',
'.provider-status{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:14px}',
'.dot{width:8px;height:8px;border-radius:50%}.dot.green{background:var(--green)}.dot.yellow{background:var(--yellow)}.dot.gray{background:#555}.dot.red{background:var(--red)}',
'.provider-reqs{font-size:12px;color:var(--dim);margin-bottom:14px}',
'.provider-error{font-size:12px;color:var(--red);margin-bottom:10px;padding:8px;background:rgba(239,68,68,.08);border-radius:6px}',
'.btn{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:6px}',
'.btn-primary{background:var(--grad);color:#fff}.btn-primary:hover{opacity:.85}',
'.btn-danger{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}.btn-danger:hover{background:rgba(239,68,68,.25)}',
'.btn-secondary{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{background:rgba(255,255,255,.1)}',
'.btn-sm{padding:6px 12px;font-size:12px}.btn:disabled{opacity:.4;cursor:not-allowed}',
'.keys-table{width:100%;border-collapse:collapse;margin-top:16px}',
'.keys-table th,.keys-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);font-size:13px}',
'.keys-table th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}',
'.key-value{font-family:monospace;font-size:12px;background:rgba(255,255,255,.04);padding:4px 8px;border-radius:4px}',
'.playground-area{display:flex;flex-direction:column;height:calc(100vh - 140px)}',
'.pg-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}',
'select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}select:focus{outline:none;border-color:var(--accent)}',
'.chat-messages{flex:1;overflow-y:auto;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:12px}',
'.msg{margin-bottom:12px;max-width:80%}.msg.user{margin-left:auto;text-align:right}',
'.msg .bubble{display:inline-block;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word}',
'.msg.user .bubble{background:var(--accent);color:#fff}.msg.ai .bubble{background:rgba(255,255,255,.06);border:1px solid var(--border)}',
'.msg .label{font-size:11px;color:var(--dim);margin-bottom:4px}',
'.chat-input-row{display:flex;gap:8px}',
'.chat-input-row input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:14px}',
'.chat-input-row input:focus{outline:none;border-color:var(--accent)}',
'.docs-content{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;font-size:14px;line-height:1.8}',
'.docs-content code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:13px}',
'.docs-content pre{background:rgba(0,0,0,.3);padding:16px;border-radius:8px;overflow-x:auto;margin:12px 0;font-size:13px}',
'.endpoint{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}',
'.method{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;min-width:50px;text-align:center}',
'.method.get{background:rgba(34,197,94,.15);color:var(--green)}.method.post{background:rgba(99,102,241,.15);color:var(--accent)}.method.delete{background:rgba(239,68,68,.15);color:var(--red)}',
'.ep-path{font-family:monospace;font-size:13px}',
'.mem-bar{margin-top:12px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--dim);display:flex;align-items:center;gap:10px}',
'.mem-bar .bar{flex:1;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden}',
'.mem-bar .bar-fill{height:100%;border-radius:3px;transition:.3s}',
'.notice{padding:12px 16px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;font-size:13px;color:var(--yellow);margin-bottom:20px}',
'.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.85);z-index:1000;align-items:center;justify-content:center}',
'.modal-overlay.show{display:flex}',
'.modal-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:95%;max-width:960px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}',
'.modal-top{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}',
'.modal-top h3{font-size:15px;font-weight:600}',
'.close-btn{background:none;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:4px 8px}.close-btn:hover{color:var(--text)}',
'.bv-screen{position:relative;background:#000;border-radius:8px;overflow:hidden;margin:16px 20px 0;cursor:crosshair}',
'.bv-screen img{width:100%;display:block;pointer-events:none}',
'.bv-screen .click-ring{position:absolute;width:20px;height:20px;border:2px solid var(--accent);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;animation:ping .4s ease-out forwards}',
'@keyframes ping{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(2)}}',
'.bv-status{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px}',
'.bv-controls{display:flex;gap:8px;padding:0 20px 16px}',
'.bv-controls input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px}',
'.bv-controls input:focus{outline:none;border-color:var(--accent)}',
'.bv-hint{padding:0 20px 14px;font-size:11px;color:var(--dim)}',
'.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dim);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}',
'@keyframes spin{to{transform:rotate(360deg)}}',
'.loading-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;z-index:5}',
'.loading-overlay .spinner{width:28px;height:28px;margin-bottom:12px}',
'</style>',
'</head>',
'<body>',
'<div class="app">',
'<nav class="sidebar">',
'<div class="logo">Nova API</div>',
'<div class="nav-item active" data-page="overview">Overview</div>',
'<div class="nav-section">Dashboard</div>',
'<div class="nav-item" data-page="providers">Providers</div>',
'<div class="nav-section">Management</div>',
'<div class="nav-item" data-page="keys">API Keys</div>',
'<div class="nav-section">Tools</div>',
'<div class="nav-item" data-page="playground">Playground</div>',
'<div class="nav-item" data-page="docs">API Docs</div>',
'</nav>',
'<div class="main">',

'<div class="page active" id="page-overview">',
'<h1>Overview</h1>',
'<div class="notice">One provider at a time on free tier (512MB RAM). Connect one, log in via browser view, then chat.</div>',
'<div class="stats-row">',
'<div class="stat-card"><div class="stat-label">Active Provider</div><div class="stat-value" id="ov-active">None</div></div>',
'<div class="stat-card"><div class="stat-label">Status</div><div class="stat-value" id="ov-status" style="font-size:18px">Disconnected</div></div>',
'<div class="stat-card"><div class="stat-label">Total Requests</div><div class="stat-value" id="ov-requests">0</div></div>',
'<div class="stat-card"><div class="stat-label">API Keys</div><div class="stat-value" id="ov-keys">0</div></div>',
'</div>',
'<div class="mem-bar"><span>Memory</span><div class="bar"><div class="bar-fill" id="mem-fill" style="width:0%;background:var(--green)"></div></div><span id="mem-text">--</span></div>',
'<h2 style="margin-top:20px">Providers</h2>',
'<div class="providers-grid" id="ov-providers"></div>',
'</div>',

'<div class="page" id="page-providers">',
'<h1>Providers</h1>',
'<div class="notice">Only one provider at a time. Connecting a new one disconnects the current.</div>',
'<div class="providers-grid" id="pv-grid"></div>',
'</div>',

'<div class="page" id="page-keys">',
'<div style="display:flex;align-items:center;justify-content:space-between"><h1>API Keys</h1><button class="btn btn-primary" id="btn-genkey">+ Generate Key</button></div>',
'<table class="keys-table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Requests</th><th></th></tr></thead><tbody id="keys-body"></tbody></table>',
'</div>',

'<div class="page" id="page-playground">',
'<h1>Playground</h1>',
'<div class="playground-area">',
'<div class="pg-header">',
'<select id="pg-provider"><option value="">Select provider...</option></select>',
'<button class="btn btn-secondary btn-sm" id="btn-clear">Clear</button>',
'</div>',
'<div class="chat-messages" id="chat-msgs"></div>',
'<div class="chat-input-row">',
'<input id="chat-input" placeholder="Type a message...">',
'<button class="btn btn-primary" id="btn-send">Send</button>',
'</div>',
'</div>',
'</div>',

'<div class="page" id="page-docs">',
'<h1>API Docs</h1>',
'<div class="docs-content">',
'<h2>Endpoints</h2>',
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/init</span></div>',
'<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/providers/:id</span></div>',
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers/:id/screenshot</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/click</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/type</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/key</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/login</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/chat/:provider</span></div>',
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/keys</span></div>',
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/keys</span></div>',
'<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/keys/:key</span></div>',
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/stats</span></div>',
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers/:id/debug</span></div>',
'<br><h2>Debug</h2><p>Visit <code>/v1/providers/chatgpt/debug</code> to inspect the browser DOM.</p>',
'</div>',
'</div>',

'</div>',
'</div>',

'<div class="modal-overlay" id="bv-modal">',
'<div class="modal-box">',
'<div class="modal-top"><h3 id="bv-title">Provider</h3><button class="close-btn" id="bv-close">&times;</button></div>',
'<div class="bv-screen" id="bv-screen">',
'<img id="bv-img" src="">',
'<div class="loading-overlay" id="bv-loading"><div class="spinner"></div><span style="font-size:13px;color:var(--dim)">Launching browser...</span></div>',
'</div>',
'<div class="bv-status"><span class="dot gray" id="bv-dot"></span><span id="bv-msg">Loading...</span></div>',
'<div class="bv-controls">',
'<input id="bv-input" type="text" placeholder="Type here and press Enter...">',
'<button class="btn btn-primary btn-sm" id="bv-submit">Submit</button>',
'<button class="btn btn-secondary btn-sm" id="bv-enter">Enter</button>',
'<button class="btn btn-secondary btn-sm" id="bv-tab">Tab</button>',
'</div>',
'<div class="bv-hint">Click screenshot to interact. Type below for email/password fields.</div>',
'</div>',
'</div>',

'<script>',
'var bvProvider=null,bvPolling=null,providers=[],connecting=false;',

'// Navigation - event delegation',
'document.querySelector(".sidebar").addEventListener("click",function(e){',
'  var item=e.target.closest(".nav-item");',
'  if(!item)return;',
'  var page=item.getAttribute("data-page");',
'  if(!page)return;',
'  document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active");});',
'  document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});',
'  document.getElementById("page-"+page).classList.add("active");',
'  item.classList.add("active");',
'  loadAll();',
'  if(page==="keys")loadKeys();',
'});',

'async function loadAll(){',
'  try{',
'    var r1=await fetch("/v1/providers");',
'    var r2=await fetch("/v1/stats");',
'    providers=await r1.json();',
'    renderAll(providers,await r2.json());',
'  }catch(e){console.error("loadAll:",e);}',
'}',

'function renderAll(ps,s){',
'  var active=ps.find(function(p){return p.status==="connected"||p.status==="connecting"||p.status==="viewing";});',
'  document.getElementById("ov-active").textContent=active?active.name:"None";',
'  var st=active?active.status:"disconnected";',
'  document.getElementById("ov-status").textContent=st.charAt(0).toUpperCase()+st.slice(1);',
'  document.getElementById("ov-status").style.color=st==="connected"?"var(--green)":(st==="connecting"||st==="viewing")?"var(--yellow)":"var(--dim)";',
'  document.getElementById("ov-requests").textContent=s.totalRequests;',
'  renderGrid("ov-providers",ps);',
'  renderGrid("pv-grid",ps);',
'  // Playground dropdown: show connected AND viewing',
'  var sel=document.getElementById("pg-provider");',
'  var cur=sel.value;',
'  sel.innerHTML="<option value=\\"\\">Select provider...</option>"+',
'    ps.filter(function(p){return p.status==="connected"||p.status==="viewing";})',
'     .map(function(p){return "<option value=\\""+p.id+"\\">"+p.name+"</option>";}).join("");',
'  if(cur)sel.value=cur;',
'  // Memory',
'  fetch("/health").then(function(r){return r.json();}).then(function(h){',
'    var mb=Math.round(h.memory/1024/1024);',
'    var pct=Math.min(100,Math.round(mb/512*100));',
'    document.getElementById("mem-fill").style.width=pct+"%";',
'    document.getElementById("mem-fill").style.background=pct>80?"var(--red)":pct>60?"var(--yellow)":"var(--green)";',
'    document.getElementById("mem-text").textContent=mb+"MB / 512MB";',
'  }).catch(function(){});',
'}',

'function renderGrid(id,ps){',
'  var c=document.getElementById(id);',
'  if(!c)return;',
'  c.innerHTML=ps.map(function(p){',
'    var dotClass=p.status==="connected"?"green":(p.status==="connecting"||p.status==="viewing")?"yellow":"gray";',
'    var statusText=p.status.charAt(0).toUpperCase()+p.status.slice(1);',
'    var btns="";',
'    if(p.status==="disconnected"){',
'      btns="<button class=\\"btn btn-primary btn-sm\\" data-action=\\"connect\\" data-id=\\""+p.id+"\\">Connect</button>";',
'    }else if(p.status==="connecting"||p.status==="viewing"){',
'      btns="<button class=\\"btn btn-secondary btn-sm\\" data-action=\\"view\\" data-id=\\""+p.id+"\\">View Browser</button>";',
'    }else{',
'      btns="<button class=\\"btn btn-secondary btn-sm\\" data-action=\\"view\\" data-id=\\""+p.id+"\\">View Browser</button> <button class=\\"btn btn-danger btn-sm\\" data-action=\\"disconnect\\" data-id=\\""+p.id+"\\">Disconnect</button>";',
'    }',
'    var err=p.error?"<div class=\\"provider-error\\">"+escHtml(p.error)+"</div>":" ";',
'    return "<div class=\\"provider-card\\">"+',
'      "<div class=\\"provider-header\\"><div class=\\"provider-icon\\" style=\\"background:"+p.color+"\\">"+p.icon+"</div>"+',
'      "<div><div class=\\"provider-name\\">"+p.name+"</div><div class=\\"provider-company\\">"+p.company+"</div></div></div>"+',
'      "<div class=\\"provider-status\\"><span class=\\"dot "+dotClass+"\\"></span>"+statusText+"</div>"+',
'      "<div class=\\"provider-reqs\\">"+p.requests+" requests</div>"+err+btns+"</div>";',
'  }).join("");',
'}',

'// Grid button delegation',
'document.addEventListener("click",function(e){',
'  var btn=e.target.closest("[data-action]");',
'  if(!btn)return;',
'  var action=btn.getAttribute("data-action");',
'  var id=btn.getAttribute("data-id");',
'  if(action==="connect")connectP(id);',
'  else if(action==="view")openBV(id);',
'  else if(action==="disconnect")disconnectP(id);',
'});',

'async function connectP(id){',
'  if(connecting)return;',
'  connecting=true;',
'  try{',
'    var r=await fetch("/v1/providers/"+id+"/init",{method:"POST"});',
'    var d=await r.json();',
'    if(d.error){alert("Error: "+d.error);connecting=false;return;}',
'    openBV(id);',
'    loadAll();',
'  }catch(e){alert("Connection failed: "+e.message);}',
'  connecting=false;',
'}',

'async function disconnectP(id){',
'  try{await fetch("/v1/providers/"+id,{method:"DELETE"});loadAll();}catch(e){alert(e.message);}',
'}',

'// Browser view',
'function openBV(id){',
'  bvProvider=id;',
'  var p=providers.find(function(x){return x.id===id;});',
'  document.getElementById("bv-title").textContent=p?p.name+" \\u2014 Browser View":id;',
'  document.getElementById("bv-modal").classList.add("show");',
'  document.getElementById("bv-msg").textContent="Launching browser...";',
'  document.getElementById("bv-dot").className="dot yellow";',
'  document.getElementById("bv-input").value="";',
'  document.getElementById("bv-loading").style.display="flex";',
'  bvStartPolling();',
'}',
'function closeBV(){document.getElementById("bv-modal").classList.remove("show");bvStopPolling();bvProvider=null;}',
'function bvStartPolling(){bvStopPolling();bvPollTick();bvPolling=setInterval(bvPollTick,2000);}',
'function bvStopPolling(){if(bvPolling){clearInterval(bvPolling);bvPolling=null;}}',

'async function bvPollTick(){',
'  if(!bvProvider)return;',
'  try{',
'    var r=await fetch("/v1/providers/"+bvProvider+"/screenshot");',
'    if(r.ok){var d=await r.json();if(d.screenshot){document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;document.getElementById("bv-loading").style.display="none";}}',
'    var s=await fetch("/v1/providers");',
'    var all=await s.json();',
'    providers=all;',
'    var p=all.find(function(x){return x.id===bvProvider;});',
'    if(p){',
'      if(p.status==="connected"){document.getElementById("bv-msg").textContent="Logged in! Close and use Playground.";document.getElementById("bv-dot").className="dot green";}',
'      else if(p.status==="viewing"){document.getElementById("bv-msg").textContent="Page loaded \\u2014 interact to log in";document.getElementById("bv-dot").className="dot yellow";}',
'      else if(p.error){document.getElementById("bv-msg").textContent="Error: "+p.error;document.getElementById("bv-dot").className="dot red";}',
'    }',
'    renderAll(all,{totalRequests:0});',
'  }catch(e){}',
'}',

'// Browser view click',
'document.getElementById("bv-screen").addEventListener("click",function(event){',
'  if(!bvProvider)return;',
'  var img=document.getElementById("bv-img");',
'  var rect=img.getBoundingClientRect();',
'  var x=Math.round((event.clientX-rect.left)/rect.width*1024);',
'  var y=Math.round((event.clientY-rect.top)/rect.height*700);',
'  var ring=document.createElement("div");',
'  ring.className="click-ring";',
'  ring.style.left=(event.clientX-rect.left)+"px";',
'  ring.style.top=(event.clientY-rect.top)+"px";',
'  document.getElementById("bv-screen").appendChild(ring);',
'  setTimeout(function(){ring.remove();},500);',
'  fetch("/v1/providers/"+bvProvider+"/click",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({x:x,y:y})})',
'    .then(function(r){return r.json();})',
'    .then(function(d){',
'      if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;',
'      if(d.message)document.getElementById("bv-msg").textContent=d.message;',
'      if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}',
'      else document.getElementById("bv-dot").className="dot yellow";',
'    }).catch(function(e){document.getElementById("bv-msg").textContent="Error: "+e.message;});',
'});',

'// Browser view controls',
'document.getElementById("bv-close").addEventListener("click",closeBV);',
'document.getElementById("bv-submit").addEventListener("click",bvSubmit);',
'document.getElementById("bv-enter").addEventListener("click",function(){bvSendKey("Enter");});',
'document.getElementById("bv-tab").addEventListener("click",function(){bvSendKey("Tab");});',
'document.getElementById("bv-input").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();bvSubmit();}});',

'async function bvSubmit(){',
'  if(!bvProvider)return;',
'  var input=document.getElementById("bv-input");',
'  var val=input.value.trim();',
'  if(!val)return;',
'  var msg=document.getElementById("bv-msg").textContent.toLowerCase();',
'  var ft="text";',
'  if(msg.indexOf("email")!==-1)ft="email";',
'  else if(msg.indexOf("password")!==-1)ft="password";',
'  else if(msg.indexOf("code")!==-1||msg.indexOf("verification")!==-1)ft="code";',
'  try{',
'    var url=ft!=="text"?"/v1/providers/"+bvProvider+"/login":"/v1/providers/"+bvProvider+"/type";',
'    var body=ft!=="text"?JSON.stringify({fieldType:ft,value:val}):JSON.stringify({text:val});',
'    var r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:body});',
'    var d=await r.json();',
'    if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;',
'    if(d.message)document.getElementById("bv-msg").textContent=d.message;',
'    if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}',
'    else document.getElementById("bv-dot").className="dot yellow";',
'    input.value="";',
'  }catch(e){document.getElementById("bv-msg").textContent="Error: "+e.message;}',
'}',

'async function bvSendKey(key){',
'  if(!bvProvider)return;',
'  try{',
'    var r=await fetch("/v1/providers/"+bvProvider+"/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key})});',
'    var d=await r.json();',
'    if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;',
'    if(d.message)document.getElementById("bv-msg").textContent=d.message;',
'    if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}',
'  }catch(e){document.getElementById("bv-msg").textContent="Error: "+e.message;}',
'}',

'// Playground',
'document.getElementById("btn-send").addEventListener("click",sendMsg);',
'document.getElementById("btn-clear").addEventListener("click",function(){document.getElementById("chat-msgs").innerHTML="";});',
'document.getElementById("chat-input").addEventListener("keydown",function(e){if(e.key==="Enter")sendMsg();});',
'document.getElementById("btn-genkey").addEventListener("click",genKey);',

'async function sendMsg(){',
'  var input=document.getElementById("chat-input");',
'  var provider=document.getElementById("pg-provider").value;',
'  var msg=input.value.trim();',
'  if(!msg||!provider)return;',
'  var msgs=document.getElementById("chat-msgs");',
'  msgs.innerHTML+="<div class=\\"msg user\\"><div class=\\"label\\">You</div><div class=\\"bubble\\">"+escHtml(msg)+"</div></div>";',
'  msgs.innerHTML+="<div class=\\"msg ai\\" id=\\"thinking\\"><div class=\\"label\\">"+provider+"</div><div class=\\"bubble\\"><span class=\\"spinner\\"></span> Thinking...</div></div>";',
'  msgs.scrollTop=msgs.scrollHeight;',
'  input.value="";',
'  try{',
'    var r=await fetch("/v1/chat/"+provider,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});',
'    var d=await r.json();',
'    var t=document.getElementById("thinking");if(t)t.remove();',
'    var reply=d.error?"Error: "+d.error:(d.choices&&d.choices[0]?d.choices[0].message.content:"No response");',
'    msgs.innerHTML+="<div class=\\"msg ai\\"><div class=\\"label\\">"+provider+"</div><div class=\\"bubble\\">"+escHtml(reply)+"</div></div>";',
'  }catch(e){',
'    var t2=document.getElementById("thinking");if(t2)t2.remove();',
'    msgs.innerHTML+="<div class=\\"msg ai\\"><div class=\\"label\\">Error</div><div class=\\"bubble\\" style=\\"color:var(--red)\\">"+escHtml(e.message)+"</div></div>";',
'  }',
'  msgs.scrollTop=msgs.scrollHeight;',
'}',

'function escHtml(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}',

'// Keys',
'async function loadKeys(){',
'  try{',
'    var r=await fetch("/v1/keys");',
'    var keys=await r.json();',
'    var body=document.getElementById("keys-body");',
'    if(keys.length){',
'      body.innerHTML=keys.map(function(k){',
'        return "<tr><td>"+escHtml(k.name)+"</td><td><span class=\\"key-value\\">"+k.key+"</span></td>"+',
'          "<td>"+new Date(k.created).toLocaleDateString()+"</td><td>"+k.requests+"</td>"+',
'          "<td><button class=\\"btn btn-danger btn-sm\\" data-revoke=\\""+k.fullKey+"\\">Revoke</button></td></tr>";',
'      }).join("");',
'    }else{',
'      body.innerHTML="<tr><td colspan=\\"5\\" style=\\"text-align:center;color:var(--dim);padding:30px\\">No API keys yet.</td></tr>";',
'    }',
'    document.getElementById("ov-keys").textContent=keys.length;',
'  }catch(e){}',
'}',

'document.getElementById("keys-body").addEventListener("click",function(e){',
'  var btn=e.target.closest("[data-revoke]");',
'  if(!btn)return;',
'  var key=btn.getAttribute("data-revoke");',
'  if(!confirm("Revoke this key?"))return;',
'  fetch("/v1/keys/"+encodeURIComponent(key),{method:"DELETE"}).then(function(){loadKeys();}).catch(function(e){alert(e.message);});',
'});',

'async function genKey(){',
'  var name=prompt("Key name:");',
'  if(!name)return;',
'  try{',
'    var r=await fetch("/v1/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name})});',
'    var d=await r.json();',
'    alert("Key: "+d.key+"\\nSave it now.");',
'    loadKeys();',
'  }catch(e){alert(e.message);}',
'}',

'loadAll();loadKeys();setInterval(loadAll,15000);',
'</script>',
'</body></html>'
].join('\n');

// Start
app.listen(PORT, function() { console.log('Nova API v3.3 on port ' + PORT); });
process.on('SIGTERM', async function() { if (browser) await browser.close().catch(function() {}); process.exit(0); });
process.on('uncaughtException', function(e) { console.error('[CRASH]', e.message); });
process.on('unhandledRejection', function(e) { console.error('[REJECT]', String(e)); });
