'use strict';
const { createRelayServer } = require('./server.js');
const { spawn } = require('node:child_process');
const server = createRelayServer({ apiKey: 'repro-key', jobTimeoutMs: 30000 });
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  (async () => {
    for (;;) {
      try {
        const res = await fetch(base + '/relay/poll?wait=1000', { headers: { 'x-api-key': 'repro-key' } });
        if (res.status !== 200) continue;
        const job = await res.json();
        await fetch(base + '/relay/complete', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'repro-key' },
          body: JSON.stringify({ id: job.id, text: 'RELAY_OK' }),
        });
      } catch (_) { break; }
    }
  })();
  const child = spawn('claude.exe', ['--bare', '--tools', '', '--model', 'opus', '-p', 'Reply with exactly RELAY_OK'], {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: 'repro-key' },
  });
  const timer = setTimeout(() => { child.kill(); server.close(); process.exit(124); }, 60000);
  child.on('exit', (code) => { clearTimeout(timer); server.close(); process.exit(code || 0); });
});
