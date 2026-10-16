const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
const apiKeys = new Map();
const conversations = new Map();
const stats = { startedAt: Date.now(), errors: 0 };

// ═══════════════════════════════════════════════════
// PROVIDERS — all free, no browser needed
// ═══════════════════════════════════════════════════
const PROVIDERS = {
    gemini: {
        name: 'Gemini 1.5 Flash',
        model: 'gemini-1.5-flash',
        icon: 'Ge', color: '#4285f4',
        desc: 'Google Gemini — 1M context, free',
        envKey: 'GEMINI_API_KEY',
        link: 'https://aistudio.google.com/apikey',
        build: msgs => ({
            contents: msgs.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
        }),
        call: async (key, body) => {
            const r = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + key,
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
            );
            if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + await r.text());
            const d = await r.json();
            return d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts[0]
                ? d.candidates[0].content.parts[0].text : 'No response';
        }
    },
    llama: {
        name: 'Llama 3.1 70B',
        model: 'llama-3.1-70b-versatile',
        icon: 'L', color: '#7c3aed',
        desc: 'Meta Llama via Groq — ultra fast, free',
        envKey: 'GROQ_API_KEY',
        link: 'https://console.groq.com/keys',
        build: msgs => ({ model: 'llama-3.1-70b-versatile', messages: msgs, max_tokens: 4096 }),
        call: async (key, body) => {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
                body: JSON.stringify(body)
            });
            if (!r.ok) throw new Error('Groq ' + r.status + ': ' + await r.text());
            const d = await r.json();
            return d.choices && d.choices[0] ? d.choices[0].message.content : 'No response';
        }
    },
    mixtral: {
        name: 'Mixtral 8x7B',
        model: 'mixtral-8x7b-32768',
        icon: 'M', color: '#f59e0b',
        desc: 'Mistral Mixtral via Groq — MoE, free',
        envKey: 'GROQ_API_KEY',
        link: 'https://console.groq.com/keys',
        build: msgs => ({ model: 'mixtral-8x7b-32768', messages: msgs, max_tokens: 4096 }),
        call: async (key, body) => {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
                body: JSON.stringify(body)
            });
            if (!r.ok) throw new Error('Groq ' + r.status + ': ' + await r.text());
            const d = await r.json();
            return d.choices && d.choices[0] ? d.choices[0].message.content : 'No response';
        }
    },
    gemma: {
        name: 'Gemma 2 9B',
        model: 'gemma2-9b-it',
        icon: 'G', color: '#10a37f',
        desc: 'Google Gemma via Groq — lightweight, free',
        envKey: 'GROQ_API_KEY',
        link: 'https://console.groq.com/keys',
        build: msgs => ({ model: 'gemma2-9b-it', messages: msgs, max_tokens: 4096 }),
        call: async (key, body) => {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
                body: JSON.stringify(body)
            });
            if (!r.ok) throw new Error('Groq ' + r.status + ': ' + await r.text());
            const d = await r.json();
            return d.choices && d.choices[0] ? d.choices[0].message.content : 'No response';
        }
    }
};

const pState = {};
Object.keys(PROVIDERS).forEach(function(id) {
    pState[id] = { connected: false, connectedAt: null, requests: 0 };
});

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
function makeKey() {
    var key = 'sk-nova-' + crypto.randomBytes(24).toString('hex');
    apiKeys.set(key, { created: Date.now(), calls: 0, providers: [], revoked: false });
    return key;
}

function checkKey(key) {
    var k = apiKeys.get(key);
    return k && !k.revoked ? k : null;
}

function getConv(userKey, provider) {
    var id = userKey + ':' + provider;
    if (!conversations.has(id)) conversations.set(id, []);
    return conversations.get(id);
}

function clearConv(userKey, provider) {
    conversations.delete(userKey + ':' + provider);
}

// ═══════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════

app.get('/', function(_, res) { res.send(HTML()); });

app.get('/v1/providers', function(_, res) {
    var out = {};
    Object.keys(PROVIDERS).forEach(function(id) {
        var p = PROVIDERS[id];
        out[id] = {
            name: p.name, model: p.model, desc: p.desc,
            icon: p.icon, color: p.color,
            configured: !!process.env[p.envKey],
            connected: pState[id].connected,
            uptime: pState[id].connectedAt ? Math.floor((Date.now() - pState[id].connectedAt) / 1000) : 0,
            requests: pState[id].requests
        };
    });
    res.json(out);
});

