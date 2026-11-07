(function() {
  'use strict';

  let interceptCount = 0;
  let swapCount = 0;
  let agent = null;

  function injectScript() {
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  injectScript();

  function loadAndSendSettings() {
    chrome.storage.local.get(["selectedEffort"], (data) => {
      window.postMessage({
        type: 'NOTION_EFFORT_SETTINGS',
        effort: data.selectedEffort || null,
      }, '*');
    });
  }

  loadAndSendSettings();

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'NOTION_RELAY_REQUEST') {
      const job = msg.job;
      const timer = setTimeout(() => {
        window.removeEventListener('message', onRelayResult);
        sendResponse({ error: 'Timed out waiting for the Notion page relay' });
      }, 170000);
      function onRelayResult(e) {
        if (e.source !== window || !e.data || e.data.type !== 'NOTION_RELAY_RESULT') return;
        if (!e.data.job || e.data.job.id !== job.id) return;
        clearTimeout(timer);
        window.removeEventListener('message', onRelayResult);
        sendResponse(e.data.result || { error: 'Empty relay result' });
      }
      window.addEventListener('message', onRelayResult);
      window.postMessage({ type: 'NOTION_RELAY_REQUEST', job }, '*');
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ interceptCount, swapCount, agent });
      return true;
    }
    if (msg.type === 'UPDATE_SETTINGS') {
      window.postMessage({
        type: 'NOTION_EFFORT_SETTINGS',
        effort: msg.effort || null,
      }, '*');
      sendResponse({ ok: true });
      return true;
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data && e.data.type === 'NOTION_EFFORT_AGENT') {
      agent = {
        thread: e.data.thread,
        model: e.data.model,
        modelSelection: e.data.modelSelection,
        reasoningEffort: e.data.reasoningEffort,
      };
    }
    if (e.data && e.data.type === 'NOTION_EFFORT_PONG') {
      interceptCount = e.data.interceptCount;
      swapCount = e.data.swappedCount;
      chrome.runtime.sendMessage({
        type: 'STATS_UPDATE',
        requests: interceptCount,
        swaps: swapCount
      });
    }
  });

  setInterval(() => {
    window.postMessage({ type: 'NOTION_EFFORT_PING' }, '*');
  }, 2000);
})();
