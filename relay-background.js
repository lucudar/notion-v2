'use strict';

// MV3 service-worker relay. It long-polls the loopback server, forwards a job
// to the top-frame content script in a logged-in Notion tab, and returns the
// resulting text to the local Claude Code endpoint.
(() => {
  const config = typeof NOTION_RELAY_CONFIG !== 'undefined' ? NOTION_RELAY_CONFIG : null;
  let running = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function notionTabs() {
    const tabs = await chrome.tabs.query({
      url: ['https://app.notion.com/*', 'https://www.notion.so/*', 'https://notion.so/*'],
    });
    return tabs.sort((a, b) => Number(b.active) - Number(a.active));
  }

  async function executeRelay(tab, job) {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      world: 'MAIN',
      args: [{ id: job.id, model: job.model, prompt: job.prompt }],
      func: async (relayJob) => {
        if (typeof window.__notionEffortChat !== 'function') {
          return { errorCode: 'NOTION_RELAY_MISSING' };
        }
        try {
          const requested = String(relayJob.model || '').toLowerCase();
          const notionModel = requested.indexOf('sonnet') !== -1 ? 'almond-croissant-low' : 'albuquerque-quinn';
          const text = await window.__notionEffortChat(relayJob.prompt, {
            model: notionModel, effort: 'max', history: false,
          });
          return { text: text, notionModel: notionModel };
        } catch (error) {
          return { error: String(error.message || error) };
        }
      },
    });
    return frames && frames[0] && frames[0].result;
  }

  async function deliver(tab, job) {
    let result = await executeRelay(tab, job);
    if (result && result.errorCode === 'NOTION_RELAY_MISSING') {
      // Load the page helper directly in MAIN world. No content-script message
      // channel is involved, so a stale tab cannot produce "receiving end does
      // not exist" after an extension reload.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        world: 'MAIN', files: ['inject.js'],
      });
      await sleep(250);
      result = await executeRelay(tab, job);
    }
    return result;
  }

  async function complete(job, result) {
    const response = await fetch(config.baseUrl + '/relay/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey },
      body: JSON.stringify({ id: job.id, ...result }),
    });
    if (!response.ok) throw new Error('Relay completion failed: HTTP ' + response.status);
  }

  async function processJob(job) {
    try {
      const tabs = await notionTabs();
      if (!tabs.length) throw new Error('Open a logged-in Notion tab and keep the relay extension loaded');
      let lastError = null;
      for (const tab of tabs) {
        try {
          const result = await deliver(tab, job);
          if (!result || result.error) throw new Error((result && result.error) || 'No response from the Notion page relay');
          await complete(job, { text: result.text, notionModel: result.notionModel });
          return;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('No usable Notion tab');
    } catch (error) {
      await complete(job, { error: String(error.message || error) }).catch(() => {});
    }
  }

  async function pollLoop() {
    if (!config || running) return;
    running = true;
    while (config) {
      try {
        const response = await fetch(config.baseUrl + '/relay/poll?wait=20000', {
          headers: { 'x-api-key': config.apiKey },
        });
        if (response.status === 204) continue;
        if (!response.ok) throw new Error('Relay poll failed: HTTP ' + response.status);
        await processJob(await response.json());
      } catch (error) {
        await sleep(2000);
      }
    }
  }

  chrome.runtime.onStartup.addListener(pollLoop);
  chrome.runtime.onInstalled.addListener(pollLoop);
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'notion-relay-keepalive') pollLoop();
  });
  chrome.alarms.create('notion-relay-keepalive', { periodInMinutes: 0.5 });
  pollLoop();
})();
