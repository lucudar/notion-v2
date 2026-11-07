#!/usr/bin/env node
/**
 * Notion desktop (Windows .exe / MSIX) version of the extension.
 *
 * The desktop app is Electron and loads app.notion.com, so the same scripts
 * work there; only the way they get in differs. Notion is started with a
 * DevTools *pipe* (stdin/stdout of its own process) and, over the Chrome
 * DevTools Protocol, the extension's scripts are registered to run in every
 * Notion page before the page's own code (Page.addScriptToEvaluateOnNewDocument)
 * — the equivalent of the manifest's document_start content scripts.
 *
 * A pipe, not a port: nothing on this machine can reach Notion's session, and
 * no firewall prompt appears. Only this process can talk to Notion, because it
 * owns the pipe. A small control server on loopback (default 9310) answers
 * --diag and /stop while the panel is running.
 *
 *   node notion-effort-desktop.js          start Notion with the panel
 *   node notion-effort-desktop.js --diag   save the diagnostics to diag.json
 *                                          and copy them to the clipboard
 *   node notion-effort-desktop.js --stop   stop the panel (Notion keeps running)
 *   node notion-effort-desktop.js --port   old way: DevTools port instead of a
 *                                          pipe (needs NOTION_EFFORT_PORT open)
 *
 * Env: NOTION_EXE (path to Notion.exe), NOTION_EFFORT_CONTROL (default 9310),
 *      NOTION_EFFORT_EXT (extension folder, default ../notion-effort),
 *      NOTION_EFFORT_PORT (DevTools port, --port mode only, default 9230).
 * No npm packages: Node 22+ (global WebSocket, fetch).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.NOTION_EFFORT_PORT) || 9230;
const CONTROL = Number(process.env.NOTION_EFFORT_CONTROL) || 9310;
const BASE = 'http://127.0.0.1:' + PORT;
const CTRL = 'http://127.0.0.1:' + CONTROL;
const USE_PORT = process.argv.includes('--port');
// The browser extension's scripts, one level up (the repository root): used as is.
const EXT_DIR = path.resolve(process.env.NOTION_EFFORT_EXT || path.join(__dirname, '..'));

const log = (...a) => console.log('[notion-effort]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms = 5000) =>
  Promise.race([p, sleep(ms).then(() => { throw new Error('no answer in ' + ms + ' ms'); })]);

// --------------------------------------------------------------- the bundle

/**
 * chrome.* stand-in. In the browser composer.js runs in the isolated world
 * with chrome.storage; here everything runs in the page, so storage is the
 * page's localStorage (shared by all Notion tabs, synced via 'storage').
 * Passed in as a parameter, so window.chrome is left alone.
 */
function shimSource(version) {
  return `
  const PFX = 'notionEffortExt:';
  const listeners = [];
  const read = (k) => { try { const v = localStorage.getItem(PFX + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } };
  const notify = (changes) => { if (Object.keys(changes).length) listeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} }); };
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key.indexOf(PFX) !== 0) return;
    const parse = (v) => { try { return v == null ? undefined : JSON.parse(v); } catch (x) { return undefined; } };
    notify({ [e.key.slice(PFX.length)]: { oldValue: parse(e.oldValue), newValue: parse(e.newValue) } });
  });
  const chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const list = keys == null ? Object.keys(localStorage).filter((k) => k.indexOf(PFX) === 0).map((k) => k.slice(PFX.length))
            : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const out = {};
          list.forEach((k) => { const v = read(k); if (v !== undefined) out[k] = v; });
          if (cb) setTimeout(() => cb(out), 0);
          return Promise.resolve(out);
        },
        set(obj, cb) {
          const changes = {};
          Object.keys(obj || {}).forEach((k) => {
            const oldValue = read(k);
            try { localStorage.setItem(PFX + k, JSON.stringify(obj[k] === undefined ? null : obj[k])); } catch (e) {}
            changes[k] = { oldValue: oldValue, newValue: obj[k] };
          });
          setTimeout(() => { notify(changes); if (cb) cb(); }, 0);
          return Promise.resolve();
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    runtime: {
      getManifest: () => ({ version: ${JSON.stringify(version + ' desktop')} }),
      getURL: (p) => p,
      onMessage: { addListener() {} },
      sendMessage: () => Promise.resolve(),
    },
  };`;
}

