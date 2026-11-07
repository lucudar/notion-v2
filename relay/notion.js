'use strict';

const crypto = require('node:crypto');

class NotionClient {
  constructor(options) {
    if (!options.tokenV2) throw new Error('tokenV2 is required');
    this.baseUrl = options.baseUrl || 'https://app.notion.com';
    this.tokenV2 = options.tokenV2;
    this.userId = options.userId || null;
    this.spaceId = options.spaceId || null;
    this.pollIntervalMs = options.pollIntervalMs == null ? 1000 : options.pollIntervalMs;
    this.maxPolls = options.maxPolls || 45;
    this.log = options.log || (() => {});
  }

  async request(path, body) {
    this.log('request start: ' + path);
    const headers = {
      'content-type': 'application/json',
      accept: '*/*',
      cookie: 'token_v2=' + this.tokenV2,
      origin: 'https://app.notion.com',
      referer: 'https://app.notion.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143 Safari/537.36',
      'notion-audit-log-platform': 'web',
    };
    if (this.userId) headers['x-notion-active-user-header'] = this.userId;
    if (this.spaceId) {
      headers['x-notion-space-id'] = this.spaceId;
      headers['x-notion-cell-hint'] = 'prod-space-usw2-0004';
      headers['x-notion-cell-hint-source'] = 'space-id-mapping';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    let response;
    try {
      response = await fetch(this.baseUrl + path, {
        method: 'POST', headers, body: JSON.stringify(body || {}), signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    this.log('response: ' + path + ' HTTP ' + response.status);
    if (!response.ok) {
      this.log('ERROR: ' + path + ' HTTP ' + response.status + ' ' + text.slice(0, 700));
      throw new Error(path + ': HTTP ' + response.status + ' ' + text.slice(0, 300));
    }
    let data;
    try { data = JSON.parse(text || '{}'); } catch (_) { throw new Error(path + ': non-JSON response'); }
    if (data.isNotionError) throw new Error(path + ': ' + (data.name || 'Notion error') + ' ' + (data.message || ''));
    return data;
  }

  async init() {
    if (this.userId && this.spaceId) return this;
    const spaces = await this.request('/api/v3/getSpaces', {});
    let fallback = null;
    for (const [userId, account] of Object.entries(spaces)) {
      for (const spaceId of Object.keys(account.space || {})) {
        if (!fallback) fallback = { userId, spaceId };
        if (!this.spaceId || spaceId === this.spaceId) {
          this.userId = this.userId || userId;
          this.spaceId = spaceId;
          return this;
        }
      }
    }
    if (fallback && !this.spaceId) {
      this.userId = this.userId || fallback.userId;
      this.spaceId = fallback.spaceId;
      return this;
    }
    throw new Error('No accessible Notion workspace found for this session');
  }

  async chat(content, options = {}) {
    await this.init();
    content = String(content || '').trim();
    if (!content) throw new Error('Cannot send an empty Notion message');
    const model = options.model || 'albuquerque-quinn';
    const effort = options.effort || 'max';
    const threadId = crypto.randomUUID();
    const created = await this.request('/api/v3/createAgentThread', {
      type: 'personal_agent', spaceId: this.spaceId, threadId,
      enableSuggestedEditsTools: true, createdSource: 'full_page_chat',
      content: [{ type: 'text', text: [[content]] }],
      policies: { approval_mode: 'yolo' },
      agentMemorySettings: { useMemories: true, excludeChatFromMemories: false },
      browserEnabled: true, clientMessageId: crypto.randomUUID(),
      model, reasoningEffort: effort,
    });
    const provider = created.thread && created.thread.data && created.thread.data.agent_provider;
    if (provider && provider.model && provider.model !== model) {
      throw new Error('Notion routed the request to ' + provider.model + ' instead of ' + model);
    }
    await this.request('/api/v3/saveTransactions', {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(), spaceId: this.spaceId,
        operations: [{
          pointer: { table: 'thread', id: threadId, spaceId: this.spaceId },
          path: ['data', 'agent_provider'], command: 'update',
          args: { model, reasoningEffort: effort, modelSelection: 'explicit' },
        }],
      }],
    }).catch(() => {});

    for (let i = 0; i < this.maxPolls; i++) {
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      let data;
      try {
        data = await this.request('/api/v3/getThreadTranscript', {
          spaceId: this.spaceId, threadId, direction: 'backward', limit: 20,
        });
      } catch (_) { continue; }
      for (const patch of data.patches || []) {
        const entity = patch && patch.entity;
        if (patch.op !== 'put' || !entity || entity.kind !== 'assistant_message') continue;
        const value = entity.content && entity.content[0] && entity.content[0].text;
        const answer = Array.isArray(value)
          ? value.map((row) => Array.isArray(row) ? row[0] : String(row)).join('').trim()
          : (typeof value === 'string' ? value.trim() : '');
        if (answer) return answer;
      }
    }
    throw new Error('Notion did not answer within ' + this.maxPolls + ' polls (thread ' + threadId + ')');
  }
}

module.exports = { NotionClient };
