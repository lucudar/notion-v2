/**
 * Diagnostic probe (MAIN world, document_start, runs before unlock/inject).
 *
 * The new Notion AI chat does not send the model / reasoning effort through
 * any fetch body we recognise. This records every channel the page can use —
 * fetch (requests + responses), XHR, WebSocket, Web/Shared Workers, message
 * ports, BroadcastChannel — and keeps only the fields that name a model or an
 * effort, so the real carrier can be found without logging message text.
 *
 * In DevTools:  copy(__notionEffortReport())  → paste the result.
 */
(function () {
  'use strict';
  if (window.__notionEffortProbe) return;

  const events = [];
  const endpoints = {};
  window.__notionEffortProbe = { events: events, endpoints: endpoints };

  const KEY = /model|effort|reason|thinking|intelligence/i;
  const VAL = /\b(opus|sonnet|haiku|fable|gpt|gemini|grok|kimi|deepseek|glm)\b|agave|flan|croissant|sorbet|froyo|budino/i;
  const BIN_HIT = /reasoning.?effort|"model"|agave-|opus/i;
  const MAX_EVENTS = 200;
  const MAX_HITS = 60;

  function shortUrl(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  }

  function clip(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function scanObject(root) {
    const hits = [];
    let visited = 0;
    (function walk(node, path, depth) {
      if (hits.length >= MAX_HITS || visited++ > 20000 || depth > 12) return;
      if (node === null || node === undefined) return;
      if (typeof node !== 'object') return;
      const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
      for (const k of keys) {
        if (hits.length >= MAX_HITS) return;
        let v;
        try { v = node[k]; } catch (e) { continue; }
        const p = Array.isArray(node) ? path + '[' + k + ']' : path ? path + '.' + k : String(k);
        const keyHit = typeof k === 'string' && KEY.test(k);
        if (typeof v === 'string') {
          if (keyHit || VAL.test(v)) hits.push(p + ' = ' + clip(JSON.stringify(v), 120));
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          if (keyHit) hits.push(p + ' = ' + v);
        } else if (v && typeof v === 'object') {
          if (keyHit) {
            let j = '';
            try { j = JSON.stringify(v); } catch (e) { j = '[object]'; }
            hits.push(p + ' = ' + clip(j, 300));
          }
          walk(v, p, depth + 1);
        }
      }
    })(root, '', 0);
    return hits;
  }

  function scanText(text) {
    if (typeof text !== 'string' || !text) return [];
    const t = text.length > 3000000 ? text.slice(0, 3000000) : text;
    const c = t.trim()[0];
    if (c === '{' || c === '[') {
      try { return scanObject(JSON.parse(t)); } catch (e) {}
      // NDJSON / streamed chunks: one JSON value per line.
      const hits = [];
      const lines = t.split('\n');
      for (let i = 0; i < lines.length && i < 3000 && hits.length < MAX_HITS; i++) {
        const l = lines[i].trim();
        if (!l || (l[0] !== '{' && l[0] !== '[')) continue;
        try {
          scanObject(JSON.parse(l)).forEach((h) => hits.push('line' + i + '.' + h));
        } catch (e) {}
      }
      if (hits.length) return hits.slice(0, MAX_HITS);
    }
    return snippets(t);
  }

  function snippets(t) {
    const hits = [];
    const re = new RegExp(BIN_HIT.source, 'gi');
    let m;
    while ((m = re.exec(t)) && hits.length < 10) {
      hits.push('…' + clip(t.slice(Math.max(0, m.index - 60), m.index + 120).replace(/[^\x20-\x7e]/g, '·'), 200));
      re.lastIndex = m.index + 120;
    }
    return hits;
  }

  // Requests that start / steer an agent chat or save settings: record their
  // full shape (keys + short values; long strings replaced by their length),
  // since the model choice may ride in a field that is not called "model".
  const SHAPE_URL = /AgentThread|AgentService|updateSpaceSettings|saveTransactions|submitTransaction|agent/i;

  function shape(value, depth) {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string') return value.length > 48 ? '<str ' + value.length + '>' : value;
      return value;
    }
    if (depth > 9) return '…';
    if (Array.isArray(value)) {
      const a = value.slice(0, 6).map((v) => shape(v, depth + 1));
      if (value.length > 6) a.push('… +' + (value.length - 6));
      return a;
    }
    const o = {};
    Object.keys(value).slice(0, 40).forEach((k) => { o[k] = shape(value[k], depth + 1); });
    return o;
  }

  function recordShape(via, url, data) {
    try {
      let obj = data;
      if (typeof data === 'string') obj = JSON.parse(data);
      if (!obj || typeof obj !== 'object') return;
      record(via, 'shape', url, [clip(JSON.stringify(shape(obj, 0)), 4000)]);
    } catch (e) {}
  }

  function scanAny(data) {
    try {
      if (typeof data === 'string') return scanText(data);
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const s = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 300000));
        return scanText(s);
      }
      if (data && typeof data === 'object') return scanObject(data);
    } catch (e) {}
    return [];
  }

  function record(via, dir, url, hits, extra) {
    if (!hits || !hits.length) return;
    events.push({
      at: new Date().toISOString().slice(11, 23),
      via: via,
      dir: dir,
      url: shortUrl(url),
      hits: hits,
      extra: extra || undefined,
    });
    if (events.length > MAX_EVENTS) events.shift();
  }

  function countEndpoint(via, method, url) {
    const k = via + ' ' + method + ' ' + shortUrl(url);
    endpoints[k] = (endpoints[k] || 0) + 1;
  }

  // ---- fetch -------------------------------------------------------------
  const rawFetch = window.fetch;
  window.fetch = function (input, options) {
    let url = '';
    let method = 'GET';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
      method = String((options && options.method) || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    } catch (e) {}
    const interesting = /\/api\/|notion/i.test(url);
    if (interesting) {
      countEndpoint('fetch', method, url);
      try {
        const b = options && options.body;
        const wantShape = SHAPE_URL.test(url) && method === 'POST';
        if (b !== undefined && b !== null) {
          record('fetch', 'req', url, scanAny(b));
          if (wantShape) recordShape('fetch', url, b);
        } else if (input instanceof Request && method !== 'GET') {
          input.clone().text().then((t) => {
            record('fetch', 'req', url, scanText(t));
            if (wantShape) recordShape('fetch', url, t);
          }).catch(() => {});
        }
      } catch (e) {}
    }
    const p = rawFetch.apply(this, arguments);
    if (interesting) {
      p.then((res) => {
        try {
          const len = Number(res.headers.get('content-length') || 0);
          if (len > 5000000) return;
          res.clone().text().then((t) => record('fetch', 'res', url, scanText(t), 'status ' + res.status)).catch(() => {});
        } catch (e) {}
      }).catch(() => {});
    }
    return p;
  };

  // ---- XHR ---------------------------------------------------------------
  const rawOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__probe = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
    return rawOpen.apply(this, arguments);
  };
  const rawSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (data) {
    const info = this.__probe;
    if (info) {
      countEndpoint('xhr', info.method, info.url);
      record('xhr', 'req', info.url, scanAny(data));
      this.addEventListener('loadend', () => {
        try {
          const r = this.responseType === '' || this.responseType === 'text' ? this.responseText : this.response;
          record('xhr', 'res', info.url, scanAny(r), 'status ' + this.status);
        } catch (e) {}
      });
    }
    return rawSend.apply(this, arguments);
  };

  // ---- WebSocket ---------------------------------------------------------
  const RawWS = window.WebSocket;
  if (RawWS) {
    const rawWsSend = RawWS.prototype.send;
    RawWS.prototype.send = function (data) {
      countEndpoint('ws', 'send', this.url);
      record('ws', 'send', this.url, scanAny(data));
      if (typeof data === 'string' && /transaction|operations|agent/i.test(data)) {
        const i = data.indexOf('{');
        recordShape('ws', this.url, i > 0 ? data.slice(i) : data);
      }
      return rawWsSend.apply(this, arguments);
    };
    const ProbeWS = function (url, protocols) {
      const ws = protocols === undefined ? new RawWS(url) : new RawWS(url, protocols);
      countEndpoint('ws', 'open', String(url));
      ws.addEventListener('message', (e) => {
        countEndpoint('ws', 'recv', String(url));
        record('ws', 'recv', String(url), scanAny(e.data));
      });
      return ws;
    };
    ProbeWS.prototype = RawWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach((k) => { ProbeWS[k] = RawWS[k]; });
    window.WebSocket = ProbeWS;
  }

  // ---- Workers, ports, broadcast channels ------------------------------
  function wrapWorker(name) {
    const Raw = window[name];
    if (!Raw) return;
    const Probe = function (url, opts) {
      const w = opts === undefined ? new Raw(url) : new Raw(url, opts);
      const u = String(url);
      countEndpoint(name, 'new', u);
      events.push({ at: new Date().toISOString().slice(11, 23), via: name, dir: 'new', url: shortUrl(u), hits: [] });
      try { w.__probeUrl = u; } catch (e) {}
      const target = name === 'SharedWorker' ? w.port : w;
      try { target.__probeUrl = u; } catch (e) {}
      target.addEventListener('message', (e) => record(name, 'in', u, scanAny(e.data)));
      return w;
    };
    Probe.prototype = Raw.prototype;
    window[name] = Probe;
  }
  wrapWorker('Worker');
  wrapWorker('SharedWorker');

  if (window.Worker && Worker.prototype.postMessage) {
    const rawPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg) {
      countEndpoint('Worker', 'post', this.__probeUrl || '?');
      record('Worker', 'out', this.__probeUrl || '?', scanAny(msg));
      return rawPost.apply(this, arguments);
    };
  }
  if (window.MessagePort) {
    const rawPortPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (msg) {
      countEndpoint('port', 'post', this.__probeUrl || '?');
      record('port', 'out', this.__probeUrl || '?', scanAny(msg));
      return rawPortPost.apply(this, arguments);
    };
  }
  if (window.BroadcastChannel) {
    const rawBc = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (msg) {
      countEndpoint('broadcast', 'post', this.name);
      record('broadcast', 'out', this.name, scanAny(msg));
      return rawBc.apply(this, arguments);
    };
  }
  if (navigator.serviceWorker && window.ServiceWorker) {
    const rawSwPost = ServiceWorker.prototype.postMessage;
    ServiceWorker.prototype.postMessage = function (msg) {
      countEndpoint('serviceWorker', 'post', this.scriptURL);
      record('serviceWorker', 'out', this.scriptURL, scanAny(msg));
      return rawSwPost.apply(this, arguments);
    };
    navigator.serviceWorker.addEventListener('message', (e) => record('serviceWorker', 'in', 'sw', scanAny(e.data)));
  }

  window.__notionEffortReport = function (filter) {
    const lines = ['== endpoints (count) =='];
    Object.keys(endpoints).sort().forEach((k) => lines.push(endpoints[k] + '  ' + k));
    lines.push('', '== events with model/effort fields ==');
    events.forEach((e) => {
      if (filter instanceof RegExp && !filter.test(e.via + ' ' + e.dir + ' ' + e.url)) return;
      lines.push('[' + e.at + '] ' + e.via + ' ' + e.dir + ' ' + e.url + (e.extra ? ' (' + e.extra + ')' : ''));
      e.hits.forEach((h) => lines.push('    ' + h));
    });
    return lines.join('\n');
  };
})();
