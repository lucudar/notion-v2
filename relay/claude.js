'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const configPath = path.join(__dirname, 'relay-config.json');
if (!fs.existsSync(configPath)) {
  console.error('Run relay/start.js first to generate the local URL and key.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const command = process.platform === 'win32' ? 'claude.exe' : 'claude';
const child = spawn(command, process.argv.slice(2), {
  stdio: 'inherit',
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
    ANTHROPIC_API_KEY: config.apiKey,
  },
});
child.on('error', (error) => {
  console.error('Could not start Claude Code: ' + error.message);
  process.exit(1);
});
child.on('exit', (code) => process.exit(code || 0));