app.post('/v1/providers/:id/init', async function(req, res) {
    var id = req.params.id;
    var p = PROVIDERS[id];
    if (!p) return res.status(400).json({ error: 'Unknown provider' });
    if (!process.env[p.envKey]) {
        return res.status(503).json({
            error: p.name + ' API key not set',
            fix: 'Set ' + p.envKey + ' in Render Environment tab',
            link: p.link
        });
    }
    try {
        var body = p.build([{ role: 'user', content: 'Say hello in 5 words.' }]);
        var reply = await p.call(process.env[p.envKey], body);
        pState[id].connected = true;
        pState[id].connectedAt = Date.now();
        res.json({ status: 'connected', provider: id, name: p.name, test: reply.slice(0, 100) });
    } catch (err) {
        res.status(500).json({ error: 'Test failed: ' + err.message });
    }
});

app.post('/v1/providers/:id/newchat', function(req, res) {
    var auth = req.headers.authorization;
    if (!auth) return res.status(401).json({ error: 'Missing auth' });
    clearConv(auth.replace('Bearer ', ''), req.params.id);
    res.json({ ok: true });
});

app.post('/v1/keys', function(_, res) {
    res.json({ key: makeKey(), message: 'Save this key. It will not be shown again.' });
});

app.get('/v1/keys', function(_, res) {
    var out = [];
    apiKeys.forEach(function(v, k) {
        out.push({
            key: k.slice(0, 12) + '...' + k.slice(-4),
            full: k,
            created: new Date(v.created).toISOString(),
            calls: v.calls,
            providers: v.providers.filter(function(v, i, a) { return a.indexOf(v) === i; }),
            revoked: v.revoked
        });
    });
    res.json(out);
});

app.delete('/v1/keys/:key', function(req, res) {
    if (!apiKeys.has(req.params.key)) return res.status(404).json({ error: 'Not found' });
    apiKeys.get(req.params.key).revoked = true;
    res.json({ ok: true });
});

app.get('/v1/stats', function(_, res) {
    var totalCalls = 0;
    apiKeys.forEach(function(v) { totalCalls += v.calls; });
    var ready = 0;
    Object.keys(PROVIDERS).forEach(function(id) {
        if (process.env[PROVIDERS[id].envKey]) ready++;
    });
    res.json({
        totalCalls: totalCalls,
        totalKeys: apiKeys.size,
        activeKeys: Array.from(apiKeys.values()).filter(function(v) { return !v.revoked; }).length,
        readyProviders: ready,
        totalProviders: Object.keys(PROVIDERS).length,
        uptime: Math.floor((Date.now() - stats.startedAt) / 1000),
        errors: stats.errors
    });
});

