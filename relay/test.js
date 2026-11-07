'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRelayServer } = require('./server.js');

async function listen(t, options = {}) {
  const server = createRelayServer({ apiKey: 'test-local-key', jobTimeoutMs: 2000, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function post(url, body, apiKey) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('health is public but messages require the generated local key', async (t) => {
  const { base } = await listen(t);
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const missing = await post(base + '/v1/messages', { model: 'opus', messages: [] });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.type, 'authentication_error');

  const wrong = await post(base + '/v1/messages', { model: 'opus', messages: [] }, 'wrong');
  assert.equal(wrong.status, 401);
});

test('messages are fulfilled by a browser relay poll and completion', async (t) => {
  const { base } = await listen(t);
  const responsePromise = post(base + '/v1/messages', {
    model: 'claude-opus-test',
    system: 'System instruction',
    messages: [{ role: 'user', content: 'Hello from Claude Code' }],
  }, 'test-local-key').then((res) => res.json());

  const poll = await fetch(base + '/relay/poll?wait=100', {
    headers: { 'x-api-key': 'test-local-key' },
  });
  assert.equal(poll.status, 200);
  const job = await poll.json();
  assert.match(job.prompt, /System instruction/);
  assert.match(job.prompt, /Hello from Claude Code/);
  assert.equal(job.model, 'claude-opus-test');

  const complete = await post(base + '/relay/complete', {
    id: job.id,
    text: 'Answer from the Notion relay',
    notionModel: 'albuquerque-quinn',
  }, 'test-local-key');
  assert.equal(complete.status, 200);

  const message = await responsePromise;
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.model, 'claude-opus-test');
  assert.equal(message.content[0].text, 'Answer from the Notion relay');
  assert.equal(message.stop_reason, 'end_turn');
});

test('stream=true returns Anthropic-compatible SSE events', async (t) => {
  const { base } = await listen(t);
  const responsePromise = post(base + '/v1/messages', {
    model: 'claude-opus-test', stream: true,
    messages: [{ role: 'user', content: 'Stream this answer' }],
  }, 'test-local-key');

  const poll = await fetch(base + '/relay/poll?wait=100', {
    headers: { 'x-api-key': 'test-local-key' },
  });
  const job = await poll.json();
  await post(base + '/relay/complete', { id: job.id, text: 'Streamed Notion answer' }, 'test-local-key');

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = await response.text();
  assert.match(events, /event: message_start/);
  assert.match(events, /event: content_block_delta/);
  assert.match(events, /Streamed Notion answer/);
  assert.match(events, /event: message_stop/);
});

test('messages use the direct Notion API client when a session is configured', async (t) => {
  const calls = [];
  const notionClient = {
    chat: async (prompt, options) => {
      calls.push({ prompt, options });
      return 'Direct Notion API answer';
    },
  };
  const { base } = await listen(t, { notionClient });
  const response = await post(base + '/v1/messages', {
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Use direct API' }],
  }, 'test-local-key');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content[0].text, 'Direct Notion API answer');
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Use direct API/);
  assert.equal(calls[0].options.model, 'albuquerque-quinn');
  assert.equal(calls[0].options.effort, 'max');
});