function buildBundle() {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    throw new Error('extension folder not found: ' + EXT_DIR + ' (keep notion-effort next to this folder or set NOTION_EFFORT_EXT)');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
  const wrap = (f) => `try {\n${fs.readFileSync(path.join(EXT_DIR, f), 'utf8')}\n} catch (e) { console.error('[Notion Effort] ${f} failed', e); }`;
  // The fetch hooks go in at once; the panel needs <html>, which a script
  // registered this way (unlike a document_start content script) runs before.
  const parts = [
    wrap('unlock.js'),
    wrap('inject.js'),
    `const panel = () => {\n${wrap('models.js')}\n${wrap('composer.js')}\n};
  if (document.documentElement) panel();
  else {
    const mo = new MutationObserver(() => {
      if (!document.documentElement) return;
      mo.disconnect();
      panel();
    });
    mo.observe(document, { childList: true });
  }`,
  ];
  // Only Notion's own pages: the desktop shell (file://) and embeds are skipped.
  return `(function () {
  if (!/^https:\\/\\/([a-z0-9-]+\\.)?notion\\.(so|com)$/.test(location.origin)) return;
  if (window.__notionEffortDesktop) return;
  window.__notionEffortDesktop = true;
  ${shimSource(manifest.version)}
  ${parts.join('\n')}
})();`;
}

// ------------------------------------------------------------------- CDP

/** One CDP connection, over a WebSocket (port mode) or a pipe. */
function connection(sendRaw, onRaw, onClose) {
  let id = 0;
  const pending = new Map();
  const handlers = [];
  onRaw((msg) => {
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      handlers.forEach((h) => h(msg));
    }
  });
  return {
    send(method, params, sessionId) {
      const msg = { id: ++id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(msg.id, { resolve, reject });
        try { sendRaw(msg); } catch (e) { reject(e); }
      });
    },
    on(fn) { handlers.push(fn); },
    onClose(fn) { onClose(fn); },
  };
}

/** DevTools over the process's own pipes: nothing is listening on a port. */
function pipeConnection(child) {
  // Chromium reads client messages on fd 3 and writes its own on fd 4.
  const toChrome = child.stdio[3];
  const fromChrome = child.stdio[4];
  if (!fromChrome || !toChrome) throw new Error('Notion did not pass the DevTools pipes');
  toChrome.on('error', () => {});
  const closes = [];
  const raw = (msg) => { try { toChrome.write(JSON.stringify(msg) + '\0'); } catch (e) { throw new Error('pipe closed'); } };
  let buf = '';
  fromChrome.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const text = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!text.trim()) continue;
      try { handlersForEach(JSON.parse(text)); } catch (e) {}
    }
  });
  fromChrome.on('error', () => {});
  fromChrome.on('close', () => closes.forEach((fn) => fn()));
  child.on('exit', () => closes.forEach((fn) => fn()));
  let handlersForEach = () => {};
  const conn = connection(raw, (fn) => { handlersForEach = fn; }, (fn) => closes.push(fn));
  return conn;
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const closes = [];
  ws.addEventListener('message', (ev) => dispatch(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())));
  ws.addEventListener('close', () => closes.forEach((fn) => fn()));
  let dispatch = () => {};
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), { once: true });
  });
  const conn = connection((msg) => ws.send(JSON.stringify(msg)), (fn) => { dispatch = fn; }, (fn) => closes.push(fn));
  conn.opened = opened;
  conn.close = () => ws.close();
  return conn;
}

