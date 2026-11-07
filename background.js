importScripts('relay-settings.js', 'relay-background.js', 'direct-session.js');

chrome.runtime.onInstalled.addListener((details) => {
  // Only on first install: an update/reload must not wipe the chosen effort.
  if (details.reason !== "install") return;
  chrome.storage.local.set({
    // No default override: until the user picks one, Notion's own effort stands.
    selectedEffort: null,
    stats: { requests: 0, swaps: 0 }
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATS_UPDATE") {
    chrome.runtime.sendMessage(msg).catch(() => {});
    chrome.storage.local.set({ stats: { requests: msg.requests, swaps: msg.swaps } });
  }
});
