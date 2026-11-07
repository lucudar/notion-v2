(function() {
  'use strict';

  // inject.js now runs as a MAIN-world content script; content.js still appends it
  // as a <script> tag on older Chrome builds, so only the first copy may wrap fetch.
  if (window.__notionEffortInjected) return;
  window.__notionEffortInjected = true;

  let interceptedCount = 0;
  let swappedCount = 0;
  let lastRequestedEffort = null;
  // Tri-state so the picker can tell "no model in the request" (nothing to
  // clamp, not alarming) apart from "model present but outside our catalogue"
  // (worth flagging, and worth surfacing its id so it can be added).
  //   'known'   → model present and recognised
  //   'unknown' → model present, not in our catalogue
  //   'absent'  → no model field in this request body
  //   'auto'    → Notion's menu is on "Auto"; the server picks the model
  let lastModelState = 'known';
// model: codename picked in the in-page picker (null = Notion's Auto). It is
// applied through the workspace's allowed-models policy (applyPolicy).
let settings = {
  effort: null,
  model: null,
  maxIntelligence: true,
  knownModels: [],
  effortsByModel: {},
};

  // ---- Trace: a readable log of every step, shown in the panel (Log) -----
  // No message text and no account data: only models, efforts, ids.
  const traceLog = [];
  function trace(kind, text) {
    const entry = { at: new Date().toISOString(), kind: kind, text: text };
    traceLog.push(entry);
    if (traceLog.length > 150) traceLog.shift();
    console.log('[Notion Effort] ' + kind + ': ' + text);
    window.postMessage({ type: 'NOTION_EFFORT_TRACE', entry: entry }, '*');
  }
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_TRACE_REQUEST') {
      window.postMessage({ type: 'NOTION_EFFORT_TRACE_ALL', entries: traceLog }, '*');
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data && e.data.type === 'NOTION_EFFORT_SETTINGS') {
      const before = (settings.model || 'auto') + '/' + (settings.effort || 'auto');
      settings.effort = e.data.effort || null;
      if ('model' in e.data) settings.model = e.data.model || null;
      if (before !== (settings.model || 'auto') + '/' + (settings.effort || 'auto')) {
        setTimeout(() => trace('pick', 'model ' + modelLabel(settings.model) + ' · effort ' + (settings.effort || 'Auto')), 0);
      }
      settings.maxIntelligence = e.data.maxIntelligence !== false;
      if (Array.isArray(e.data.knownModels) && e.data.knownModels.length) {
        settings.knownModels = e.data.knownModels;
      }
      if (e.data.effortsByModel) settings.effortsByModel = e.data.effortsByModel;
    }
    if (e.data && e.data.type === 'NOTION_EFFORT_PING') {
      window.postMessage({
        type: 'NOTION_EFFORT_PONG',
        interceptCount: interceptedCount,
        swappedCount: swappedCount,
      }, '*');
    }
  });

  /**
   * Report what actually went out on the wire so the in-page picker can show
   * proof rather than an assumption. `status` is 'pending' before the request
   * resolves, then 'ok' or 'error' once the server answers.
   */
  function notifyApplied(
    model,
    effort,
    status,
    code,
    actual,
    effortStatus,
    effortActual,
    modelEvidence
  ) {
    window.postMessage({
      type: 'NOTION_EFFORT_APPLIED',
      model: model,
      // How many independent payload paths named this model, whether the
      // request agreed, and any conflicting ids. Lets the picker state its
      // confidence instead of asserting one.
      modelEvidence: modelEvidence || null,
      effort: effort || null,
      status: status,
      code: code || null,
      actual: actual || null,
      effortStatus: effortStatus || null,
      effortActual: effortActual || null,
      // What the user asked for, before any per-model clamp.
      requestedEffort: lastRequestedEffort,
      // 'known' | 'unknown' | 'absent'. Only 'unknown' means Notion picked a
      // model outside our catalogue (effort sent unclamped); 'absent' means the
      // request carried no model field at all, which is not a problem.
      modelState: lastModelState,
      swaps: swappedCount,
    }, '*');
  }

  /** True when the model is empty of a known catalogue or explicitly listed. */
  function isKnownModel(model) {
    if (!settings.knownModels || !settings.knownModels.length) return true;
    return settings.knownModels.indexOf(model) !== -1;
  }

  const AUTO_MODEL = /^(auto|default)$/i;
  // Where the model has been seen in the request, most specific first. The new
  // menu is not guaranteed to keep using config.value.model, and a model sent
  // as an object ({ id, name }) must not read as "no model".
  const REQUEST_MODEL_KEYS = ['model', 'modelId', 'model_id', 'selectedModel', 'modelOverride', 'modelName'];

  function modelIdOf(v) {
    if (typeof v === 'string') return v || null;
    if (v && typeof v === 'object') {
      for (const k of ['model', 'id', 'modelId', 'codename', 'value']) {
        if (typeof v[k] === 'string' && v[k]) return v[k];
      }
    }
    return null;
  }

  /** { id, path } of the model this request asks for, or null. */
  function resolveRequestModel(configValue, body) {
    if (configValue) {
      for (const key of REQUEST_MODEL_KEYS) {
        const id = modelIdOf(configValue[key]);
        if (id) return { id: id, path: 'transcript[config].value.' + key };
      }
    }
    // Last resort: any model-ish field anywhere in the body, but only a
    // catalogue id counts — a bare string under "model" could be anything.
    const known = settings.knownModels || [];
    if (!known.length) return null;
    const fields = [];
    collectModelCandidates(body, '', fields, 0);
    const found = fields.find((f) => known.indexOf(f.value) !== -1);
    return found ? { id: found.value, path: found.path } : null;
  }

  function modelStateOf(id) {
    if (!id) return 'absent';
    if (AUTO_MODEL.test(id)) return 'auto';
    return isKnownModel(id) ? 'known' : 'unknown';
  }

  // Keys that enumerate what the workspace *could* run. A hit here says nothing
  // about what actually ran, so it must never drive a verdict.
  const CATALOGUE_KEY = /(models|options|available|allowed|supported|catalog|list|choices)/i;

  // Configuration echoed back — what the account prefers, not what just ran.
  const PREFERENCE_KEY = /(default|prefer|setting|fallback|recommend|suggest|placeholder)/i;

  /**
   * Collect every string that a model-ish key points at, remembering the path
   * so a verdict can be explained (and audited) instead of just asserted.
   */
  function collectModelCandidates(value, path, out, depth, keyRe) {
    const re = keyRe || /model/i;
    if (depth > 8 || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      // An array under a model-ish key is a catalogue, not an answer.
      for (let i = 0; i < value.length; i++) {
        collectModelCandidates(value[i], path + '[' + i + ']', out, depth + 1, re);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      const child = value[key];
      const childPath = path ? path + '.' + key : key;

      if (typeof child === 'string' && re.test(key) && child && child.length < 64) {
        out.push({
          path: childPath,
          value: child,
          // Path-wide test: a model id nested anywhere under settings or a
          // list is describing configuration, not this run.
          catalogue:
            CATALOGUE_KEY.test(key) ||
            CATALOGUE_KEY.test(path) ||
            PREFERENCE_KEY.test(key) ||
            PREFERENCE_KEY.test(path) ||
            /\[\d+\]/.test(path),
        });
      }
      collectModelCandidates(child, childPath, out, depth + 1, re);
    }
  }

  function plainField(f) {
    return { path: f.path, value: f.value };
  }

  const EFFORT_KEY = /effort|reasoning|thinking|budget/i;
  const EFFORT_VALUES = ['low', 'medium', 'high', 'max'];

  function collectEffortCandidates(value, path, out, depth) {
    collectModelCandidates(value, path, out, depth, EFFORT_KEY);
  }

  /**
   * Turn candidates into a verdict. Deliberately conservative: anything
   * ambiguous degrades to "no evidence" rather than accusing the server of a
   * swap, because a false mismatch is worse than an honest unknown.
   */
  function judgeCandidates(candidates, sentModel, knownValues) {
    const known = knownValues || settings.knownModels || [];
    const usable = candidates.filter((c) => {
      if (c.catalogue) return false;
      if (AUTO_MODEL.test(c.value)) return false;
      // With a catalogue available, only ids we recognise count as identity —
      // plus the id the request itself carried, so a model newer than the
      // catalogue can still be confirmed instead of silently ignored.
      return known.length === 0 || known.indexOf(c.value) !== -1 || (!!sentModel && c.value === sentModel);
    });

    const distinct = [];
    for (const c of usable) {
      if (distinct.indexOf(c.value) === -1) distinct.push(c.value);
    }

    if (distinct.length === 0) return { status: 'unverified', actual: null, paths: [] };
    // Several different ids outside a catalogue key: cannot tell which ran, and
    // the conflicting set travels on so the picker can say so out loud.
    if (distinct.length > 1) {
      return { status: 'unverified', actual: null, paths: [], conflicting: distinct };
    }

    // How many independent places in the payload name this id. One mention is a
    // hint that a stray field could explain; several agreeing mentions are much
    // harder to explain away, so the count is kept rather than discarded.
    const paths = usable.filter((c) => c.value === distinct[0]).map((c) => c.path);

    if (distinct[0] === sentModel) {
      return { status: 'verified', actual: distinct[0], paths: paths };
    }
    return { status: 'mismatch', actual: distinct[0], paths: paths };
  }

  /**
   * Read a copy of the stream so the page still gets the original untouched,
   * and report whether the server named a model back to us. Silence here means
   * "no evidence either way", never "confirmed".
   */
  async function verifyResponseModel(response, sentModel, sentEffort, observeOnly) {
    let copy;
    try {
      copy = response.clone();
    } catch (e) {
      return;
    }

    try {
      const text = await copy.text();
      const candidates = [];
      const effortCandidates = [];

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (e) {
          continue;
        }
        collectModelCandidates(parsed, '', candidates, 0);
        collectEffortCandidates(parsed, '', effortCandidates, 0);
      }

      // Effort is judged separately: the server can honour the model and still
      // drop reasoningEffort, and that combination must not read as success.
      const effortVerdict = sentEffort
        ? judgeCandidates(effortCandidates, sentEffort, EFFORT_VALUES)
        : { status: 'unverified', actual: null };

      // Without a swap there is nothing to contradict, so the server's choice
      // is reported as an observation rather than judged against an intent.
      const verdict = observeOnly
        ? (function () {
            const seen = judgeCandidates(candidates, sentModel);
            // Carry the supporting paths through: they are the whole basis for
            // the confidence shown later, and rebuilding the verdict object
            // without them would silently reduce it to a bare assertion.
            return seen.actual
              ? { status: 'observed', actual: seen.actual, paths: seen.paths }
              : { status: 'unverified', actual: null, paths: [], conflicting: seen.conflicting };
          })()
        : judgeCandidates(candidates, sentModel);

      // Keep the evidence inspectable: any verdict here is a heuristic over an
      // undocumented payload, so it must be auditable rather than trusted.
      const prev = window.__notionEffortDebug || {};

      // Corroboration across independent sources. The response naming a model
      // is one source; the request carrying the same id is a second, unrelated
      // one. Agreement between them is the strongest evidence obtainable while
      // the payload stays undocumented — so it is measured, not assumed.
      const requestModel = prev.incoming ? prev.incoming.model : null;
      const modelEvidence = {
        paths: verdict.paths || [],
        agreeing: (verdict.paths || []).length,
        conflicting: verdict.conflicting || null,
        requestModel: requestModel,
        matchesRequest: !!(requestModel && verdict.actual && requestModel === verdict.actual),
      };

      window.__notionEffortDebug = {
        incoming: prev.incoming || null,
        request: prev.request || null,
        sentModel: sentModel,
        verdict: verdict.status,
        actual: verdict.actual,
        modelEvidence: modelEvidence,
        candidates: candidates,
        sentEffort: sentEffort,
        effortVerdict: effortVerdict.status,
        effortActual: effortVerdict.actual,
        effortCandidates: effortCandidates,
        raw: text.slice(0, 200000),
      };

      notifyApplied(
        sentModel,
        sentEffort,
        verdict.status,
        null,
        verdict.actual,
        effortVerdict.status,
        effortVerdict.actual,
        modelEvidence
      );
    } catch (e) {
      notifyApplied(sentModel, sentEffort, 'unverified');
    }
  }

  // ------------------------------------------------------------ interception
  //
  // The new Notion AI chat no longer reliably goes through
  // fetch('/api/v3/runInferenceTranscript', { body: string }): the endpoint can
  // be renamed, the call can be a Request object with no options, or go via
  // XHR. So instead of one URL, any /api/ POST whose body carries a transcript
  // config (or a reasoningEffort field) is treated as an AI request.

  const AI_URL = /(runInference|inference|agent|assistant|completion|\/ai[\/A-Z_-])/i;
  const AI_BODY = /"transcript"|reasoningEffort|reasoning_effort/;

  // Every AI-looking request, patched or not, so "nothing was sent through
  // fetch" can be told apart from "sent, but in a shape we did not understand".
  const seen = [];
  window.__notionEffortSeen = seen;

  function shortUrl(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  }

  // The classic chat is the one that still sends runInferenceTranscript (model
  // and effort live in its body). Tell the panel which page that was, so its
  // "New old AI chat" button can return there. sure = the body carried a
  // transcript config we could patch, whatever the endpoint is called (the
  // agent chat never does). Top frame only.
  let creatingOldChat = false; // true while createOldChat's own request is out
  function noteOldChat(url, sure) {
    if (window.top !== window || creatingOldChat) return;
    if (!sure && !/runInferenceTranscript/i.test(String(url || ''))) return;
    window.postMessage({ type: 'NOTION_EFFORT_OLD_CHAT', href: location.href }, '*');
  }

  function noteSeen(url, via, reason) {
    const entry = {
      url: shortUrl(url),
      via: via,
      reason: reason,
      at: new Date().toISOString().slice(11, 19),
    };
    seen.push(entry);
    if (seen.length > 30) seen.shift();
    window.postMessage({
      type: 'NOTION_EFFORT_SEEN',
      url: entry.url,
      via: via,
      reason: reason,
      count: interceptedCount,
    }, '*');
  }

  /**
   * The object whose reasoningEffort gets patched: the transcript's config step
   * wherever it now sits in the body.
   */
  function findConfigStep(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const s = node[i];
        if (s && s.type === 'config' && s.value && typeof s.value === 'object') {
          return { obj: s.value, path: path + '[' + i + '].value' };
        }
      }
      for (let i = 0; i < node.length; i++) {
        const f = findConfigStep(node[i], path + '[' + i + ']', depth + 1);
        if (f) return f;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const f = findConfigStep(node[key], path ? path + '.' + key : key, depth + 1);
      if (f) return f;
    }
    return null;
  }

  /** Fallback: any object that already carries an effort field. */
  function findEffortHolder(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (!Array.isArray(node) && ('reasoningEffort' in node || 'reasoning_effort' in node)) {
      return {
        obj: node,
        path: path || '(root)',
        key: 'reasoningEffort' in node ? 'reasoningEffort' : 'reasoning_effort',
      };
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      const next = Array.isArray(node) ? path + '[' + k + ']' : path ? path + '.' + k : String(k);
      const f = findEffortHolder(node[k], next, depth + 1);
      if (f) return f;
    }
    return null;
  }

  /**
   * Patch one parsed request body in place. Synchronous so fetch and XHR can
   * share it. Returns null when the body is not something we understand.
   */
  function patchPayload(body) {
    const target = findConfigStep(body, '', 0) || findEffortHolder(body, '', 0);
    if (!target) return null;
    const cfg = target.obj;
    const effortKey = target.key || 'reasoningEffort';

    // Snapshot what Notion itself sent, before we touch anything. The server
    // never echoes the effort back, so comparing our request against a
    // genuine untouched one is the only evidence left that we are pulling the
    // same lever the native UI pulls.
    const reqModel = resolveRequestModel(cfg, body);
    const incoming = {
      path: target.path,
      model: reqModel ? reqModel.id : null,
      modelPath: reqModel ? reqModel.path : null,
      reasoningEffort: cfg[effortKey] || null,
      effortFields: (function () {
        const f = [];
        collectEffortCandidates(body, '', f, 0);
        return f.map(plainField);
      })(),
    };

    // Whatever model Notion's own menu picked is the model that runs.
    const activeModel = reqModel ? reqModel.id : null;
    const requestedEffort = settings.effort;
    let clampedFrom = null;
    let modified = false;

    // Safety net: if Notion moved to a model we have never seen, we have no
    // effort ceiling for it, so the clamp below is skipped and the ask goes
    // out as-is. Distinguish an absent model field (nothing to clamp, not a
    // problem) and "Auto" (server picks) from a present-but-unfamiliar id
    // (worth flagging) so the picker does not cry wolf.
    lastModelState = modelStateOf(activeModel);
    lastRequestedEffort = requestedEffort;

    // Asking for an effort a model does not offer risks a rejected request,
    // so it is lowered to that model's ceiling instead of sent blindly.
    const supported = settings.effortsByModel[activeModel];
    let targetEffort = requestedEffort;
    if (requestedEffort && Array.isArray(supported)) {
      targetEffort = nearestEffort(requestedEffort, supported);
      if (targetEffort !== requestedEffort) clampedFrom = requestedEffort;
    }

    if (targetEffort && cfg[effortKey] !== targetEffort) {
      cfg[effortKey] = targetEffort;
      modified = true;
    }

    // Only meaningful on the classic config step; not invented on some other
    // object that merely happens to hold an effort field.
    if (settings.maxIntelligence && !target.key) {
      if (cfg.useContextualCoreDocsAutoLoad !== true) {
        cfg.useContextualCoreDocsAutoLoad = true;
        modified = true;
      }
      if (cfg.useDocPreviewsForCoreAutoLoad !== true) {
        cfg.useDocPreviewsForCoreAutoLoad = true;
        modified = true;
      }
    }

    const sentModel = activeModel;
    const sentEffort = cfg[effortKey] || null;

    if (!modified) {
      window.__notionEffortDebug = { incoming: incoming, request: null };
      return { modified: false, sentModel: sentModel, sentEffort: null };
    }

    swappedCount++;

    // If the server takes the effort from some other field, that field shows
    // up here unpatched — the difference between "ignored" and "never asked".
    const requestFields = [];
    collectModelCandidates(body, '', requestFields, 0);
    const requestEffortFields = [];
    collectEffortCandidates(body, '', requestEffortFields, 0);

    // Several Notion model ids carry the effort as a suffix
    // ("...-high", "...-medium"), so the id may be the real effort lever
    // and reasoningEffort merely decorative. Surface both to tell them apart.
    const suffix = /-(low|medium|high|max)$/.exec(sentModel || '');
    window.__notionEffortDebug = {
      incoming: incoming,
      request: {
        patchedPath: target.path + '.' + effortKey,
        sentModel: sentModel,
        modelPath: reqModel ? reqModel.path : null,
        sentEffort: sentEffort,
        requestedEffort: requestedEffort,
        clampedFrom: clampedFrom,
        // 'known' | 'unknown' | 'absent' | 'auto'. 'unknown' => model outside
        // our catalogue, so no effort ceiling could be applied.
        modelState: lastModelState,
        modelFields: requestFields.map(plainField),
        stale: requestFields.filter((f) => f.value !== sentModel).map(plainField),
        effortFields: requestEffortFields.map(plainField),
        effortInModelId: suffix ? suffix[1] : null,
      },
    };
    return { modified: true, sentModel: sentModel, sentEffort: sentEffort };
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof Request) return input.url;
    if (input && typeof input.href === 'string') return input.href;
    return '';
  }

  async function readBody(input, options) {
    if (options && options.body != null) {
      return typeof options.body === 'string' ? options.body : null;
    }
    if (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
      try {
        return await input.clone().text();
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  const originalFetch = window.fetch;
  // Agent-chat traffic never carries a patchable config: pass it straight
  // through instead of buffering and re-parsing every poll and stream.
  const AGENT_PASS_URL = /\/api\/v3\/(?!runInference)(\w*AgentThread|\w*AgentService|\w*ThreadTranscript|\w*InferenceTranscripts?\w*|getAgent\w*|getThreadSpaceId)/;
  window.fetch = async function (...args) {
    const [input, options] = args;
    const url = urlOf(input);
    if (url.indexOf('/api/') === -1 || AGENT_PASS_URL.test(url)) return originalFetch.apply(this, args);

    const method = String(
      (options && options.method) || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'POST') return originalFetch.apply(this, args);

    let text = null;
    try {
      text = await readBody(input, options);
    } catch (e) {}

    noteOldChat(url);
    const aiUrl = AI_URL.test(url);
    if (!text || text.length > 8000000 || !(aiUrl || AI_BODY.test(text))) {
      if (aiUrl) noteSeen(url, 'fetch', text ? 'body too large' : 'body not readable (not a string)');
      return originalFetch.apply(this, args);
    }

    interceptedCount++;

    let body;
    let result;
    try {
      body = JSON.parse(text);
      result = patchPayload(body);
    } catch (e) {
      noteSeen(url, 'fetch', 'body is not JSON');
      return originalFetch.apply(this, args);
    }

    if (!result) {
      noteSeen(url, 'fetch', 'no config / reasoningEffort in body');
      return originalFetch.apply(this, args);
    }
    noteSeen(url, 'fetch', result.modified ? 'patched' : 'already matched');
    noteOldChat(url, true);
    rememberOldChatTemplate(url, body);

    if (!result.modified) {
      // No swap (Auto, or the body already matched). Still read the answer so
      // a server-side allowlist can be tested with the extension standing down.
      const passthrough = await originalFetch.apply(this, args);
      if (passthrough.ok) verifyResponseModel(passthrough, result.sentModel, null, true);
      return passthrough;
    }

    const newText = JSON.stringify(body);
    notifyApplied(result.sentModel, result.sentEffort, 'pending');

    const response = await (input instanceof Request
      ? originalFetch(new Request(input, Object.assign({}, options || {}, { body: newText })))
      : originalFetch(input, Object.assign({}, options, { body: newText })));

    notifyApplied(
      result.sentModel,
      result.sentEffort,
      response.ok ? 'ok' : 'error',
      response.ok ? null : response.status
    );
    if (response.ok) {
      // The model came from Notion, not from us, so it can only be observed
      // — judging it as ours would credit the extension for someone else's
      // choice, which is exactly the lie this rewrite removes.
      verifyResponseModel(response, result.sentModel, result.sentEffort, true);
    }
    return response;
  };

  // XHR path: same patch, applied synchronously to the outgoing body. The
  // response is not re-read here; the footer reports what was sent.
  const rawXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__effortMethod = String(method || 'GET').toUpperCase();
    this.__effortUrl = String(url || '');
    return rawXhrOpen.call(this, method, url, ...rest);
  };

  const rawXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (data) {
    try {
      const url = this.__effortUrl || '';
      if (this.__effortMethod === 'POST') noteOldChat(url);
      if (
        this.__effortMethod === 'POST' &&
        url.indexOf('/api/') !== -1 &&
        typeof data === 'string' &&
        data.length < 8000000 &&
        (AI_URL.test(url) || AI_BODY.test(data))
      ) {
        interceptedCount++;
        const body = JSON.parse(data);
        const result = patchPayload(body);
        if (result) {
          noteOldChat(url, true);
          rememberOldChatTemplate(url, body);
        }
        noteSeen(
          url,
          'xhr',
          !result ? 'no config / reasoningEffort in body' : result.modified ? 'patched' : 'already matched'
        );
        if (result && result.modified) {
          data = JSON.stringify(body);
          notifyApplied(result.sentModel, result.sentEffort, 'pending');
          const xhr = this;
          xhr.addEventListener('loadend', () => {
            const ok = xhr.status >= 200 && xhr.status < 300;
            notifyApplied(result.sentModel, result.sentEffort, ok ? 'ok' : 'error', ok ? null : xhr.status);
          });
        }
      }
    } catch (e) {}
    try {
      const url = this.__effortUrl || '';
      if (url.indexOf('/api/') !== -1 && typeof data === 'string') {
        const xhr = this;
        noteModelSetting(url.replace(location.origin, ''), data, new Promise((resolve) => {
          xhr.addEventListener('loadend', () => resolve({
            status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300,
            clone: () => ({ text: () => Promise.resolve(String(xhr.responseText || '')) }),
          }));
        }), 'xhr');
      }
    } catch (e) {}
    return rawXhrSend.call(this, data);
  };

  // ---- New agent chat: read the model the server actually assigned ---------
  //
  // The new chat (createAgentThread / sendEventToAgentThread) sends no model
  // and no effort: the server resolves them from the workspace policy and
  // stores the result on the thread record as data.agent_provider
  // { model, modelSelection, reasoningEffort }. Watch the responses that carry
  // thread records and report what the server chose for the open thread.

  const AGENT_RECORD_URL = /\/api\/v3\/(syncRecordValues|createAgentThread|getInferenceTranscriptsForUser|sendEventToAgentThread|getThreadTranscript)/;
  const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
  const agentThreads = {};
  window.__notionEffortAgent = agentThreads;
  // The thread this tab last sent a message to. List responses carry many
  // thread records, so "the last one parsed" would name some old chat.
  let activeThreadKey = null;

  function plainId(id) {
    return String(id || '').replace(/-/g, '').toLowerCase();
  }

  function findAgentProviders(node, uuidKey, depth, out) {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (!Array.isArray(node) && node.data && node.data.agent_provider && typeof node.data.agent_provider === 'object') {
      out.push({ thread: node.id || uuidKey || null, p: node.data.agent_provider });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      findAgentProviders(node[k], typeof k === 'string' && UUID.test(k) ? k : uuidKey, depth + 1, out);
    }
  }

  function openThreadKey() {
    try {
      const t = new URLSearchParams(location.search).get('t');
      if (t) return plainId(t);
    } catch (e) {}
    return null;
  }

  function publishAgent() {
    const key = openThreadKey();
    const info = (key && agentThreads[key]) || (!key && activeThreadKey && agentThreads[activeThreadKey]);
    if (!info) return;
    window.postMessage(Object.assign({ type: 'NOTION_EFFORT_AGENT' }, info), '*');
  }

  const effortHistory = [];

  /** A record with long strings cut: settings and ids stay, message text does not. */
  function shortJson(v, depth, key) {
    depth = depth || 0;
    if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
    // Fingerprints are config hashes/descriptors, not text: keep them whole.
    if (typeof v === 'string') return v.length > (/Fingerprint$/.test(key || '') ? 400 : 80) ? '<' + v.length + ' chars>' : v;
    if (depth > 6) return '…';
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => shortJson(x, depth + 1));
    const o = {};
    Object.keys(v).slice(0, 60).forEach((k) => { o[k] = shortJson(v[k], depth + 1, k); });
    return o;
  }

  // The whole thread record, read fresh, for --probe: everything the server
  // keeps next to agent_provider (selection source, fallback, limits...).
  window.__notionEffortProbeThread = function (thread) {
    const id = dashedId(thread);
    const spaces = Object.keys(headersBySpace);
    const tryOne = (i) => {
      if (i >= spaces.length) return Promise.resolve({ error: 'thread not found in ' + spaces.length + ' workspaces' });
      return apiPost('probe', dashedId(spaces[i]), '/api/v3/syncRecordValues', {
        requests: [{ pointer: { table: 'thread', id: id, spaceId: dashedId(spaces[i]) }, version: -1 }],
      }).then((json) => {
        const t = json && json.recordMap && json.recordMap.thread;
        const k = t && Object.keys(t)[0];
        const v = k && unwrapRecord(t[k]);
        return v && v.id ? { space: spaces[i], record: shortJson(v) } : tryOne(i + 1);
      }, () => tryOne(i + 1));
    };
    return tryOne(0).then((r) => JSON.stringify(Object.assign(r, {
      history: effortHistory.filter((h) => h.thread === plainId(thread)),
    }), null, 2));
  };

  // The catalogue as one given workspace sees it (plans differ per workspace,
  // and the picker's catalogue is only read for one of them).
  window.__notionEffortProbeCatalogue = function (spaceId) {
    const sid = dashedId(spaceId);
    return apiPost('probe models', sid, '/api/v3/getAvailableModels', { spaceId: sid, surface: 'workspace_model_settings' })
      .then((json) => JSON.stringify({
        space: plainId(sid),
        models: ((json && json.models) || []).map((m) => ({
          model: m.model, provider: m.modelProvider, disabled: !!m.isDisabled,
          restricted: !!m.restrictedForPersonalAgent, config: shortJson(m.modelConfiguration),
          // Limit-ish flags Notion returns per model: rate-limit headroom and the
          // disaster-recovery switch, plus the raw card attributes.
          rateLimit: m.isApproachingRateLimit === undefined ? undefined : !!m.isApproachingRateLimit,
          outage: m.isDisabledOnlyByDisasterRecovery === undefined ? undefined : !!m.isDisabledOnlyByDisasterRecovery,
          card: shortJson(m.modelCardAttributes),
          optIn: shortJson(m.restrictedAccessModelsInPickerConfig),
        })),
        top: shortJson(Object.assign({}, json, { models: undefined })),
      }, null, 2), (e) => JSON.stringify({ error: String(e.message || e) }));
  };

  // The message body is what the router actually obeys: every send carries the
  // native picker's state, and with the picker on Auto it says
  // modelSelection {"type":"automatic"} — the record pin alone does not
  // survive that. The exact "selected" shape is Notion's private one, so it is
  // learned from a real hand-pick: one send made with a model chosen in Notion's
  // own picker is captured (learnPickTemplate) and reused as a template, with
  // the model id substituted. Without a template a best guess is written.
  const PICK_TPL_KEY = 'notionEffortPickTemplate';
  let pickTemplate = null;
  try { pickTemplate = JSON.parse(localStorage.getItem(PICK_TPL_KEY) || 'null'); } catch (e) {}

  function learnPickTemplate(body, source) {
    if (!body || typeof body !== 'object' || !body.model) return false;
    const sel = body.modelSelection;
    const selAuto = !sel || (typeof sel === 'object'
      ? (sel.type === 'automatic' || sel.type === 'auto')
      : (sel === 'auto' || sel === 'automatic'));
    if (selAuto) return false;
    pickTemplate = { model: body.model, modelSelection: sel, reasoningEffort: body.reasoningEffort || null };
    try { localStorage.setItem(PICK_TPL_KEY, JSON.stringify(pickTemplate)); } catch (e) {}
    trace('pick', 'learned the picked-model body shape (' + (source || "Notion's picker") + ', model ' + body.model + ')');
    return true;
  }

  function substDeep(v, from, to) {
    if (v === from) return to;
    if (Array.isArray(v)) return v.map((x) => substDeep(x, from, to));
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach((k) => { o[k] = substDeep(v[k], from, to); });
      return o;
    }
    return v;
  }

  // The exact picked-model shape of sendEventToAgentThread is Notion's private
  // schema; the guess {type:"selected"} is refused (HTTP 400, v2.29). So the
  // send walks a list of candidate shapes: every refusal is a rejected event
  // (nothing is processed twice), the walk always ends with the original body
  // so the message is delivered whatever happens. A shape that comes back 200
  // is saved as the template for all later sends. Each shape is tried without
  // a reasoningEffort field first — the v2.30 trace refused every variant, and
  // the only field they shared was reasoningEffort="max", which the record
  // schema accepts but the send schema may not.
  // The send schema rejected every hand-made shape (v2.30 trace: 5 candidates
  // and the original body all 400 once the record is pinned to selected), so
  // the real picked-model shape has to be seen, not guessed. describeBody dumps
  // the whole request: every top-level key with short values, long ones cut,
  // and modelSelection fully expanded. Pasted back, it shows the exact field
  // the native client uses.
  function describeBody(bodyText) {
    let b;
    try { b = JSON.parse(bodyText); } catch (e) { return bodyText.slice(0, 200); }
    const parts = Object.keys(b).map((k) => {
      let v = b[k];
      const s = JSON.stringify(v);
      if (s && s.length > 90) {
        if (v && typeof v === 'object') {
          const inner = Object.keys(v).map((kk) => {
            const vs = JSON.stringify(v[kk]);
            return kk + ': ' + (vs && vs.length > 60 ? vs.slice(0, 60) + '…' : vs);
          }).join(', ');
          return k + ' {' + inner + '}';
        }
        return k + ': ' + s.slice(0, 60) + '…(' + s.length + ' chars)';
      }
      return k + ': ' + s;
    });
    return parts.join(' | ');
  }

  function sendVariants(bodyText, wantModel, wantEffort) {
    let base;
    try { base = JSON.parse(bodyText); } catch (e) { return []; }
    if (!base || typeof base !== 'object') return [];
    const sel = base.modelSelection;
    const selAuto = !sel || (typeof sel === 'object'
      ? (sel.type === 'automatic' || sel.type === 'auto')
      : (sel === 'auto' || sel === 'automatic'));
    if (!selAuto) return []; // the native client picked a model itself: leave it
    const eff = wantEffort ? agentTargetEffort(wantModel) : null;
    // Custom Agent follow-ups have no modelSelection at all:
    // {spaceId, threadId, event, surface:"custom_agent"}. Test their own
    // override field at the actual send boundary instead of the personal-chat
    // modelSelection shapes, which do not apply to this schema.
    if (base.surface === 'custom_agent') {
      const shapes = [
        { label: 'custom send: override string + model/effort', extra: { customAgentModelSelectionOverride: 'explicit', model: wantModel, reasoningEffort: eff || undefined } },
        { label: 'custom send: override object + model/effort', extra: { customAgentModelSelectionOverride: { type: 'explicit', model: wantModel, reasoningEffort: eff || undefined }, model: wantModel, reasoningEffort: eff || undefined } },
        { label: 'custom send: model/effort only', extra: { model: wantModel, reasoningEffort: eff || undefined } },
        { label: 'custom send: modelSelection explicit', extra: { modelSelection: { type: 'explicit', model: wantModel, reasoningEffort: eff || undefined } } },
      ];
      const preferredShape = Math.max(0, Math.min(shapes.length - 1, Number(localStorage.getItem('notionEffortCustomSendShape') || 0)));
      const orderedShapes = shapes.slice(preferredShape).concat(shapes.slice(0, preferredShape));
      const out = orderedShapes.map((shape) => {
        const t = Object.assign(JSON.parse(bodyText), shape.extra);
        if (t.clientEventId) t.clientEventId = crypto.randomUUID();
        return { text: JSON.stringify(t), label: shape.label };
      });
      out.push({ text: bodyText, label: 'original custom-agent body' });
      return out;
    }
    const candidates = [];
    // EFFORT FIRST: on business trials the follow-up model is server-locked
    // to auto, but the effort may still be steerable through the body. Two
    // never-probed spots: a top-level reasoningEffort with the selection left
    // automatic, and effort INSIDE the automatic selection object.
    if (eff) {
      // Server said it plainly: "modelSelection cannot be combined with
      // legacy model fields". So the legacy shape is its own schema — no
      // modelSelection, effort top-level. That is the follow-up effort lever.
      const legacy = JSON.parse(bodyText);
      delete legacy.modelSelection;
      delete legacy.model;
      legacy.reasoningEffort = eff;
      candidates.push({ label: 'legacy body + effort=' + eff, raw: legacy });
      const top = JSON.parse(bodyText);
      top.reasoningEffort = eff;
      candidates.push({ label: 'auto + effort=' + eff + ' (top-level)', raw: top });
      const inner = JSON.parse(bodyText);
      inner.modelSelection = { type: 'automatic', reasoningEffort: eff };
      inner.reasoningEffort = eff;
      candidates.push({ label: 'auto + effort=' + eff + ' (inside selection)', raw: inner });
    }
    if (pickTemplate && pickTemplate.modelSelection) {
      candidates.push({
        label: 'learned pick shape',
        sel: substDeep(JSON.parse(JSON.stringify(pickTemplate.modelSelection)), pickTemplate.model, wantModel),
        model: null,
      });
    }
    candidates.push(
      // The REAL native shape, captured from Notion's own picker after the
      // catalogue was seeded: {"type":"explicit","model":...,"reasoningEffort":...}
      // (effort lives INSIDE the selection object there).
      { label: 'native explicit', sel: { type: 'explicit', model: wantModel, reasoningEffort: eff || undefined }, model: null },
      { label: '{type:explicit, model}', sel: { type: 'explicit', model: wantModel }, model: null },
      { label: 'model + {type:explicit, model}', sel: { type: 'explicit', model: wantModel }, model: wantModel },
      { label: '{type:selected, model}', sel: { type: 'selected', model: wantModel }, model: null },
      { label: 'model + {type:selected, model}', sel: { type: 'selected', model: wantModel }, model: wantModel },
      // getCreditRateLimitStatus exposes router decisions for "auto" AND
      // "flex" — flex is a real selection type, worth probing next to selected.
      { label: '{type:flex, model}', sel: { type: 'flex', model: wantModel }, model: null },
      { label: 'model + {type:flex, model}', sel: { type: 'flex', model: wantModel }, model: wantModel },
      { label: '{type:flex} alone', sel: { type: 'flex' }, model: null },
      { label: 'selection "flex"', sel: 'flex', model: wantModel },
      { label: 'selectedModel only', sel: undefined, model: null, extra: { selectedModel: wantModel } },
      { label: 'model+selectedModel', sel: undefined, model: wantModel, extra: { selectedModel: wantModel } },
      { label: '{type:selected} alone', sel: { type: 'selected' }, model: null },
      { label: 'selection "selected"', sel: 'selected', model: wantModel },
      { label: '{type:selected, modelId}', sel: { type: 'selected', modelId: wantModel }, model: null },
      { label: '{type:manual, model}', sel: { type: 'manual', model: wantModel }, model: null },
      { label: 'model + {type:selected}', sel: { type: 'selected' }, model: wantModel }
    );
    const out = [];
    const seen = {};
    // Every attempt replays the same clientEventId — the server treats the
    // retries as duplicates and the FINAL original body can die with a
    // generic 400, losing the message. Give each variant its own id; the
    // untouched original keeps its own (never yet sent).
    const push = (t, label) => {
      if (t.clientEventId) t.clientEventId = crypto.randomUUID();
      const text = JSON.stringify(t);
      if (!seen[text]) { seen[text] = true; out.push({ text: text, label: label }); }
    };
    // NOTE: a body without modelSelection is accepted (200) on some
    // workspaces but the router ignores it — so that candidate is pushed at
    // the END (below), never first, or the walk stops on a false success.
    candidates.forEach((c) => {
      if (c.raw) { push(c.raw, c.label); return; } // prebuilt body (effort probes)
      [false, eff ? true : false].forEach((withEff) => {
        const t = JSON.parse(bodyText);
        if (c.model) t.model = c.model; else delete t.model;
        if (c.sel === undefined) delete t.modelSelection; else t.modelSelection = c.sel;
        if (c.extra) Object.keys(c.extra).forEach((k) => { t[k] = c.extra[k]; });
        if (withEff) t.reasoningEffort = eff; else delete t.reasoningEffort;
        push(t, c.label + (withEff ? ' + effort=' + eff : ' (no effort)'));
      });
    });
    out.push({ text: bodyText, label: 'original body (auto)' });
    // Accepted (200) but IGNORED by the router on business trials — kept only
    // as last-resort delivery, never before the original body.
    [false, eff ? true : false].forEach((withEff) => {
      const t = JSON.parse(bodyText);
      delete t.modelSelection;
      delete t.model;
      if (withEff) t.reasoningEffort = eff; else delete t.reasoningEffort;
      push(t, 'no modelSelection (ignored by router)' + (withEff ? ' + effort=' + eff : ' (no effort)'));
    });
    // 'model only' comes back 200 but the server ignores the field and routes
    // to Auto — it must not short-circuit the walk, so it goes last, after the
    // original body. A 200 here means "delivered", not "pinned".
    [false, eff ? true : false].forEach((withEff) => {
      const t = JSON.parse(bodyText);
      t.model = wantModel;
      delete t.modelSelection;
      if (withEff) t.reasoningEffort = eff; else delete t.reasoningEffort;
      push(t, 'model only (ignored by router)' + (withEff ? ' + effort=' + eff : ' (no effort)'));
    });
    return out;
  }

  /** The server said 400: its ValidationError names the offending field. */
  function logRefusal(res, label) {
    if (!res || !res.clone) return;
    try {
      res.clone().text().then((t) => {
        if (!t) return;
        const m = t.match(/"debugMessage"\s*:\s*"((?:[^"\\]|\\.){0,180})/i);
        trace('sent', label + ' — server said: ' + (m ? m[1] : t.slice(0, 180)));
      }).catch(() => {});
    } catch (e) {}
  }

  function rememberWinner(text, label) {
    let b;
    try { b = JSON.parse(text); } catch (e) { return; }
    const sel = b && b.modelSelection;
    const model = b && b.model ? b.model : (sel && typeof sel === 'object' && sel.model ? sel.model : null);
    if (!model || sel === undefined || sel === null) return;
    const selAuto = sel === 'auto' || sel === 'automatic' ||
      (typeof sel === 'object' && (sel.type === 'automatic' || sel.type === 'auto'));
    if (selAuto) return;
    pickTemplate = { model: model, modelSelection: sel, reasoningEffort: b.reasoningEffort || null };
    try { localStorage.setItem(PICK_TPL_KEY, JSON.stringify(pickTemplate)); } catch (e) {}
    trace('pick', 'the server accepted a picked-model body (' + label + '): saved as the template');
  }

  // Workspaces where every picked-model body shape was refused (business
  // trials accept automatic only): probing again costs ~12 s and risks the
  // original body, so such workspaces send follow-ups as Notion made them.
  const SEND_BAD_KEY = 'notionEffortSendShapesBad.v5'; // new key = new variant set
  function badSends() {
    try { return JSON.parse(localStorage.getItem(SEND_BAD_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function isBadSend(spaceId) { return !!badSends()[plainId(spaceId || '')]; }
  function markBadSend(spaceId) {
    const b = badSends(); b[plainId(spaceId)] = new Date().toISOString();
    try { localStorage.setItem(SEND_BAD_KEY, JSON.stringify(b)); } catch (e) {}
  }

  function watchAgentResponse(response) {
    if (!response || !response.ok) return Promise.resolve();
    return response.clone().text().then((text) => {
      if (text.indexOf('agent_provider') === -1) return;
      const found = [];
      findAgentProviders(JSON.parse(text), null, 0, found);
      found.forEach((f) => {
        if (!f.p.model && !f.p.reasoningEffort) return;
        const key = plainId(f.thread || 'unknown');
        const prev = agentThreads[key];
        // Who changed the effort, and with what else in the record: the
        // server's reason for a reset may sit in a field we do not read.
        if (!prev || prev.reasoningEffort !== (f.p.reasoningEffort || null)) {
          logPush(effortHistory, {
            at: new Date().toISOString(), thread: key, url: (response.url || '').replace(location.origin, ''),
            from: prev ? prev.reasoningEffort : undefined, to: f.p.reasoningEffort || null, provider: shortJson(f.p),
          });
        }
        agentThreads[key] = {
          thread: f.thread,
          model: f.p.model || null,
          modelSelection: f.p.modelSelection || null,
          reasoningEffort: f.p.reasoningEffort || null,
          sticky: f.p.stickyAutoModelAssignment || null,
          selectedModel: f.p.selectedModel || null,
        };
        if (f.p.modelSelection && f.p.modelSelection !== 'auto') learnedSelection = f.p.modelSelection;
      });
      if (found.length) publishAgent();
    }).catch(() => {});
  }

  // ---- Agent effort lever ------------------------------------------------
  //
  // space_view.settings.personal_agent_model_preference looked like the lever,
  // but on trials the server ignores it: with { albuquerque-quinn, max } saved,
  // new threads still came back auto / medium. It is only read for diagnostics.
  // The write goes to the thread record itself instead (ensureThreadEffort).

  const PREF_URL = /\/api\/v3\/(getSpaces|syncRecordValues|loadUserContent|getBacklinksForBlock|getUserHomePages)/;
  const AGENT_SEND_URL = /\/api\/v3\/(createAgentThread|sendEventToAgentThread)$/;
  const agentPrefs = {}; // plain spaceId -> { spaceViewId, spaceId, pref }
  window.__notionEffortAgentPrefs = agentPrefs;

  function unwrapRecord(r) {
    for (let i = 0; i < 3 && r && r.value && typeof r.value === 'object' && !r.id; i++) r = r.value;
    return r;
  }

  function findSpaceViews(node, depth) {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (!Array.isArray(node) && node.space_view && typeof node.space_view === 'object') {
      Object.keys(node.space_view).forEach((k) => {
        const v = unwrapRecord(node.space_view[k]);
        if (!v || !v.id || !v.space_id) return;
        const pref = v.settings && v.settings.personal_agent_model_preference;
        const key = plainId(v.space_id);
        const prev = agentPrefs[key];
        // Keep the view that already carries a preference over a bare one.
        if (prev && prev.pref && !pref) return;
        agentPrefs[key] = { spaceViewId: v.id, spaceId: v.space_id, pref: pref || null };
      });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) findSpaceViews(node[k], depth + 1);
  }

  function watchPrefResponse(response) {
    if (!response || !response.ok) return;
    response.clone().text().then((text) => {
      const hasView = text.indexOf('space_view') !== -1;
      const hasSpace = text.indexOf('"space"') !== -1;
      if (!hasView && !hasSpace) return;
      const json = JSON.parse(text);
      if (hasView) findSpaceViews(json, 0);
      if (hasSpace) findSpaceModelSettings(json, 0);
    }).catch(() => {});
  }

  // Model-related fields of space records (Settings > Notion AI > Model
  // controls lives somewhere in here), for the diagnostics.
  const spaceModelSettings = {}; // plain spaceId -> { field: value }
  const MODEL_FIELD = /model|agent|(^|_)ai(_|$)|^ai[A-Z]/i;

  function pickModelFields(obj, prefix, out, depth) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return;
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (MODEL_FIELD.test(k)) out[prefix + k] = JSON.stringify(v).slice(0, 1500);
      else if (v && typeof v === 'object' && !Array.isArray(v)) pickModelFields(v, prefix + k + '.', out, depth + 1);
    });
  }

  function findSpaceModelSettings(node, depth) {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (!Array.isArray(node) && node.space && typeof node.space === 'object') {
      Object.keys(node.space).forEach((k) => {
        const v = unwrapRecord(node.space[k]);
        if (!v || !v.id) return;
        const out = {};
        pickModelFields(v, '', out, 0);
        if (Object.keys(out).length) spaceModelSettings[plainId(v.id)] = out;
      });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) findSpaceModelSettings(node[k], depth + 1);
  }

  // Notion's full scale; the panel offers low…max. A model that tops out at
  // xhigh (Grok 4.6) gets xhigh for Max: an effort the model does not take
  // makes Notion drop the pick and answer with its default model instead.
  const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  function nearestEffort(wanted, supported) {
    if (!wanted || !Array.isArray(supported) || supported.indexOf(wanted) !== -1) return wanted;
    if (!supported.length) return null;
    const rank = (e) => EFFORT_SCALE.indexOf(e);
    const real = supported.filter((e) => rank(e) > 0).sort((a, b) => rank(a) - rank(b)); // not "none"
    const lower = real.filter((e) => rank(e) <= rank(wanted));
    return lower.length ? lower.pop() : real.length ? real[0] : supported[0];
  }

  function agentTargetEffort(model) {
    return nearestEffort(settings.effort, model && settings.effortsByModel[model]);
  }

  function requestHeaders(input, options) {
    const h = new Headers((options && options.headers) || (input instanceof Request ? input.headers : undefined));
    h.set('content-type', 'application/json');
    return h;
  }

  function reportPref(status, detail) {
    window.__notionEffortAgentPref = Object.assign({ status: status, at: new Date().toISOString() }, detail);
    console.log('[Notion Effort] agent effort preference:', status, detail);
    window.postMessage({ type: 'NOTION_EFFORT_AGENT_PREF', status: status, detail: detail }, '*');
  }

  function dashedId(id) {
    const p = plainId(id);
    return p.length === 32
      ? [p.slice(0, 8), p.slice(8, 12), p.slice(12, 16), p.slice(16, 20), p.slice(20)].join('-')
      : String(id);
  }

  function txPost(input, options, tx) {
    const headers = requestHeaders(input, options);
    const post = (path) => effortFetch(location.origin + path, {
      method: 'POST', credentials: 'include', headers: headers, body: JSON.stringify(tx),
    });
    return post('/api/v3/saveTransactionsFanout')
      .then((res) => (res.status === 404 ? post('/api/v3/saveTransactions') : res));
  }

  // Re-read the thread so the panel shows what the server now holds, not what
  // we hoped to write.
  function rereadThread(input, options, id, spaceId) {
    return effortFetch(location.origin + '/api/v3/syncRecordValues', {
      method: 'POST', credentials: 'include', headers: requestHeaders(input, options),
      body: JSON.stringify({ requests: [{ pointer: { table: 'thread', id: id, spaceId: spaceId }, version: -1 }] }),
    }).then(watchAgentResponse);
  }

  // ---- Per-thread effort ----------------------------------------------------
  //
  // The server stores the effort it runs a chat with on the thread record
  // (data.agent_provider.reasoningEffort). Write the picker's effort there —
  // one field, via update so model/selection stay as the server set them —
  // then re-read the record. If the server resets it, the panel says so.

  // The model is written to the thread itself when a pick must stick: on the
  // trial the server resets a hand-picked model ("Changed model to Auto"), so
  // this is a fight — the write below is retried after every send. The
  // stickyAutoModelAssignment field is never touched: its struct write is
  // rejected (HTTP 400, v2.30 trace) and writing null into it poisons the
  // thread — after a "sticky removed 200" every send, including the original
  // body, answered 400. The workspace policy stays the first line of defense
  // (below).
  const inflight = {};
  const writeLog = []; // our writes and what the record said afterwards
  const foreignLog = []; // agent_provider writes Notion's own client made
  // A non-auto modelSelection seen on any record — the user's own hand-pick
  // teaches the exact enum value the server expects ('selected' is a guess).
  let learnedSelection = null;
  try { localStorage.removeItem('notionEffortModelStrategy'); localStorage.removeItem('notionEffortChatModelTrial'); } catch (e) {}

  function logPush(list, entry) {
    list.push(entry);
    if (list.length > 12) list.shift();
  }

  function snap(t) {
    return t ? { model: t.model, modelSelection: t.modelSelection, reasoningEffort: t.reasoningEffort, sticky: t.sticky || null } : null;
  }

  function threadOf(bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch (e) { return null; }
    const raw = body && (body.threadId || (body.thread && body.thread.id));
    if (!raw || !body.spaceId) return null;
    return { id: dashedId(raw), key: plainId(raw), spaceId: body.spaceId };
  }

  function ensureThreadEffort(input, options, bodyText) {
    const th = threadOf(bodyText);
    if (!th) return Promise.resolve();
    const { id, key, spaceId } = th;
    if (inflight[key]) return inflight[key];
    const thread = agentThreads[key] || {};
    // With a model picked, Auto can only route to it, so clamp to its efforts.
    const effort = agentTargetEffort(settings.model || thread.model);
    // stickyAutoModelAssignment is never written: its struct write is
    // rejected (HTTP 400) and a null write poisons the thread (v2.30 trace).
    // A pick that must stick is written into the record with an explicit
    // selection: model + modelSelection 'selected'.
    // Notion's router resets these ("Changed model to Auto"), which the re-pin
    // after every send answers — the record is only honest after a fight.
    const sel = learnedSelection || 'selected';
    const modelOff = !!(settings.model &&
      (thread.model !== settings.model || thread.modelSelection !== sel));
    // Write when: a model is picked and the record's model/selection drift,
    // or an effort is picked and the record's effort differs.
    const effortOff = !!effort && thread.reasoningEffort !== effort;
    if (!settings.model && !effort) return Promise.resolve();
    if (!effortOff && !modelOff) return Promise.resolve();
    const args = effort ? { reasoningEffort: effort } : {};
    const detail = { thread: id, from: thread.reasoningEffort || null, to: effort || "Notion's", model: thread.model || null,
      selection: thread.modelSelection || null,
      pin: modelOff ? (thread.model || 'auto') + ' → ' + settings.model + ' / ' + sel : undefined };
    const op = (path, command, a) => ({ pointer: { table: 'thread', id: id, spaceId: spaceId }, path: path, command: command, args: a });
    const tx = (ops) => ({
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(),
        spaceId: spaceId,
        debug: { userAction: 'NotionEffort.setThreadConfig' },
        operations: ops,
      }],
    });
    // The server rejects a whole transaction it does not like (ValidationError),
    // so the pin is tried in steps: the full pin first, then progressively
    // smaller patches — the smallest one that sticks is used.
    const base = effort ? op(['data', 'agent_provider'], 'update', args) : null;
    const attempts = [];
    if (modelOff) {
      const pin = Object.assign({ model: settings.model, modelSelection: sel }, args);
      attempts.push(
        // 'selectedModel only' REGRESSED message #1 to the auto model (v2.39
        // trace: create-injected chat ran Terra instead of Opus). The record
        // needs model + modelSelection 'selected'; selectedModel rides along.
        { name: 'pin selectedModel+selection', ops: [op(['data', 'agent_provider'], 'update', Object.assign({ selectedModel: settings.model }, pin))] },
        { name: 'pin model+selection', ops: [op(['data', 'agent_provider'], 'update', pin)] },
        { name: 'pin model only', ops: [op(['data', 'agent_provider'], 'update', { model: settings.model })] }
      );
    }
    if (effortOff) attempts.push({ name: 'effort only', ops: [base] });
    if (!attempts.length) return Promise.resolve();
    const entry = { at: new Date().toISOString(), thread: id, before: snap(thread), args: args, attempts: [] };
    logPush(writeLog, entry);
    inflight[key] = (async () => {
      try {
        let res = null;
        let used = null;
        for (const a of attempts) {
          res = await txPost(input, options, tx(a.ops));
          const err = res.ok ? null : (await res.clone().text()).slice(0, 160);
          entry.attempts.push({ name: a.name, http: res.status, error: err || undefined });
          if (res.ok) { used = a.name; break; }
        }
        entry.http = res.status;
        if (res.ok) {
          swappedCount++;
          trace('effort', 'chat effort ' + (detail.from || 'unset') + ' → ' + detail.to + ' written' +
            (detail.pin ? ' · pin ' + detail.pin : '') +
            ' · ' + entry.attempts.map((a) => a.name + ' ' + a.http).join(', '));
          reportPref('ok', Object.assign({ via: used }, detail));
          await rereadThread(input, options, id, spaceId).catch(() => {});
          entry.after = snap(agentThreads[key]);
        } else {
          trace('effort', 'write FAILED: HTTP ' + res.status);
          reportPref('error', Object.assign({ http: res.status, text: (await res.text()).slice(0, 300) }, detail));
        }
      } catch (e) {
        entry.error = String(e);
        reportPref('error', Object.assign({ error: String(e) }, detail));
      }
    })().finally(() => { inflight[key] = null; });
    return inflight[key];
  }

  // Auto picks the model once the message is in, so look at the record again
  // after the server has had time to act.
  function rereadAfterSend(input, options, bodyText) {
    const th = threadOf(bodyText);
    if (!th) return;
    const sentModel = settings.model;
    const sentAt = Date.now();
    const sentEffort = settings.effort ? agentTargetEffort(settings.model || (agentThreads[th.key] || {}).model) : null;
    [4000, 15000].forEach((ms) => setTimeout(() => {
      rereadThread(input, options, th.id, th.spaceId).then(() => {
        const last = writeLog.filter((w) => w.thread === th.id).pop();
        if (last) last['after' + ms / 1000 + 's'] = snap(agentThreads[th.key]);
        publishAgent();
        reportResult(th, ms, sentModel, sentEffort, sentAt);
        // The server re-pins Auto ("Changed model to Auto") and re-routes to
        // its own model. Once the record is fresh, answer with a corrective
        // write: model + selection 'selected'. Checked at 4 s and
        // again at 15 s (the 4 s write may itself be reset or land late). This
        // steers the NEXT message (this one has already run) and is the
        // realistic way to make the pick stick — the record is re-fought
        // after every send, no unbounded loop.
        if (!watchOnly && sentModel) {
          const ag = agentThreads[th.key] || {};
          const bad = ag.model !== sentModel || ag.modelSelection !== (learnedSelection || 'selected');
          if (bad) {
            const run = runByThread[th.key];
            trace('repin', ms / 1000 + ' s: server drifted to ' + modelLabel(ag.model) + ' (selection ' + (ag.modelSelection || '?') + '): re-pinning ' + modelLabel(sentModel));
            if (run) { run.fix = 're-pinned model+selection (next message)'; publishRuns(); }
            ensureThreadEffort(input, options, bodyText).catch(() => {});
          }
        }
      }).catch(() => {});
    }, ms));
  }

  function reportResult(th, ms, sentModel, sentEffort, sentAt) {
    const ag = agentThreads[th.key];
    if (!ag || !ag.model) { trace('result', ms / 1000 + ' s: chat record has no model yet'); return; }
    const run = runByThread[th.key];
    // Freeze the first post-send record BEFORE our corrective repin. The 15 s
    // record often shows the model WE wrote, not the model that generated the
    // answer; presenting that later write as a server success is false.
    if (ms === 4000 && run) run.observedRuntime = snap(ag);
    const observed = (ms > 4000 && run && run.observedRuntime) ? run.observedRuntime : snap(ag);
    const okModel = !sentModel || observed.model === sentModel;
    const okEffort = !sentEffort || observed.reasoningEffort === sentEffort;
    const recordChanged = observed.model !== ag.model || observed.reasoningEffort !== ag.reasoningEffort || observed.modelSelection !== ag.modelSelection;
    trace('result', ms / 1000 + ' s: server ran ' + modelLabel(observed.model) + ' / ' + (observed.reasoningEffort || '?') +
      ' (selection: ' + (observed.modelSelection || '?') + ')' +
      (okModel ? '' : ' ≠ wanted ' + modelLabel(sentModel)) + (okEffort ? '' : ' · effort ≠ ' + sentEffort) +
      (okModel && okEffort ? ' ✓' : '') +
      (recordChanged ? ' · record now shows ' + modelLabel(ag.model) + ' after OUR repin — not the answer runtime' : ''));
    updateRun(th.key, ms);
    if (!okModel && ms === 4000) {
      explainMismatch(th.spaceId, sentModel, sentEffort, observed.model, sentAt).catch((e) => trace('why', 'could not check: ' + String(e.message || e)));
    }
  }

  // What the server's answer stream says about the model: which one it ran,
  // fallbacks, limits, errors. Only short values under such keys, never the
  // reply text. Read from a copy, so Notion's own reading is untouched.
  const STREAM_KEY = /model|fallback|downgrad|reroute|reason|limit|quota|credit|usage|error|warning|unavailable|disabled|policy|provider|selection|effort/i;
  const STREAM_SKIP = /^(text|content|value|delta|markdown|title)$/i;
  function traceStream(res) {
    let copy;
    try { copy = res.clone(); } catch (e) { return; }
    copy.text().then((text) => {
      const seen = new Set();
      const walk = (v, key, depth) => {
        if (depth > 10 || v == null || seen.size > 40) return;
        if (Array.isArray(v)) { v.slice(0, 50).forEach((x) => walk(x, key, depth + 1)); return; }
        if (typeof v === 'object') {
          Object.keys(v).forEach((k) => { if (!STREAM_SKIP.test(k)) walk(v[k], k, depth + 1); });
          return;
        }
        if (!key || !STREAM_KEY.test(key)) return;
        if (typeof v === 'string' && (v.length > 80 || /\s.*\s.*\s/.test(v) && v.length > 40)) return;
        seen.add(key + '=' + JSON.stringify(v));
      };
      let lines = 0;
      text.split('\n').forEach((line) => {
        const s = line.trim().replace(/^data:\s*/, '');
        if (!s || (s[0] !== '{' && s[0] !== '[')) return;
        lines++;
        try { walk(JSON.parse(s), '', 0); } catch (e) {}
      });
      if (!lines) { try { walk(JSON.parse(text), '', 0); lines = 1; } catch (e) {} }
      trace('stream', lines + ' events · ' + (seen.size ? Array.from(seen).join(', ') : 'no model/limit/error fields'));
    }).catch((e) => trace('stream', 'could not read: ' + String(e.message || e)));
  }

  // Model/effort fields Notion's own client puts in the send (no message
  // text: only short values under keys that name a model or effort).
  function modelFieldsOf(bodyText) {
    const out = [];
    const walk = (v, path, depth) => {
      if (depth > 8 || v == null || out.length > 12) return;
      if (Array.isArray(v)) { v.slice(0, 20).forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1)); return; }
      if (typeof v !== 'object') return;
      Object.keys(v).forEach((k) => {
        const x = v[k];
        const p = path ? path + '.' + k : k;
        if (/model|effort|reason|provider|selection/i.test(k) && (typeof x !== 'object' || x === null)) {
          if (typeof x !== 'string' || x.length <= 60) out.push(p + '=' + JSON.stringify(x));
        } else if (/model|effort|provider|selection/i.test(k) && x && typeof x === 'object') {
          out.push(p + '=' + JSON.stringify(x).slice(0, 120));
        } else {
          walk(x, p, depth + 1);
        }
      });
    };
    try { walk(JSON.parse(bodyText), '', 0); } catch (e) { return 'not JSON'; }
    return out.length ? 'Notion sends ' + out.join(', ') : 'Notion sends no model/effort field';
  }

  // Everything that could make Auto skip the picked model, checked on the server.
  async function explainMismatch(spaceId, model, effort, ran, sentAt) {
    const p = await readPolicy(spaceId);
    trace('why', 'policy right now allows: ' + describePolicy(p, spaceId));
    // Fresh read: the cached catalogue was taken under the previous policy, and
    // restrictedForPersonalAgent there just means "not allowed by that policy".
    catalogue = null;
    const models = await readCatalogue(spaceId).catch((e) => { trace('why', 'catalogue: ' + String(e.message || e)); return []; });
    const m = models.find((x) => x.model === model);
    if (!m) { trace('why', modelLabel(model) + ' is not in this workspace catalogue'); return; }
    const sup = (m.modelConfiguration && m.modelConfiguration.supportedReasoningEfforts) || [];
    const flags = [];
    if (m.isDisabled) flags.push('disabled for this workspace');
    if (m.isDisabledOnlyByDisasterRecovery) flags.push('disabled by Notion (outage)');
    if (m.isApproachingRateLimit) flags.push('near rate limit');
    if (m.restrictedForPersonalAgent) flags.push('restricted for Notion Agent');
    if (isOptIn(model)) flags.push('opt-in model');
    if (effort && sup.length && sup.indexOf(effort) === -1) flags.push('effort ' + effort + ' not supported (' + sup.join(', ') + ')');
    trace('why', modelLabel(model) + ' (fresh catalogue): ' + (flags.length ? flags.join(' · ') : 'no flags'));
    const allowed = models.filter((x) => !x.restrictedForPersonalAgent && !x.isDisabled).map((x) => modelLabel(x.model));
    trace('why', 'catalogue says Notion Agent may use: ' + (allowed.length ? allowed.join(', ') : 'nothing'));
    if (ran && ran !== model) {
      const r = models.find((x) => x.model === ran);
      trace('why', 'the model that ran (' + ran + ') ' + (r
        ? 'is in the catalogue as ' + modelLabel(ran) + (r.restrictedForPersonalAgent ? ', restricted' : '') + (r.isDisabled ? ', disabled' : '')
        : 'is NOT in the catalogue: a server-side fallback, not a model the policy allowed'));
    }
    if (lastPolicyWriteAt && sentAt && sentAt - lastPolicyWriteAt < 5000) {
      trace('why', 'the policy was written only ' + (sentAt - lastPolicyWriteAt) + ' ms before the send (the server may still have used the old list)');
    }
  }

  // Log agent_provider writes Notion's own client makes: if the revert comes
  // from the client rather than the server, this is where it shows up.
  function noteForeignTx(bodyText) {
    if (bodyText.indexOf('agent_provider') === -1 || bodyText.indexOf('NotionEffort.') !== -1) return;
    try {
      const b = JSON.parse(bodyText);
      (b.transactions || []).forEach((t) => (t.operations || []).forEach((op) => {
        if (JSON.stringify(op).indexOf('agent_provider') === -1) return;
        logPush(foreignLog, {
          at: new Date().toISOString(),
          userAction: t.debug && t.debug.userAction,
          table: op.pointer && op.pointer.table, id: op.pointer && op.pointer.id,
          path: op.path, command: op.command, args: op.args,
        });
      }));
    } catch (e) {}
  }

  // ---- Probe: workspace "Allowed models for Notion Agent" ------------------
  //
  // Settings > Notion AI > Model controls restricts which models Notion Agent
  // may use, and Auto respects it. That is the lever for picking a model on a
  // trial, but the request it sends is not known yet: log any API request
  // whose body names a model codename (or looks like a model allowlist) so
  // the format can be read off copy(__notionEffortAgentDiag()).modelSettings.
  const modelSettingLog = [];
  const ALLOW_HINT = /allowed_?models|allowedModels|model_?allow|disabled_?models|model_?restrict/i;

  // Telemetry repeats every experiment name; chat sends carry the user's text.
  const PROBE_SKIP = /etClient|trackEvent|\/log|telemetry|sendEventToAgentThread|createAgentThread|runInference|getCompletion|syncRecordValues|getInferenceTranscripts|getThreadTranscript|listenToThreadTranscript/i;
  const PROBE_URL = /model|aiSetting|ai_setting|agentSetting|allowed|restrict/i;

  // ---- Usage limits: percent used and reset time ---------------------------
  //
  // Notion does not put the AI usage figures in getAvailableModels; a separate
  // request carries them. Rather than guess its path, every API response is
  // scanned for the fields such a payload would have to contain (a percentage
  // or count, a limit, a reset moment) and the shape is kept here for the
  // panel. Key names only, no message text: this is a settings payload.
  const limitLog = [];
  // Only a response that really looks like a usage/entitlement payload is kept:
  // a bare "ai_credit_overage_policy" string on the space record is not one.
  const LIMIT_KEY = /(credit|usage|quota|limit|reset|remaining|entitlement|allowance)/i;
  const LIMIT_VALUE = /(credit|usage|quota|limit|reset|remaining|entitlement|allowance|window|period|expire)/i;
  const LIMIT_NUM = /(percent|pct|used|count|consumed|spent|remaining)/i;
  const LIMIT_SKIP = /etClient|trackEvent|telemetry|getInferenceTranscripts|getThreadTranscript|listenToThreadTranscript|sendEventToAgentThread|createAgentThread|runInference|getCompletion/i;

  function scanLimits(value, path, out, depth) {
    if (out.length > 60 || depth > 12 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 12).forEach((x, i) => scanLimits(x, path + '[' + i + ']', out, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    Object.keys(value).forEach((k) => {
      const v = value[k];
      const p = path ? path + '.' + k : k;
      if (v != null && typeof v !== 'object' && LIMIT_KEY.test(k)) out.push({ path: p, value: typeof v === 'string' && v.length > 60 ? v.slice(0, 60) : v });
      else scanLimits(v, p, out, depth + 1);
    });
  }

  /** Does this response hold numbers in a usage shape, or only policy strings? */
  function looksLikeUsage(fields) {
    const numeric = fields.filter((f) => typeof f.value === 'number');
    if (numeric.length < 2) return false;
    return numeric.some((f) => LIMIT_NUM.test(f.path));
  }

  function noteLimits(path, p) {
    if (LIMIT_SKIP.test(path)) return;
    p.then((res) => {
      if (!res || !res.ok) return;
      const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (type && type.indexOf('json') === -1) return;
      res.clone().text().then((text) => {
        let json;
        try { json = JSON.parse(text); } catch (e) { return; }
        const out = [];
        scanLimits(json, '', out, 0);
        const fields = out.filter((f) => LIMIT_VALUE.test(f.path));
        if (!fields.length) return;
        const entry = { at: new Date().toISOString(), url: path, usage: looksLikeUsage(fields), fields: fields.slice(0, 60) };
        const had = limitLog.some((l) => l.url === path);
        if (had && !entry.usage) return;
        logPush(limitLog, entry);
        console.log('[Notion Effort] usage/limit response:', path, entry.usage ? '(usage-like)' : '(policy only)');
      }).catch(() => {});
    }, () => {});
  }

  function noteModelSetting(path, bodyText, p, via) {
    if (PROBE_SKIP.test(path) || bodyText.indexOf('NotionEffort.') !== -1) return;
    const known = settings.knownModels || [];
    const hit = PROBE_URL.test(path) || ALLOW_HINT.test(bodyText) ||
      known.some((m) => m && bodyText.indexOf('"' + m + '"') !== -1) ||
      (/saveTransactions/.test(path) && /"table":"space"/.test(bodyText) && /model|agent/i.test(bodyText));
    if (!hit) return;
    const entry = { at: new Date().toISOString(), via: via || 'fetch', url: path, body: bodyText.slice(0, 4000) };
    logPush(modelSettingLog, entry);
    console.log('[Notion Effort] model setting request:', path, entry.body);
    p.then((res) => {
      entry.http = res && res.status;
      if (res && res.ok) {
        res.clone().text().then((t) => { entry.response = t.slice(0, 1500); }).catch(() => {});
      }
    }, (e) => { entry.error = String(e); });
  }

  // ---- Model: workspace "Allowed models for Notion Agent" ------------------
  //
  // Auto respects Settings > Notion AI > Model controls > Allowed models for
  // Notion Agent, trial included. That setting is
  // space.settings.personal_agent_model_policy:
  //   { disabledModels: [codename], disabledProviders: ['xai', ...],
  //     allowedRestrictedModels: [codename] }   (restricted = opt-in models)
  // written with updateSpaceSettings { spaceId, settingsPatch, unsetSettingKeys }.
  // Picking a model disables every other one, so Auto can only run the pick;
  // picking Auto puts back the policy the workspace had before, which is kept
  // in localStorage until then. It is workspace-wide, like the setting itself.
  // custom_agent_model_policy (Custom Agents) is left alone.
  const POLICY_KEY = 'personal_agent_model_policy';
  const BACKUP_KEY = 'notionEffortPolicyBackup';
  // The Auto router only honors workspace_ai_provider_restriction: individual
  // disabledModels in personal_agent_model_policy never reach its "may use"
  // list (Sonnet 4.6 stays available with Opus pinned). So the pick is ALSO
  // written into the workspace restriction's disabledModels.
  const WPOLICY_KEY = 'workspace_ai_provider_restriction';
  const WBACKUP_KEY = 'notionEffortWPolicyBackup';
  // Workspaces whose provider restrictions reject every policy write we can
  // build: skip further writes so a pick does not pay 1.3 s of guaranteed 400s.
  const disabledHardFail = {};
  // Notion routes each workspace to a "cell"; a request carrying another
  // workspace's x-notion-cell / space headers fails with
  // MemcachedCrossCellError. So keep the headers per workspace, as Notion's
  // own requests for that workspace sent them.
  const CELL_HEADER = /^x-notion-(space-id|space-short-id|cell|cell-hint|cell-hint-source)$/;
  const headersBySpace = {}; // plain spaceId -> x-notion-* headers of a request for it
  const baseHeaders = {}; // the rest (client version, active user)
  let lastSpaceId = null; // from request bodies
  let headerSpaceId = null; // from x-notion-space-id
  let agentSpaceId = null; // from chat sends: the workspace this chat is in
  let catalogue = null; // { spaceId, models } from getAvailableModels
  const policyLog = [];
  let policyState = null;
  let policyChain = Promise.resolve();
  let lastPolicyWriteAt = 0;
  let appliedKey = null; // "space|model" last confirmed on the server
  let settingsSeen = false; // the panel's pick has not arrived yet: touch nothing
  // "space|model" (or a bare space for a restore) whose write failed: no
  // retry until the next pick.
  const failed = new Set();

  function noteApiRequest(opts) {
    const h = opts && opts.headers;
    if (h) {
      const got = {};
      const each = (v, k) => { if (/^x-notion-|^notion-/i.test(k)) got[k.toLowerCase()] = String(v); };
      try {
        if (h instanceof Headers) h.forEach(each);
        else if (Array.isArray(h)) h.forEach((kv) => each(kv[1], kv[0]));
        else Object.keys(h).forEach((k) => each(h[k], k));
      } catch (e) {}
      Object.keys(got).forEach((k) => { if (!CELL_HEADER.test(k)) baseHeaders[k] = got[k]; });
      const sid = got['x-notion-space-id'];
      if (sid) {
        headersBySpace[plainId(sid)] = got;
        headerSpaceId = sid;
      }
    }
    if (opts && typeof opts.body === 'string') {
      const m = /"spaceId"\s*:\s*"([0-9a-f-]{32,36})"/i.exec(opts.body);
      if (m) {
        lastSpaceId = dashedId(m[1]);
        setTimeout(loadCatalogueForPicker, 0);
      }
    }
  }

  function currentSpaceId() {
    return agentSpaceId || headerSpaceId || lastSpaceId;
  }

  // Headers of Notion's own request for this workspace; without one, only
  // the workspace id and no cell, and let Notion route it.
  function headersFor(spaceId, bare) {
    const own = !bare && headersBySpace[plainId(spaceId)];
    const h = new Headers(own || Object.assign({}, baseHeaders, { 'x-notion-space-id': dashedId(spaceId) }));
    h.set('content-type', 'application/json');
    return h;
  }

  function apiPost(step, spaceId, path, body) {
    const once = (bare) => effortFetch(location.origin + path, {
      method: 'POST', credentials: 'include', headers: headersFor(spaceId, bare), body: JSON.stringify(body),
    }).then((res) => res.text().then((text) => ({ res: res, text: text })));
    return once(false).then((r) => (!r.res.ok && (/CrossCell/.test(r.text) || r.res.status === 403) ? once(true) : r)).then((r) => {
      if (!r.res.ok) {
        throw Object.assign(new Error(step + ': HTTP ' + r.res.status + ' ' + r.text.slice(0, 200)), { http: r.res.status });
      }
      return JSON.parse(r.text);
    });
  }

  // undefined = the response has no record for this space; null = no policy.
  function findSpaceSetting(json, spaceId, key) {
    const space = json && json.recordMap && json.recordMap.space;
    if (!space) return undefined;
    const k = Object.keys(space).find((id) => plainId(id) === plainId(spaceId));
    const v = k && unwrapRecord(space[k]);
    if (!v || !v.id) return undefined;
    return (v.settings && v.settings[key]) || null;
  }

  function findSpacePolicy(json, spaceId) {
    return findSpaceSetting(json, spaceId, POLICY_KEY);
  }

  function readPolicy(spaceId) {
    return apiPost('read policy', spaceId, '/api/v3/syncRecordValues', {
      requests: [{ pointer: { table: 'space', id: spaceId }, version: -1 }],
    }).then((json) => {
      const p = findSpacePolicy(json, spaceId);
      if (p === undefined) throw new Error('space record not returned');
      return p;
    });
  }

  function readSpaceSetting(spaceId, key) {
    return apiPost('read setting', spaceId, '/api/v3/syncRecordValues', {
      requests: [{ pointer: { table: 'space', id: spaceId }, version: -1 }],
    }).then((json) => {
      const p = findSpaceSetting(json, spaceId, key);
      if (p === undefined) throw new Error('space record not returned');
      return p;
    });
  }

  function loadWBackups() {
    try { return JSON.parse(localStorage.getItem(WBACKUP_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveWBackups(b) {
    try { localStorage.setItem(WBACKUP_KEY, JSON.stringify(b)); } catch (e) {}
  }

  // RESTORE ONLY. Writing the pick into workspace_ai_provider_restriction
  // disabled AI on the whole space (create answered 403 "AI is not enabled
  // on this space", v2.37 trace) — the router read the restriction as "no
  // eligible models". So this function now exists solely to put back the
  // original restriction saved by v2.37; it never writes a new one.
  async function applyWorkspaceRestriction(spaceId, model) {
    const sk = plainId(spaceId);
    const backups = loadWBackups();
    const has = Object.prototype.hasOwnProperty.call(backups, sk);
    if (model || !has) return;
    const current = await readSpaceSetting(spaceId, WPOLICY_KEY);
    const target = backups[sk];
    if (norm(current) === norm(target)) {
      delete backups[sk]; saveWBackups(backups);
      trace('policy', 'workspace restriction already back to the original list');
      return;
    }
    const body = target
      ? { spaceId: spaceId, settingsPatch: { [WPOLICY_KEY]: target }, unsetSettingKeys: [] }
      : { spaceId: spaceId, settingsPatch: {}, unsetSettingKeys: [WPOLICY_KEY] };
    await apiPost('restore workspace restriction', spaceId, '/api/v3/updateSpaceSettings', body);
    delete backups[sk]; saveWBackups(backups);
    trace('policy', 'workspace restriction restored to the original list (AI re-enabled)');
  }

  // Without the surface the server answers with an empty list.
  function readCatalogue(spaceId) {
    if (catalogue && catalogue.spaceId === plainId(spaceId)) return Promise.resolve(catalogue.models);
    return apiPost('read models', spaceId, '/api/v3/getAvailableModels', { spaceId: spaceId, surface: 'workspace_model_settings' })
      .then((json) => {
        const models = ((json && json.models) || []).filter((m) => m && m.model);
        if (!models.length) throw new Error('getAvailableModels returned no models');
        // Opt-in models (Fable on a trial, ...). Note restrictedForPersonalAgent
        // is no guide: it is also true for every model the policy disables.
        const optIn = ((json && json.restrictedAccessModelsInPickerConfig) || []).map((r) => r && r.codename).filter(Boolean);
        catalogue = { spaceId: plainId(spaceId), models: models, optIn: optIn };
        publishCatalogue();
        return models;
      });
  }

  const FAMILY_OF = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini', xai: 'xai' };
  function publishCatalogue() {
    if (!catalogue) return;
    window.postMessage({
      type: 'NOTION_EFFORT_SPACE_MODELS',
      spaceId: catalogue.spaceId,
      models: catalogue.models.map((m) => ({
        model: m.model,
        name: m.modelMessage || m.displayName || m.name || m.model, // modelMessage is the display name
        family: FAMILY_OF[m.modelFamily] || FAMILY_OF[m.modelProvider] || 'mystery',
        efforts: (m.modelConfiguration && m.modelConfiguration.supportedReasoningEfforts) || [],
        // The effort the server takes when nothing is written: what a reset
        // falls back to, so the panel can name the number the reroute picks.
        defaultEffort: (m.modelConfiguration && m.modelConfiguration.defaultReasoningEffort) || null,
        // Limit flags Notion returns per model, for the panel's Limits view.
        rateLimit: m.isApproachingRateLimit === undefined ? undefined : !!m.isApproachingRateLimit,
        outage: m.isDisabledOnlyByDisasterRecovery === undefined ? undefined : !!m.isDisabledOnlyByDisasterRecovery,
        disabled: !!m.isDisabled,
        credit: !!(m.modelCardAttributes && m.modelCardAttributes.billsNotionCredits),
        optIn: isOptIn(m.model),
      })),
    }, '*');
  }

  // Read-only, for the picker: any workspace id seen will do until a chat
  // send names the real one (the offer is nearly the same everywhere).
  let catalogueLoading = false;
  function loadCatalogueForPicker() {
    const sid = agentSpaceId || currentSpaceId();
    if (catalogue || catalogueLoading || !sid) return;
    catalogueLoading = true;
    readCatalogue(sid).catch(() => {}).then(() => { catalogueLoading = false; });
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_SPACE_MODELS_REQUEST') {
      if (catalogue) publishCatalogue();
      else loadCatalogueForPicker();
    }
  });

  function loadBackups() {
    try { return JSON.parse(localStorage.getItem(BACKUP_KEY)) || {}; } catch (e) { return {}; }
  }

  function saveBackups(b) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(b)); } catch (e) {}
  }

  const uniq = (a) => Array.from(new Set(a));
  const arr = (v) => (Array.isArray(v) ? v : []);

  function modelLabel(id) {
    if (!id) return 'Auto';
    const m = catalogue && catalogue.models.find((x) => x.model === id);
    return (m && m.modelMessage) || id;
  }

  /** Which models a policy lets Notion Agent use, by name. */
  function describePolicy(p, spaceId) {
    if (!p) return 'every model (no policy)';
    const models = catalogue && catalogue.spaceId === plainId(spaceId) ? catalogue.models : null;
    if (!models) return 'disabled ' + arr(p.disabledModels).length + ' models, ' + arr(p.disabledProviders).length + ' providers';
    const ok = models.filter((m) => arr(p.disabledModels).indexOf(m.model) === -1 &&
      arr(p.disabledProviders).indexOf(m.modelProvider) === -1 &&
      (!isOptIn(m.model) || arr(p.allowedRestrictedModels).indexOf(m.model) !== -1));
    if (!ok.length) return 'nothing';
    if (ok.length === models.length) return 'every model';
    const names = ok.map((m) => m.modelMessage || m.model);
    return names.length > 6 ? names.length + ' models (' + names.slice(0, 6).join(', ') + ', …)' : names.join(', ');
  }

  // Codenames there may lack the effort suffix (acai-budino for acai-budino-high).
  function isOptIn(model) {
    return !!catalogue && (catalogue.optIn || []).some((c) => model === c || model.indexOf(c + '-') === 0);
  }

  // Providers as Notion's own Model controls page names them. The router's
  // fallback (orange-mousse, openai) is not in the catalogue, so disabling it
  // by id does nothing; only switching off its whole provider keeps it out.
  // That is what the settings page does, and why a pick made there sticks.
  // For an OpenAI pick the provider has to stay on, so the fallback is also
  // named in disabledModels even though the catalogue does not list it. If the
  // server refuses or drops an id it does not know, the write is retried
  // without it (see applyPolicy).
  const FALLBACK_IDS = ['orange-mousse'];
  const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai', 'deepseek', 'kimi', 'glm'];

  function policyFor(model, base, models) {
    const entry = models.find((m) => m.model === model);
    if (!entry) return null;
    const b = base || {};
    // Opt-in (restricted) models are allowed only via allowedRestrictedModels,
    // and the server rejects a model that is both allowed and disabled
    // (ValidationError). So only the pick stays allowed; the catalogue flag
    // reads false for ones already allowed, hence the base list check.
    const restricted = isOptIn(model) || arr(b.allowedRestrictedModels).indexOf(model) !== -1;
    return Object.assign({}, b, {
      disabledModels: uniq(arr(b.disabledModels).concat(models.map((m) => m.model), FALLBACK_IDS)).filter((id) => id !== model),
      disabledProviders: uniq(arr(b.disabledProviders).concat(KNOWN_PROVIDERS, models.map((m) => m.modelProvider).filter(Boolean)))
        .filter((p) => p !== entry.modelProvider),
      allowedRestrictedModels: restricted ? [model] : [],
    });
  }

  function norm(p) {
    if (!p) return 'null';
    const o = {};
    // The server drops empty lists (and nulls) instead of storing them.
    Object.keys(p).sort().forEach((k) => {
      const v = p[k];
      if (v == null || (Array.isArray(v) && !v.length)) return;
      o[k] = Array.isArray(v) ? v.slice().sort() : v;
    });
    return JSON.stringify(o);
  }

  async function applyPolicy(spaceId, model) {
    const sk = plainId(spaceId);
    const backups = loadBackups();
    const has = Object.prototype.hasOwnProperty.call(backups, sk);
    if (!model && !has) return { changed: false }; // Auto, nothing of ours to undo
    const current = await readPolicy(spaceId);
    const where = 'workspace ' + plainId(spaceId).slice(0, 8);
    trace('policy', where + ' now allows: ' + describePolicy(current, spaceId));
    let target;
    if (model) {
      const models = await readCatalogue(spaceId);
      target = policyFor(model, has ? backups[sk] : current, models);
      if (!target) throw new Error(model + ' is not offered in this workspace');
      if (!has) { backups[sk] = current; saveBackups(backups); }
    } else {
      target = backups[sk];
    }
    if (disabledHardFail[sk]) {
      // The last write for this workspace hit the provider-restriction wall and
      // there is nothing we can write that the server accepts — skip further
      // writes so each pick does not cost 1.3 s of guaranteed 400s.
      trace('policy', where + ': disabled for this workspace (previous write failed: ' + disabledHardFail[sk] + ')');
      return { changed: false, hardFail: true };
    }
    if (norm(current) === norm(target)) {
      trace('policy', model ? 'already set for ' + modelLabel(model) + ', no write needed' : where + ': original list already in place');
      return { changed: false };
    }
    trace('policy', model ? 'writing: allow only ' + modelLabel(model) : where + ': restoring the original list');
    const body = target
      ? { spaceId: spaceId, settingsPatch: { [POLICY_KEY]: target }, unsetSettingKeys: [] }
      : { spaceId: spaceId, settingsPatch: {}, unsetSettingKeys: [POLICY_KEY] };
    // Degradations for a server that refuses the full patch. The fallback id
    // (orange-mousse) is not in the catalogue and some workspaces validate
    // disabledProviders against ai_provider_restrictions: HTTP 400
    // ValidationError "… must match workspace ai_provider_restrictions".
    // A policy without disabledProviders still pins the pick: every catalogue
    // model except it is disabled by id.
    const strip = (p) => p && Object.assign({}, p, { disabledModels: arr(p.disabledModels).filter((id) => FALLBACK_IDS.indexOf(id) === -1) });
    const stripProviders = (p) => p && Object.assign({}, p, { disabledProviders: [] });
    const named = target && arr(target.disabledModels).some((id) => FALLBACK_IDS.indexOf(id) !== -1);
    // Try the server-friendly form first (disabledProviders removed): the full
    // write has never succeeded here (every attempt was 400), and the reduced
    // form is what the server ends up keeping anyway.
    let attempts = [stripProviders(strip(target)), strip(target), target];
    if (!named) attempts = attempts.filter((a) => !a || !arr(a.disabledModels).some((id) => FALLBACK_IDS.indexOf(id) !== -1));
    attempts = attempts.filter(Boolean).filter((p, i, a) => a.findIndex((q) => norm(q) === norm(p)) === i);
    // The server stores the reduced form, while the target is rebuilt full
    // from the backup — comparing against the full target rewrites the policy
    // on EVERY send, and a send that lands mid-rewrite meets an unsettled
    // model list. Accept any stored attempt form as "already set".
    if (attempts.some((a) => norm(a) === norm(current))) {
      trace('policy', model ? 'already set for ' + modelLabel(model) + ', no write needed' : where + ': original list already in place');
      lastPolicyWriteAt = lastPolicyWriteAt || Date.now();
      return { changed: false };
    }
    let json = null;
    if (target) {
      let lastErr = null;
      for (let i = 0; i < attempts.length; i++) {
        body.settingsPatch = { [POLICY_KEY]: attempts[i] };
        try {
          json = await apiPost('write policy', spaceId, '/api/v3/updateSpaceSettings', body);
          target = attempts[i];
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (e && e.http !== 400) throw e;
          trace('policy', 'server refused the write (' + String(e.message || e).slice(0, 120) + '): retrying with a reduced policy');
        }
      }
      if (lastErr) {
        // Restoring (Auto pick): the saved policy may no longer validate
        // against the workspace's current provider restrictions. Last resort:
        // drop our policy key entirely — the workspace returns to default.
        if (!model) {
          try {
            json = await apiPost('restore policy (unset)', spaceId, '/api/v3/updateSpaceSettings',
              { spaceId: spaceId, settingsPatch: {}, unsetSettingKeys: [POLICY_KEY] });
            target = null;
            lastErr = null;
            trace('policy', where + ': saved policy no longer valid here — policy key removed instead');
          } catch (e2) { lastErr = e2; }
        }
      }
      if (lastErr) {
        // "must leave at least one eligible model" — the provider restrictions
        // of this workspace reject any bounded list we can write. Remember it
        // and skip next time. The run is still driven by the record/body pin.
        if (lastErr && lastErr.serverMsg && /at least one eligible model|provider_restrictions/i.test(lastErr.serverMsg)) {
          disabledHardFail[sk] = lastErr.serverMsg;
          trace('policy', where + ': provider restrictions reject every bounded policy — disabling policy writes for this workspace');
        }
        throw lastErr;
      }
    } else {
      json = await apiPost('write policy', spaceId, '/api/v3/updateSpaceSettings', body);
    }
    const after = findSpacePolicy(json, spaceId);
    if (after !== undefined && norm(after) !== norm(target)) {
      // The server may silently drop ids it does not know; adopt the reduced
      // variant it stored instead of failing the pick.
      const alt = [strip(target), stripProviders(target), stripProviders(strip(target))]
        .filter(Boolean)
        .find((p) => norm(p) === norm(after));
      if (alt) {
        trace('policy', 'server stored a reduced policy; adopting it');
        target = alt;
      } else {
        throw new Error('server stored a different policy');
      }
    }
    lastPolicyWriteAt = Date.now();
    trace('policy', 'saved, server now allows: ' + describePolicy(after === undefined ? target : after, spaceId));
    return { changed: true, allowed: model || null };
  }

  function reportPolicy(status, detail) {
    policyState = Object.assign({ status: status, at: new Date().toISOString() }, detail);
    logPush(policyLog, policyState);
    console.log('[Notion Effort] allowed-models policy:', status, detail);
    window.postMessage({ type: 'NOTION_EFFORT_POLICY', status: status, detail: detail }, '*');
  }

  function hasBackups() {
    return Object.keys(loadBackups()).length > 0;
  }

  // Only the workspace a chat is sent in: any other id seen in traffic may be
  // one of the user's other workspaces (2.9 wrote the policy into one).
  // A backup left in another workspace is put back only once this account is
  // seen using that workspace: the list may hold a workspace of another
  // account or one no longer reachable (403), and trying it there only fails.
  // And only on Auto: while a model is picked, every workspace keeps "only the
  // pick". Putting a list back on each workspace switch changed the policy under
  // open chats; the server then re-routed them at the default effort (medium)
  // and, in the gap, Auto pinned new chats to other models for good.
  function strayBackups(sid) {
    if (settings.model) return [];
    return Object.keys(loadBackups()).filter((k) => k !== plainId(sid) && !failed.has(k) && headersBySpace[k]);
  }

  // fresh: re-read the server's policy even if this tab set it already. The
  // desktop app or another browser profile may have rewritten it since.
  // ---- Chat tab: which model really answered each message -----------------
  //
  // Every send gets a row: what the workspace allowed at that moment and what
  // the server ran (read from the chat record 4 s and 15 s later). In watch
  // only mode the extension writes nothing at all, so the workspace settings
  // set by hand in Notion are what the server sees.
  const WATCH_KEY = 'notionEffortWatchOnly';
  let watchOnly = false;
  try { watchOnly = localStorage.getItem(WATCH_KEY) === '1'; } catch (e) {}
  const runs = [];
  const runByThread = {};
  function publishRuns() {
    window.postMessage({ type: 'NOTION_EFFORT_RUNS', runs: runs, watchOnly: watchOnly }, '*');
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'NOTION_EFFORT_RUNS_REQUEST') publishRuns();
    if (e.data.type === 'NOTION_EFFORT_FIND_ONBOARDING') findOnboarding();
    if (e.data.type === 'NOTION_EFFORT_CREATE_OLD_CHAT') createOldChat(e.data.text);
    if (e.data.type === 'NOTION_EFFORT_OLD_CHAT_DEAD') {
      trace('old chat', 'opened ' + String(e.data.id || '').slice(0, 8) + ' (saved as ' + (e.data.recordType || '?') + ') → Notion: no access at ' + shortUrl(e.data.url));
    }
    if (e.data.type === 'NOTION_EFFORT_WATCH_ONLY') {
      watchOnly = !!e.data.on;
      try { localStorage.setItem(WATCH_KEY, watchOnly ? '1' : '0'); } catch (x) {}
      trace('watch', watchOnly
        ? 'watch only ON: the extension changes nothing (workspace list, chat model, effort are left to Notion)'
        : 'watch only OFF: the panel picks apply again');
      publishRuns();
    }
  });

  function policyAllows(p, m) {
    if (!p) return true;
    if (arr(p.disabledModels).indexOf(m.model) !== -1) return false;
    if (arr(p.disabledProviders).indexOf(m.modelProvider) !== -1) return false;
    return !isOptIn(m.model) || arr(p.allowedRestrictedModels).indexOf(m.model) !== -1;
  }

  function startRun(bodyText, isNew, after) {
    const th = threadOf(bodyText);
    if (!th) return;
    const run = {
      at: new Date().toISOString(), thread: th.key, isNew: isNew,
      watchOnly: watchOnly, picked: watchOnly ? null : settings.model,
      allowed: '…', allowedIds: null, ran: null, ranName: null, effort: null, selection: null, inList: null, checks: 0,
      // The effort this send asked for (after the model-limit clamp), so the
      // panel can tell a reset from an older pick.
      wantEffort: watchOnly || !settings.effort ? null
        : agentTargetEffort(settings.model || (agentThreads[th.key] || {}).model) || null,
    };
    runs.push(run);
    if (runs.length > 30) runs.shift();
    runByThread[th.key] = run;
    publishRuns();
    // Read in parallel: the send is not held up.
    // After our own policy write (if any), so the list shown is what the server had.
    Promise.resolve(after).then(() => Promise.all([readPolicy(th.spaceId), readCatalogue(th.spaceId).catch(() => [])])).then(([p, models]) => {
      run.allowed = describePolicy(p, th.spaceId);
      if (models.length) run.allowedIds = models.filter((m) => policyAllows(p, m)).map((m) => m.model);
      finishRun(run);
    }).catch((e) => { run.allowed = 'could not read: ' + String(e.message || e).slice(0, 120); publishRuns(); });
    return { th: th, run: run };
  }

  function finishRun(run) {
    if (run.ran && run.allowedIds) run.inList = run.allowedIds.indexOf(run.ran) !== -1;
    publishRuns();
  }

  function updateRun(key, ms) {
    const run = runByThread[key];
    const ag = agentThreads[key];
    if (!run || !ag || !ag.model) return;
    run.ran = ag.model;
    run.ranName = modelLabel(ag.model);
    run.effort = ag.reasoningEffort || null;
    run.selection = ag.modelSelection || null;
    run.checks = ms / 1000;
    finishRun(run);
    if (ms === 4000) {
      trace('chat', 'answered by ' + run.ranName + (run.ranName !== ag.model ? ' (' + ag.model + ')' : '') +
        ' / ' + (run.effort || '?') + ' · workspace allowed: ' + run.allowed +
        (run.inList === false ? ' · NOT in that list' : run.inList ? ' · in that list ✓' : ''));
    }
  }

  // Watch only (or nothing picked): pass the send through untouched, then look.
  function watchSend(self, args, opts, isNew) {
    const started = startRun(opts.body, isNew);
    const p = effortFetch.apply(self, args);
    p.then((res) => {
      if (!res || !res.ok || !started) return;
      traceStream(res);
      [4000, 15000].forEach((ms) => setTimeout(() => {
        rereadThread(args[0], opts, started.th.id, started.th.spaceId)
          .then(() => { publishAgent(); updateRun(started.th.key, ms); }).catch(() => {});
      }, ms));
    }, () => {});
    return p;
  }

  function ensurePolicy(spaceId, fresh) {
    if (watchOnly) return Promise.resolve();
    const sid = spaceId || agentSpaceId;
    if (!sid || !settingsSeen) {
      if (fresh) trace('policy', !sid ? 'skipped: workspace not known yet' : 'skipped: panel settings not loaded yet');
      return Promise.resolve();
    }
    const want = plainId(sid) + '|' + (settings.model || '');
    if (!fresh && (want === appliedKey || failed.has(want)) && !strayBackups(sid).length && !Object.keys(loadWBackups()).length) return Promise.resolve();
    policyChain = policyChain.catch(() => {}).then(async () => {
      // v2.37 wrote picks into workspace_ai_provider_restriction; that broke
      // AI on a191501c (403 "AI is not enabled") and did not steer the router
      // on 437cb23b. Any saved backup of that setting is put back here, once.
      for (const wk of Object.keys(loadWBackups())) {
        try { await applyWorkspaceRestriction(dashedId(wk), null); } catch (e) {
          trace('policy', 'workspace restriction restore failed for ' + wk.slice(0, 8) + ': ' + policyError(e));
        }
      }
      for (const k of strayBackups(sid)) {
        const other = dashedId(k);
        reportPolicy('pending', { model: null, spaceId: other, restore: true });
        try {
          const r = await applyPolicy(other, null);
          reportPolicy('ok', Object.assign({ model: null, spaceId: other, restore: true }, r));
          await applyWorkspaceRestriction(other, null).catch(() => {});
        } catch (e) {
          failed.add(k);
          reportPolicy('error', { model: null, spaceId: other, restore: true, error: policyError(e), http: e && e.http });
        }
      }
      const model = settings.model;
      const key = plainId(sid) + '|' + (model || '');
      if (failed.has(key)) {
        if (fresh) trace('policy', 'skipped: the last write here failed (' + ((policyState && policyState.error) || 'error') + '); pick again to retry');
        return;
      }
      if (key === appliedKey && !fresh) return;
      if (!model && !Object.prototype.hasOwnProperty.call(loadBackups(), plainId(sid))) {
        if (fresh) trace('policy', 'Auto: workspace list left as it is');
        return;
      }
      reportPolicy('pending', { model: model, spaceId: sid });
      return applyPolicy(sid, model).then((r) => {
        appliedKey = key;
        reportPolicy('ok', Object.assign({ model: model, spaceId: sid }, r));
      }, (e) => {
        failed.add(key);
        trace('policy', 'FAILED: ' + policyError(e));
        reportPolicy('error', { model: model, spaceId: sid, error: policyError(e), http: e && e.http });
        // A restore that the server keeps rejecting (workspace restrictions
        // changed since the backup) must not retry on every send: mark the
        // workspace and leave the user's own settings alone.
        if (!model) disabledHardFail[plainId(sid)] = policyError(e);
      });
    });
    return policyChain;
  }

  function policyError(e) {
    const text = String((e && e.message) || e);
    if (e && e.http === 403) return 'no rights to change workspace settings here (403: only workspace owners can)';
    return text;
  }

  // The settings listener at the top has already stored the new pick.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_SETTINGS') {
      settingsSeen = true;
      failed.clear(); // a new pick: try again
      if (!watchOnly) ensurePolicy();
    }
  });

  const TIMED_OUT = {};
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(TIMED_OUT), ms))]);
  }

  // ---- Deep model-routing debug (opt-in, read-only) ----------------------
  // Enable with __notionEffortDeepDebug(true), then repeat the same actions
  // on business and free. Download with __notionEffortDeepDebugDump().
  // Only model/routing fields are recorded; message text and credentials are
  // redacted. Nothing here changes requests, responses or workspace settings.
  const DEEP_DEBUG_KEY = 'notionEffortDeepDebug';
  const deepDebugLog = [];
  const DEEP_RE = /getAvailableModels|getCreditRateLimitStatus|createAgentThread|sendEventToAgentThread|saveTransactions|updateSpaceSettings|getWorkflowAdminSummaries|getThreadTranscript|getInferenceTranscriptsForUser|syncRecordValues|setDefaultAgentCreditLimitForSpace|workflow|customAgent|agentConfig/i;
  const DEEP_KEEP = /^(model|modelMessage|modelFamily|modelProvider|displayGroup|modelConfiguration|supportedReasoningEfforts|defaultReasoningEffort|selectedModel|modelSelection|modelSelectionRestricted|reasoningEffort|customAgentModelSelectionOverride|customAgentSetup|agent_provider|personal_agent_model_policy|custom_agent_model_policy|workspace_ai_provider_restriction|allowedRestrictedModels|disabledModels|disabledProviders|restrictedForPersonalAgent|restrictedForCustomAgent|isDisabled|models|offeredModels|surface|spaceId|threadId|workflowId|id|kind|sequence|forward_cursor|forward_after_sequence|has_more_forward|appliedModelConfigFingerprint|appliedCustomAgentConfigFingerprint|appliedCustomAgentInstructionsFingerprint|providerId|sessionId|url|path|command|operations|transactions|pointer|table|args|settingsPatch|unsetSettingKeys|type|status|http|error)$/i;
  const DEEP_REDACT = /text|content|message|prompt|instruction|credential|token|authorization|cookie|secret|password|title|description|name|email|user/i;
  function deepDebugEnabled() {
    try { return localStorage.getItem(DEEP_DEBUG_KEY) === '1'; } catch (e) { return false; }
  }
  function deepClean(v, depth) {
    if (v == null || typeof v !== 'object') return typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    if (depth > 10) return '[depth]';
    if (Array.isArray(v)) return v.slice(0, 100).map((x) => deepClean(x, depth + 1));
    const out = {};
    Object.keys(v).forEach((k) => {
      if (DEEP_REDACT.test(k)) { out[k] = '[redacted]'; return; }
      if (DEEP_KEEP.test(k) || typeof v[k] === 'object') out[k] = deepClean(v[k], depth + 1);
    });
    return out;
  }
  function deepPush(entry) {
    if (!deepDebugEnabled()) return;
    entry.at = new Date().toISOString();
    deepDebugLog.push(entry);
    if (deepDebugLog.length > 250) deepDebugLog.shift();
    console.log('[Notion Effort DEEP]', entry.kind, entry.url, entry.status || '', entry.body || entry.fields || '');
  }
  function deepRequest(url, opts) {
    if (!deepDebugEnabled() || !DEEP_RE.test(url)) return;
    let body = null;
    try { body = opts && typeof opts.body === 'string' ? deepClean(JSON.parse(opts.body), 0) : null; } catch (e) { body = '[unparsed]'; }
    deepPush({ kind: 'request', url: url.replace(location.origin, ''), body: body });
  }
  function deepResponse(url, res) {
    if (!deepDebugEnabled() || !DEEP_RE.test(url) || !res) return;
    const entry = { kind: 'response', url: url.replace(location.origin, ''), status: res.status };
    deepPush(entry);
    try {
      res.clone().text().then((text) => {
        let fields = null;
        try { fields = deepClean(JSON.parse(text), 0); } catch (e) { fields = text.slice(0, 500); }
        deepPush({ kind: 'response-body', url: url.replace(location.origin, ''), status: res.status, fields: fields });
      }).catch(() => {});
    } catch (e) {}
  }
  window.__notionEffortDeepDebug = function (on) {
    try { localStorage.setItem(DEEP_DEBUG_KEY, on === false ? '0' : '1'); } catch (e) {}
    console.log('[Notion Effort] deep debug ' + (on === false ? 'OFF' : 'ON — now repeat the native model actions, then run __notionEffortDeepDebugDump()'));
  };
  window.__notionEffortDeepDebugDump = function () {
    const dump = JSON.stringify({ version: '2.67', at: new Date().toISOString(), url: location.href, entries: deepDebugLog }, null, 2);
    const blob = new Blob([dump], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'notion-deep-debug-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return dump;
  };

  // ---- Onboarding chat finder ---------------------------------------------
  //
  // The onboarding chat ("Welcome to Notion") is a classic chat. Thread
  // records passing through chat-list / record responses are scanned for it,
  // and the panel's "Find onboarding chat" button opens the best match.
  // Read-only: at most it repeats the chat-list request Notion itself sent.
  const THREAD_LIST_URL = /\/api\/v3\/(getInferenceTranscriptsForUser|syncRecordValues)/;
  const ONBOARD_RE = /onboard|unboxing|briefing|welcome to notion|добро пожаловать/i;
  const STRONG_RE = /onboard|unboxing|briefing/i;
  const onboardingThreads = {};
  window.__notionEffortOnboarding = onboardingThreads;
  let lastThreadList = null; // { path, spaceId, body }: Notion's own last chat-list request

  function noteThreadListRequest(url, opts) {
    if (!/getInferenceTranscriptsForUser/.test(url) || !opts || typeof opts.body !== 'string') return;
    try {
      const body = JSON.parse(opts.body);
      let spaceId = body.spaceId || null;
      if (!spaceId && opts.headers) {
        try { spaceId = new Headers(opts.headers).get('x-notion-space-id'); } catch (e) {}
      }
      lastThreadList = { path: url.replace(location.origin, '').split('#')[0], spaceId: spaceId, body: body };
    } catch (e) {}
  }

  function findRecords(node, path, depth, out) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (!Array.isArray(node) && typeof node.id === 'string' && UUID.test(node.id)) out.push({ node: node, path: path });
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) findRecords(node[k], path + '/' + k, depth + 1, out);
  }

  /** Short string values of this record itself, not of records nested in it. */
  function ownStrings(node, depth, out) {
    if (!node || typeof node !== 'object' || depth > 3) return out;
    Object.keys(node).slice(0, 80).forEach((k) => {
      const v = node[k];
      if (typeof v === 'string') { if (v.length <= 120) out.push(v); }
      else if (v && typeof v === 'object' && !(v.id && !Array.isArray(v))) ownStrings(v, depth + 1, out);
    });
    return out;
  }

  // Thread records in a response: recordMap.thread.<id>.value(.value) or,
  // in a chat list, its top-level items (not the steps nested inside them).
  function threadRecords(json, fromList) {
    const found = [];
    findRecords(json, '', 0, found);
    return found.filter((f) => /\/thread\//.test(f.path) || (fromList && f.path.split('/').length <= 5));
  }

  // Short shape of the last chat-list responses, for __notionEffortChatList().
  const chatListSeen = [];
  function noteChatList(json, url) {
    const recs = threadRecords(json, true);
    chatListSeen.push({
      at: new Date().toISOString().slice(11, 19),
      url: shortUrl(url),
      topKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 20) : typeof json,
      records: recs.length,
      sample: recs.slice(0, 40).map((f) => ({
        id: plainId(f.node.id),
        path: f.path.replace(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi, '<id>').slice(0, 80),
        keys: Object.keys(f.node).slice(0, 25),
        strings: ownStrings(f.node, 0, []).slice(0, 8).map((s) => s.slice(0, 60)),
      })),
    });
    if (chatListSeen.length > 5) chatListSeen.shift();
  }
  window.__notionEffortChatList = function () {
    return JSON.stringify({ onboarding: onboardingThreads, lists: chatListSeen }, null, 2);
  };

  function scanForOnboarding(json, fromList) {
    threadRecords(json, fromList).forEach((f) => {
      const words = ownStrings(f.node, 0, []);
      const hit = words.find((w) => ONBOARD_RE.test(w));
      if (!hit) return;
      const key = plainId(f.node.id);
      const prev = onboardingThreads[key];
      onboardingThreads[key] = {
        id: key,
        title: typeof f.node.title === 'string' ? f.node.title : (prev && prev.title) || hit.slice(0, 80),
        strong: words.some((w) => STRONG_RE.test(w)) || !!(prev && prev.strong),
        at: Number(f.node.created_time || f.node.createdAt || f.node.last_edited_time || 0) || (prev && prev.at) || 0,
        path: f.path.slice(0, 120),
      };
    });
  }

  function watchThreadList(response) {
    if (!response || !response.ok) return Promise.resolve();
    const fromList = /getInferenceTranscriptsForUser/.test(response.url || '');
    return response.clone().text().then((text) => {
      if (!fromList && !ONBOARD_RE.test(text)) return;
      const json = JSON.parse(text);
      if (fromList) noteChatList(json, response.url);
      if (ONBOARD_RE.test(text)) scanForOnboarding(json, fromList);
    }).catch(() => {});
  }

  function bestOnboarding() {
    const all = Object.keys(onboardingThreads).map((k) => onboardingThreads[k]);
    all.sort((a, b) => (Number(b.strong) - Number(a.strong)) || (b.at - a.at));
    return all[0] || null;
  }

  function publishOnboarding(reason, stats) {
    const best = bestOnboarding();
    window.postMessage({
      type: 'NOTION_EFFORT_ONBOARDING',
      pages: stats ? stats.pages : null,
      total: stats ? stats.records : null,
      found: !!best,
      id: best ? best.id : null,
      title: best ? best.title : null,
      count: Object.keys(onboardingThreads).length,
      listed: chatListSeen.length ? chatListSeen[chatListSeen.length - 1].records : null,
      reason: best ? null : reason,
    }, '*');
  }

  // Next-page token of a chat-list answer, whatever Notion calls it.
  function listCursorOf(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    if (json.hasMore === false || json.has_more === false) return null;
    const keys = Object.keys(json);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (/cursor/i.test(k) && json[k] != null && json[k] !== '') return { key: k, value: json[k] };
    }
    return null;
  }

  // Every page of the chat list, in every workspace seen: Notion itself only
  // loads the newest few, and the onboarding chat is one of the oldest.
  // Replays Notion's own list request (bigger page, next cursor).
  async function readAllChatLists() {
    const base = lastThreadList;
    const stats = { pages: 0, records: 0 };
    const hasSpace = base.body && typeof base.body === 'object' && 'spaceId' in base.body;
    const spaces = [base.spaceId].concat(Object.keys(headersBySpace)).filter(Boolean).map(dashedId)
      .filter((s, i, a) => a.findIndex((x) => plainId(x) === plainId(s)) === i);
    if (!spaces.length) spaces.push(null);
    for (let s = 0; s < spaces.length; s++) {
      if (s > 0 && !hasSpace) break;
      const sid = spaces[s];
      let body = cloneJson(base.body || {});
      if (hasSpace && sid) body.spaceId = sid;
      if (typeof body.limit === 'number') body.limit = Math.max(body.limit, 100);
      const cursorKey = Object.keys(body).find((k) => /cursor/i.test(k)) || null;
      for (let p = 0; p < 15; p++) {
        let json;
        try {
          json = await apiPost('chat list', sid, base.path, body);
        } catch (e) {
          trace('onboarding', 'chat list read failed in ' + plainId(sid).slice(0, 8) + ': ' + String((e && e.message) || e).slice(0, 120));
          break;
        }
        stats.pages++;
        stats.records += threadRecords(json, true).length;
        noteChatList(json, base.path);
        scanForOnboarding(json, true);
        if (bestOnboarding()) return stats;
        const c = listCursorOf(json);
        if (!c) break;
        const key = cursorKey || c.key;
        if (JSON.stringify(body[key]) === JSON.stringify(c.value)) break;
        body = Object.assign({}, body);
        body[key] = c.value;
      }
    }
    return stats;
  }

  let findingOnboarding = false;
  async function findOnboarding() {
    if (bestOnboarding()) { publishOnboarding(null); return; }
    if (!lastThreadList) {
      trace('onboarding', 'Notion has not loaded a chat list in this tab yet: nothing to search');
      publishOnboarding('no-list');
      return;
    }
    if (findingOnboarding) return;
    findingOnboarding = true;
    let stats = { pages: 0, records: 0 };
    try {
      stats = await readAllChatLists();
    } catch (e) {
      console.warn('[Notion Effort] chat list re-read failed:', e && e.message);
    } finally {
      findingOnboarding = false;
    }
    const best = bestOnboarding();
    trace('onboarding', best
      ? 'found ' + best.id.slice(0, 8) + ' after ' + stats.pages + ' list pages'
      : 'not found in ' + stats.records + ' chats over ' + stats.pages + ' list pages');
    publishOnboarding(best ? null : 'not-in-list', stats);
  }


  // ---- Create a classic chat ------------------------------------------------
  //
  // "Create old AI chat" makes a new classic chat itself: one
  // runInferenceTranscript with a fresh threadId and createThread: true. The
  // body comes from the last classic request seen in this browser (its config
  // and context steps only, no message text), or from a default body when none
  // was seen yet. The first message is the one typed in the panel. Effort (and
  // the picked model) go in through the usual patch. The answer stream is read
  // to the end so the server finishes the thread; then the panel opens it.
  const OLD_TEMPLATE_KEY = 'notionEffortOldChatTemplate';
  const OLD_CREATE_TIMEOUT = 120000;

  function cloneJson(v) {
    return JSON.parse(JSON.stringify(v));
  }

  function rememberOldChatTemplate(url, body) {
    try {
      if (creatingOldChat || window.top !== window) return;
      if (!/runInferenceTranscript/i.test(String(url || ''))) return;
      if (!body || !Array.isArray(body.transcript)) return;
      const isStep = (t) => (s) => s && s.type === t && s.value && typeof s.value === 'object';
      const config = body.transcript.find(isStep('config'));
      if (!config) return;
      const context = body.transcript.find(isStep('context')) || null;
      const top = {};
      Object.keys(body).forEach((k) => { if (k !== 'transcript') top[k] = body[k]; });
      localStorage.setItem(OLD_TEMPLATE_KEY, JSON.stringify({
        path: shortUrl(url) || '/api/v3/runInferenceTranscript',
        savedAt: new Date().toISOString(),
        spaceId: body.spaceId || currentSpaceId() || null,
        top: cloneJson(top),
        config: cloneJson(config),
        context: context ? cloneJson(context) : null,
      }));
    } catch (e) {}
  }

  function loadOldChatTemplate() {
    try {
      const t = JSON.parse(localStorage.getItem(OLD_TEMPLATE_KEY) || 'null');
      return t && t.config && t.config.value && t.top ? t : null;
    } catch (e) {
      return null;
    }
  }
  window.__notionEffortOldChatTemplate = loadOldChatTemplate;

  // Who is signed in and the ids/names Notion puts into the context step.
  async function oldChatSession(spaceId) {
    const res = await effortFetch(location.origin + '/api/v3/getSpaces', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const json = await res.json();
    let pick = null;
    Object.keys(json || {}).forEach((uid) => {
      const acc = json[uid] || {};
      const has = !!spaceId && Object.keys(acc.space || {}).some((k) => plainId(k) === plainId(spaceId));
      if (!pick || (has && !pick.has)) pick = { uid: uid, acc: acc, has: has };
    });
    if (!pick) return null;
    const acc = pick.acc;
    const sid = spaceId || Object.keys(acc.space || {})[0] || null;
    const spaceKey = Object.keys(acc.space || {}).find((k) => plainId(k) === plainId(sid));
    const user = unwrapRecord((acc.notion_user || {})[pick.uid]) || {};
    const space = (spaceKey && unwrapRecord(acc.space[spaceKey])) || {};
    let spaceViewId = null;
    Object.keys(acc.space_view || {}).forEach((k) => {
      const v = unwrapRecord(acc.space_view[k]);
      if (v && v.space_id && plainId(v.space_id) === plainId(sid)) spaceViewId = v.id || k;
    });
    return {
      userId: pick.uid,
      spaceId: sid,
      userName: user.name || null,
      userEmail: user.email || null,
      spaceName: space.name || null,
      spaceViewId: spaceViewId,
    };
  }

  function buildOldChatBody(tpl, kind, spaceId, threadId, text, who) {
    const now = new Date().toISOString();
    const uid = who && who.userId;
    const sameSpace = !!tpl && plainId(tpl.spaceId) === plainId(spaceId);

    const config = tpl ? cloneJson(tpl.config) : {
      type: 'config',
      value: {
        type: kind,
        useWebSearch: true,
        useReadOnlyMode: false,
        writerMode: false,
        isCustomAgent: false,
        enableCreateAndRunThread: true,
      },
    };
    config.id = crypto.randomUUID();
    if (settings.model) {
      config.value.model = settings.model;
      if (!tpl || 'modelFromUser' in config.value) config.value.modelFromUser = true;
    }

    const context = tpl && tpl.context ? cloneJson(tpl.context) : { type: 'context', value: {} };
    context.id = crypto.randomUUID();
    const cv = context.value;
    if (!sameSpace) {
      cv.spaceId = spaceId;
      if (uid) cv.userId = uid;
      if (who && who.userName) cv.userName = who.userName;
      if (who && who.userEmail && (!tpl || 'userEmail' in cv)) cv.userEmail = who.userEmail;
      if (who && who.spaceName) cv.spaceName = who.spaceName;
      if (who && who.spaceViewId) cv.spaceViewId = who.spaceViewId;
    }
    if (!tpl || 'currentDatetime' in cv) cv.currentDatetime = now;
    if (!cv.timezone) {
      try { cv.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    }
    if (!tpl) cv.surface = 'ai_module';

    const user = { id: crypto.randomUUID(), type: 'user', value: [[text]], createdAt: now };
    if (uid) user.userId = uid;

    const body = tpl ? cloneJson(tpl.top) : {
      threadParentPointer: { table: 'space', id: spaceId, spaceId: spaceId },
      generateTitle: true,
      saveAllThreadOperations: true,
      setUnreadState: true,
      isPartialTranscript: true,
      asPatchResponse: true,
      threadType: kind,
    };
    body.traceId = crypto.randomUUID();
    body.spaceId = spaceId;
    body.threadId = threadId;
    body.createThread = true;
    if (!tpl || 'generateTitle' in body) body.generateTitle = true;
    const ptr = body.threadParentPointer;
    if (ptr && typeof ptr === 'object' && !sameSpace) {
      if (ptr.table === 'space') ptr.id = spaceId;
      if ('spaceId' in ptr) ptr.spaceId = spaceId;
    }
    body.transcript = [config, context, user];
    return body;
  }

  /** Short error text from one ndjson line of the answer (never answer text). */
  function oldStreamError(line) {
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== 'object' || (o.type !== 'error' && !o.error)) return null;
      const m = o.message || (o.error && (o.error.message || o.error.name || o.error)) || o.type;
      return String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 200);
    } catch (e) {
      return null;
    }
  }

  async function drainOldChatStream(res) {
    const out = { lines: 0, error: null, timedOut: false, shapes: [] };
    if (!res.body || !res.body.getReader) {
      await res.text().catch(() => '');
      return out;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const until = Date.now() + OLD_CREATE_TIMEOUT;
    let buf = '';
    const take = (line) => {
      line = line.trim();
      if (!line) return;
      out.lines++;
      if (out.shapes.length < 6) out.shapes.push(oldLineShape(line));
      if (!out.error) out.error = oldStreamError(line);
    };
    for (;;) {
      const left = until - Date.now();
      const step = left > 0
        ? await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), left))])
        : null;
      if (!step) {
        out.timedOut = true;
        reader.cancel().catch(() => {});
        break;
      }
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        take(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    take(buf);
    return out;
  }

  // The created chat is only real once its thread record can be read back.
  // Looked up in the send's workspace first, then in every other one seen,
  // a few times (the server may save it a moment after the answer).
  let lastOldChatAttempts = [];
  window.__notionEffortOldChatDiag = function () {
    return JSON.stringify(lastOldChatAttempts, null, 2);
  };
  async function findThreadRecord(threadId, spaceId) {
    const id = dashedId(threadId);
    const spaces = [dashedId(spaceId)].concat(
      Object.keys(headersBySpace).map(dashedId).filter((s) => plainId(s) !== plainId(spaceId))
    );
    const waits = [0, 1500, 4000];
    for (let w = 0; w < waits.length; w++) {
      if (waits[w]) await new Promise((r) => setTimeout(r, waits[w]));
      for (let i = 0; i < spaces.length; i++) {
        const sid = spaces[i];
        try {
          const json = await apiPost('read new chat', sid, '/api/v3/syncRecordValues', {
            requests: [{ pointer: { table: 'thread', id: id, spaceId: sid }, version: -1 }],
          });
          const t = json && json.recordMap && json.recordMap.thread;
          const k = t && Object.keys(t)[0];
          const v = k && unwrapRecord(t[k]);
          if (v && v.id) {
            return {
              space: v.space_id || sid,
              type: v.type || (v.data && v.data.type) || null,
              parent: v.parent_table ? v.parent_table + ':' + plainId(v.parent_id).slice(0, 8) : null,
              alive: v.alive !== false,
            };
          }
        } catch (e) {}
      }
    }
    return null;
  }

  /** Keys and type of one answer line, never its text. */
  function oldLineShape(line) {
    try {
      const o = JSON.parse(line);
      if (!o || typeof o !== 'object') return typeof o;
      return Object.keys(o).slice(0, 8).join(',') + (typeof o.type === 'string' ? ' =' + o.type.slice(0, 40) : '');
    } catch (e) {
      return 'not JSON';
    }
  }

  async function createOldChat(text) {
    const report = (o) => window.postMessage(Object.assign({ type: 'NOTION_EFFORT_OLD_CHAT_CREATE' }, o), '*');
    if (window.top !== window) return;
    if (creatingOldChat) { report({ status: 'busy' }); return; }
    creatingOldChat = true;
    const tpl = loadOldChatTemplate();
    try {
      text = String(text || '').trim() || 'Hi';
      report({ status: 'sending' });
      let spaceId = currentSpaceId() || (tpl && tpl.spaceId) || null;
      const who = await oldChatSession(spaceId).catch(() => null);
      if (!spaceId && who) spaceId = who.spaceId;
      if (!spaceId) throw new Error('workspace not known yet, open any Notion page in this tab and try again');
      spaceId = dashedId(spaceId);
      // Order: the saved classic request (exactly what Notion sent), then the
      // default body, the type that worked last time first. An attempt counts
      // only when the thread record can be read back: a 200 answer alone has
      // opened dead links ("You don't have access to this chat").
      const KIND_KEY = 'notionEffortOldChatKind';
      let goodKind = null;
      try { goodKind = localStorage.getItem(KIND_KEY); } catch (e) {}
      const defaults = ['markdown-chat', 'workflow'];
      const gi = goodKind ? defaults.indexOf(goodKind) : -1;
      if (gi > 0) defaults.unshift(defaults.splice(gi, 1)[0]);
      const kinds = tpl ? [null].concat(defaults) : defaults;
      let lastErr = null;
      const attempts = [];
      lastOldChatAttempts = attempts;
      for (let k = 0; k < kinds.length; k++) {
        const kind = kinds[k];
        const way = kind || 'saved request';
        const threadId = crypto.randomUUID();
        const body = buildOldChatBody(kind ? null : tpl, kind, spaceId, threadId, text, who);
        const h = headersFor(spaceId);
        h.set('accept', 'application/x-ndjson');
        h.set('notion-audit-log-platform', 'web');
        if (who && who.userId) h.set('x-notion-active-user-header', who.userId);
        trace('old chat', 'create ' + plainId(threadId).slice(0, 8) + ' via ' +
          (!kind ? 'saved classic request (' + String(tpl.savedAt || '').slice(0, 16) + ')' : 'default body, type ' + kind) +
          ' · model ' + modelLabel(settings.model) + ' · effort ' + (settings.effort || 'Auto'));
        const path = (!kind && tpl.path) || '/api/v3/runInferenceTranscript';
        const attempt = { way: way, thread: plainId(threadId), space: plainId(spaceId), http: null, lines: 0, shapes: [], error: null, record: null };
        attempts.push(attempt);
        const res = await effortFetch(location.origin + path, {
          method: 'POST', credentials: 'include', headers: h, body: JSON.stringify(body),
        });
        attempt.http = res.status;
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          lastErr = 'HTTP ' + res.status + ' ' + t.slice(0, 200);
          attempt.error = lastErr;
          trace('old chat', 'create FAILED (' + way + '): ' + lastErr);
          continue;
        }
        report({ status: 'answering', id: plainId(threadId) });
        const r = await drainOldChatStream(res);
        attempt.lines = r.lines;
        attempt.shapes = r.shapes;
        attempt.error = r.error;
        report({ status: 'verifying', id: plainId(threadId) });
        const rec = await findThreadRecord(threadId, spaceId);
        attempt.record = rec;
        if (!rec) {
          lastErr = r.error
            ? 'Notion refused: ' + r.error
            : 'Notion answered (' + r.lines + ' lines) but did not save the chat';
          trace('old chat', 'NOT saved (' + way + '): ' + lastErr + (r.shapes.length ? ' · answer: ' + r.shapes.join(' | ') : ''));
          continue;
        }
        if (kind) {
          try { localStorage.setItem(KIND_KEY, kind); } catch (e) {}
        }
        trace('old chat', 'created ✓ ' + plainId(threadId).slice(0, 8) + ' (' + way + ') · saved as ' + (rec.type || '?') +
          (rec.parent ? ' under ' + rec.parent : '') + ' in workspace ' + plainId(rec.space).slice(0, 8) +
          (r.timedOut ? ' · answer still running after ' + OLD_CREATE_TIMEOUT / 1000 + ' s' : ''));
        report({
          status: 'created', id: plainId(threadId), lines: r.lines, timedOut: r.timedOut,
          fromTemplate: !kind, recordType: rec.type || null,
        });
        return;
      }
      report({
        status: 'failed', error: lastErr, fromTemplate: !!tpl,
        tried: attempts.map((a) => a.way + ': ' + (a.http && a.http !== 200 ? 'HTTP ' + a.http : a.error ? 'refused' : 'not saved')).join(' · '),
      });
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      trace('old chat', 'create FAILED: ' + msg);
      report({ status: 'failed', error: msg, fromTemplate: !!tpl });
    } finally {
      creatingOldChat = false;
    }
  }

  const effortFetch = window.fetch;
  window.fetch = function (...args) {
    let url = '';
    try { url = urlOf(args[0]); } catch (e) {}
    const opts = args[1];
    deepRequest(url, opts);
    const watch = (p) => {
      p.then((res) => deepResponse(url, res), () => {});
      if (AGENT_RECORD_URL.test(url)) p.then(watchAgentResponse, () => {});
      if (THREAD_LIST_URL.test(url)) {
        noteThreadListRequest(url, opts);
        p.then(watchThreadList, () => {});
      }
      if (PREF_URL.test(url)) p.then(watchPrefResponse, () => {});
      return p;
    };
    if (AGENT_SEND_URL.test(url.split('?')[0]) && opts && typeof opts.body === 'string') {
      try {
        const b = JSON.parse(opts.body);
        const t = b.threadId || (b.thread && b.thread.id);
        if (t) activeThreadKey = plainId(t);
        if (b.spaceId) agentSpaceId = dashedId(b.spaceId);
      } catch (e) {}
    }
    const path = url.split('?')[0];
    if (/\/api\/v3\//.test(path) && opts) noteApiRequest(opts);
    if (/saveTransactions(Fanout)?$/.test(path) && opts && typeof opts.body === 'string') noteForeignTx(opts.body);
    // Notion loads the chat transcript with its own getThreadTranscript body
    // shape — capture it so __notionEffortExportChat can replay it verbatim.
    if (/getThreadTranscript/.test(path) && opts && typeof opts.body === 'string') transcriptBodyTemplate = opts.body;
    // Chat sends carry the user's text; a codename in there is not a setting.
    if (/\/api\//.test(path) && !PROBE_SKIP.test(path) && opts && typeof opts.body === 'string') {
      const self = this;
      const p = watch(effortFetch.apply(self, args));
      noteModelSetting(path.replace(location.origin, ''), opts.body, p);
      noteLimits(path.replace(location.origin, ''), p);
      return p;
    }
    // Before the message goes out: the policy (Auto picks the model for this
    // very message) and, on an existing thread, the effort. A new thread's
    // record does not exist until createAgentThread returns, so its effort is
    // written after.
    if (AGENT_SEND_URL.test(path) && opts && typeof opts.body === 'string' &&
        (watchOnly || !(settings.effort || settings.model || hasBackups()))) {
      trace('send', (/createAgentThread$/.test(path) ? 'new chat' : 'chat') + (watchOnly ? ' · watch only: sent as is' : ' · nothing picked: sent as is'));
      return watch(watchSend(this, args, opts, /createAgentThread$/.test(path)));
    }
    if ((settings.effort || settings.model || hasBackups()) && AGENT_SEND_URL.test(path) && opts && typeof opts.body === 'string') {
      const self = this;
      const isNew = /createAgentThread$/.test(path);
      let policyDone;
      const afterPolicy = new Promise((r) => { policyDone = r; });
      startRun(opts.body, isNew, afterPolicy);
      const th = threadOf(opts.body);
      const t0 = Date.now();
      const wantEff = settings.effort
        ? (agentTargetEffort(settings.model || (th && (agentThreads[th.key] || {}).model)) || 'none')
        : "Notion's";
      // createAgentThread carries no model fields, so message #1 runs on the
      // server's model before any thread record exists to pin. Inject the pick
      // into the create body; if the server refuses the fields, the retry below
      // sends the original body so the message is not lost.
      const origBody = opts.body;
      let variants = [];
      if (settings.model && !watchOnly) {
        try {
          const b = JSON.parse(origBody);
          if (isNew) {
            // createAgentThread carries no model fields: inject the pick so
            // message #1 does not run on the server's model. The create schema
            // took model + string 'selected' (HTTP 200, v2.29).
            b.model = settings.model;
            b.modelSelection = learnedSelection || 'selected';
            if (settings.effort) b.reasoningEffort = agentTargetEffort(settings.model) || undefined;
            variants = [
              { text: JSON.stringify(b), label: 'create with injected pick' },
              { text: origBody, label: 'original create body' },
            ];
            trace('body', 'create: injected model=' + settings.model + ' modelSelection=' + b.modelSelection +
              (b.reasoningEffort ? ' reasoningEffort=' + b.reasoningEffort : ''));
          } else {
            // sendEventToAgentThread carries the native picker's state and the
            // router obeys it. The picked shape is learned (a native hand-pick
            // or a probe that came back 200); until then the send walks the
            // candidate list and ends with the original body.
            learnPickTemplate(b);
            if (isBadSend(b.spaceId)) {
              variants = [{ text: origBody, label: 'original body (auto)' }];
              trace('body', 'send: picked-model bodies were refused in this workspace before — sending as Notion made it (record stays pinned)');
            } else {
              variants = sendVariants(origBody, settings.model, settings.effort);
            }
            trace('body', 'native send body: ' + describeBody(origBody));
            if (variants.length > 1) {
              trace('body', 'send: native picker on automatic — trying ' + variants[0].label +
                (variants.length > 2 ? ' (' + (variants.length - 1) + ' variants before the original body)' : ''));
            }
          }
        } catch (e) {}
      } else if (settings.effort && !watchOnly && !isNew) {
        // No model picked, but an effort is: probe the effort-only body shapes
        // (legacy schema first), ending with the untouched original.
        try {
          variants = sendVariants(origBody, null, settings.effort).filter((v) =>
            /effort|original/.test(v.label));
          if (variants.length) trace('body', 'send: effort-only walk — ' + variants[0].label + ' first');
        } catch (e) {}
      } else if (settings.effort && !watchOnly) {
        // No model picked, effort picked (Auto + max): the model is whatever
        // the router chooses, so only the effort goes into the body.
        try {
          const b = JSON.parse(origBody);
          const knownModel = th && (agentThreads[th.key] || {}).model;
          const eff = agentTargetEffort(settings.model || knownModel) || settings.effort;
          if (isNew) {
            b.reasoningEffort = eff;
            variants = [
              { text: JSON.stringify(b), label: 'create with effort only' },
              { text: origBody, label: 'original create body' },
            ];
            trace('body', 'create: injected reasoningEffort=' + eff);
          } else {
            const shapes = [];
            const a = JSON.parse(origBody); a.reasoningEffort = eff; shapes.push({ text: JSON.stringify(a), label: 'auto + effort=' + eff + ' (top-level)' });
            const c = JSON.parse(origBody); c.modelSelection = { type: 'automatic', reasoningEffort: eff }; c.reasoningEffort = eff; shapes.push({ text: JSON.stringify(c), label: 'auto + effort=' + eff + ' (inside selection)' });
            shapes.push({ text: origBody, label: 'original body (auto)' });
            variants = shapes;
          }
        } catch (e) {}
      }
      if (variants.length) opts.body = variants[0].text;
      trace('send', (isNew ? 'new chat' : 'chat ' + (th ? th.key.slice(0, 8) : '?')) +
        ' · want ' + modelLabel(settings.model) + ' / ' + wantEff + ' effort');
      trace('body', modelFieldsOf(opts.body));
      const before = [withTimeout(ensurePolicy(th && th.spaceId, true).catch(() => {}), 4000).then((r) => {
        trace('wait', r === TIMED_OUT
          ? 'policy not confirmed within 4 s: message sent anyway (may run on the old list)'
          : 'policy checked in ' + (Date.now() - t0) + ' ms');
        policyDone();
      })];
      if (!isNew) {
        before.push(withTimeout(ensureThreadEffort(args[0], opts, opts.body)
          .catch((e) => trace('effort', 'chat write error: ' + String(e.message || e))), 4000));
      }
      return Promise.all(before).then(() => {
        // The walk: try each variant until one comes back 200; refusals are
        // traced with the server's own field-level message. The last variant is
        // always the untouched original body, so the message is delivered
        // whatever the schema turns out to be.
        const run = (i) => {
          const v = variants[i];
          // Each attempt must send ITS body: args[1].body was set once above,
          // so without this every "variant" (including the original body)
          // resends variants[0] and the walk is an illusion.
          const callArgs = args.slice();
          callArgs[1] = Object.assign({}, opts, { body: v.text });
          const p = watch(effortFetch.apply(self, callArgs));
          return p.then((res) => {
            if (res && res.status !== 200 && i < variants.length - 1) {
              logRefusal(res, v.label + ' refused (HTTP ' + res.status + ')');
              return run(i + 1);
            }
            if (res && res.status === 200 && !isNew && i < variants.length - 1) rememberWinner(v.text, v.label);
            return res;
          });
        };
        const p = variants.length ? run(0) : watch(effortFetch.apply(self, args));
        p.then((res) => {
          trace('sent', 'Notion answered HTTP ' + (res && res.status));
          if (res) traceStream(res);
          if (!res || !res.ok) {
            // Every candidate, including the untouched original body, was refused:
            // the message was not delivered. Surface it so the user can retry.
            const runObj = th ? runByThread[th.key] : null;
            if (runObj) { runObj.error = 'send refused on every body variant (HTTP ' + (res && res.status) + '): message not delivered'; publishRuns(); }
            if (!isNew && variants.length > 2 && th) {
              markBadSend(th.spaceId);
              trace('send', 'marking this workspace: picked-model bodies are not accepted here');
            }
            return;
          }
          if (isNew) ensureThreadEffort(args[0], opts, opts.body).catch(() => {});
          rereadAfterSend(args[0], opts, opts.body);
        }, () => {});
        return p;
      });
    }
    return watch(effortFetch.apply(this, args));
  };

  // __notionEffortPinCustomAgentThread(threadId?, modelId?, effort?) — set the
  // Custom Agent override on an ALREADY CREATED thread, then read it back.
  // Run this after a native first message and before the follow-up.
  window.__notionEffortPinCustomAgentThread = async function (threadId, modelId, effort) {
    if (!threadId) {
      const m = location.href.match(/[?&]t=([0-9a-f]{32})/i);
      threadId = m && m[1] ? (m[1].slice(0, 8) + '-' + m[1].slice(8, 12) + '-' + m[1].slice(12, 16) + '-' + m[1].slice(16, 20) + '-' + m[1].slice(20)) : null;
    }
    if (!threadId) throw new Error('Open the Custom Agent chat first or pass threadId');
    modelId = modelId || 'albuquerque-quinn';
    effort = effort || 'max';
    const sid = agentSpaceId || currentSpaceId();
    if (!sid) throw new Error('Workspace not known yet');
    await apiPost('pin custom thread override', sid, '/api/v3/saveTransactionsFanout', {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(), spaceId: sid,
        debug: { userAction: 'NotionEffort.pinCustomAgentThread', clientCommitTimeMs: Date.now() },
        operations: [{
          pointer: { table: 'thread', id: threadId, spaceId: sid },
          command: 'update', path: ['data', 'agent_provider'],
          args: {
            model: modelId, reasoningEffort: effort, modelSelection: 'explicit',
            customAgentModelSelectionOverride: 'explicit',
          },
        }],
      }],
    });
    const check = await apiPost('verify custom thread override', sid, '/api/v3/syncRecordValuesSpaceInitial', {
      requests: [{ pointer: { table: 'thread', id: threadId, spaceId: sid }, version: -1 }],
      spacePointer: { table: 'space', id: sid },
    });
    const threads = check.recordMap.thread || {};
    const recordKey = Object.keys(threads).find((key) => plainId(key) === plainId(threadId));
    const record = recordKey ? threads[recordKey] : null;
    const recordValue = record && record.value;
    const data = recordValue && recordValue.value ? recordValue.value : recordValue;
    const provider = data && data.data ? data.data.agent_provider : data && data.agent_provider;
    console.log('[Notion Effort] custom thread override after write:', provider);
    if (!provider) {
      console.warn('[Notion Effort] custom thread read-back:', { threadId: threadId, spaceId: sid, returnedThreadKeys: Object.keys(threads), record: record });
    }
    if (!provider || provider.model !== modelId || provider.customAgentModelSelectionOverride !== 'explicit') {
      throw new Error('Server did not preserve the custom thread override');
    }
    console.log('[Notion Effort] custom thread pinned — now send a FOLLOW-UP in this chat and inspect the actual model');
    return provider;
  };

  // __notionEffortSetAgentRuntimeModel(workflowId, mode?) — try the runtime
  // fields on the agent's PUBLISHED workflow_artifact. mode="agentService"
  // (default) writes data.agentService.model; mode="config_overrides" writes
  // data.config_overrides.model. The original value is backed up in
  // localStorage and can be restored with __notionEffortRestoreAgentRuntime().
  window.__notionEffortSetAgentRuntimeModel = async function (workflowId, mode, modelId, effort) {
    if (!workflowId) throw new Error('Pass workflowId first, then optional mode/model/effort');
    mode = mode || 'agentService';
    if (mode !== 'agentService' && mode !== 'config_overrides') throw new Error('mode must be agentService or config_overrides');
    modelId = modelId || 'albuquerque-quinn';
    effort = effort || 'max';
    const sid = agentSpaceId || currentSpaceId();
    if (!sid) throw new Error('Workspace not known yet');
    const workflow = await apiPost('read workflow', sid, '/api/v3/syncRecordValuesSpaceInitial', {
      requests: [{ pointer: { table: 'workflow', id: workflowId, spaceId: sid }, version: -1 }],
      spacePointer: { table: 'space', id: sid },
    });
    const wf = workflow.recordMap.workflow[workflowId].value.value;
    const wfData = wf && wf.data ? wf.data : wf;
    const pointer = wfData && (wfData.published_artifact_pointer || wfData.draft_artifact_pointer);
    if (!pointer) {
      console.warn('[Notion Effort] workflow record:', wf);
      throw new Error('Agent has no published/draft artifact pointer in the returned workflow record');
    }
    if (!wfData.published_artifact_pointer) {
      console.warn('[Notion Effort] using the draft artifact because published_artifact_pointer is absent');
    }
    const backupKey = 'notionEffortAgentRuntimeBackup';
    const backups = JSON.parse(localStorage.getItem(backupKey) || '{}');
    const key = pointer.id + ':' + mode;
    if (!Object.prototype.hasOwnProperty.call(backups, key)) {
      backups[key] = { spaceId: sid, artifactId: pointer.id, workflowId: workflowId, mode: mode, value: wfData[mode] };
      localStorage.setItem(backupKey, JSON.stringify(backups));
    }
    // workflow_artifact is read-only for clients. The supported path is:
    // update workflow.data, then let Notion publish a fresh artifact itself.
    await apiPost('write runtime model', sid, '/api/v3/saveTransactionsFanout', {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(), spaceId: sid,
        debug: { userAction: 'NotionEffort.setAgentRuntimeModel', clientCommitTimeMs: Date.now() },
        operations: [{
          pointer: { table: 'workflow', id: workflowId, spaceId: sid },
          command: 'set', path: ['data', mode, 'model'],
          args: { type: modelId, reasoningEffort: effort },
        }],
      }],
    });
    await apiPost('publish runtime model', sid, '/api/v3/publishCustomAgentVersion', {
      workflowId: workflowId, spaceId: sid,
    });
    const updated = await apiPost('read published workflow', sid, '/api/v3/syncRecordValuesSpaceInitial', {
      requests: [{ pointer: { table: 'workflow', id: workflowId, spaceId: sid }, version: -1 }],
      spacePointer: { table: 'space', id: sid },
    });
    const updatedData = updated.recordMap.workflow[workflowId].value.value;
    const updatedPointer = updatedData.published_artifact_pointer || updatedData.draft_artifact_pointer || pointer;
    const check = await apiPost('verify runtime model', sid, '/api/v3/syncRecordValuesSpaceInitial', {
      requests: [{ pointer: { table: 'workflow_artifact', id: updatedPointer.id, spaceId: sid }, version: -1 }],
      spacePointer: { table: 'space', id: sid },
    });
    const artifactValue = check.recordMap.workflow_artifact[updatedPointer.id].value.value;
    const artifactData = artifactValue && artifactValue.data ? artifactValue.data : {};
    const saved = artifactData[mode] && artifactData[mode].model;
    if (!saved || saved.type !== modelId || saved.reasoningEffort !== effort) {
      console.warn('[Notion Effort] published artifact data:', artifactData);
      throw new Error('Publish did not preserve data.' + mode + '.model; saved value: ' + JSON.stringify(saved));
    }
    console.log('[Notion Effort] runtime model saved and published:', { mode: mode, artifactId: updatedPointer.id, model: saved }, '— now open a NEW chat with this agent');
    return saved;
  };
  window.__notionEffortRestoreAgentRuntime = async function (workflowId, mode) {
    mode = mode || 'agentService';
    const backupKey = 'notionEffortAgentRuntimeBackup';
    const backups = JSON.parse(localStorage.getItem(backupKey) || '{}');
    const entry = Object.values(backups).find((b) => b.workflowId === workflowId && b.mode === mode);
    if (!entry) throw new Error('No runtime backup for this agent/mode');
    const sid = entry.spaceId;
    await apiPost('restore runtime model', sid, '/api/v3/saveTransactionsFanout', {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(), spaceId: sid,
        operations: [{
          pointer: { table: 'workflow', id: workflowId, spaceId: sid },
          command: 'set', path: ['data', mode], args: entry.value || {},
        }],
      }],
    });
    await apiPost('republish restored runtime', sid, '/api/v3/publishCustomAgentVersion', {
      workflowId: workflowId, spaceId: sid,
    });
    delete backups[entry.artifactId + ':' + mode];
    localStorage.setItem(backupKey, JSON.stringify(backups));
    console.log('[Notion Effort] runtime field restored:', mode);
  };

  // __notionEffortBlockCustomAgentModel(modelId?) — add a model to the
  // workspace's CUSTOM-agent disabledModels only. Defaults to olive-jellyroll
  // (GPT-5.6 Luna). Personal chats and provider restrictions are untouched.
  // The original policy is backed up; restore with
  // __notionEffortRestoreCustomAgentPolicy().
  const CUSTOM_POLICY_KEY = 'custom_agent_model_policy';
  const CUSTOM_POLICY_BACKUP = 'notionEffortCustomAgentPolicyBackup';
  function customPolicyBackups() {
    try { return JSON.parse(localStorage.getItem(CUSTOM_POLICY_BACKUP) || '{}') || {}; } catch (e) { return {}; }
  }
  window.__notionEffortBlockCustomAgentModel = async function (modelId, spaceId) {
    modelId = modelId || 'olive-jellyroll';
    const sid = spaceId || agentSpaceId || currentSpaceId();
    if (!sid) throw new Error('Workspace not known yet — open a Notion chat first');
    const current = await readSpaceSetting(sid, CUSTOM_POLICY_KEY);
    const backups = customPolicyBackups();
    if (!Object.prototype.hasOwnProperty.call(backups, plainId(sid))) {
      backups[plainId(sid)] = current;
      try { localStorage.setItem(CUSTOM_POLICY_BACKUP, JSON.stringify(backups)); } catch (e) {}
    }
    const target = Object.assign({}, current || {}, {
      disabledModels: uniq(arr(current && current.disabledModels).concat([modelId])),
    });
    const json = await apiPost('block custom-agent model', sid, '/api/v3/updateSpaceSettings', {
      spaceId: sid, settingsPatch: { [CUSTOM_POLICY_KEY]: target }, unsetSettingKeys: [],
    });
    const after = findSpaceSetting(json, sid, CUSTOM_POLICY_KEY);
    if (!after || arr(after.disabledModels).indexOf(modelId) === -1) {
      throw new Error('Server did not store the block: ' + JSON.stringify(after));
    }
    console.log('[Notion Effort] custom agents blocked model:', modelId, '— now open a NEW chat with the agent');
    return after;
  };
  window.__notionEffortRestoreCustomAgentPolicy = async function (spaceId) {
    const sid = spaceId || agentSpaceId || currentSpaceId();
    const backups = customPolicyBackups();
    const key = plainId(sid || '');
    if (!Object.prototype.hasOwnProperty.call(backups, key)) {
      console.log('[Notion Effort] no custom-agent policy backup for this workspace');
      return null;
    }
    const target = backups[key];
    await apiPost('restore custom-agent policy', sid, '/api/v3/updateSpaceSettings', target
      ? { spaceId: sid, settingsPatch: { [CUSTOM_POLICY_KEY]: target }, unsetSettingKeys: [] }
      : { spaceId: sid, settingsPatch: {}, unsetSettingKeys: [CUSTOM_POLICY_KEY] });
    delete backups[key];
    try { localStorage.setItem(CUSTOM_POLICY_BACKUP, JSON.stringify(backups)); } catch (e) {}
    console.log('[Notion Effort] custom-agent policy restored');
    return target;
  };

  // __notionEffortSetAgentModel(modelId?, effort?, workflowId?) — pin a Custom
  // Agent's own model in workflow.data.model. Defaults: Opus 5.5 / max.
  // Run on the agent's settings page (/agent/<id>), or pass its workflow id.
  // Writes ONLY the workflow record, then verifies the saved value by reading
  // it back. No thread records or workspace policies are touched.
  window.__notionEffortSetAgentModel = async function (modelId, effort, workflowId) {
    modelId = modelId || 'albuquerque-quinn';
    effort = effort || 'max';
    const uuid = (value) => {
      const s = String(value == null ? '' : value).replace(/-/g, '').toLowerCase();
      return /^[0-9a-f]{32}$/.test(s)
        ? s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20)
        : null;
    };
    const match = location.pathname.match(/^\/agent\/([0-9a-f-]+)\/?$/i);
    const targetWorkflowId = uuid(workflowId || (match && match[1]));
    if (!targetWorkflowId) throw new Error('Open the agent settings at /agent/<id>, or pass workflowId as the third argument');
    const post = async (path, body, headers) => {
      const res = await effortFetch(location.origin + '/api/v3/' + path, {
        method: 'POST', credentials: 'include',
        headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(path + ': HTTP ' + res.status + ' ' + text.slice(0, 300));
      return text ? JSON.parse(text) : {};
    };
    const spaces = await post('getSpaces', {});
    const candidates = [];
    Object.entries(spaces).forEach(([userKey, account]) => {
      const userId = uuid(userKey);
      if (!userId) return;
      const userKeyInMap = Object.keys((account && account.notion_user) || {}).find((k) => uuid(k) === userId);
      const user = userKeyInMap && account.notion_user[userKeyInMap] && account.notion_user[userKeyInMap].value && account.notion_user[userKeyInMap].value.value || {};
      Object.entries((account && account.space) || {}).forEach(([spaceKey, spaceRecord]) => {
        const spaceId = uuid(spaceKey);
        if (!spaceId) return;
        candidates.push({
          userId: userId, spaceId: spaceId,
          user: user.email || user.name || userId,
          workspace: spaceRecord && spaceRecord.value && spaceRecord.value.value && spaceRecord.value.value.name || spaceId,
        });
      });
    });
    let found = null;
    const failures = [];
    for (const candidate of candidates) {
      const headers = { 'x-notion-active-user-header': candidate.userId, 'x-notion-space-id': candidate.spaceId };
      try {
        const data = await post('syncRecordValuesSpaceInitial', {
          requests: [{ pointer: { table: 'workflow', id: targetWorkflowId, spaceId: candidate.spaceId }, version: -1 }],
          spacePointer: { table: 'space', id: candidate.spaceId },
        }, headers);
        const records = data && data.recordMap && data.recordMap.workflow || {};
        const key = Object.keys(records).find((k) => uuid(k) === targetWorkflowId);
        const workflow = key && records[key] && records[key].value && records[key].value.value;
        if (workflow && uuid(workflow.id) === targetWorkflowId && uuid(workflow.space_id) === candidate.spaceId) {
          found = Object.assign({}, candidate, { headers: headers, workflow: workflow });
          break;
        }
      } catch (e) { failures.push(candidate.workspace + ': ' + String(e.message || e)); }
    }
    if (!found) throw new Error('Could not read this agent in any accessible workspace. ' + failures.join('; '));
    const agentName = found.workflow.name || (found.workflow.data && found.workflow.data.name) || targetWorkflowId;
    if (!confirm('Set ' + modelId + ' / ' + effort + ' for agent «' + agentName + '» in workspace «' + found.workspace + '»?')) return null;
    const now = Date.now();
    const pointer = { table: 'workflow', id: targetWorkflowId, spaceId: found.spaceId };
    await post('saveTransactionsFanout', {
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(), spaceId: found.spaceId,
        debug: { userAction: 'WorkflowActions.saveModel', clientCommitTimeMs: now },
        operations: [
          { pointer: pointer, command: 'set', path: ['data', 'model'], args: { type: modelId, reasoningEffort: effort } },
          { pointer: pointer, path: [], command: 'update', args: { last_edited_time: now, last_edited_by_id: found.userId, last_edited_by_table: 'notion_user' } },
        ],
      }],
    }, Object.assign({}, found.headers, { 'notion-audit-log-platform': 'web' }));
    const check = await post('syncRecordValuesSpaceInitial', {
      requests: [{ pointer: pointer, version: -1 }],
      spacePointer: { table: 'space', id: found.spaceId },
    }, found.headers);
    const records = check && check.recordMap && check.recordMap.workflow || {};
    const key = Object.keys(records).find((k) => uuid(k) === targetWorkflowId);
    const saved = key && records[key] && records[key].value && records[key].value.value && records[key].value.value.data && records[key].value.value.data.model;
    if (!saved || saved.type !== modelId || saved.reasoningEffort !== effort) {
      throw new Error('Write accepted but read-back did not confirm the model: ' + JSON.stringify(saved));
    }
    console.log('[Notion Effort] agent model saved and verified:', saved, '— now open a NEW chat with this agent');
    return saved;
  };

  // __notionEffortChat(text, options?) — model-pinned chat that works around
  // the trial's follow-up lock. Each call creates a NEW personal-agent thread
  // with the chosen model and puts the previous dialogue into the message as
  // context (the approach found in notion_trial_new.zip). The answer is read
  // from getThreadTranscript. Returns the assistant's text.
  // __notionEffortChatReset() clears the local dialogue history.
  const DIRECT_CHAT_KEY = 'notionEffortDirectChatHistory';
  function directChatHistory() {
    try { return JSON.parse(localStorage.getItem(DIRECT_CHAT_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function saveDirectChatHistory(history) {
    try { localStorage.setItem(DIRECT_CHAT_KEY, JSON.stringify(history.slice(-40))); } catch (e) {}
  }
  window.__notionEffortChatReset = function () {
    try { localStorage.removeItem(DIRECT_CHAT_KEY); } catch (e) {}
    console.log('[Notion Effort] direct chat history cleared');
  };
  window.__notionEffortChat = async function (text, options) {
    options = options || {};
    text = String(text || '').trim();
    if (!text) throw new Error('Pass a non-empty message: __notionEffortChat("привет")');
    const spaceId = options.spaceId || agentSpaceId || currentSpaceId();
    if (!spaceId) throw new Error('Workspace not known yet — open a Notion chat first');
    const model = options.model || settings.model || 'albuquerque-quinn';
    const effort = options.effort || settings.effort || 'max';
    const history = directChatHistory();
    const useHistory = options.history !== false;
    let content = text;
    if (useHistory && history.length) {
      content = history.map((m) => (m.role === 'user' ? 'User' : 'Assistant') + ': ' + m.text).join('\n') + '\n\nUser: ' + text;
    }
    const spacesRes = await effortFetch(location.origin + '/api/v3/getSpaces', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const spaces = await spacesRes.json();
    const uid = Object.keys(spaces)[0];
    if (!uid) throw new Error('Notion session not found');
    let threadId = crypto.randomUUID();
    const h = headersFor(spaceId);
    h.set('accept', '*/*');
    h.set('notion-audit-log-platform', 'web');
    h.set('x-notion-active-user-header', uid);
    if (!h.has('x-notion-cell-hint')) h.set('x-notion-cell-hint', 'prod-space-usw2-0004');
    if (!h.has('x-notion-cell-hint-source')) h.set('x-notion-cell-hint-source', 'space-id-mapping');
    const isCustomAgent = !!options.workflowId;
    console.log('[Notion Effort] direct chat start:', { type: isCustomAgent ? 'custom_agent' : 'personal_agent', spaceId: spaceId, workflowId: options.workflowId || null, model: model, effort: effort });
    let createData = null;
    let lastCreateError = null;
    if (isCustomAgent) {
      // Match the native Custom Agent create shape first. Then add exactly one
      // model override per attempt, so a 500 identifies the rejected field.
      const attempts = [
        { label: 'minimal + model/effort', extra: { model: model, reasoningEffort: effort } },
        { label: 'minimal + modelSelection object', extra: { modelSelection: { type: 'explicit', model: model, reasoningEffort: effort } } },
        { label: 'minimal + override object', extra: { customAgentModelSelectionOverride: { type: 'explicit', model: model, reasoningEffort: effort } } },
        { label: 'minimal + override string', extra: { customAgentModelSelectionOverride: 'explicit', model: model, reasoningEffort: effort } },
        { label: 'native minimal', extra: {} },
      ];
      for (const attempt of attempts) {
        threadId = crypto.randomUUID();
        const body = Object.assign({
          type: 'custom_agent', spaceId: spaceId, workflowId: options.workflowId,
          threadId: threadId, content: [{ type: 'text', text: [[content]] }],
          threadContext: {}, clientMessageId: crypto.randomUUID(),
        }, attempt.extra);
        const res = await effortFetch(location.origin + '/api/v3/createAgentThread', {
          method: 'POST', credentials: 'include', headers: h, body: JSON.stringify(body),
        });
        const text = await res.text();
        console.log('[Notion Effort] custom create attempt:', attempt.label, res.status, text.slice(0, 300));
        if (!res.ok) { lastCreateError = new Error(attempt.label + ': HTTP ' + res.status + ' ' + text.slice(0, 300)); continue; }
        let data;
        try { data = JSON.parse(text); } catch (e) { lastCreateError = e; continue; }
        if (data.isNotionError) { lastCreateError = new Error(data.name + ': ' + (data.message || '')); continue; }
        createData = data;
        const provider = data.thread && data.thread.data && data.thread.data.agent_provider;
        console.log('[Notion Effort] custom create agent_provider:', provider || '(not returned)');
        if (provider && provider.model === model) {
          console.log('[Notion Effort] model override WORKED:', attempt.label);
          break;
        }
        // Keep trying the remaining shapes when the server accepted the body
        // but ignored the model, so the response proves which one actually works.
      }
      if (!createData) throw lastCreateError || new Error('Every custom-agent create shape failed');
    } else {
      const createRes = await effortFetch(location.origin + '/api/v3/createAgentThread', {
        method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({
          type: 'personal_agent', spaceId: spaceId, threadId: threadId,
          enableSuggestedEditsTools: true, createdSource: 'full_page_chat',
          content: [{ type: 'text', text: [[content]] }],
          policies: { approval_mode: 'yolo' },
          agentMemorySettings: { useMemories: true, excludeChatFromMemories: false },
          browserEnabled: true, clientMessageId: crypto.randomUUID(),
          model: model, reasoningEffort: effort,
        }),
      });
      const createText = await createRes.text();
      if (!createRes.ok) throw new Error('createAgentThread: HTTP ' + createRes.status + ' ' + createText.slice(0, 300));
      createData = JSON.parse(createText);
      if (createData.isNotionError) throw new Error(createData.name + ': ' + (createData.message || ''));
    }
    if (createData.isNotionError) throw new Error(createData.name + ': ' + (createData.message || ''));
    if (!isCustomAgent) {
      // The record uses Notion's real enum value "explicit" (not "selected").
      await effortFetch(location.origin + '/api/v3/saveTransactions', {
        method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          transactions: [{
            id: crypto.randomUUID(), spaceId: spaceId,
            operations: [{
              pointer: { table: 'thread', id: threadId, spaceId: spaceId },
              path: ['data', 'agent_provider'], command: 'update',
              args: { model: model, reasoningEffort: effort, modelSelection: 'explicit' },
            }],
          }],
        }),
      }).catch(() => {});
    }
    let answer = null;
    for (let i = 0; i < 45 && !answer; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const trRes = await effortFetch(location.origin + '/api/v3/getThreadTranscript', {
        method: 'POST', credentials: 'include', headers: h,
        body: JSON.stringify({ spaceId: spaceId, threadId: threadId, direction: 'backward', limit: 20 }),
      });
      if (!trRes.ok) continue;
      const data = await trRes.json();
      for (const p of data.patches || []) {
        const e = p && p.entity;
        if (p.op === 'put' && e && e.kind === 'assistant_message') {
          const value = e.content && e.content[0] && e.content[0].text;
          if (typeof value === 'string' && value.trim()) answer = value.trim();
          else if (Array.isArray(value)) answer = value.map((r) => Array.isArray(r) ? r[0] : String(r)).join('').trim();
          if (answer) break;
        }
      }
    }
    if (!answer) throw new Error('The model did not answer within 45 s (thread ' + threadId + ')');
    history.push({ role: 'user', text: text }, { role: 'assistant', text: answer });
    saveDirectChatHistory(history);
    console.log('[Notion Effort] ' + model + ' / ' + effort + ' answered in new thread ' + threadId + '\n\n' + answer);
    return answer;
  };

  // __notionEffortExportChat() — dump the open chat as markdown: copies it to
  // the clipboard and downloads a file. Works from any console, no fetching
  // by hand: run it on the page of the chat you want to keep.
  let transcriptBodyTemplate = null;
  window.__notionEffortExportChat = async function () {
    let m = location.href.match(/[?&]t=([0-9a-f-]{36})/i) || location.href.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    let threadId = m && m[1];
    if (!threadId) {
      // URL carries no id (sidebar chat, clean path): use the thread the
      // extension currently sees.
      const known = openThreadKey() || activeThreadKey;
      if (known) threadId = dashedId(known);
    }
    if (!threadId) { console.warn('[Notion Effort] open a chat first (no thread id in the URL and none seen in traffic)'); return; }
    const spaceId = agentSpaceId || currentSpaceId();
    if (!spaceId) { console.warn('[Notion Effort] workspace not known yet — send any message first'); return; }
    // Body shapes to try: first the one Notion itself used (captured when it
    // loaded a transcript), then guesses. threadId in the template is swapped
    // for the current one.
    const bodies = [];
    if (transcriptBodyTemplate) {
      try {
        const t = JSON.parse(transcriptBodyTemplate);
        let seen = [];
        const swap = (n) => { if (n && typeof n === 'object') { if (Array.isArray(n)) n.forEach(swap); else Object.keys(n).forEach((k) => { if (/thread/i.test(k) && typeof n[k] === 'string') { seen.push(n[k]); n[k] = threadId; } else swap(n[k]); }); } };
        swap(t);
        if (seen.length) bodies.push(t);
      } catch (e) {}
    }
    bodies.push({ threadId: threadId, spaceId: spaceId }, { threadId: threadId }, { thread: { id: threadId, spaceId: spaceId } });
    let json = null, lastErr = null;
    for (const b of bodies) {
      try { json = await apiPost('export chat', spaceId, '/api/v3/getThreadTranscript', b); break; }
      catch (e) { lastErr = e; }
    }
    if (!json) throw lastErr;
    // Transcript pages: patches[] hold entities; kind=user_message is the
    // user, everything else with text is the assistant. Paginate forward
    // until has_more_forward is false (max 60 pages of safety).
    const msgs = [];
    const collect = (page) => {
      (page.patches || []).forEach((p) => {
        const e = p && p.entity;
        if (!e || !e.kind) return;
        const textOf = (t) => Array.isArray(t) ? t.map((r) => Array.isArray(r) ? r[0] : String(r)).join('') : (typeof t === 'string' ? t : '');
        if (/user_message/.test(e.kind)) {
          const t = textOf(e.text);
          if (t.trim()) msgs.push({ role: 'User', text: t.trim() });
        } else if (/thinking|tool|status|rate/.test(e.kind)) {
          // skip scaffolding; thinking kept out to keep the export readable
        } else {
          const t = textOf(e.text || e.content_text);
          if (t.trim()) msgs.push({ role: 'Assistant', text: t.trim() });
        }
      });
    };
    collect(json);
    let pages = 1;
    // The cursor key name is server-specific ("invalid Agent Service
    // transcript cursor" for the wrong one) — probe the usual suspects.
    const CURSOR_KEYS = ['forward_cursor', 'cursor', 'forwardCursor', 'after_sequence', 'afterSequence'];
    let cursorKey = null;
    while (json.has_more_forward && json.forward_cursor && pages < 60) {
      let next = null;
      const keys = cursorKey ? [cursorKey] : CURSOR_KEYS;
      for (const k of keys) {
        const nextBody = Object.assign({}, bodies[0] || { threadId: threadId, spaceId: spaceId });
        nextBody[k] = json.forward_cursor;
        try { next = await apiPost('export chat page', spaceId, '/api/v3/getThreadTranscript', nextBody); cursorKey = k; break; }
        catch (e) { /* try the next key name */ }
      }
      if (!next || !next.patches || next.forward_after_sequence === json.forward_after_sequence) break;
      json = next;
      collect(json);
      pages++;
    }
    console.log('[Notion Effort] transcript pages read: ' + pages);
    const md = msgs.length
      ? msgs.map((x) => '## ' + x.role + '\n\n' + x.text).join('\n\n')
      : JSON.stringify(json, null, 2);
    try { await navigator.clipboard.writeText(md); } catch (e) {}
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'notion-chat-' + threadId.slice(0, 8) + '.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    console.log('[Notion Effort] chat exported: ' + msgs.length + ' messages, copied to clipboard + downloaded');
    return md;
  };

  // copy(__notionEffortAgentDiag()) — everything the effort lever knows.
  window.__notionEffortAgentDiag = function () {
    return JSON.stringify({
      version: '2.70',
      watchOnly: watchOnly,
      runs: runs,
      url: location.href,
      openThread: openThreadKey(),
      activeThread: activeThreadKey,
      shown: agentThreads[openThreadKey() || activeThreadKey] || null,
      threads: agentThreads,
      prefs: agentPrefs,
      lastSave: window.__notionEffortAgentPref || null,
      wanted: settings.effort,
      wantedModel: settings.model,
      learnedSelection: learnedSelection,
      pickTemplate: pickTemplate,
      // What the clamp itself believes, per model: the picker's own ceilings.
      wantedEffortsByModel: (function () {
        const m = settings.model;
        return m ? (settings.effortsByModel[m] || null) : null;
      })(),
      lastDebug: window.__notionEffortDebug || null,
      effortHistory: effortHistory,
      lastModelState: lastModelState,
      lastRequestedEffort: lastRequestedEffort,
      spaceId: agentSpaceId,
      seenSpaceId: currentSpaceId(),
      headerSpaces: Object.keys(headersBySpace),
      headerNames: Object.keys(baseHeaders),
      policy: policyState,
      policyLog: policyLog,
      policyBackup: loadBackups(),
      trace: traceLog.map((t) => t.at.slice(11, 19) + ' ' + t.kind + ' ' + t.text),
      catalogue: catalogue && catalogue.models.map((m) => m.model + '/' + m.modelProvider +
        (m.restrictedForPersonalAgent ? '/restricted' : '') + (m.isDisabled ? '/disabled' : '') +
        // The effort ceiling the clamp reads: without it a max→medium drop
        // cannot be told apart from the server ignoring the ask.
        '[' + (((m.modelConfiguration && m.modelConfiguration.supportedReasoningEfforts) || []).join(',') || '?') + ']'),
      catalogueKeys: catalogue && catalogue.models[0] ? Object.keys(catalogue.models[0]) : null,
      writes: writeLog,
      foreign: foreignLog,
      modelSettings: modelSettingLog,
      limitLog: limitLog,
      spaceModelSettings: spaceModelSettings,
    }, null, 2);
  };

  // Claude Code relay: the background worker sends an Anthropic conversation
  // already flattened to text. Use a NEW Personal Agent thread per request so
  // Notion's first-message model injection applies and follow-up Auto routing
  // is never involved. The full conversation is included in job.prompt.
  if (window.top === window) {
    window.addEventListener('message', async (e) => {
      if (e.source !== window || !e.data || e.data.type !== 'NOTION_RELAY_REQUEST') return;
      const job = e.data.job;
      let result;
      try {
        const requested = String(job.model || '').toLowerCase();
        const notionModel = requested.indexOf('sonnet') !== -1 ? 'almond-croissant-low' : 'albuquerque-quinn';
        const text = await window.__notionEffortChat(job.prompt, {
          model: notionModel, effort: 'max', history: false,
        });
        result = { text: text, notionModel: notionModel };
      } catch (error) {
        result = { error: String(error.message || error) };
      }
      window.postMessage({ type: 'NOTION_RELAY_RESULT', job: { id: job.id }, result: result }, '*');
    });
  }

  // SPA navigation between chats changes ?t= without a new record fetch.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    publishAgent();
  }, 1000);
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'NOTION_EFFORT_AGENT_REQUEST') return;
    publishAgent();
    if (policyState) window.postMessage({ type: 'NOTION_EFFORT_POLICY', status: policyState.status, detail: policyState }, '*');
  });
})();