async function portInfo() {
  try {
    const r = await fetch(BASE + '/json/version');
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

async function controlUp() {
  try {
    const r = await fetch(CTRL + '/status');
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------- launch

function findNotion() {
  if (process.env.NOTION_EXE && fs.existsSync(process.env.NOTION_EXE)) return process.env.NOTION_EXE;
  const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Notion', 'Notion.exe');
  if (fs.existsSync(local)) return local;
  // Microsoft Store / MSIX install: the exe sits under WindowsApps.
  try {
    const dir = execFileSync('powershell', ['-NoProfile', '-Command',
      '(Get-AppxPackage com.notion.app.desktop.notion).InstallLocation'], { encoding: 'utf8' }).trim();
    const exe = dir && path.join(dir, 'Notion', 'Notion.exe');
    if (exe && fs.existsSync(exe)) return exe;
  } catch (e) {}
  return null;
}

function notionRunning() {
  try {
    return /notion\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq Notion.exe', '/NH'], { encoding: 'utf8' }));
  } catch (e) {
    return false;
  }
}

async function closeNotion() {
  // Notion is single-instance: a second start only hands its arguments to the
  // running one, which ignores the pipes. So it has to restart.
  log('Notion is running without the panel — restarting it (your pages are saved by Notion).');
  try { execFileSync('taskkill', ['/IM', 'Notion.exe'], { stdio: 'ignore' }); } catch (e) {}
  for (let i = 0; i < 20 && notionRunning(); i++) await sleep(500);
  if (notionRunning()) {
    try { execFileSync('taskkill', ['/IM', 'Notion.exe', '/F'], { stdio: 'ignore' }); } catch (e) {}
    for (let i = 0; i < 10 && notionRunning(); i++) await sleep(500);
  }
}

/** Starts Notion with the DevTools pipe and returns the live CDP connection. */
async function startNotion() {
  const exe = findNotion();
  if (!exe) throw new Error('Notion.exe not found. Set NOTION_EXE to its full path.');
  if (notionRunning()) await closeNotion();
  log('starting', exe);
  const child = spawn(exe, ['--remote-debugging-pipe'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  child.on('exit', () => { log('Notion closed.'); process.exit(0); });
  const conn = pipeConnection(child);
  conn.child = child;
  // The pipe is there as soon as Notion answers on it.
  for (let i = 0; i < 60; i++) {
    try {
      const v = await withTimeout(conn.send('Browser.getVersion'), 2000);
      log('connected to', v.product);
      return conn;
    } catch (e) {
      await sleep(500);
    }
  }
  throw new Error('Notion started but did not answer on its DevTools pipe.');
}

/** --port mode: the old way, a local DevTools port. */
async function attachByPort() {
  if (!(await portInfo())) {
    const exe = findNotion();
    if (!exe) throw new Error('Notion.exe not found. Set NOTION_EXE to its full path.');
    if (notionRunning()) await closeNotion();
    log('starting', exe);
    spawn(exe, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore' }).unref();
    for (let i = 0; i < 60; i++) {
      if (await portInfo()) break;
      await sleep(500);
    }
    if (!(await portInfo())) throw new Error('Notion started but its DevTools port ' + PORT + ' did not open.');
  }
  const info = await portInfo();
  const conn = cdp(info.webSocketDebuggerUrl);
  await conn.opened;
  return conn;
}

// ---------------------------------------------------------------- inject

async function run() {
  if (await controlUp()) {
    log('the panel is already running (control server on ' + CTRL + '). Nothing to do.');
    return;
  }
  const browser = USE_PORT ? await attachByPort() : await startNotion();
  const bundle = buildBundle();
  const done = new Set();

  async function prepare(sessionId, targetInfo, waiting) {
    const quiet = () => {};
    if (waiting) {
      // A paused tab answers nothing until it is resumed, so awaiting any of
      // these first would hang the tab for good (a new chat that never opens).
      // Sent together, in order: the script is registered before it resumes.
      browser.send('Page.enable', {}, sessionId).catch(quiet);
      browser.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle }, sessionId).catch(quiet);
      browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(quiet);
      log('attached (new tab)');
      return;
    }
    try {
      await withTimeout(browser.send('Page.enable', {}, sessionId));
      await withTimeout(browser.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle }, sessionId));
      if (!/^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(targetInfo.url) || /\/blank\b/.test(targetInfo.url)) return;
      // Already loaded before we got here: the fetch hooks must be in before
      // Notion's code runs, so load it again — unless they already are.
      const r = await withTimeout(browser.send('Runtime.evaluate', { expression: '!!window.__notionEffortDesktop', returnByValue: true }, sessionId));
      if (!(r && r.result && r.result.value)) await browser.send('Page.reload', {}, sessionId);
      log('attached', targetInfo.url);
    } catch (e) {
      log('skipped a tab:', e.message);
    }
  }

  browser.on((msg) => {
    if (msg.method !== 'Target.attachedToTarget') return;
    const { sessionId, targetInfo, waitingForDebugger } = msg.params;
    if (targetInfo.type !== 'page' || done.has(targetInfo.targetId)) {
      if (waitingForDebugger) browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      return;
    }
    done.add(targetInfo.targetId);
    prepare(sessionId, targetInfo, waitingForDebugger);
    publish.pages++;
  });

  // New tabs: paused until the script is registered, so none slips through.
  await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const { targetInfos } = await browser.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type === 'page' && !done.has(t.targetId)) {
      await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => {});
      publish.pages++;
    }
  }

  // Control server, loopback only: --diag and --stop talk to it.
  const publish = { mode: USE_PORT ? 'port' : 'pipe', pid: process.pid, pages: 0, started: new Date().toISOString() };
  const server = require('http').createServer(async (req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      if (req.url === '/status') return send(200, publish);
      if (req.url === '/stop') {
        send(200, { stopping: true });
        log('stop requested — Notion is left running.');
        await sleep(300);
        process.exit(0);
      }
      if (req.url === '/diag') {
        const got = await readDiag(browser);
        if (!got || !got.text) return send(404, { error: 'no Notion page with the panel found' });
        return send(200, got);
      }
      if (req.url === '/diag-all') {
        // Every Notion window keeps its own log: a chat sent from another
        // window is not in the first page's diag.
        return send(200, { pages: await readAllDiag(browser) });
      }
      if (req.url.startsWith('/probe?s=')) {
        const s = decodeURIComponent(req.url.slice(9)).replace(/[^0-9a-f-]/gi, '');
        const got = await evalOnNotion(browser, 'typeof __notionEffortProbeCatalogue === "function" ? __notionEffortProbeCatalogue(' + JSON.stringify(s) + ') : null');
        if (!got) return send(404, { error: 'no Notion page with the panel found' });
        return send(200, { text: got });
      }
      if (req.url.startsWith('/probe?t=')) {
        const t = decodeURIComponent(req.url.slice(9)).replace(/[^0-9a-f-]/gi, '');
        const got = await evalOnNotion(browser, 'typeof __notionEffortProbeThread === "function" ? __notionEffortProbeThread(' + JSON.stringify(t) + ') : null');
        if (!got) return send(404, { error: 'no Notion page with the panel found' });
        return send(200, { text: got });
      }
      send(404, { error: 'unknown' });
    } catch (e) {
      send(500, { error: String(e.message || e) });
    }
  });
  server.on('error', (e) => log('control server: ' + e.message));
  server.listen(CONTROL, '127.0.0.1', () => {
    log('ready — the panel is in Notion. Control server on ' + CTRL + ' (--diag, --stop).');
    log(USE_PORT ? 'NOTE: Notion is listening on port ' + PORT + ' for any local program.' : 'Notion exposes no port: only this process can reach it.');
  });
  await new Promise((r) => browser.onClose ? browser.onClose(r) : setTimeout(r, 60 * 60 * 1000));
  log('connection to Notion lost.');
  process.exit(0);
}

