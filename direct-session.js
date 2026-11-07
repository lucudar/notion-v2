'use strict';

// One-time session handoff to the loopback server. After this succeeds, Claude
// Code requests go Node -> Notion directly; the browser is not in the request
// path. The session cookie is never sent anywhere except 127.0.0.1:8787.
(() => {
  async function configureDirectSession() {
    const config = typeof NOTION_RELAY_CONFIG !== 'undefined' ? NOTION_RELAY_CONFIG : null;
    if (!config) return;
    try {
      const health = await fetch(config.baseUrl + '/health').then((r) => r.json());
      if (health.directNotion) return;
      const cookie = await chrome.cookies.get({ url: 'https://app.notion.com', name: 'token_v2' });
      if (!cookie || !cookie.value) {
        console.warn('[Notion relay] token_v2 not found; open an authenticated Notion tab');
        return;
      }
      const response = await fetch(config.baseUrl + '/relay/configure', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
        body: JSON.stringify({ tokenV2: cookie.value }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(text.slice(0, 300));
      console.log('[Notion relay] direct Notion API session configured', JSON.parse(text));
    } catch (error) {
      console.warn('[Notion relay] direct session setup:', String(error.message || error));
    }
  }

  chrome.runtime.onInstalled.addListener(configureDirectSession);
  chrome.runtime.onStartup.addListener(configureDirectSession);
  chrome.cookies.onChanged.addListener((change) => {
    if (change.cookie && change.cookie.name === 'token_v2' && /(^|\.)notion\.(com|so)$/i.test(change.cookie.domain)) {
      configureDirectSession();
    }
  });
  configureDirectSession();
})();
