/**
 * Standalone console version (no extension needed).
 *
 * Paste into DevTools console on app.notion.com. It does two things:
 *   1. DIAGNOSE  — prints which Statsig SDK Notion is running, where gate values
 *      are cached, and what `hide_model_selector_for_business_trials` evaluates to.
 *   2. UNLOCK    — seeds legacy localStorage overrides AND patches the live client
 *      (overrideAdapter + checkGate), because the page is already booted.
 *
 * NOTE: pasting in the console runs AFTER Notion's bundle. The live patch works
 * until reload; the localStorage seed only helps if Notion still uses the legacy
 * `statsig-js` SDK. For a patch that lands before boot, use the extension
 * (unlock.js runs at document_start in the MAIN world).
 */
(() => {
  const GATES = {
    hide_model_selector_for_business_trials: false,
    hide_model_selector_for_trials: false,
    hide_model_selector: false,
    hide_model_picker_for_business_trials: false,
    hide_model_picker: false,
    show_model_selector: true,
    enable_model_selector: true,
  };

  const djb2 = (v) => {
    let h = 0;
    for (let i = 0; i < v.length; i++) { h = (h << 5) - h + v.charCodeAt(i); h = h & h; }
    return String(h >>> 0);
  };

  // ---- 1. diagnose -------------------------------------------------------
  const report = { sdk: [], storage: [], gateValues: {} };
  if (window.__STATSIG__) report.sdk.push('@statsig/js-client → window.__STATSIG__ {' + Object.keys(window.__STATSIG__).join(', ') + '}');
  if (window.statsig) report.sdk.push('legacy statsig-js → window.statsig');
  if (!report.sdk.length) report.sdk.push('no global Statsig client (bootstrapped/bundled privately or gate evaluated server-side)');

  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const value = localStorage.getItem(key) || '';
    if (/statsig/i.test(key) || value.includes('model_selector') || value.includes(djb2('hide_model_selector_for_business_trials'))) {
      report.storage.push(key + ' (' + value.length + ' chars)');
    }
  }

  const clients = [];
  const root = window.__STATSIG__;
  if (root) {
    const candidates = [root.instance, root.client, root.instances];
    for (const candidate of candidates) {
      if (!candidate) continue;
      if (typeof candidate === 'function') { try { clients.push(candidate()); } catch (_) {} }
      else if (typeof candidate.checkGate === 'function') clients.push(candidate);
      else if (typeof candidate === 'object') clients.push(...Object.values(candidate));
    }
  }
  if (window.statsig) clients.push(window.statsig);

  for (const client of clients) {
    if (!client || typeof client.checkGate !== 'function') continue;
    for (const name of Object.keys(GATES)) {
      try { report.gateValues[name] = client.checkGate(name); } catch (_) {}
    }
  }

  // ---- 2. unlock ---------------------------------------------------------
  const KEYS = ['STATSIG_LOCAL_STORAGE_INTERNAL_STORE_OVERRIDES_V3', 'STATSIG_OVERRIDES', 'statsig.local-overrides'];
  for (const key of KEYS) {
    let cur = {};
    try { cur = JSON.parse(localStorage.getItem(key) || '{}'); } catch (_) {}
    const gates = { ...(cur.gates || {}) };
    for (const [name, value] of Object.entries(GATES)) { gates[name] = value; gates[djb2(name)] = value; }
    localStorage.setItem(key, JSON.stringify({ ...cur, gates, configs: cur.configs || {}, dynamicConfigs: cur.dynamicConfigs || {}, layers: cur.layers || {} }));
  }

  let livePatched = 0;
  for (const client of clients) {
    if (!client) continue;
    try {
      if (client.overrideAdapter && typeof client.overrideAdapter.overrideGate === 'function') {
        for (const [name, value] of Object.entries(GATES)) client.overrideAdapter.overrideGate(name, value);
        livePatched++;
      }
    } catch (_) {}
    for (const method of ['checkGate', 'getFeatureGate']) {
      try {
        if (typeof client[method] !== 'function') continue;
        const original = client[method].bind(client);
        client[method] = (name, ...rest) => {
          if (name in GATES) {
            const result = original(name, ...rest);
            if (result && typeof result === 'object') { result.value = GATES[name]; return result; }
            return GATES[name];
          }
          return original(name, ...rest);
        };
        livePatched++;
      } catch (_) {}
    }
  }

  console.log('%c[Notion Unlock] diagnosis', 'font-weight:bold', report);
  console.log('[Notion Unlock] live client patches applied:', livePatched, '| clients found:', clients.length);
  console.log(
    livePatched
      ? '[Notion Unlock] reopen the AI panel (no reload — a reload drops in-memory patches).'
      : '[Notion Unlock] no live client reachable — the gate is bootstrapped or server-evaluated. Use the extension (unlock.js at document_start).'
  );
})();
