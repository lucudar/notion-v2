'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { NotionClient } = require('./notion.js');

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  res.end(data);
}

function apiError(res, status, type, message) {
  sendJson(res, status, { type: 'error', error: { type, message } });
}

function authorized(req, apiKey) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return req.headers['x-api-key'] === apiKey || bearer === apiKey;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 12 * 1024 * 1024) {
        reject(new Error('Request body exceeds 12 MiB'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'tool_result') return '[Tool result]\n' + contentText(block.content);
    if (block.type === 'tool_use') return '[Tool call: ' + (block.name || 'unknown') + ']\n' + JSON.stringify(block.input || {});
    if (block.type === 'image') return '[Image omitted: the Notion relay currently accepts text only]';
    return '';
  }).filter(Boolean).join('\n');
}

function promptFromRequest(body) {
  const parts = [];
  const system = contentText(body.system);
  if (system) parts.push('SYSTEM\n' + system);
  for (const message of body.messages || []) {
    const role = message.role === 'assistant' ? 'ASSISTANT' : 'USER';
    const text = contentText(message.content);
    if (text) parts.push(role + '\n' + text);
  }
  parts.push('Respond as the assistant. Preserve the conversation context above.');
  return parts.join('\n\n');
}

function anthropicMessage(body, result) {
  return {
    id: 'msg_' + crypto.randomUUID().replace(/-/g, ''),
    type: 'message', role: 'assistant', model: body.model || 'claude-opus-4-6',
    content: [{ type: 'text', text: result.text || '' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sendAnthropicStream(res, body, result) {
  const message = anthropicMessage(body, result);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  });
  const send = (event, data) => {
    res.write('event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
  };
  send('message_start', { type: 'message_start', message: { ...message, content: [] } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.text || '' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

function createRelayServer(options) {
  const apiKey = options.apiKey;
  const jobTimeoutMs = options.jobTimeoutMs || 180000;
  if (!apiKey) throw new Error('apiKey is required');
  const jobs = new Map();
  const queue = [];
  const waiters = new Set();
  let relayConnected = false;
  let lastRelayPoll = 0;
  let notionClient = options.notionClient || null;
  if (!notionClient && options.sessionPath && fs.existsSync(options.sessionPath)) {
    try {
      const session = JSON.parse(fs.readFileSync(options.sessionPath, 'utf8'));
      notionClient = new NotionClient({
        tokenV2: session.tokenV2, userId: session.userId,
        spaceId: session.spaceId || options.spaceId,
        log: options.log || (() => {}),
      });
    } catch (_) {}
  }

  function notionModelFor(requested) {
    return String(requested || '').toLowerCase().indexOf('sonnet') !== -1
      ? 'almond-croissant-low' : 'albuquerque-quinn';
  }

  function takeJob() {
    const id = queue.shift();
    if (!id) return null;
    const job = jobs.get(id);
    if (!job || job.settled) return takeJob();
    job.inflight = true;
    return job;
  }

  function offerJob() {
    if (!queue.length || !waiters.size) return;
    for (const waiter of waiters) {
      const job = takeJob();
      if (!job) return;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(job);
      return;
    }
  }

  function settle(job, error, result) {
    if (!job || job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    jobs.delete(job.id);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true, service: 'notion-claude-relay',
          relayConnected: relayConnected && Date.now() - lastRelayPoll < 45000,
          directNotion: !!notionClient,
          queuedJobs: queue.length,
        });
        return;
      }
      if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/relay/')) {
        if (!authorized(req, apiKey)) {
          apiError(res, 401, 'authentication_error', 'Invalid or missing local relay key');
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readJson(req);
        if (!Array.isArray(body.messages)) {
          apiError(res, 400, 'invalid_request_error', 'messages must be an array');
          return;
        }
        if (notionClient) {
          if (options.log) options.log('direct Claude request received: model=' + body.model);
          const notionModel = notionModelFor(body.model);
          const text = await notionClient.chat(promptFromRequest(body), {
            model: notionModel, effort: 'max',
          });
          const result = { text, notionModel };
          if (body.stream === true) sendAnthropicStream(res, body, result);
          else sendJson(res, 200, anthropicMessage(body, result));
          return;
        }
        const id = 'job_' + crypto.randomUUID();
        const job = {
          id, model: body.model || 'claude-opus-4-6', prompt: promptFromRequest(body),
          stream: body.stream === true, inflight: false, settled: false,
        };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        job.timer = setTimeout(() => settle(job, new Error('No browser relay completed the request within the timeout')), jobTimeoutMs);
        job.timer.unref();
        jobs.set(id, job);
        queue.push(id);
        offerJob();
        const result = await job.promise;
        if (body.stream === true) sendAnthropicStream(res, body, result);
        else sendJson(res, 200, anthropicMessage(body, result));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        sendJson(res, 200, { input_tokens: 0 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/configure') {
        const session = await readJson(req);
        if (!session.tokenV2 || typeof session.tokenV2 !== 'string') {
          apiError(res, 400, 'invalid_request_error', 'tokenV2 is required');
          return;
        }
        const client = new NotionClient({
          tokenV2: session.tokenV2,
          spaceId: session.spaceId || options.spaceId || null,
        });
        await client.init();
        if (options.sessionPath) {
          fs.writeFileSync(options.sessionPath, JSON.stringify({
            tokenV2: session.tokenV2, userId: client.userId, spaceId: client.spaceId,
          }), { mode: 0o600 });
        }
        notionClient = client;
        sendJson(res, 200, { ok: true, userId: client.userId, spaceId: client.spaceId });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/poll') {
        relayConnected = true;
        lastRelayPoll = Date.now();
        let job = takeJob();
        if (!job) {
          const waitMs = Math.min(25000, Math.max(0, Number(url.searchParams.get('wait') || 20000)));
          job = await new Promise((resolve) => {
            const waiter = { resolve, timer: null };
            waiter.timer = setTimeout(() => { waiters.delete(waiter); resolve(null); }, waitMs);
            waiter.timer.unref();
            waiters.add(waiter);
            offerJob();
          });
        }
        if (!job) {
          res.writeHead(204, { 'cache-control': 'no-store' });
          res.end();
          return;
        }
        sendJson(res, 200, { id: job.id, model: job.model, prompt: job.prompt });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/complete') {
        const result = await readJson(req);
        const job = jobs.get(result.id);
        if (!job) {
          apiError(res, 404, 'not_found_error', 'Unknown or expired relay job');
          return;
        }
        if (result.error) settle(job, new Error(String(result.error)));
        else {
          settle(job, null, { text: String(result.text || ''), notionModel: result.notionModel || null });
          lastRelayPoll = Date.now();
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      apiError(res, 404, 'not_found_error', 'Unknown endpoint');
    } catch (error) {
      apiError(res, 500, 'api_error', String(error.message || error));
    }
  });
}

module.exports = { createRelayServer, sendJson, apiError, promptFromRequest };