/** First Notion page that returns a value for the expression (awaits promises). */
async function evalOnNotion(browser, expression) {
  let targets;
  try { targets = (await browser.send('Target.getTargets')).targetInfos; } catch (e) { return null; }
  const pages = (targets || []).filter((t) => t.type === 'page' && /^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(t.url));
  for (const t of pages) {
    let sessionId;
    try {
      sessionId = (await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      const r = await withTimeout(browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId), 15000);
      const v = r && r.result && r.result.value;
      if (v) return v;
    } catch (e) {
      continue;
    } finally {
      if (sessionId) browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }
  return null;
}

async function readAllDiag(browser) {
  let targets;
  try { targets = (await browser.send('Target.getTargets')).targetInfos; } catch (e) { return []; }
  const pages = (targets || []).filter((t) => t.type === 'page' && /^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(t.url));
  const out = [];
  for (const t of pages) {
    let sessionId;
    try {
      sessionId = (await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      const r = await withTimeout(browser.send('Runtime.evaluate', {
        expression: 'typeof __notionEffortAgentDiag === "function" ? __notionEffortAgentDiag() : null', returnByValue: true,
      }, sessionId), 8000);
      out.push({ url: t.url, text: (r && r.result && r.result.value) || null });
    } catch (e) {
      out.push({ url: t.url, error: e.message });
    } finally {
      if (sessionId) browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }
  return out;
}

async function readDiag(browser) {
  let targets;
  try { targets = (await browser.send('Target.getTargets')).targetInfos; } catch (e) { return null; }
  const pages = (targets || []).filter((t) => t.type === 'page' && /^https:\/\/([a-z0-9-]+\.)?notion\.(so|com)\//.test(t.url));
  for (const t of pages) {
    let sessionId;
    try {
      sessionId = (await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      const r = await browser.send('Runtime.evaluate', {
        // The diag function already returns formatted JSON text.
        expression: 'typeof __notionEffortAgentDiag === "function" ? (() => { const d = __notionEffortAgentDiag(); return typeof d === "string" ? d : JSON.stringify(d, null, 2); })() : null',
        returnByValue: true,
      }, sessionId);
      const text = r && r.result && r.result.value;
      if (!text) continue;
      // Same page: is the panel itself on it? (the scripts can be in while the
      // UI failed to build).
      let panel = null;
      try {
        const p = await browser.send('Runtime.evaluate', {
          expression: '!!(document.getElementById("notion-effort-picker") || [...document.querySelectorAll("*")].some((n) => n.shadowRoot && n.shadowRoot.querySelector(".pname")))',
          returnByValue: true,
        }, sessionId);
        panel = !!(p && p.result && p.result.value);
      } catch (e) {}
      return { text: text, url: t.url, panel: panel };
    } catch (e) {
      continue;
    } finally {
      if (sessionId) browser.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }
  return null;
}

// ------------------------------------------------------------------- diag

async function diag() {
  const status = await controlUp();
  if (!status) {
    console.error('[notion-effort] the panel is not running. Start it with "Notion Effort.cmd" (or --port mode) first.');
    process.exitCode = 1;
    return;
  }
  let got;
  try {
    got = await fetch(CTRL + '/diag').then((r) => r.json());
  } catch (e) {
    throw new Error('could not read the diagnostics: ' + e.message);
  }
  if (!got || !got.text) throw new Error((got && got.error) || 'no diagnostics');
  log('page:', got.url, '· panel on it:', got.panel);
  const file = path.join(__dirname, 'diag.json');
  fs.writeFileSync(file, got.text);
  try { execFileSync('clip', { input: got.text }); log('diagnostics copied to the clipboard'); } catch (e) {}
  log('saved', file);
}

(async () => {
  if (process.argv.includes('--stop')) {
    const status = await controlUp();
    if (!status) { log('the panel is not running.'); return; }
    await fetch(CTRL + '/stop').catch(() => {});
    log('stopped. Notion keeps running; to get the panel back, start Notion Effort again.');
  } else if (process.argv.includes('--diag')) {
    await diag();
  } else {
    await run();
  }
})().catch((e) => {
  console.error('[notion-effort] ' + e.message);
  process.exitCode = 1;
});