app.post('/v1/chat/:provider', async function(req, res) {
    var provider = req.params.provider;
    var message = req.body.message;
    var auth = req.headers.authorization;

    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing API key' });
    var userKey = auth.replace('Bearer ', '');
    var kd = checkKey(userKey);
    if (!kd) return res.status(403).json({ error: 'Invalid or revoked key' });

    var p = PROVIDERS[provider];
    if (!p) return res.status(400).json({ error: 'Unknown provider', available: Object.keys(PROVIDERS) });
    if (!process.env[p.envKey]) return res.status(503).json({ error: p.name + ' not configured on server' });
    if (!message) return res.status(400).json({ error: 'No message provided' });

    var start = Date.now();
    try {
        var conv = getConv(userKey, provider);
        conv.push({ role: 'user', content: message });
        while (conv.length > 20) conv.shift();

        var body = p.build(conv);
        var reply = await p.call(process.env[p.envKey], body);
        conv.push({ role: 'assistant', content: reply });

        kd.calls++;
        if (kd.providers.indexOf(provider) === -1) kd.providers.push(provider);
        pState[provider].requests++;

        res.json({ provider: provider, model: p.name, reply: reply, latency: (Date.now() - start) + 'ms' });
    } catch (err) {
        stats.errors++;
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════
// HTML DASHBOARD
// ═══════════════════════════════════════════════════

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
    '.alert{background:#f59e0b11;border:1px solid #f59e0b33;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:12px;font-size:13px}\n' +
    '.alert-icon{font-size:20px}\n' +
    '.alert-text strong{color:var(--amber)}\n' +
    '.provider-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:24px}\n' +
    '.p-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;transition:all .2s}\n' +
    '.p-card:hover{border-color:var(--border2);transform:translateY(-2px)}\n' +
    '.p-card-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}\n' +
    '.p-card-icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#000;flex-shrink:0}\n' +
    '.p-card-name{font-size:15px;font-weight:700}\n' +
    '.p-card-desc{font-size:12px;color:var(--muted)}\n' +
    '.p-card-model{font-size:11px;color:#555;font-family:monospace;margin-top:2px}\n' +
    '.p-card-status{display:flex;align-items:center;gap:6px;font-size:12px;margin:12px 0;font-weight:500}\n' +
    '.p-card-status.ready{color:var(--green)}\n' +
    '.p-card-status.not-configured{color:#666}\n' +
    '.p-card-status.connected{color:var(--green)}\n' +
    '.status-dot{width:8px;height:8px;border-radius:50%;display:inline-block}\n' +
    '.status-dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}\n' +
    '.status-dot.off{background:#555}\n' +
    '.p-card-meta{font-size:11px;color:#444;margin-bottom:12px}\n' +
    '.p-card-actions{display:flex;gap:8px}\n' +
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
    '.setup-step{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:14px}\n' +
    '.setup-step h4{font-size:14px;font-weight:700;margin-bottom:8px;display:flex;align-items:center;gap:8px}\n' +
    '.setup-step .num{width:24px;height:24px;background:linear-gradient(135deg,var(--blue),var(--green));border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#000;flex-shrink:0}\n' +
    '.setup-step p{font-size:13px;color:#888;line-height:1.6;margin-bottom:8px}\n' +
    '.setup-step code{background:#1a1a28;padding:2px 7px;border-radius:5px;font-size:12px;font-family:monospace;color:#ccc}\n' +
    '.setup-step a{color:var(--blue);text-decoration:none}\n' +
    '.setup-step a:hover{text-decoration:underline}\n' +
    '.doc-block{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:12px}\n' +
    '.doc-block .endpoint{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}\n' +
    '.method{padding:3px 10px;border-radius:5px;font-weight:700;font-size:11px;letter-spacing:.5px}\n' +
    '.m-get{background:#10a37f22;color:#10a37f}\n' +
    '.m-post{background:#2563eb22;color:#60a5fa}\n' +
    '.m-delete{background:#ef444422;color:#ef4444}\n' +
    '.doc-block code{background:#1a1a28;padding:3px 7px;border-radius:5px;font-size:12px;font-family:monospace;color:#ccc}\n' +
    '.doc-block .desc{font-size:13px;color:#888;line-height:1.6}\n' +
    '.doc-block .example{background:#0a0a10;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:10px;font-family:monospace;font-size:12px;color:#aaa;line-height:1.7;white-space:pre;overflow-x:auto}\n' +
    '.toast{position:fixed;bottom:24px;right:24px;background:var(--card);border:1px solid var(--border2);border-radius:10px;padding:10px 18px;font-size:13px;display:none;z-index:999;animation:fadeIn .2s}\n' +
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
    '      <span class="badge" id="providerBadge">0</span>\n' +
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
    '    <a class="sb-link" data-page="setup" onclick="switchPage(\'setup\')">\n' +
    '      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>\n' +
    '      <span>Setup</span>\n' +
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
    '      <div class="pill"><span class="dot"></span><span id="readyCount">0</span> Ready</div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div class="content">\n' +

    // DASHBOARD PAGE
    '    <div class="page active" id="page-dashboard">\n' +
    '      <div id="setupAlert"></div>\n' +
    '      <div class="stats-row" id="statsRow"></div>\n' +
    '      <div class="section-head"><h3>Providers</h3></div>\n' +
    '      <div class="provider-grid" id="dashProviders"></div>\n' +
    '    </div>\n' +

    // PROVIDERS PAGE
    '    <div class="page" id="page-providers">\n' +
    '      <div class="section-head"><h3>AI Providers</h3><span id="providerCountLabel" style="font-size:12px;color:var(--muted)"></span></div>\n' +
    '      <div class="provider-grid" id="providerGrid"></div>\n' +
    '    </div>\n' +

    // KEYS PAGE
    '    <div class="page" id="page-keys">\n' +
    '      <div class="section-head">\n' +
    '        <h3>API Keys</h3>\n' +
    '        <button class="btn btn-primary btn-sm" onclick="generateKey()">+ New Key</button>\n' +
    '      </div>\n' +
    '      <div class="table-wrap">\n' +
    '        <table><thead><tr><th>Key</th><th>Created</th><th>Calls</th><th>Providers</th><th>Status</th><th>Actions</th></tr></thead>\n' +
    '        <tbody id="keysTableBody"><tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet. Generate one to get started.</td></tr></tbody></table>\n' +
    '      </div>\n' +
    '    </div>\n' +

    // PLAYGROUND PAGE
    '    <div class="page" id="page-playground">\n' +
    '      <div class="chat-container">\n' +
    '        <div class="chat-header">\n' +
    '          <select id="chatProvider"></select>\n' +
    '          <button class="btn btn-outline btn-sm" onclick="newChat()">New Chat</button>\n' +
    '          <button class="btn btn-outline btn-sm" onclick="clearChat()">Clear</button>\n' +
    '        </div>\n' +
    '        <div class="chat-messages" id="chatBox">\n' +
    '          <div class="msg msg-system">Select a provider and start chatting. Responses come from free AI APIs.</div>\n' +
    '        </div>\n' +
    '        <div class="chat-input-wrap">\n' +
    '          <textarea id="chatInput" placeholder="Type a message..." rows="1"></textarea>\n' +
    '          <button class="btn btn-primary" id="sendBtn" onclick="sendMsg()">Send</button>\n' +
    '        </div>\n' +
    '      </div>\n' +
    '    </div>\n' +

    // SETUP PAGE
    '    <div class="page" id="page-setup">\n' +
    '      <div class="section-head"><h3>Setup Guide</h3></div>\n' +
    '      <div class="setup-step">\n' +
    '        <h4><span class="num">1</span> Get a Gemini API Key (Free)</h4>\n' +
    '        <p>Go to <a href="https://aistudio.google.com/apikey" target="_blank">Google AI Studio</a> and create an API key. No credit card needed. Free tier: 15 requests/min, 1M tokens/day.</p>\n' +
    '        <p>Then on Render: Environment → Add <code>GEMINI_API_KEY</code> = your key</p>\n' +
    '        <div id="geminiStatus" style="margin-top:8px;font-size:12px"></div>\n' +
    '      </div>\n' +
    '      <div class="setup-step">\n' +
    '        <h4><span class="num">2</span> Get a Groq API Key (Free)</h4>\n' +
    '        <p>Go to <a href="https://console.groq.com/keys" target="_blank">Groq Console</a> and create an API key. No credit card needed. Free tier: 30 requests/min. Runs Llama 3.1, Mixtral, and Gemma.</p>\n' +
    '        <p>Then on Render: Environment → Add <code>GROQ_API_KEY</code> = your key</p>\n' +
    '        <div id="groqStatus" style="margin-top:8px;font-size:12px"></div>\n' +
    '      </div>\n' +
    '      <div class="setup-step">\n' +
    '        <h4><span class="num">3</span> Redeploy</h4>\n' +
    '        <p>After adding the environment variables, go to Render → Manual Deploy → Deploy latest commit. The providers will auto-configure on startup.</p>\n' +
    '      </div>\n' +
    '    </div>\n' +

    // DOCS PAGE
    '    <div class="page" id="page-docs">\n' +
    '      <div class="section-head"><h3>API Reference</h3></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/keys</code></div><div class="desc">Generate a new API key for your users.</div><div class="example">curl -X POST https://your-app.onrender.com/v1/keys\n// Response: { "key": "sk-nova-a1b2c3..." }</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-get">GET</span> <code>/v1/providers</code></div><div class="desc">List all providers with connection status and model info.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/init</code></div><div class="desc">Test and enable a provider. Replace <code>:provider</code> with <code>gemini</code>, <code>llama</code>, <code>mixtral</code>, or <code>gemma</code>.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/chat/:provider</code></div><div class="desc">Send a message. Supports multi-turn conversations.</div><div class="example">curl -X POST https://your-app.onrender.com/v1/chat/gemini \\\n  -H "Authorization: Bearer sk-nova-YOUR_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"message": "Hello!"}\'\n\n// Response:\n{ "provider": "gemini", "model": "Gemini 1.5 Flash",\n  "reply": "Hi! How can I help you?", "latency": "450ms" }</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-post">POST</span> <code>/v1/providers/:provider/newchat</code></div><div class="desc">Clear conversation history for a fresh start.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-delete">DELETE</span> <code>/v1/keys/:key</code></div><div class="desc">Revoke an API key. Calls using it will be rejected.</div></div>\n' +
    '      <div class="doc-block"><div class="endpoint"><span class="method m-get">GET</span> <code>/v1/stats</code></div><div class="desc">Platform statistics — calls, keys, providers, uptime.</div></div>\n' +
    '    </div>\n' +

    '  </div>\n</div>\n</div>\n' +
    '<div class="toast" id="toast"></div>\n' +

    // JAVASCRIPT
    '<script>\n' +
    'var myKey = localStorage.getItem("nova_key") || "";\n' +
    'var providers = {};\n' +
    'var keys = [];\n' +
    'var pageTitles = {dashboard:"Dashboard",providers:"Providers",keys:"API Keys",playground:"Playground",setup:"Setup Guide",docs:"API Documentation"};\n' +

    'function switchPage(page) {\n' +
    '  document.querySelectorAll(".page").forEach(function(p){p.classList.remove("active")});\n' +
    '  document.getElementById("page-"+page).classList.add("active");\n' +
    '  document.querySelectorAll(".sb-link").forEach(function(l){l.classList.remove("active")});\n' +
    '  var link = document.querySelector(".sb-link[data-page=\\""+page+"\\"]");\n' +
    '  if(link) link.classList.add("active");\n' +
    '  document.getElementById("pageTitle").textContent = pageTitles[page];\n' +
    '  if(page==="keys") loadKeys();\n' +
    '  if(page==="providers"||page==="dashboard") loadProviders();\n' +
    '}\n' +

    'function showToast(msg, color) {\n' +
    '  var t = document.getElementById("toast");\n' +
    '  t.textContent = msg;\n' +
    '  t.style.color = color || "var(--green)";\n' +
    '  t.style.display = "block";\n' +
    '  clearTimeout(t._t);\n' +
    '  t._t = setTimeout(function(){t.style.display="none"},3000);\n' +
    '}\n' +

    'function copyText(text, btn) {\n' +
    '  navigator.clipboard.writeText(text).then(function(){\n' +
    '    if(btn){btn.classList.add("copied");btn.textContent="\\u2713";setTimeout(function(){btn.classList.remove("copied");btn.textContent="\\ud83d\\udccb"},1500)}\n' +
    '    showToast("Copied to clipboard");\n' +
    '  }).catch(function(){\n' +
    '    var ta=document.createElement("textarea");ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);\n' +
    '    showToast("Copied to clipboard");\n' +
    '  });\n' +
    '}\n' +

    'function fmtUptime(sec) {\n' +
    '  if(sec<60) return sec+"s";\n' +
    '  if(sec<3600) return Math.floor(sec/60)+"m "+(sec%60)+"s";\n' +
    '  return Math.floor(sec/3600)+"h "+Math.floor((sec%3600)/60)+"m";\n' +
    '}\n' +

    'function fmtDate(ts) {\n' +
    '  var d = new Date(ts);\n' +
    '  return d.toLocaleDateString("en-US",{month:"short",day:"numeric"})+" "+d.toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit"});\n' +
    '}\n' +

    // LOAD PROVIDERS
    'async function loadProviders() {\n' +
    '  try {\n' +
    '    var res = await fetch("/v1/providers");\n' +
    '    providers = await res.json();\n' +
    '    var ready = 0;\n' +
    '    Object.keys(providers).forEach(function(id){if(providers[id].configured) ready++});\n' +
    '    document.getElementById("readyCount").textContent = ready;\n' +
    '    document.getElementById("providerBadge").textContent = ready;\n' +
    '    renderProviderCards("dashProviders", true);\n' +
    '    renderProviderCards("providerGrid", false);\n' +
    '    renderSetupStatus();\n' +
    '    // Chat provider select\n' +
    '    var sel = document.getElementById("chatProvider");\n' +
    '    var cur = sel.value;\n' +
    '    sel.innerHTML = "";\n' +
    '    Object.keys(providers).forEach(function(id){\n' +
    '      var p = providers[id];\n' +
    '      var opt = document.createElement("option");\n' +
    '      opt.value = id;\n' +
    '      opt.textContent = p.name + (p.configured ? " \\u2713" : "");\n' +
    '      sel.appendChild(opt);\n' +
    '    });\n' +
    '    if(cur) sel.value = cur;\n' +
    '  } catch(e) { console.error(e); }\n' +
    '}\n' +

    'function renderProviderCards(containerId, compact) {\n' +
    '  var grid = document.getElementById(containerId);\n' +
    '  if(!grid) return;\n' +
    '  grid.innerHTML = "";\n' +
    '  Object.keys(providers).forEach(function(id){\n' +
    '    var p = providers[id];\n' +
    '    var card = document.createElement("div");\n' +
    '    card.className = "p-card";\n' +
    '    var isReady = p.configured;\n' +
    '    var isConnected = p.connected;\n' +
    '    var statusClass = isConnected ? "connected" : (isReady ? "ready" : "not-configured");\n' +
    '    var statusText = isConnected ? "Connected \\u2022 up " + fmtUptime(p.uptime) : (isReady ? "Ready to connect" : "API key not set");\n' +
    '    card.innerHTML = \'<div class="p-card-head">\' +\n' +
    '      \'<div class="p-card-icon" style="background:\'+p.color+\'">\'+p.icon+\'</div>\' +\n' +
    '      \'<div><div class="p-card-name">\'+p.name+\'</div><div class="p-card-desc">\'+p.desc+\'</div><div class="p-card-model">\'+p.model+\'</div></div>\' +\n' +
    '      \'</div>\' +\n' +
    '      \'<div class="p-card-status \'+statusClass+\'">\' +\n' +
    '        \'<span class="status-dot \'+(isConnected?"on":"off")+\'"></span>\' + statusText +\n' +
    '      \'</div>\' +\n' +
    '      (compact ? \'\' : \'<div class="p-card-meta">\'+p.requests+\' requests served</div>\' +\n' +
    '        \'<div class="p-card-actions">\' +\n' +
    '          (isReady ? \'<button class="btn btn-primary btn-sm" onclick="initProvider(\\\'\'+id+\'\\\')">\'+(isConnected?"Test":"Connect")+\'</button>\' : \'<button class="btn btn-outline btn-sm" onclick="switchPage(\\\'setup\\\')">Setup</button>\') +\n' +
    '          (isConnected ? \'<button class="btn btn-outline btn-sm" onclick="switchPage(\\\'playground\\\')">Chat</button>\' : \'\') +\n' +
    '        \'</div>\');\n' +
    '    grid.appendChild(card);\n' +
    '  });\n' +
    '  var lbl = document.getElementById("providerCountLabel");\n' +
    '  if(lbl) lbl.textContent = Object.keys(providers).length + " providers";\n' +
    '}\n' +

    'function renderSetupStatus() {\n' +
    '  var alert = document.getElementById("setupAlert");\n' +
    '  var missing = [];\n' +
    '  Object.keys(providers).forEach(function(id){if(!providers[id].configured) missing.push(providers[id].name)});\n' +
    '  if(missing.length > 0) {\n' +
    '    alert.innerHTML = \'<div class="alert"><span class="alert-icon">\\u26a0\\ufe0f</span><div class="alert-text"><strong>Setup Required:</strong> \'+missing.join(", ")+\' need API keys. <a href="#" onclick="switchPage(\\\'setup\\\');return false" style="color:var(--blue)">Setup Guide</a></div></div>\';\n' +
    '  } else {\n' +
    '    alert.innerHTML = "";\n' +
    '  }\n' +
    '  // Setup page status\n' +
    '  var gs = document.getElementById("geminiStatus");\n' +
    '  if(gs) gs.innerHTML = providers.gemini && providers.gemini.configured ? \'<span style="color:var(--green)">\\u2713 GEMINI_API_KEY is set</span>\' : \'<span style="color:var(--red)">\\u2717 GEMINI_API_KEY not set</span>\';\n' +
    '  var grs = document.getElementById("groqStatus");\n' +
    '  if(grs) grs.innerHTML = providers.llama && providers.llama.configured ? \'<span style="color:var(--green)">\\u2713 GROQ_API_KEY is set</span>\' : \'<span style="color:var(--red)">\\u2717 GROQ_API_KEY not set</span>\';\n' +
    '}\n' +

    // INIT PROVIDER
    'async function initProvider(id) {\n' +
    '  showToast("Testing "+id+"...", "var(--amber)");\n' +
    '  try {\n' +
    '    var res = await fetch("/v1/providers/"+id+"/init", {method:"POST"});\n' +
    '    var data = await res.json();\n' +
    '    if(data.error) showToast("Error: "+data.error, "var(--red)");\n' +
    '    else showToast(id+" connected! Response: "+data.test);\n' +
    '  } catch(e) { showToast("Failed: "+e.message, "var(--red)"); }\n' +
    '  loadProviders();\n' +
    '}\n' +

    // LOAD STATS
    'async function loadStats() {\n' +
    '  try {\n' +
    '    var res = await fetch("/v1/stats");\n' +
    '    var s = await res.json();\n' +
    '    document.getElementById("statsRow").innerHTML =\n' +
    '      \'<div class="stat-card"><div class="label">Total Requests</div><div class="value">\'+s.totalCalls+\'</div><div class="sub">All time</div></div>\' +\n' +
    '      \'<div class="stat-card"><div class="label">Active Keys</div><div class="value">\'+s.activeKeys+\'</div><div class="sub">\'+s.totalKeys+\' total generated</div></div>\' +\n' +
    '      \'<div class="stat-card"><div class="label">Ready Providers</div><div class="value">\'+s.readyProviders+\'</div><div class="sub">of \'+s.totalProviders+\' available</div></div>\' +\n' +
    '      \'<div class="stat-card"><div class="label">Uptime</div><div class="value">\'+fmtUptime(s.uptime)+\'</div><div class="sub">\'+s.errors+\' errors</div></div>\';\n' +
    '  } catch(e) { console.error(e); }\n' +
    '}\n' +

    // KEYS
    'async function generateKey() {\n' +
    '  var res = await fetch("/v1/keys", {method:"POST"});\n' +
    '  var data = await res.json();\n' +
    '  myKey = data.key;\n' +
    '  localStorage.setItem("nova_key", myKey);\n' +
    '  showToast("Key generated — save it now!");\n' +
    '  loadKeys();\n' +
    '}\n' +

    'async function loadKeys() {\n' +
    '  try {\n' +
    '    var res = await fetch("/v1/keys");\n' +
    '    keys = await res.json();\n' +
    '    var tbody = document.getElementById("keysTableBody");\n' +
    '    if(!keys.length) {\n' +
    '      tbody.innerHTML = \'<tr><td colspan="6" style="text-align:center;color:#555;padding:30px">No keys yet. Click "+ New Key" to generate one.</td></tr>\';\n' +
    '      return;\n' +
    '    }\n' +
    '    tbody.innerHTML = "";\n' +
    '    keys.forEach(function(k){\n' +
    '      var tr = document.createElement("tr");\n' +
    '      var provTags = k.providers.map(function(p){\n' +
    '        var col = providers[p] ? providers[p].color : "#555";\n' +
    '        return \'<span style="background:\'+col+\'22;color:\'+col+\';padding:2px 7px;border-radius:4px;font-size:10px;margin-right:4px">\'+p+\'</span>\';\n' +
    '      }).join("") || \'<span style="color:#444">\\u2014</span>\';\n' +
    '      tr.innerHTML =\n' +
    '        \'<td><span class="mono">\'+k.key+\'</span> <button class="copy-btn" onclick="copyText(\\\'\'+k.full+\'\\\', this)">\\ud83d\\udccb</button></td>\' +\n' +
    '        \'<td>\'+fmtDate(new Date(k.created).getTime())+\'</td>\' +\n' +
    '        \'<td style="font-weight:600">\'+k.calls+\'</td>\' +\n' +
    '        \'<td>\'+provTags+\'</td>\' +\n' +
    '        \'<td>\'+(k.revoked?\'<span style="color:var(--red)">Revoked</span>\':\'<span style="color:var(--green)">Active</span>\')+\'</td>\' +\n' +
    '        \'<td>\'+(k.revoked?\'\\u2014\':\'<button class="btn btn-danger btn-xs" onclick="revokeKey(\\\'\'+k.full+\'\\\')">Revoke</button>\')+\'</td>\';\n' +
    '      tbody.appendChild(tr);\n' +
    '    });\n' +
    '  } catch(e) { console.error(e); }\n' +
    '}\n' +

    'async function revokeKey(key) {\n' +
    '  if(!confirm("Revoke this key?")) return;\n' +
    '  await fetch("/v1/keys/"+key, {method:"DELETE"});\n' +
    '  showToast("Key revoked");\n' +
    '  loadKeys(); loadStats();\n' +
    '}\n' +

    // PLAYGROUND
    'var chatBox, chatInput, sendBtn;\n' +
    'document.addEventListener("DOMContentLoaded", function(){\n' +
    '  chatBox = document.getElementById("chatBox");\n' +
    '  chatInput = document.getElementById("chatInput");\n' +
    '  sendBtn = document.getElementById("sendBtn");\n' +
    '  chatInput.addEventListener("keydown", function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg()}});\n' +
    '  chatInput.addEventListener("input", function(){chatInput.style.height="auto";chatInput.style.height=Math.min(chatInput.scrollHeight,120)+"px"});\n' +
    '});\n' +

    'function addMsg(text, cls, meta) {\n' +
    '  var div = document.createElement("div");\n' +
    '  div.className = "msg "+cls;\n' +
    '  if(cls==="msg-bot"||cls==="msg-user") {\n' +
    '    var safe = text.replace(/</g,"&lt;").replace(/>/g,"&gt;");\n' +
    '    div.innerHTML = safe + \'<button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.replace(/\\\\ud83d\\\\udccb/g,\'\').trim(),this)">\\ud83d\\udccb</button>\' + (meta?\'<div class="msg-meta">\'+meta+\'</div>\':\'\');\n' +
    '  } else {\n' +
    '    div.textContent = text;\n' +
    '  }\n' +
    '  chatBox.appendChild(div);\n' +
    '  chatBox.scrollTop = chatBox.scrollHeight;\n' +
    '  return div;\n' +
    '}\n' +

    'async function sendMsg() {\n' +
    '  if(!myKey){showToast("Generate an API key first","var(--red)");switchPage("keys");return}\n' +
    '  var text = chatInput.value.trim();\n' +
    '  if(!text) return;\n' +
    '  var provider = document.getElementById("chatProvider").value;\n' +
    '  addMsg(text, "msg-user");\n' +
    '  chatInput.value=""; chatInput.style.height="44px";\n' +
    '  sendBtn.disabled=true;\n' +
    '  var thinking = addMsg("", "msg-bot");\n' +
    '  thinking.innerHTML = \'<span class="spinner"></span> Querying \'+provider+\'...\';\n' +
    '  try {\n' +
    '    var res = await fetch("/v1/chat/"+provider, {\n' +
    '      method:"POST",\n' +
    '      headers:{"Content-Type":"application/json","Authorization":"Bearer "+myKey},\n' +
    '      body:JSON.stringify({message:text})\n' +
    '    });\n' +
    '    var data = await res.json();\n' +
    '    if(data.error) {\n' +
    '      thinking.className = "msg msg-error";\n' +
    '      thinking.innerHTML = "Error: "+data.error.replace(/</g,"&lt;")+\' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button>\';\n' +
    '    } else {\n' +
    '      thinking.className = "msg msg-bot";\n' +
    '      var safe = data.reply.replace(/</g,"&lt;").replace(/>/g,"&gt;");\n' +
    '      thinking.innerHTML = safe + \'<button class="copy-btn msg-copy" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button><div class="msg-meta">\'+data.model+" \\u00b7 "+data.latency+\'</div>\';\n' +
    '    }\n' +
    '  } catch(e) {\n' +
    '    thinking.className = "msg msg-error";\n' +
    '    thinking.innerHTML = "Network error: "+e.message+\' <button class="copy-btn" onclick="copyText(this.parentElement.textContent.trim(),this)">\\ud83d\\udccb</button>\';\n' +
    '  }\n' +
    '  sendBtn.disabled=false;\n' +
    '  chatInput.focus();\n' +
    '  loadStats();\n' +
    '}\n' +

    'async function newChat() {\n' +
    '  var provider = document.getElementById("chatProvider").value;\n' +
    '  await fetch("/v1/providers/"+provider+"/newchat", {\n' +
    '    method:"POST",\n' +
    '    headers:{"Authorization":"Bearer "+myKey}\n' +
    '  });\n' +
    '  clearChat();\n' +
    '  addMsg("New conversation started on "+provider, "msg-system");\n' +
    '}\n' +

    'function clearChat() { chatBox.innerHTML=""; }\n' +

    // INIT
    'loadProviders();\n' +
    'loadStats();\n' +
    'loadKeys();\n' +
    'setInterval(function(){loadProviders();loadStats()},15000);\n' +
    '</script>\n</body>\n</html>';
}

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('');
    console.log('  Nova API Gateway v2.0');
    console.log('  http://localhost:' + PORT);
    console.log('');
    Object.keys(PROVIDERS).forEach(function(id) {
        var p = PROVIDERS[id];
        var status = process.env[p.envKey] ? '✓ ready' : '✗ missing ' + p.envKey;
        console.log('  ' + p.name + ': ' + status);
    });
    console.log('');
});
