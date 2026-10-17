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
let activeProvider = null;
const providers = {};
const apiKeys = {};
const stats = { totalRequests: 0 };
Object.keys(PROVIDERS).forEach(function(id) {
  providers[id] = { status: 'disconnected', requests: 0, lastUsed: null, error: null, context: null, page: null };
});

// ====== SESSIONS ======
function loadSession(id) {
  try {
    var f = path.join(SESSIONS_DIR, id + '.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {}
  return null;
}

function saveSession(id, state) {
  try { fs.writeFileSync(path.join(SESSIONS_DIR, id + '.json'), JSON.stringify(state)); } catch (e) {}
}

// ====== BROWSER ======
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('[Browser] Launching Firefox...');
  browser = await firefox.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  browser.on('disconnected', function() {
    browser = null;
    if (activeProvider) {
      providers[activeProvider].status = 'disconnected';
      providers[activeProvider].context = null;
      providers[activeProvider].page = null;
      activeProvider = null;
    }
    console.log('[Browser] Firefox disconnected');
  });
  console.log('[Browser] Firefox launched OK');
  return browser;
}

async function closeActiveProvider() {
  try {
    if (activeProvider && providers[activeProvider]) {
      try { await providers[activeProvider].context.close(); } catch (e) {}
      providers[activeProvider] = { ...providers[activeProvider], status: 'disconnected', context: null, page: null };
    }
  } catch (e) {}
  activeProvider = null;
  try { if (browser) await browser.close(); } catch (e) {}
  browser = null;
}

async function initProvider(id) {
  if (!PROVIDERS[id]) throw new Error('Unknown provider');

  if (activeProvider && activeProvider !== id) {
    console.log('[Init] Disconnecting', activeProvider, 'to connect', id);
    try {
      providers[activeProvider].status = 'disconnected';
      if (providers[activeProvider].context) await providers[activeProvider].context.close().catch(function() {});
    } catch (e) {}
    providers[activeProvider].context = null;
    providers[activeProvider].page = null;
    try { if (browser) await browser.close(); } catch (e) {}
    browser = null;
    activeProvider = null;
  }

  providers[id].status = 'connecting';
  providers[id].error = null;

  try {
    var b = await getBrowser();
    var saved = loadSession(id);
    var ctxOpts = { viewport: { width: 1024, height: 700 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0' };
    if (saved) ctxOpts.storageState = saved;
    var ctx = await b.newContext(ctxOpts);
    var page = await ctx.newPage();
    console.log('[Init] Navigating to', PROVIDERS[id].url);
    await page.goto(PROVIDERS[id].url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    providers[id].context = ctx;
    providers[id].page = page;
    providers[id].status = 'viewing';
    activeProvider = id;

    var state = await detectState(id);
    console.log('[Init] State:', state.state);
    if (state.state === 'connected') {
      providers[id].status = 'connected';
      saveSession(id, await ctx.storageState());
    }

    var screenshot = await getScreenshot(id);
    return { state: state.state, message: state.message, screenshot: screenshot };
  } catch (e) {
    console.error('[Init] Error:', e.message);
    providers[id].status = 'disconnected';
    providers[id].error = e.message;
    throw e;
  }
}

// ====== DETECT STATE ======
async function detectState(id) {
  var p = providers[id];
  if (!p || !p.page) return { state: 'disconnected', message: 'Not connected' };
  try {
    var hasEmail = await p.page.$('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
    var hasPass = await p.page.$('input[type="password"]');
    var hasCode = await p.page.$('input[name="code"], input[autocomplete="one-time-code"]');
    var hasChat = await p.page.$('#prompt-textarea, textarea:not([aria-hidden="true"]), [contenteditable="true"][role="textbox"], div[contenteditable="true"]');
    if (hasCode) return { state: 'needs_code', message: 'Verification code required' };
    if (hasPass && !hasChat) return { state: 'needs_password', message: 'Password required' };
    if (hasEmail && !hasChat) return { state: 'needs_email', message: 'Email required' };
    if (hasChat) {
      providers[id].status = 'connected';
      try { saveSession(id, await p.context.storageState()); } catch (e) {}
      return { state: 'connected', message: 'Logged in! Ready to chat.' };
    }
  } catch (e) { console.log('[Detect] Error:', e.message); }
  return { state: 'viewing', message: 'Page loaded' };
}

// ====== SCREENSHOT ======
async function getScreenshot(id) {
  var p = providers[id];
  if (!p || !p.page) return null;
  try {
    var buf = await p.page.screenshot({ type: 'jpeg', quality: 35 });
    return buf.toString('base64');
  } catch (e) {
    console.log('[Screenshot] Error:', e.message);
    return null;
  }
}

// ====== BROWSER INTERACTIONS ======
async function clickAt(id, x, y) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.mouse.click(x, y);
  await p.page.waitForTimeout(1500);
  var state = await detectState(id);
  return { state: state.state, message: state.message, screenshot: await getScreenshot(id) };
}

async function typeText(id, text) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.keyboard.type(text, { delay: 20 });
  return { screenshot: await getScreenshot(id) };
}

async function pressKey(id, key) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  await p.page.keyboard.press(key);
  await p.page.waitForTimeout(2000);
  var state = await detectState(id);
  return { state: state.state, message: state.message, screenshot: await getScreenshot(id) };
}

async function fillField(id, fieldType, value) {
  var p = providers[id]; if (!p || !p.page) throw new Error('Not connected');
  var sel = fieldType === 'email' ? 'input[type="email"], input[name="email"], input[name="username"]'
    : fieldType === 'password' ? 'input[type="password"]'
    : 'input[name="code"], input[autocomplete="one-time-code"], input[type="tel"]';
  var input = await p.page.waitForSelector(sel, { timeout: 8000 });
  await input.click();
  await input.fill(value);
  await p.page.waitForTimeout(300);
  await p.page.keyboard.press('Enter');
  await p.page.waitForTimeout(4000);
  var state = await detectState(id);
  return { state: state.state, message: state.message, screenshot: await getScreenshot(id) };
}

// ====== SEND CHAT MESSAGE (SIMPLIFIED + CRASH-PROOF) ======
async function sendChatMessage(id, message) {
  var p = providers[id];
  if (!p || !p.page) throw new Error('Not connected');
  if (p.status !== 'connected' && p.status !== 'viewing') throw new Error('Not logged in yet');
  var page = p.page;

  console.log('[Chat] Sending to', id, ':', message.substring(0, 80));

  // Step 1: Try to navigate to new chat
  try {
    var newChatBtn = await page.$('a[href="/"], a[href="/new"], nav a:first-child');
    if (newChatBtn) {
      await newChatBtn.click();
      await page.waitForTimeout(2000);
    }
  } catch (e) { console.log('[Chat] New chat nav skipped:', e.message); }

  // Step 2: Find input
  var input = null;
  var inputSelectors = ['#prompt-textarea', 'textarea[data-id="root"]', 'textarea[placeholder]', 'textarea', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'];
  for (var i = 0; i < inputSelectors.length; i++) {
    try {
      input = await page.$(inputSelectors[i]);
      if (input) { console.log('[Chat] Input found:', inputSelectors[i]); break; }
    } catch (e) {}
  }
  if (!input) throw new Error('Cannot find chat input');

  // Step 3: Fill input
  await input.click();
  await page.waitForTimeout(300);

  var filled = false;
  try { await input.fill(message); filled = true; console.log('[Chat] fill() OK'); } catch (e) { console.log('[Chat] fill() failed:', e.message); }

  if (!filled) {
    try {
      await input.evaluate(function(el, msg) {
        if (el.tagName === 'TEXTAREA') { el.value = msg; el.dispatchEvent(new Event('input', { bubbles: true })); }
        else { el.focus(); document.execCommand('insertText', false, msg); }
      }, message);
      filled = true;
      console.log('[Chat] evaluate fill OK');
    } catch (e) { console.log('[Chat] evaluate fill failed:', e.message); }
  }

  if (!filled) {
    await page.keyboard.type(message, { delay: 10 });
    console.log('[Chat] Typed via keyboard');
  }

  await page.waitForTimeout(800);

  // Step 4: Count existing assistant messages
  var beforeCount = 0;
  try {
    beforeCount = await page.evaluate(function() {
      return document.querySelectorAll('[data-message-author-role="assistant"]').length;
    });
  } catch (e) { console.log('[Chat] Count error:', e.message); }
  console.log('[Chat] Assistant msgs before:', beforeCount);

  // Step 5: Send
  var sent = false;
  try {
    var sendBtn = await page.$('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label*="Send"], button[aria-label*="send"]');
    if (sendBtn) { await sendBtn.click(); sent = true; console.log('[Chat] Clicked send'); }
  } catch (e) { console.log('[Chat] Send btn error:', e.message); }
  if (!sent) {
    await page.keyboard.press('Enter');
    console.log('[Chat] Pressed Enter');
  }

  // Step 6: Wait for response
  console.log('[Chat] Waiting for response...');
  await page.waitForTimeout(6000);

  var lastText = '';
  var stableCount = 0;
  var maxPolls = 20;

  for (var poll = 0; poll < maxPolls; poll++) {
    var text = '';
    try {
      text = await page.evaluate(function(beforeCount) {
        var result = '';

        // Strategy 1: data-message-author-role="assistant"
        var msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (msgs.length > beforeCount) {
          result = msgs[msgs.length - 1].innerText || '';
          if (result.length > 5) return result;
        }

        // Strategy 2: .markdown.prose or .prose
        var prose = document.querySelectorAll('.markdown.prose, .prose, .markdown');
        if (prose.length > 0) {
          result = prose[prose.length - 1].innerText || '';
          if (result.length > 5) return result;
        }

        // Strategy 3: testid selectors
        var turns = document.querySelectorAll('[data-testid*="conversation-turn"], [data-testid*="assistant"], [data-testid*="bot"]');
        if (turns.length > 0) {
          result = turns[turns.length - 1].innerText || '';
          if (result.length > 5) return result;
        }

        // Strategy 4: broad class search
        var broad = document.querySelectorAll('.agent-turn, [class*="assistant"], [class*="Turn"], [class*="response"]');
        for (var i = broad.length - 1; i >= 0; i--) {
          var t = (broad[i].innerText || '').trim();
          if (t.length > 20) return t;
        }

        return '';
      }, beforeCount);
    } catch (e) {
      console.log('[Chat] Evaluate error:', e.message);
      break;
    }

    console.log('[Chat] Poll', poll, 'text length:', text.length);

    if (text.length > 10) {
      if (text === lastText) {
        stableCount++;
        console.log('[Chat] Stable:', stableCount, '/2');
        if (stableCount >= 2) {
          console.log('[Chat] Response ready, length:', text.length);
          // Update stats
          stats.totalRequests++;
          providers[id].requests++;
          providers[id].lastUsed = new Date().toISOString();
          try { saveSession(id, await p.context.storageState()); } catch (e) {}
          return text;
        }
      } else {
        stableCount = 0;
        lastText = text;
      }
    }

    await page.waitForTimeout(3000);
  }

  // Return whatever we have
  if (lastText.length > 10) {
    stats.totalRequests++;
    providers[id].requests++;
    providers[id].lastUsed = new Date().toISOString();
    try { saveSession(id, await p.context.storageState()); } catch (e) {}
    return lastText;
  }

  return 'Response timed out. Open the Browser View to check if the AI replied, then try again.';
}

// ====== DEBUG ENDPOINT ======
app.get('/v1/providers/:id/debug', async function(req, res) {
  try {
    var p = providers[req.params.id];
    if (!p || !p.page) return res.json({ error: 'Not connected' });
    var info = await p.page.evaluate(function() {
      var r = { url: window.location.href, title: document.title, bodyLen: document.body.innerText.length };
      var checks = {
        'dataMsgRole': '[data-message-author-role="assistant"]',
        'prose': '.markdown.prose, .prose',
        'testId': '[data-testid*="conversation-turn"]',
        'textarea': 'textarea',
        'promptArea': '#prompt-textarea',
        'contenteditable': '[contenteditable="true"]'
      };
      r.elements = {};
      for (var k in checks) {
        var els = document.querySelectorAll(checks[k]);
        r.elements[k] = { count: els.length, lastText: els.length > 0 ? (els[els.length - 1].innerText || '').substring(0, 300) : '' };
      }
      return r;
    });
    res.json(info);
  } catch (e) { res.json({ error: e.message }); }
});

// ====== ROUTES ======
app.get('/favicon.ico', function(req, res) { res.status(204).end(); });

app.get('/v1/providers', function(req, res) {
  try {
    var list = [];
    Object.keys(PROVIDERS).forEach(function(id) {
      list.push({
        id: id,
        name: PROVIDERS[id].name,
        company: PROVIDERS[id].company,
        color: PROVIDERS[id].color,
        icon: PROVIDERS[id].icon,
        url: PROVIDERS[id].url,
        status: providers[id].status,
        requests: providers[id].requests,
        error: providers[id].error || null
      });
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/providers/:id/init', async function(req, res) {
  try {
    var result = await initProvider(req.params.id);
    res.json(result);
  } catch (e) {
    console.error('[Init Error]', req.params.id, e.message);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/v1/providers/:id', async function(req, res) {
  try {
    if (activeProvider === req.params.id) await closeActiveProvider();
    else if (providers[req.params.id]) providers[req.params.id].status = 'disconnected';
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/v1/providers/:id/screenshot', async function(req, res) {
  try {
    var s = await getScreenshot(req.params.id);
    if (s) res.json({ screenshot: s });
    else res.status(404).json({ error: 'No screenshot' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/providers/:id/click', async function(req, res) {
  try { res.json(await clickAt(req.params.id, req.body.x, req.body.y)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/providers/:id/type', async function(req, res) {
  try { res.json(await typeText(req.params.id, req.body.text)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/providers/:id/key', async function(req, res) {
  try { res.json(await pressKey(req.params.id, req.body.key)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/providers/:id/login', async function(req, res) {
  try { res.json(await fillField(req.params.id, req.body.fieldType, req.body.value)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/chat/:provider', async function(req, res) {
  try {
    console.log('[Chat Request]', req.params.provider);
    var response = await sendChatMessage(req.params.provider, req.body.message);
    res.json({
      id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion',
      model: PROVIDERS[req.params.provider] ? PROVIDERS[req.params.provider].name : req.params.provider,
      choices: [{ index: 0, message: { role: 'assistant', content: response }, finish_reason: 'stop' }]
    });
  } catch (e) {
    console.error('[Chat Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/v1/keys', function(req, res) {
  try {
    var list = [];
    Object.keys(apiKeys).forEach(function(k) {
      list.push({ key: k.slice(0, 8) + '...' + k.slice(-4), fullKey: k, name: apiKeys[k].name, created: apiKeys[k].created, requests: apiKeys[k].requests });
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/v1/keys', function(req, res) {
  try {
    var key = 'nva-' + crypto.randomBytes(24).toString('hex');
    apiKeys[key] = { name: req.body.name || 'Unnamed', created: new Date().toISOString(), requests: 0 };
    res.json({ key: key, name: apiKeys[key].name, created: apiKeys[key].created, requests: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/v1/keys/:key', function(req, res) {
  try {
    if (apiKeys[req.params.key]) { delete apiKeys[req.params.key]; res.json({ ok: true }); }
    else res.status(404).json({ error: 'Not found' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/v1/stats', function(req, res) { res.json(stats); });

app.get('/health', function(req, res) {
  res.json({ status: 'ok', memory: process.memoryUsage().rss, active: activeProvider });
});

// ====== FRONTEND ======
app.get('/', function(req, res) { res.send(HTML); });

var HTML = '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'<title>Nova API</title>\n' +
'<style>\n' +
'*{margin:0;padding:0;box-sizing:border-box}\n' +
':root{--bg:#06060f;--surface:#0c0c18;--card:#111122;--border:#1a1a30;--text:#e0e0f0;--dim:#7070a0;--accent:#6366f1;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--grad:linear-gradient(135deg,#6366f1,#a855f7)}\n' +
'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}\n' +
'.app{display:flex;min-height:100vh}\n' +
'.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);padding:20px 0;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;z-index:100}\n' +
'.logo{padding:0 20px 24px;font-size:20px;font-weight:700;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent}\n' +
'.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;color:var(--dim);cursor:pointer;font-size:14px;transition:.2s;border-left:3px solid transparent}\n' +
'.nav-item:hover,.nav-item.active{color:var(--text);background:rgba(99,102,241,.08);border-left-color:var(--accent)}\n' +
'.nav-section{padding:16px 20px 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}\n' +
'.main{margin-left:220px;flex:1;padding:28px 32px;min-height:100vh}\n' +
'.page{display:none}.page.active{display:block}\n' +
'h1{font-size:24px;margin-bottom:20px}h2{font-size:18px;margin-bottom:16px;color:var(--dim)}\n' +
'.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:28px}\n' +
'.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px 20px}\n' +
'.stat-label{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px}\n' +
'.stat-value{font-size:28px;font-weight:700;margin-top:4px}\n' +
'.providers-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}\n' +
'.provider-card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:20px;transition:.2s}\n' +
'.provider-card:hover{border-color:var(--accent);transform:translateY(-2px)}\n' +
'.provider-header{display:flex;align-items:center;gap:12px;margin-bottom:14px}\n' +
'.provider-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;color:#fff}\n' +
'.provider-name{font-size:16px;font-weight:600}.provider-company{font-size:12px;color:var(--dim)}\n' +
'.provider-status{display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:14px}\n' +
'.dot{width:8px;height:8px;border-radius:50%}\n' +
'.dot.green{background:var(--green)}.dot.yellow{background:var(--yellow)}.dot.gray{background:#555}.dot.red{background:var(--red)}\n' +
'.provider-reqs{font-size:12px;color:var(--dim);margin-bottom:14px}\n' +
'.provider-error{font-size:12px;color:var(--red);margin-bottom:10px;padding:8px;background:rgba(239,68,68,.08);border-radius:6px}\n' +
'.btn{padding:8px 16px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;transition:.2s;display:inline-flex;align-items:center;gap:6px}\n' +
'.btn-primary{background:var(--grad);color:#fff}.btn-primary:hover{opacity:.85}\n' +
'.btn-danger{background:rgba(239,68,68,.15);color:var(--red);border:1px solid rgba(239,68,68,.3)}.btn-danger:hover{background:rgba(239,68,68,.25)}\n' +
'.btn-secondary{background:rgba(255,255,255,.06);color:var(--text);border:1px solid var(--border)}.btn-secondary:hover{background:rgba(255,255,255,.1)}\n' +
'.btn-sm{padding:6px 12px;font-size:12px}\n' +
'.keys-table{width:100%;border-collapse:collapse;margin-top:16px}\n' +
'.keys-table th,.keys-table td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);font-size:13px}\n' +
'.keys-table th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}\n' +
'.key-value{font-family:monospace;font-size:12px;background:rgba(255,255,255,.04);padding:4px 8px;border-radius:4px}\n' +
'.playground-area{display:flex;flex-direction:column;height:calc(100vh - 140px)}\n' +
'.pg-header{display:flex;align-items:center;gap:12px;margin-bottom:16px}\n' +
'select{background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}\n' +
'select:focus{outline:none;border-color:var(--accent)}\n' +
'.chat-messages{flex:1;overflow-y:auto;padding:16px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:12px}\n' +
'.msg{margin-bottom:12px;max-width:80%}.msg.user{margin-left:auto;text-align:right}\n' +
'.msg .bubble{display:inline-block;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word}\n' +
'.msg.user .bubble{background:var(--accent);color:#fff}\n' +
'.msg.ai .bubble{background:rgba(255,255,255,.06);border:1px solid var(--border)}\n' +
'.msg .label{font-size:11px;color:var(--dim);margin-bottom:4px}\n' +
'.chat-input-row{display:flex;gap:8px}\n' +
'.chat-input-row input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px 16px;font-size:14px}\n' +
'.chat-input-row input:focus{outline:none;border-color:var(--accent)}\n' +
'.docs-content{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px;font-size:14px;line-height:1.8}\n' +
'.docs-content code{background:rgba(255,255,255,.06);padding:2px 6px;border-radius:4px;font-size:13px}\n' +
'.docs-content pre{background:rgba(0,0,0,.3);padding:16px;border-radius:8px;overflow-x:auto;margin:12px 0;font-size:13px}\n' +
'.endpoint{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}\n' +
'.method{font-size:11px;font-weight:700;padding:3px 8px;border-radius:4px;min-width:50px;text-align:center}\n' +
'.method.get{background:rgba(34,197,94,.15);color:var(--green)}\n' +
'.method.post{background:rgba(99,102,241,.15);color:var(--accent)}\n' +
'.method.delete{background:rgba(239,68,68,.15);color:var(--red)}\n' +
'.ep-path{font-family:monospace;font-size:13px}\n' +
'.mem-bar{margin-top:12px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--dim);display:flex;align-items:center;gap:10px}\n' +
'.mem-bar .bar{flex:1;height:6px;background:rgba(255,255,255,.06);border-radius:3px;overflow:hidden}\n' +
'.mem-bar .bar-fill{height:100%;border-radius:3px;transition:.3s}\n' +
'.notice{padding:12px 16px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.2);border-radius:10px;font-size:13px;color:var(--yellow);margin-bottom:20px}\n' +
'.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.85);z-index:1000;align-items:center;justify-content:center}\n' +
'.modal-overlay.show{display:flex}\n' +
'.modal-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;width:95%;max-width:960px;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}\n' +
'.modal-top{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)}\n' +
'.modal-top h3{font-size:15px;font-weight:600}\n' +
'.close-btn{background:none;border:none;color:var(--dim);font-size:22px;cursor:pointer;padding:4px 8px}.close-btn:hover{color:var(--text)}\n' +
'.bv-screen{position:relative;background:#000;border-radius:8px;overflow:hidden;margin:16px 20px 0;cursor:crosshair}\n' +
'.bv-screen img{width:100%;display:block;pointer-events:none}\n' +
'.bv-screen .click-ring{position:absolute;width:20px;height:20px;border:2px solid var(--accent);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;animation:ping .4s ease-out forwards}\n' +
'@keyframes ping{0%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(2)}}\n' +
'.bv-status{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px}\n' +
'.bv-controls{display:flex;gap:8px;padding:0 20px 16px}\n' +
'.bv-controls input{flex:1;background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13px}\n' +
'.bv-controls input:focus{outline:none;border-color:var(--accent)}\n' +
'.bv-hint{padding:0 20px 14px;font-size:11px;color:var(--dim)}\n' +
'.spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--dim);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}\n' +
'@keyframes spin{to{transform:rotate(360deg)}}\n' +
'.loading-overlay{position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);display:flex;flex-direction:column;align-items:center;justify-content:center;border-radius:8px;z-index:5}\n' +
'.loading-overlay .spinner{width:28px;height:28px;margin-bottom:12px}\n' +
'</style>\n</head>\n<body>\n' +

'<div class="app">\n' +
'<nav class="sidebar">\n' +
'<div class="logo">Nova API</div>\n' +
'<div class="nav-item active" onclick="nav(\'overview\',this)">Overview</div>\n' +
'<div class="nav-section">Dashboard</div>\n' +
'<div class="nav-item" onclick="nav(\'providers\',this)">Providers</div>\n' +
'<div class="nav-section">Management</div>\n' +
'<div class="nav-item" onclick="nav(\'keys\',this)">API Keys</div>\n' +
'<div class="nav-section">Tools</div>\n' +
'<div class="nav-item" onclick="nav(\'playground\',this)">Playground</div>\n' +
'<div class="nav-item" onclick="nav(\'docs\',this)">API Docs</div>\n' +
'</nav>\n' +

'<div class="main">\n' +

// Overview page
'<div class="page active" id="page-overview">\n' +
'<h1>Overview</h1>\n' +
'<div class="notice">One provider at a time on free tier (512MB RAM). Connect, log in via Browser View, then chat.</div>\n' +
'<div class="stats-row">\n' +
'<div class="stat-card"><div class="stat-label">Active Provider</div><div class="stat-value" id="ov-active">None</div></div>\n' +
'<div class="stat-card"><div class="stat-label">Status</div><div class="stat-value" id="ov-status" style="font-size:18px">Disconnected</div></div>\n' +
'<div class="stat-card"><div class="stat-label">Total Requests</div><div class="stat-value" id="ov-requests">0</div></div>\n' +
'<div class="stat-card"><div class="stat-label">API Keys</div><div class="stat-value" id="ov-keys">0</div></div>\n' +
'</div>\n' +
'<div class="mem-bar"><span>Memory</span><div class="bar"><div class="bar-fill" id="mem-fill" style="width:0%;background:var(--green)"></div></div><span id="mem-text">--</span></div>\n' +
'<h2 style="margin-top:20px">Providers</h2>\n' +
'<div class="providers-grid" id="ov-providers"></div>\n' +
'</div>\n' +

// Providers page
'<div class="page" id="page-providers">\n' +
'<h1>Providers</h1>\n' +
'<div class="notice">Only one provider at a time. Connecting a new one disconnects the current.</div>\n' +
'<div class="providers-grid" id="pv-grid"></div>\n' +
'</div>\n' +

// Keys page
'<div class="page" id="page-keys">\n' +
'<div style="display:flex;align-items:center;justify-content:space-between"><h1>API Keys</h1><button class="btn btn-primary" onclick="genKey()">+ Generate Key</button></div>\n' +
'<table class="keys-table"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Requests</th><th></th></tr></thead><tbody id="keys-body"></tbody></table>\n' +
'</div>\n' +

// Playground page
'<div class="page" id="page-playground">\n' +
'<h1>Playground</h1>\n' +
'<div class="playground-area">\n' +
'<div class="pg-header">\n' +
'<select id="pg-provider"><option value="">Select provider...</option></select>\n' +
'<button class="btn btn-secondary btn-sm" onclick="clearChat()">Clear</button>\n' +
'</div>\n' +
'<div class="chat-messages" id="chat-msgs"></div>\n' +
'<div class="chat-input-row">\n' +
'<input id="chat-input" placeholder="Type a message..." onkeydown="if(event.key===\'Enter\')sendMsg()">\n' +
'<button class="btn btn-primary" onclick="sendMsg()">Send</button>\n' +
'</div>\n' +
'</div>\n' +
'</div>\n' +

// Docs page
'<div class="page" id="page-docs">\n' +
'<h1>API Docs</h1>\n' +
'<div class="docs-content">\n' +
'<h2>Endpoints</h2>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/init</span></div>\n' +
'<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/providers/:id</span></div>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers/:id/screenshot</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/click</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/type</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/key</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/providers/:id/login</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/chat/:provider</span></div>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/keys</span></div>\n' +
'<div class="endpoint"><span class="method post">POST</span><span class="ep-path">/v1/keys</span></div>\n' +
'<div class="endpoint"><span class="method delete">DEL</span><span class="ep-path">/v1/keys/:key</span></div>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/stats</span></div>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/v1/providers/:id/debug</span></div>\n' +
'<div class="endpoint"><span class="method get">GET</span><span class="ep-path">/health</span></div>\n' +
'<br><h2>Debug</h2>\n' +
'<p>Visit <code>/v1/providers/chatgpt/debug</code> to see what the browser sees.</p>\n' +
'</div>\n</div>\n' +

'</div>\n</div>\n' +

// Browser View Modal
'<div class="modal-overlay" id="bv-modal">\n' +
'<div class="modal-box">\n' +
'<div class="modal-top"><h3 id="bv-title">Provider</h3><button class="close-btn" onclick="closeBV()">&times;</button></div>\n' +
'<div class="bv-screen" id="bv-screen" onclick="bvClick(event)">\n' +
'<img id="bv-img" src="">\n' +
'<div class="loading-overlay" id="bv-loading"><div class="spinner"></div><span style="font-size:13px;color:var(--dim)">Launching browser...</span></div>\n' +
'</div>\n' +
'<div class="bv-status"><span class="dot gray" id="bv-dot"></span><span id="bv-msg">Loading...</span></div>\n' +
'<div class="bv-controls">\n' +
'<input id="bv-input" type="text" placeholder="Type here and press Enter..." onkeydown="if(event.key===\'Enter\'){bvSubmit();event.preventDefault()}">\n' +
'<button class="btn btn-primary btn-sm" onclick="bvSubmit()">Submit</button>\n' +
'<button class="btn btn-secondary btn-sm" onclick="bvSendKey(\'Enter\')">Enter</button>\n' +
'<button class="btn btn-secondary btn-sm" onclick="bvSendKey(\'Tab\')">Tab</button>\n' +
'</div>\n' +
'<div class="bv-hint">Click screenshot to interact. Type below for email/password fields.</div>\n' +
'</div>\n</div>\n' +

// JavaScript
'<script>\n' +
'var bvProvider=null,bvPolling=null,providers=[],connecting=false;\n' +

'function nav(page,el){\n' +
'  document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active");});\n' +
'  document.querySelectorAll(".nav-item").forEach(function(n){n.classList.remove("active");});\n' +
'  document.getElementById("page-"+page).classList.add("active");\n' +
'  if(el)el.classList.add("active");\n' +
'  loadAll();\n' +
'  if(page==="keys")loadKeys();\n' +
'}\n' +

'async function loadAll(){\n' +
'  try{\n' +
'    var r1=await fetch("/v1/providers");\n' +
'    var r2=await fetch("/v1/stats");\n' +
'    providers=await r1.json();\n' +
'    var s=await r2.json();\n' +
'    renderAll(providers,s);\n' +
'  }catch(e){console.error("loadAll:",e);}\n' +
'}\n' +

'function renderAll(ps,s){\n' +
'  var active=ps.find(function(p){return p.status==="connected"||p.status==="connecting"||p.status==="viewing";});\n' +
'  document.getElementById("ov-active").textContent=active?active.name:"None";\n' +
'  var st=active?active.status:"disconnected";\n' +
'  document.getElementById("ov-status").textContent=st.charAt(0).toUpperCase()+st.slice(1);\n' +
'  document.getElementById("ov-status").style.color=st==="connected"?"var(--green)":(st==="connecting"||st==="viewing")?"var(--yellow)":"var(--dim)";\n' +
'  document.getElementById("ov-requests").textContent=s.totalRequests;\n' +
'  renderGrid("ov-providers",ps);\n' +
'  renderGrid("pv-grid",ps);\n' +

'  var sel=document.getElementById("pg-provider");\n' +
'  var cur=sel.value;\n' +
'  var opts="<option value=\\"\\">Select provider...</option>";\n' +
'  for(var i=0;i<ps.length;i++){\n' +
'    if(ps[i].status==="connected"||ps[i].status==="viewing"){\n' +
'      opts+="<option value=\\""+ps[i].id+"\\">"+ps[i].name+"</option>";\n' +
'    }\n' +
'  }\n' +
'  sel.innerHTML=opts;\n' +
'  if(cur)sel.value=cur;\n' +

'  fetch("/health").then(function(r){return r.json();}).then(function(h){\n' +
'    var mb=Math.round(h.memory/1024/1024);\n' +
'    var pct=Math.min(100,Math.round(mb/512*100));\n' +
'    document.getElementById("mem-fill").style.width=pct+"%";\n' +
'    document.getElementById("mem-fill").style.background=pct>80?"var(--red)":pct>60?"var(--yellow)":"var(--green)";\n' +
'    document.getElementById("mem-text").textContent=mb+"MB / 512MB";\n' +
'  }).catch(function(){});\n' +
'}\n' +

'function renderGrid(id,ps){\n' +
'  var c=document.getElementById(id);\n' +
'  if(!c)return;\n' +
'  var html="";\n' +
'  for(var i=0;i<ps.length;i++){\n' +
'    var p=ps[i];\n' +
'    var dotClass=p.status==="connected"?"green":(p.status==="connecting"||p.status==="viewing")?"yellow":"gray";\n' +
'    var statusText=p.status.charAt(0).toUpperCase()+p.status.slice(1);\n' +
'    var btns="";\n' +
'    if(p.status==="disconnected"){\n' +
'      btns=\'<button class="btn btn-primary btn-sm" onclick="connectP(\\\'\'+p.id+\'\\\')">Connect</button>\';\n' +
'    }else if(p.status==="connecting"||p.status==="viewing"){\n' +
'      btns=\'<button class="btn btn-secondary btn-sm" onclick="openBV(\\\'\'+p.id+\'\\\')">View Browser</button>\';\n' +
'    }else{\n' +
'      btns=\'<button class="btn btn-secondary btn-sm" onclick="openBV(\\\'\'+p.id+\'\\\')">View Browser</button> \'+\n' +
'           \'<button class="btn btn-danger btn-sm" onclick="disconnectP(\\\'\'+p.id+\'\\\')">Disconnect</button>\';\n' +
'    }\n' +
'    var err=p.error?\'<div class="provider-error">\'+escHtml(p.error)+"</div>":"";\n' +
'    html+=\'<div class="provider-card">\'+\n' +
'      \'<div class="provider-header"><div class="provider-icon" style="background:\'+p.color+\'">\'+p.icon+"</div>"+\n' +
'      "<div><div class=\\"provider-name\\">"+p.name+"</div><div class=\\"provider-company\\">"+p.company+"</div></div></div>"+\n' +
'      \'<div class="provider-status"><span class="dot \'+dotClass+\'"></span>\'+statusText+"</div>"+\n' +
'      \'<div class="provider-reqs">\'+p.requests+" requests</div>"+err+btns+"</div>";\n' +
'  }\n' +
'  c.innerHTML=html;\n' +
'}\n' +

'async function connectP(id){\n' +
'  if(connecting)return;\n' +
'  connecting=true;\n' +
'  try{\n' +
'    var r=await fetch("/v1/providers/"+id+"/init",{method:"POST"});\n' +
'    var d=await r.json();\n' +
'    if(d.error){alert("Error: "+d.error);connecting=false;return;}\n' +
'    openBV(id);\n' +
'    loadAll();\n' +
'  }catch(e){alert("Connection failed: "+e.message);}\n' +
'  connecting=false;\n' +
'}\n' +

'async function disconnectP(id){\n' +
'  try{await fetch("/v1/providers/"+id,{method:"DELETE"});loadAll();}catch(e){alert(e.message);}\n' +
'}\n' +

'function openBV(id){\n' +
'  bvProvider=id;\n' +
'  var p=providers.find(function(x){return x.id===id;});\n' +
'  document.getElementById("bv-title").textContent=p?p.name+" \\u2014 Browser View":id;\n' +
'  document.getElementById("bv-modal").classList.add("show");\n' +
'  document.getElementById("bv-msg").textContent="Launching browser...";\n' +
'  document.getElementById("bv-dot").className="dot yellow";\n' +
'  document.getElementById("bv-input").value="";\n' +
'  document.getElementById("bv-loading").style.display="flex";\n' +
'  bvStartPolling();\n' +
'}\n' +

'function closeBV(){\n' +
'  document.getElementById("bv-modal").classList.remove("show");\n' +
'  bvStopPolling();\n' +
'  bvProvider=null;\n' +
'}\n' +

'function bvStartPolling(){bvStopPolling();bvPollTick();bvPolling=setInterval(bvPollTick,2000);}\n' +
'function bvStopPolling(){if(bvPolling){clearInterval(bvPolling);bvPolling=null;}}\n' +

'async function bvPollTick(){\n' +
'  if(!bvProvider)return;\n' +
'  try{\n' +
'    var r=await fetch("/v1/providers/"+bvProvider+"/screenshot");\n' +
'    if(r.ok){\n' +
'      var d=await r.json();\n' +
'      if(d.screenshot){\n' +
'        document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;\n' +
'        document.getElementById("bv-loading").style.display="none";\n' +
'      }\n' +
'    }\n' +
'  }catch(e){}\n' +
'  try{\n' +
'    var s=await fetch("/v1/providers");\n' +
'    var all=await s.json();\n' +
'    providers=all;\n' +
'    var p=all.find(function(x){return x.id===bvProvider;});\n' +
'    if(p){\n' +
'      if(p.status==="connected"){document.getElementById("bv-msg").textContent="Logged in! Close and use Playground.";document.getElementById("bv-dot").className="dot green";}\n' +
'      else if(p.status==="viewing"){document.getElementById("bv-msg").textContent="Page loaded \\u2014 interact to log in";document.getElementById("bv-dot").className="dot yellow";}\n' +
'      else if(p.error){document.getElementById("bv-msg").textContent="Error: "+p.error;document.getElementById("bv-dot").className="dot red";}\n' +
'    }\n' +
'    renderAll(all,{totalRequests:0});\n' +
'  }catch(e){}\n' +
'}\n' +

'async function bvClick(event){\n' +
'  if(!bvProvider)return;\n' +
'  var img=document.getElementById("bv-img");\n' +
'  var rect=img.getBoundingClientRect();\n' +
'  var x=Math.round((event.clientX-rect.left)/rect.width*1024);\n' +
'  var y=Math.round((event.clientY-rect.top)/rect.height*700);\n' +
'  var ring=document.createElement("div");\n' +
'  ring.className="click-ring";\n' +
'  ring.style.left=(event.clientX-rect.left)+"px";\n' +
'  ring.style.top=(event.clientY-rect.top)+"px";\n' +
'  document.getElementById("bv-screen").appendChild(ring);\n' +
'  setTimeout(function(){ring.remove();},500);\n' +
'  try{\n' +
'    var r=await fetch("/v1/providers/"+bvProvider+"/click",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({x:x,y:y})});\n' +
'    var d=await r.json();\n' +
'    if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;\n' +
'    if(d.message)document.getElementById("bv-msg").textContent=d.message;\n' +
'    if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}\n' +
'    else document.getElementById("bv-dot").className="dot yellow";\n' +
'  }catch(e){document.getElementById("bv-msg").textContent="Error: "+e.message;}\n' +
'}\n' +

'async function bvSubmit(){\n' +
'  if(!bvProvider)return;\n' +
'  var input=document.getElementById("bv-input");\n' +
'  var val=input.value.trim();\n' +
'  if(!val)return;\n' +
'  var msg=document.getElementById("bv-msg").textContent.toLowerCase();\n' +
'  var ft="text";\n' +
'  if(msg.indexOf("email")!==-1)ft="email";\n' +
'  else if(msg.indexOf("password")!==-1)ft="password";\n' +
'  else if(msg.indexOf("code")!==-1||msg.indexOf("verification")!==-1)ft="code";\n' +
'  try{\n' +
'    var url=ft!=="text"?"/v1/providers/"+bvProvider+"/login":"/v1/providers/"+bvProvider+"/type";\n' +
'    var body=ft!=="text"?JSON.stringify({fieldType:ft,value:val}):JSON.stringify({text:val});\n' +
'    var r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:body});\n' +
'    var d=await r.json();\n' +
'    if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;\n' +
'    if(d.message)document.getElementById("bv-msg").textContent=d.message;\n' +
'    if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}\n' +
'    else document.getElementById("bv-dot").className="dot yellow";\n' +
'    input.value="";\n' +
'  }catch(e){document.getElementById("bv-msg").textContent="Error: "+e.message;}\n' +
'}\n' +

'async function bvSendKey(key){\n' +
'  if(!bvProvider)return;\n' +
'  try{\n' +
'    var r=await fetch("/v1/providers/"+bvProvider+"/key",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:key})});\n' +
'    var d=await r.json();\n' +
'    if(d.screenshot)document.getElementById("bv-img").src="data:image/jpeg;base64,"+d.screenshot;\n' +
'    if(d.message)document.getElementById("bv-msg").textContent=d.message;\n' +
'    if(d.state==="connected"){document.getElementById("bv-dot").className="dot green";loadAll();}\n' +
'  }catch(e){document.getElementById("bv-msg").textContent="Error: "+e.message;}\n' +
'}\n' +

'async function sendMsg(){\n' +
'  var input=document.getElementById("chat-input");\n' +
'  var provider=document.getElementById("pg-provider").value;\n' +
'  var msg=input.value.trim();\n' +
'  if(!msg||!provider)return;\n' +
'  var msgs=document.getElementById("chat-msgs");\n' +
'  msgs.innerHTML+="<div class=\\"msg user\\"><div class=\\"label\\">You</div><div class=\\"bubble\\">"+escHtml(msg)+"</div></div>";\n' +
'  msgs.innerHTML+="<div class=\\"msg ai\\" id=\\"thinking\\"><div class=\\"label\\">"+provider+"</div><div class=\\"bubble\\"><span class=\\"spinner\\"></span> Thinking...</div></div>";\n' +
'  msgs.scrollTop=msgs.scrollHeight;\n' +
'  input.value="";\n' +
'  try{\n' +
'    var r=await fetch("/v1/chat/"+provider,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});\n' +
'    var d=await r.json();\n' +
'    var t=document.getElementById("thinking");if(t)t.remove();\n' +
'    var reply=d.error?"Error: "+d.error:(d.choices&&d.choices[0]?d.choices[0].message.content:"No response");\n' +
'    msgs.innerHTML+="<div class=\\"msg ai\\"><div class=\\"label\\">"+provider+"</div><div class=\\"bubble\\">"+escHtml(reply)+"</div></div>";\n' +
'  }catch(e){\n' +
'    var t2=document.getElementById("thinking");if(t2)t2.remove();\n' +
'    msgs.innerHTML+="<div class=\\"msg ai\\"><div class=\\"label\\">Error</div><div class=\\"bubble\\" style=\\"color:var(--red)\\">"+escHtml(e.message)+"</div></div>";\n' +
'  }\n' +
'  msgs.scrollTop=msgs.scrollHeight;\n' +
'}\n' +

'function clearChat(){document.getElementById("chat-msgs").innerHTML="";}\n' +
'function escHtml(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}\n' +

'async function loadKeys(){\n' +
'  try{\n' +
'    var r=await fetch("/v1/keys");\n' +
'    var keys=await r.json();\n' +
'    var body=document.getElementById("keys-body");\n' +
'    if(keys.length){\n' +
'      var h="";\n' +
'      for(var i=0;i<keys.length;i++){\n' +
'        var k=keys[i];\n' +
'        h+="<tr><td>"+escHtml(k.name)+"</td><td><span class=\\"key-value\\">"+k.key+"</span></td>"+\n' +
'           "<td>"+new Date(k.created).toLocaleDateString()+"</td><td>"+k.requests+"</td>"+\n' +
'           "<td><button class=\\"btn btn-danger btn-sm\\" onclick=\\"revokeKey(\\'"+k.fullKey+"\\')\\">Revoke</button></td></tr>";\n' +
'      }\n' +
'      body.innerHTML=h;\n' +
'    }else{\n' +
'      body.innerHTML="<tr><td colspan=\\"5\\" style=\\"text-align:center;color:var(--dim);padding:30px\\">No API keys yet.</td></tr>";\n' +
'    }\n' +
'    document.getElementById("ov-keys").textContent=keys.length;\n' +
'  }catch(e){}\n' +
'}\n' +

'async function genKey(){\n' +
'  var name=prompt("Key name:");\n' +
'  if(!name)return;\n' +
'  try{\n' +
'    var r=await fetch("/v1/keys",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name})});\n' +
'    var d=await r.json();\n' +
'    alert("Key: "+d.key+"\\nSave it now.");\n' +
'    loadKeys();\n' +
'  }catch(e){alert(e.message);}\n' +
'}\n' +

'async function revokeKey(key){\n' +
'  if(!confirm("Revoke this key?"))return;\n' +
'  try{await fetch("/v1/keys/"+encodeURIComponent(key),{method:"DELETE"});loadKeys();}catch(e){alert(e.message);}\n' +
'}\n' +

'loadAll();\n' +
'loadKeys();\n' +
'setInterval(loadAll,15000);\n' +
'</script>\n</body>\n</html>';

// ====== START SERVER ======
app.listen(PORT, function() { console.log('Nova API v4 on port ' + PORT); });

process.on('SIGTERM', async function() { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
process.on('SIGINT', async function() { try { if (browser) await browser.close(); } catch (e) {} process.exit(0); });
process.on('uncaughtException', function(e) { console.error('[CRASH CAUGHT]', e.message); });
process.on('unhandledRejection', function(e) { console.error('[REJECTION CAUGHT]', String(e)); });
