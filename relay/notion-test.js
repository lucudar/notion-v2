'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { NotionClient } = require('./notion.js');

test('direct Notion client pins the model and reads the assistant transcript', async (t) => {
  const calls = [];
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    calls.push({ url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v3/createAgentThread') {
      res.end(JSON.stringify({
        threadId: body.threadId,
        thread: { data: { agent_provider: { model: 'albuquerque-quinn', reasoningEffort: 'max' } } },
      }));
      return;
    }
    if (req.url === '/api/v3/saveTransactions') { res.end('{}'); return; }
    if (req.url === '/api/v3/getThreadTranscript') {
      res.end(JSON.stringify({ patches: [{ op: 'put', entity: { kind: 'assistant_message', content: [{ text: [['Hello from direct API']] } ] } }] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));

  const client = new NotionClient({
    baseUrl: `http://127.0.0.1:${fake.address().port}`,
    tokenV2: 'test-session-cookie', userId: 'user-1', spaceId: 'space-1', pollIntervalMs: 1,
  });
  const answer = await client.chat('Hello', { model: 'albuquerque-quinn', effort: 'max' });
  assert.equal(answer, 'Hello from direct API');

  const create = calls.find((call) => call.url === '/api/v3/createAgentThread');
  assert.equal(create.headers.cookie, 'token_v2=test-session-cookie');
  assert.equal(create.headers['x-notion-active-user-header'], 'user-1');
  assert.equal(create.body.model, 'albuquerque-quinn');
  assert.equal(create.body.reasoningEffort, 'max');
  assert.equal(create.body.type, 'personal_agent');
});
