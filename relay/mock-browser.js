'use strict';

// Test-only stand-in for the Chrome relay. It proves the Claude Code protocol
// without pretending that a real Notion response was received.
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'relay-config.json'), 'utf8'));
const base = `http://${config.host}:${config.port}`;
const headers = { 'content-type': 'application/json', 'x-api-key': config.apiKey };

async function run() {
  for (;;) {
    try {
      const response = await fetch(base + '/relay/poll?wait=20000', { headers });
      if (response.status === 204) continue;
      if (!response.ok) throw new Error('poll HTTP ' + response.status);
      const job = await response.json();
      await fetch(base + '/relay/complete', {
        method: 'POST', headers,
        body: JSON.stringify({ id: job.id, text: 'RELAY_OK', notionModel: 'mock-browser-relay' }),
      });
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
run();
