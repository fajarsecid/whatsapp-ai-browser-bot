import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { resolveBrowserProfile } from '../src/browser-profile.js';
import { loadEnvFile } from '../src/env.js';

loadEnvFile();

const TARGETS = Object.freeze({
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com'
  },
  gemini: {
    label: 'Gemini',
    url: 'https://gemini.google.com/app'
  }
});

const targetName = normalizeTarget(process.argv[2] || process.env.WEB_AI_SERVICE || 'gemini');
const target = TARGETS[targetName];
const host = process.env.REMOTE_LOGIN_HOST || '0.0.0.0';
const port = Number.parseInt(process.env.REMOTE_LOGIN_PORT || '8787', 10);
const token = process.env.REMOTE_LOGIN_TOKEN || randomBytes(12).toString('hex');
const publicUrl = normalizePublicUrl(process.env.REMOTE_LOGIN_PUBLIC_URL || '');
const profile = resolveBrowserProfile(targetName);
const userAgent = process.env.BROWSER_USER_AGENT || '';

let context;
let page;

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    ...(userAgent ? { userAgent } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  page = context.pages()[0] || (await context.newPage());
  await page.goto(target.url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000
  });

  const server = createServer(handleRequest);
  server.listen(port, host, () => {
    console.log(`${target.label} remote login ready.`);
    if (publicUrl) {
      console.log(`Buka dari HP: ${publicUrl}/?token=${token}`);
    } else {
      console.log(`Port lokal remote login: http://127.0.0.1:${port}/?token=${token}`);
      console.log('Di VPS, buka dari HP lewat domain HTTPS/tunnel yang mengarah ke port ini, bukan IP VPS mentah.');
      console.log(`Contoh: https://subdomain.lhr.life/?token=${token}`);
    }
    console.log(`Profile: ${profile}`);
    console.log('Setelah login selesai dan halaman chat terbuka, tekan tombol Done di panel.');
  });

  process.once('SIGINT', async () => {
    await shutdown(server);
  });
} catch (error) {
  console.error(`Gagal membuka remote login ${target.label}:`, error);
  process.exitCode = 1;
  await context?.close().catch(() => {});
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!isAuthorized(url)) {
      sendText(res, 404, 'Not found');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendHtml(res, renderPage({ target: target.label, token }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, {
        title: await page.title().catch(() => ''),
        url: page.url(),
        viewport: page.viewportSize()
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/screenshot.jpg') {
      const image = await page.screenshot({
        type: 'jpeg',
        quality: 72,
        fullPage: false,
        timeout: 15_000
      });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store, max-age=0'
      });
      res.end(image);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/click') {
      const body = await readJson(req);
      const viewport = page.viewportSize() || { width: 1280, height: 900 };
      await page.mouse.click(body.x * viewport.width, body.y * viewport.height);
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/type') {
      const body = await readJson(req);
      await page.keyboard.insertText(String(body.text || ''));
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/type-enter') {
      const body = await readJson(req);
      await page.keyboard.insertText(String(body.text || ''));
      await page.keyboard.press('Enter');
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/clear-field') {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await page.keyboard.press('Backspace');
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/press') {
      const body = await readJson(req);
      await page.keyboard.press(String(body.key || 'Enter'));
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/goto') {
      const body = await readJson(req);
      await page.goto(String(body.url || target.url), {
        waitUntil: 'domcontentloaded',
        timeout: 60_000
      });
      sendJson(res, { ok: true });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/done') {
      sendJson(res, { ok: true });
      setTimeout(() => shutdown(this), 250);
      return;
    }

    sendText(res, 404, 'Not found');
  } catch (error) {
    console.error('Remote login request failed:', error);
    sendJson(res, { ok: false, error: error.message }, 500);
  }
}

function renderPage({ target, token }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(target)} Remote Login</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #111; color: #eee; }
    header { position: sticky; top: 0; z-index: 2; background: #1c1c1c; padding: 10px; border-bottom: 1px solid #333; }
    #meta { font-size: 12px; color: #bbb; overflow-wrap: anywhere; }
    #screen { display: block; width: 100%; height: auto; background: #222; touch-action: manipulation; }
    .controls { display: grid; gap: 8px; grid-template-columns: 1fr 1fr; padding: 10px; background: #1c1c1c; position: sticky; bottom: 0; }
    textarea, button { font: inherit; padding: 12px; border-radius: 6px; border: 1px solid #444; }
    textarea { background: #080808; color: #eee; min-width: 0; grid-column: 1 / -1; resize: vertical; min-height: 54px; }
    button { background: #2d6cdf; color: white; }
    .row { display: flex; gap: 8px; grid-column: 1 / -1; }
    .row button { flex: 1; }
    .hint { grid-column: 1 / -1; color: #bbb; font-size: 12px; line-height: 1.35; }
  </style>
</head>
<body>
  <header>
    <strong>${escapeHtml(target)} Remote Login</strong>
    <div id="meta">Loading...</div>
  </header>
  <img id="screen" alt="browser screenshot">
  <div class="controls">
    <div class="hint">1. Tap field email/password di screenshot. 2. Ketik di kotak ini. 3. Tekan Send Text atau Send + Enter.</div>
    <textarea id="text" placeholder="Ketik email/password/kode di sini" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"></textarea>
    <button id="type">Send Text</button>
    <button id="typeEnter">Send + Enter</button>
    <div class="row">
      <button id="enter">Enter</button>
      <button data-key="Tab">Tab</button>
      <button data-key="Backspace">Backspace</button>
      <button id="clearField">Clear Field</button>
      <button data-key="Escape">Esc</button>
    </div>
    <div class="row">
      <button id="refresh">Refresh Screen</button>
      <button id="done">Done</button>
    </div>
  </div>
  <script>
    const token = ${JSON.stringify(token)};
    const screen = document.getElementById('screen');
    const meta = document.getElementById('meta');
    const text = document.getElementById('text');
    const base = location.pathname.endsWith('/') ? location.pathname.slice(0, -1) : location.pathname;
    const withToken = (path) => base + path + '?token=' + encodeURIComponent(token);
    const api = (path, options = {}) => fetch(withToken(path), options);
    let paused = false;

    async function refresh() {
      if (paused) return;
      screen.src = withToken('/screenshot.jpg') + '&t=' + Date.now();
      const state = await api('/state').then(r => r.json()).catch(() => null);
      if (state) meta.textContent = state.title + ' | ' + state.url;
    }

    screen.addEventListener('click', async (event) => {
      const rect = screen.getBoundingClientRect();
      await api('/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          x: (event.clientX - rect.left) / rect.width,
          y: (event.clientY - rect.top) / rect.height
        })
      });
      setTimeout(refresh, 350);
    });

    document.getElementById('type').addEventListener('click', async () => {
      await api('/type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.value })
      });
      text.value = '';
      paused = false;
      setTimeout(refresh, 350);
    });
    document.getElementById('typeEnter').addEventListener('click', async () => {
      await api('/type-enter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.value })
      });
      text.value = '';
      paused = false;
      setTimeout(refresh, 350);
    });
    document.getElementById('clearField').addEventListener('click', async () => {
      await api('/clear-field', { method: 'POST' });
      setTimeout(refresh, 350);
    });

    document.getElementById('enter').addEventListener('click', () => press('Enter'));
    document.querySelectorAll('[data-key]').forEach(button => {
      button.addEventListener('click', () => press(button.dataset.key));
    });
    document.getElementById('refresh').addEventListener('click', refresh);
    document.getElementById('done').addEventListener('click', async () => {
      await api('/done', { method: 'POST' });
      meta.textContent = 'Saved. You can close this page.';
    });
    text.addEventListener('focus', () => { paused = true; });
    text.addEventListener('blur', () => { paused = false; refresh(); });
    text.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter' && event.ctrlKey) {
        event.preventDefault();
        document.getElementById('typeEnter').click();
      }
    });

    async function press(key) {
      await api('/press', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      setTimeout(refresh, 350);
    }

    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

function isAuthorized(url) {
  return url.searchParams.get('token') === token;
}

async function readJson(req) {
  let content = '';
  for await (const chunk of req) {
    content += chunk;
    if (content.length > 100_000) throw new Error('Request too large.');
  }
  return content ? JSON.parse(content) : {};
}

function sendHtml(res, body) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(body);
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0'
  });
  res.end(body);
}

function normalizeTarget(value) {
  const normalized = String(value || 'gemini')
    .trim()
    .toLowerCase();

  if (!Object.hasOwn(TARGETS, normalized)) {
    throw new Error('Target remote login harus "chatgpt" atau "gemini".');
  }

  return normalized;
}

function normalizePublicUrl(value) {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';

  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('REMOTE_LOGIN_PUBLIC_URL harus diawali http:// atau https://.');
  }

  return normalized;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function shutdown(server) {
  await context?.close().catch(() => {});
  server?.close?.();
  process.exit(0);
}
