/**
 * Notion Effort — Model Selector Unlocker
 *
 * Runs in the MAIN world at document_start, i.e. BEFORE Notion's bundle and
 * before any Statsig client is constructed.
 *
 * Why the old localStorage snippet stopped working:
 *   STATSIG_LOCAL_STORAGE_INTERNAL_STORE_OVERRIDES_V3 is only read by the legacy
 *   `statsig-js` SDK. The modern `@statsig/js-client` keeps overrides in memory
 *   (LocalOverrideAdapter) and reads gate values from either a bootstrap blob
 *   embedded in the page or a cached `statsig.cached.evaluations.*` entry.
 *   So we patch every surface a gate value can arrive through instead of one.
 *
 * Surfaces patched (in order of arrival):
 *   1. localStorage seeds + getItem hook  (legacy SDK + cached evaluations)
 *   2. JSON.parse hook                    (bootstrap blob inlined in HTML)
 *   3. fetch / XMLHttpRequest responses   (/v1/initialize, Notion API proxies)
 *   4. Live client instances              (checkGate / getFeatureGate / overrideAdapter)
 */
(() => {
  'use strict';
  if (window.__notionUnlock) return;

  /* ------------------------------------------------------------------ *
   * Gate list — key: raw gate name, value: what we want it to evaluate to
   * ------------------------------------------------------------------ */
  const GATES = {
    // confirmed: djb2("hide_model_selector_for_business_trials") === "1783351065"
    hide_model_selector_for_business_trials: false,
    hide_model_selector_for_trials: false,
    hide_model_selector: false,
    hide_model_picker_for_business_trials: false,
    hide_model_picker: false,
    hide_ai_model_selector: false,
    disable_model_selector_for_business_trials: false,
    disable_model_selector: false,
    model_selector_disabled_for_trials: false,
    // positive-polarity variants (force ON)
    show_model_selector: true,
    show_model_picker: true,
    enable_model_selector: true,
    ai_model_selector_enabled: true,
    model_selector_enabled: true,
    allow_model_selection: true,
  };

  /* ----------------------------- hashing ---------------------------- */

  // Statsig's djb2 (hashing: 'djb2')
  function djb2(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash = hash & hash;
    }
    return String(hash >>> 0);
  }

  // Statsig's default hashing: base64(sha256(name)) — implemented synchronously
  // because we must patch responses inline, not in a promise.
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Base64(str) {
    const utf8 = unescape(encodeURIComponent(str));
    const len = utf8.length;
    const withPad = ((len + 8) >> 6) + 1;
    const words = new Uint32Array(withPad * 16);
    for (let i = 0; i < len; i++) words[i >> 2] |= utf8.charCodeAt(i) << (24 - (i % 4) * 8);
    words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
    words[withPad * 16 - 1] = len * 8;

    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let block = 0; block < withPad; block++) {
      for (let i = 0; i < 16; i++) w[i] = words[block * 16 + i];
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [h[0] + a | 0, h[1] + b | 0, h[2] + c | 0, h[3] + d | 0, h[4] + e | 0, h[5] + f | 0, h[6] + g | 0, h[7] + hh | 0];
    }

    let bytes = '';
    for (const word of h) {
      bytes += String.fromCharCode((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff);
    }
    return btoa(bytes);
  }

  /** key (raw name | djb2 | sha256-b64) -> desired boolean */
  const TARGETS = new Map();
  function registerGate(name, value) {
    GATES[name] = value;
    TARGETS.set(name, value);
    TARGETS.set(djb2(name), value);
    TARGETS.set(sha256Base64(name), value);
  }
  Object.keys(GATES).forEach((name) => registerGate(name, GATES[name]));

  const stats = { storage: 0, json: 0, network: 0, client: 0, plan: 0, hits: [] };
  function hit(where, key) {
    stats[where]++;
    const label = where + ':' + key;
    if (!stats.hits.includes(label)) {
      stats.hits.push(label);
      console.log('[Notion Unlock] gate neutralised via', where, '→', key);
    }
  }

  /* --------------------------- JSON patching ------------------------- */

  const NAME_RE = /^hide_(ai_)?model_(selector|picker)/i;

  function desiredFor(key) {
    if (TARGETS.has(key)) return TARGETS.get(key);
    if (NAME_RE.test(key)) return false;
    return undefined;
  }

  function patchNode(node, where, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (const item of node) changed = patchNode(item, where, depth + 1) || changed;
      return changed;
    }

    // Statsig evaluation entry: { name: "<hashed>", value: true, rule_id: ... }
    if (typeof node.name === 'string' && typeof node.value === 'boolean') {
      const want = desiredFor(node.name);
      if (want !== undefined && node.value !== want) {
        node.value = want;
        hit(where, node.name);
        changed = true;
      }
    }

    for (const key of Object.keys(node)) {
      const want = desiredFor(key);
      const val = node[key];

      if (want !== undefined) {
        if (typeof val === 'boolean' && val !== want) {
          node[key] = want;
          hit(where, key);
          changed = true;
          continue;
        }
        if (val && typeof val === 'object' && typeof val.value === 'boolean' && val.value !== want) {
          val.value = want;
          hit(where, key);
          changed = true;
          continue;
        }
      }

      if (val && typeof val === 'object') {
        changed = patchNode(val, where, depth + 1) || changed;
      } else if (typeof val === 'string' && val.length > 20 && looksRelevant(val)) {
        // nested JSON kept as a string (cached evaluations store `data` this way)
        try {
          const inner = rawParse(val);
          if (patchNode(inner, where, depth + 1)) {
            node[key] = JSON.stringify(inner);
            changed = true;
          }
        } catch (_) {}
      }
    }
    return changed;
  }

  function looksRelevant(text) {
    if (text.indexOf('feature_gates') !== -1) return true;
    if (text.indexOf('model_selector') !== -1 || text.indexOf('model_picker') !== -1) return true;
    for (const key of TARGETS.keys()) {
      if (key.length > 6 && text.indexOf(key) !== -1) return true;
    }
    return false;
  }

  // Captured before the JSON.parse hook below, so patchText can tell whether IT
  // changed anything instead of seeing an object the hook already fixed.
  const rawParse = JSON.parse;

  function patchText(text, where) {
    if (typeof text !== 'string' || !looksRelevant(text)) return null;
    try {
      const parsed = rawParse(text);
      return patchNode(parsed, where, 0) ? JSON.stringify(parsed) : null;
    } catch (_) {
      return null;
    }
  }

  /* ------------------- 3b. Notion plan / entitlement ----------------- *
   * Every Statsig gate can read `false` and the picker still stays hidden,
   * because Notion also gates it on the space's subscription state. On a
   * Business Trial the payload carries trial markers; on Free it does not,
   * and Free shows every model. So we make the client see "not trialing".
   * ------------------------------------------------------------------ */

  // Blanket /api/v3/ minus anything streaming, long-polling, or hot-path:
  // buffering those through clone().text() would stall the AI stream.
  // Any /api/ path, not just v3: the model catalogue may live elsewhere.
  const PLAN_URL_RE = /\/api\//i;
  const PLAN_SKIP_RE = /(runInference|subscribe|\/ping|trackEvent|recordPageVisit|saveTransactions|submitTransaction|syncRecord|heartbeat|upload|\/stream|listenTo|Transcript|AgentThread|AgentService|etClient|collector)/i;
  const PLAN_TEXT_RE = /(trial|subscription_tier|subscriptionTier|plan_type|planType|modelSelector|model_selector|modelPicker|availableModels|allowedModels|enabledModels)/i;

  /* Recorded-but-not-patched: the picker renders yet lists only "Auto", so the
   * catalogue arrives under names PLAN_TEXT_RE never matched. Recording is
   * read-only, so casting a wide net here is safe. */
  const MODEL_TEXT_RE = /("[a-z_]*model[a-z_]*"\s*:|"llm|eligibilit|entitle|ai_credit|aiCredit)/i;

  /* Field names below are the REAL ones observed in this Notion build via
   * why(): is_biz_trial, days_until_trial_end, subscription_tier, plan_type,
   * spaceSubscriptionTier, subscriptionTier, planType, trial_start. */

  /* `modelSelectionRestricted: true` on /api/v3/getAvailableModels is the flag
   * that collapses the picker down to "Auto" — confirmed via models(). */
  const FORCE_FALSE = /^(modelSelectionRestricted|model_selection_restricted|modelSelectionLocked|isModelSelectionRestricted|restrictModelSelection|is_biz_trial|is_business_trial|isBizTrial|isBusinessTrial|is_enterprise_trial|isEnterpriseTrial|is_trialing|isTrialing|is_trial|isTrial|is_in_trial|isInTrial|inTrial|in_trial|on_trial|onTrial|trialing|is_on_trial|isOnTrial|has_trial|hasTrial|is_trial_active|isTrialActive|hideModelSelector|hide_model_selector|hideModelPicker|hide_model_picker|shouldHideModelSelector|should_hide_model_selector|isModelSelectorHidden|modelSelectorHidden|model_selector_hidden|modelSelectorDisabled|model_selector_disabled)$/;
  const FORCE_TRUE = /^(canSelectModel|can_select_model|canSelectModels|showModelSelector|show_model_selector|showModelPicker|show_model_picker|modelSelectorEnabled|model_selector_enabled|isModelSelectorEnabled|allowModelSelection|allow_model_selection|canChooseModel|can_choose_model|hasModelSelection|canUseModelSelector|can_use_model_selector)$/;

  /* String tier/plan fields. On a Business Trial these carry a trial marker;
   * we strip it so the client reads a settled (non-trial) plan. */
  /* Bare `tier` is deliberately NOT here: it matched Statsig's environment
   * field and rewrote `tier: "production"` → `"free"`, which is unrelated to
   * billing and risks breaking feature-flag evaluation. */
  const TIER_KEY = /^(subscription_tier|subscriptionTier|spaceSubscriptionTier|space_subscription_tier|plan_type|planType|pending_plan_type|pendingPlanType|onboarding_plan_type|space_plan_type|spacePlanType|current_plan_type)$/;

  /* Deployment-environment values that must never be treated as a plan. */
  const ENV_VALUE = /^(production|development|staging|preview|test|local)$/i;

  /* Tier fields whose NAME says trial even when the VALUE looks innocent:
   * observed `trial-v0.trial_tier: "business"` — no "trial" substring in the
   * value, so the TIER_KEY rule above skips it. Blank these out entirely. */
  const TRIAL_TIER_KEY = /^(trial_tier|trialTier|trial_plan|trialPlan|trial_plan_type|trial_type|trialType|trial_subscription_tier)$/;

  /* Namespaced trial containers, e.g. `trial-v0`. Everything inside is trial
   * state by definition, so the whole subtree gets neutralised. */
  const TRIAL_CONTAINER_KEY = /^trial[-_]?v?\d*$/i;

  /* Countdown fields — a positive number is what renders the trial state. */
  const TRIAL_NUM_KEY = /^(days_until_trial_end|daysUntilTrialEnd|days_left_in_trial|trial_days_remaining|trialDaysRemaining|days_until_trial_expiry)$/;

  /* Timestamps that mark an active trial window. */
  const TRIAL_DATE_KEY = /^(trial_start|trialStart|trial_end|trialEnd|trial_started_at|trial_end_date|trialEndDate|trial_expiration|trialExpiration)$/;

  /* The empty `models: []` array on getAvailableModels. Seeding it is OFF by
   * default: the catalogue is withheld server-side, so injected entries only
   * make the menu *look* populated and the server can still refuse the pick. */
  const MODEL_LIST_KEY = /^(models|modelOptions|model_options|availableModels|available_models|allowedModels|allowed_models|enabledModels|selectableModels)$/;

  let planPatchEnabled = true;
  let tierMode = 'strip'; // 'strip' | a literal tier string | 'off'
  let seedModels = null;  // null = disabled; otherwise an array to inject

  /** "business_trial" -> "business"; bare "trial" -> "free". */
  function detrial(value) {
    if (tierMode === 'off') return value;
    if (tierMode !== 'strip') return tierMode;
    const out = value
      .replace(/[_-]?trial[_-]?/gi, '')
      .replace(/^[_-]+|[_-]+$/g, '');
    return out.length > 1 ? out : 'free';
  }

  /**
   * Inside a `trial-v0` container every value describes an active trial, so
   * flatten by type: booleans -> false, counters -> 0, dates/tiers -> empty.
   * `*_eligible` is left alone — it gates the offer, not the trial state.
   */
  function neutraliseTrialContainer(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (const item of node) changed = neutraliseTrialContainer(item, path, depth + 1) || changed;
      return changed;
    }

    for (const key of Object.keys(node)) {
      const val = node[key];
      if (/eligib/i.test(key)) continue;

      if (typeof val === 'boolean') {
        if (val !== false) { node[key] = false; hit('plan', path + '.' + key + ':true→false'); changed = true; }
      } else if (typeof val === 'number') {
        if (val !== 0) { node[key] = 0; hit('plan', path + '.' + key + ':' + val + '→0'); changed = true; }
      } else if (typeof val === 'string') {
        if (val !== '') { node[key] = ''; hit('plan', path + '.' + key + ':' + val + "→''"); changed = true; }
      } else if (val && typeof val === 'object') {
        changed = neutraliseTrialContainer(val, path + '.' + key, depth + 1) || changed;
      }
    }
    return changed;
  }

  function patchPlanNode(node, depth) {
    if (!node || typeof node !== 'object' || depth > 16) return false;
    let changed = false;

    if (Array.isArray(node)) {
      for (const item of node) changed = patchPlanNode(item, depth + 1) || changed;
      return changed;
    }

    for (const key of Object.keys(node)) {
      const val = node[key];

      // Opt-in: fill the server-emptied model catalogue.
      if (seedModels && Array.isArray(val) && val.length === 0 && MODEL_LIST_KEY.test(key)) {
        node[key] = JSON.parse(JSON.stringify(seedModels));
        hit('plan', key + ':[]→' + seedModels.length + ' seeded');
        changed = true;
        continue;
      }

      // Whole `trial-v0`-style subtree: flatten every trial signal inside it,
      // not just the specific field names we happen to know about.
      if (val && typeof val === 'object' && TRIAL_CONTAINER_KEY.test(key)) {
        if (neutraliseTrialContainer(val, key, 0)) changed = true;
        continue;
      }

      if (typeof val === 'boolean') {
        if (FORCE_FALSE.test(key) && val !== false) {
          node[key] = false; hit('plan', key + ':true→false'); changed = true; continue;
        }
        if (FORCE_TRUE.test(key) && val !== true) {
          node[key] = true; hit('plan', key + ':false→true'); changed = true; continue;
        }
      } else if (typeof val === 'string') {
        if (TRIAL_TIER_KEY.test(key) && val !== '') {
          node[key] = ''; hit('plan', key + ':' + val + "→''"); changed = true; continue;
        }
        // A literal tierMode ('free') must apply even when the value has no
        // "trial" in it — that gate is only meaningful for 'strip' mode.
        if (TIER_KEY.test(key) && !ENV_VALUE.test(val) &&
            (tierMode !== 'strip' || /trial/i.test(val))) {
          const next = detrial(val);
          if (next !== val) { node[key] = next; hit('plan', key + ':' + val + '→' + next); changed = true; }
          continue;
        }
        if (TRIAL_DATE_KEY.test(key)) {
          node[key] = null; hit('plan', key + '→null'); changed = true; continue;
        }
      } else if (typeof val === 'number') {
        if (TRIAL_NUM_KEY.test(key) && val !== 0) {
          node[key] = 0; hit('plan', key + ':' + val + '→0'); changed = true; continue;
        }
        if (TRIAL_DATE_KEY.test(key) && val !== null) {
          node[key] = null; hit('plan', key + '→null'); changed = true; continue;
        }
      } else if (typeof val === 'object' && val === null) {
        continue;
      }

      if (val && typeof val === 'object') changed = patchPlanNode(val, depth + 1) || changed;
    }
    return changed;
  }

  /* Recorder — keeps the last plan-ish payload per endpoint so `why()` and
   * `dump()` can show the REAL field names instead of us guessing them. */
  const recorder = [];
  const KEY_RE = /"([A-Za-z0-9_-]*(?:rial|ubscription|lanType|lan_type|odel|Model|ntitle|ligib|lm_|LLM)[A-Za-z0-9_-]*)"\s*:/g;

  function record(url, text) {
    const keys = new Set();
    KEY_RE.lastIndex = 0;
    let match;
    while ((match = KEY_RE.exec(text)) && keys.size < 40) keys.add(match[1]);
    if (!keys.size) return;

    const short = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    // getAppConfig alone is ~1.3 MB, so keep enough to let dump() reach it.
    const kept = text.length < 4000000 ? text : null;
    const existing = recorder.find((e) => e.url === short);
    if (existing) {
      existing.count++;
      existing.size = text.length;
      existing.keys = [...new Set([...existing.keys, ...keys])];
      if (kept) existing.text = kept;
      return;
    }
    if (recorder.length > 30) recorder.shift();
    recorder.push({ url: short, keys: [...keys], count: 1, size: text.length, text: kept });
  }

  /* ------------------ model catalogue (read-only) ------------------- *
   * Notion's own menu is fed from the server (getAvailableModels and friends).
   * Reading its codename -> display-name pairs lets a model we have never seen
   * (e.g. Opus 5.5) be recognised without hand-editing models.js. Nothing here
   * modifies the response.
   * ------------------------------------------------------------------ */
  const CAT_ID_KEYS = ['model', 'modelId', 'model_id', 'codename', 'id', 'value', 'key'];
  const CAT_NAME_KEYS = ['modelMessage', 'displayName', 'display_name', 'modelName', 'model_name', 'name', 'label', 'title'];
  const CAT_EFFORT_KEY = /(effort|reasoning)/i;
  const EFFORT_WORD = /^(low|medium|high|max)$/i;
  const catalogue = [];

  function pickString(obj, keys) {
    for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k];
    return null;
  }

  function pickEfforts(obj) {
    // Agent-service catalogue: { modelConfiguration: { supportedReasoningEfforts: [...] } }
    if (obj.modelConfiguration && typeof obj.modelConfiguration === 'object' && obj !== obj.modelConfiguration) {
      const nested = pickEfforts(obj.modelConfiguration);
      if (nested) return nested;
    }
    for (const key of Object.keys(obj)) {
      if (!CAT_EFFORT_KEY.test(key) || !Array.isArray(obj[key])) continue;
      const out = [];
      for (const e of obj[key]) {
        const v = typeof e === 'string' ? e : e && (e.value || e.id || e.effort || e.name);
        if (typeof v === 'string' && EFFORT_WORD.test(v) && out.indexOf(v.toLowerCase()) === -1) {
          out.push(v.toLowerCase());
        }
      }
      if (out.length) return out;
    }
    return null;
  }

  function addCatalogueEntry(out, id, item) {
    const name = pickString(item, CAT_NAME_KEYS);
    // Codenames are single tokens; a spaced "id" is a display name in disguise.
    if (!id || !name || id === name || id.length > 80 || /\s/.test(id)) return;
    if (out.some((m) => m.model === id)) return;
    out.push({ model: id, name: name, efforts: pickEfforts(item), source: 'catalogue' });
  }

  function extractCatalogue(node, path, out, depth) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    const last = path.split('.').pop() || '';
    const modelish = /model/i.test(last);

    if (Array.isArray(node)) {
      if (modelish) {
        for (const item of node) {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            addCatalogueEntry(out, pickString(item, CAT_ID_KEYS), item);
          }
        }
      }
      node.forEach((item, i) => extractCatalogue(item, path + '[' + i + ']', out, depth + 1));
      return;
    }

    // Map form: { models: { "agave-flan": { displayName: "Opus 5" } } }
    // Plural key only: a single "model" object is one choice, not a catalogue.
    if (/models$/i.test(last)) {
      for (const key of Object.keys(node)) {
        const item = node[key];
        if (item && typeof item === 'object' && !Array.isArray(item)) addCatalogueEntry(out, key, item);
      }
    }
    for (const key of Object.keys(node)) {
      extractCatalogue(node[key], path ? path + '.' + key : key, out, depth + 1);
    }
  }

  function publishCatalogue() {
    window.postMessage({ type: 'NOTION_EFFORT_CATALOGUE', models: catalogue.slice() }, '*');
  }

  function learnCatalogue(text) {
    let parsed;
    try { parsed = rawParse(text); } catch (_) { return; }
    const found = [];
    extractCatalogue(parsed, '', found, 0);
    let added = 0;
    for (const m of found) {
      if (catalogue.some((c) => c.model === m.model)) continue;
      catalogue.push(m);
      added++;
    }
    if (added) {
      console.log('[Notion Unlock] model catalogue +' + added + ':', found.map((m) => m.model + ' = ' + m.name).join(', '));
      publishCatalogue();
    }
  }

  // composer.js may load after the catalogue arrived; let it ask for a replay.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_CATALOGUE_REQUEST' && catalogue.length) {
      publishCatalogue();
    }
  });

  /** Runs both the gate patcher and the plan patcher over one response body. */
  function processBody(text, url, isGate, isPlan) {
    let out = isGate ? patchText(text, 'network') : null;
    if (!isPlan) return out;

    const planMatch = PLAN_TEXT_RE.test(text);
    const modelMatch = MODEL_TEXT_RE.test(text);
    // Record model/eligibility payloads too, so models() has data to scan.
    if (planMatch || modelMatch) record(url, text);
    // Before patching: the catalogue is read from what the server actually sent.
    if (modelMatch) learnCatalogue(text);

    // getAvailableModels carries `modelSelectionRestricted` but none of the
    // plan keywords, so it must be patched on the model match as well.
    if ((planMatch || modelMatch) && planPatchEnabled) {
      try {
        const parsed = rawParse(out !== null ? out : text);
        if (patchPlanNode(parsed, 0)) out = JSON.stringify(parsed);
      } catch (_) {}
    }
    return out;
  }

  /* --------------------------- 1. localStorage ----------------------- */

  const LEGACY_KEY = 'STATSIG_LOCAL_STORAGE_INTERNAL_STORE_OVERRIDES_V3';
  const OVERRIDE_KEYS = [LEGACY_KEY, 'STATSIG_OVERRIDES', 'statsig.local-overrides'];

  function overridePayload(existing) {
    let cur = {};
    try { cur = JSON.parse(existing || '{}') || {}; } catch (_) {}
    const gates = { ...(cur.gates || {}) };
    for (const [key, value] of TARGETS) gates[key] = value;
    return JSON.stringify({
      ...cur,
      gates,
      configs: cur.configs || {},
      dynamicConfigs: cur.dynamicConfigs || {},
      layers: cur.layers || {},
    });
  }

  const rawGetItem = Storage.prototype.getItem;
  const rawSetItem = Storage.prototype.setItem;

  const PLAN_FLAG_KEY = 'notionUnlock.planPatch';
  const TIER_MODE_KEY = 'notionUnlock.tierMode';
  const SEED_KEY = 'notionUnlock.seedModels';
  try {
    planPatchEnabled = rawGetItem.call(localStorage, PLAN_FLAG_KEY) !== 'off';
    tierMode = rawGetItem.call(localStorage, TIER_MODE_KEY) || 'strip';
    const rawSeed = rawGetItem.call(localStorage, SEED_KEY);
    if (rawSeed) {
      const parsedSeed = rawParse(rawSeed);
      if (Array.isArray(parsedSeed) && parsedSeed.length) seedModels = parsedSeed;
    }
  } catch (_) {}

  for (const key of OVERRIDE_KEYS) {
    try { rawSetItem.call(localStorage, key, overridePayload(rawGetItem.call(localStorage, key))); } catch (_) {}
  }

  Storage.prototype.getItem = function (key) {
    const value = rawGetItem.call(this, key);
    if (typeof key !== 'string') return value;

    if (OVERRIDE_KEYS.includes(key)) {
      hit('storage', key);
      return overridePayload(value);
    }
    // cached evaluations written by @statsig/js-client
    if (value && /statsig/i.test(key)) {
      const patched = patchText(value, 'storage');
      if (patched) return patched;
    }
    return value;
  };

  /* ---------------------------- 2. JSON.parse ------------------------ */

  JSON.parse = function (text, reviver) {
    const result = rawParse.call(this, text, reviver);
    if (typeof text === 'string' && text.length > 40 && looksRelevant(text)) {
      try { patchNode(result, 'json', 0); } catch (_) {}
    }
    return result;
  };

  /* ------------------------- 3. network responses -------------------- */

  const NETWORK_RE = /(statsig|featuregates|featureassets|prodregistry|assetsconfigcdn|\/v1\/initialize|\/v2\/initialize|initialize\?|experiment|feature_gates|getUserAnalyticsSettings|getExperimentValues|getClientExperiments)/i;

  const rawFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await rawFetch.apply(this, args);
    try {
      const url = (typeof args[0] === 'string' ? args[0] : args[0] && args[0].url) || response.url || '';
      const isGate = NETWORK_RE.test(url);
      const isPlan = PLAN_URL_RE.test(url) && !PLAN_SKIP_RE.test(url);
      if (!isGate && !isPlan) return response;
      if (!response.ok || response.status === 204 || !response.body) return response;

      // Never buffer a stream: runInferenceTranscript is SSE, and awaiting
      // clone.text() on it would hold the AI response until it fully ends.
      const type = response.headers.get('content-type') || '';
      if (type.indexOf('json') === -1 && !isGate) return response;
      if (type.indexOf('event-stream') !== -1 || type.indexOf('ndjson') !== -1) return response;

      const clone = response.clone();
      const text = await clone.text();
      if (text.length > 6000000) return response;
      const patched = processBody(text, url, isGate, isPlan);
      if (!patched) return response;

      return new Response(patched, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (_) {
      return response;
    }
  };

  const rawOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__unlockUrl = String(url || '');
    return rawOpen.call(this, method, url, ...rest);
  };

  const rawSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (NETWORK_RE.test(this.__unlockUrl || '')) {
      this.addEventListener('readystatechange', function () {
        if (this.readyState !== 4) return;
        try {
          const patched = patchText(this.responseText, 'network');
          if (!patched) return;
          Object.defineProperty(this, 'responseText', { get: () => patched, configurable: true });
          Object.defineProperty(this, 'response', { get: () => patched, configurable: true });
        } catch (_) {}
      });
    }
    return rawSend.apply(this, args);
  };

  /* --------------------------- 4. live clients ----------------------- */

  const patchedInstances = new WeakSet();

  function patchClient(client) {
    if (!client || typeof client !== 'object' || patchedInstances.has(client)) return;
    patchedInstances.add(client);

    // Preferred path: the SDK's own override adapter.
    try {
      const adapter = client.overrideAdapter;
      if (adapter && typeof adapter.overrideGate === 'function') {
        for (const [name, value] of Object.entries(GATES)) adapter.overrideGate(name, value);
        hit('client', 'overrideAdapter');
      }
    } catch (_) {}

    for (const method of ['checkGate', 'getFeatureGate', 'gate']) {
      try {
        if (typeof client[method] !== 'function') continue;
        const original = client[method].bind(client);
        client[method] = function (name, ...rest) {
          const want = desiredFor(name);
          const result = original(name, ...rest);
          if (want === undefined) return result;
          hit('client', String(name));
          if (result && typeof result === 'object') {
            try { result.value = want; } catch (_) {}
            return result;
          }
          return want;
        };
      } catch (_) {}
    }
  }

  function sweepClients() {
    const root = window.__STATSIG__;
    if (root) {
      const buckets = [root.instance, root.instances, root.client, root.StatsigClient];
      for (const bucket of buckets) {
        if (!bucket) continue;
        if (typeof bucket.checkGate === 'function') patchClient(bucket);
        else if (typeof bucket === 'object') Object.values(bucket).forEach(patchClient);
      }
      if (typeof root.instance === 'function') {
        try { patchClient(root.instance()); } catch (_) {}
      }
    }
    if (window.statsig) patchClient(window.statsig);          // legacy statsig-js global
    if (window.Statsig) patchClient(window.Statsig);
  }

  sweepClients();
  const sweepTimer = setInterval(sweepClients, 400);
  setTimeout(() => clearInterval(sweepTimer), 60000);

  /* --------------------------- diagnostics API ----------------------- */

  window.__notionUnlock = {
    gates: GATES,
    stats,
    /** codename -> name pairs read from Notion's own model catalogue. */
    catalogue,
    hash: (name) => ({ raw: name, djb2: djb2(name), sha256: sha256Base64(name) }),
    addGate(name, value = false) {
      registerGate(name, value);
      for (const key of OVERRIDE_KEYS) {
        try { rawSetItem.call(localStorage, key, overridePayload(rawGetItem.call(localStorage, key))); } catch (_) {}
      }
      console.log('[Notion Unlock] added', name, '=', value, '— reload the page');
    },
    /** Find where the flag currently lives: storage keys, statsig caches, client state. */
    scan() {
      const found = { storage: [], statsigKeys: [], clients: [], gateValues: {} };
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const value = rawGetItem.call(localStorage, key) || '';
        if (/statsig/i.test(key)) found.statsigKeys.push(key + ' (' + value.length + ' chars)');
        if (value.indexOf('model_selector') !== -1 || value.indexOf('model_picker') !== -1) {
          found.storage.push(key);
        }
        for (const target of TARGETS.keys()) {
          if (target.length > 6 && value.indexOf(target) !== -1) found.storage.push(key + ' ~ ' + target);
        }
      }
      const root = window.__STATSIG__;
      if (root) found.clients.push('window.__STATSIG__: ' + Object.keys(root).join(', '));
      if (window.statsig) found.clients.push('window.statsig (legacy SDK)');
      for (const name of Object.keys(GATES)) {
        try {
          const client = root && (root.instance && (typeof root.instance === 'function' ? root.instance() : root.instance));
          if (client && typeof client.checkGate === 'function') found.gateValues[name] = client.checkGate(name);
        } catch (_) {}
      }
      console.log('[Notion Unlock] scan', found, '\npatch stats:', stats);
      return found;
    },

    /** Which Notion endpoints carry plan/trial/model fields. Run AFTER a reload. */
    why() {
      if (!recorder.length) {
        console.warn('[Notion Unlock] nothing recorded yet — reload the page, open the AI composer, then run why() again');
        return [];
      }
      const rows = recorder.map((e) => ({
        endpoint: e.url,
        calls: e.count,
        kb: Math.round(e.size / 1024),
        keys: e.keys.join(', '),
      }));
      if (console.table) console.table(rows); else console.log(rows);
      console.log('[Notion Unlock] plan patch:', planPatchEnabled ? 'ON' : 'OFF', '| stats:', stats);
      console.log('Next: __notionUnlock.dump("<endpoint fragment>") to see the actual values.');
      return rows;
    },

    /** Print every plan/model-ish key/value pair from a recorded response. */
    dump(fragment) {
      const entry = recorder.find((e) => e.url.indexOf(fragment) !== -1);
      if (!entry) {
        console.warn('[Notion Unlock] no recorded response matching', fragment, '— known:', recorder.map((e) => e.url));
        return null;
      }
      if (!entry.text) {
        console.warn('[Notion Unlock] payload was too large to keep (', entry.size, 'bytes )');
        return null;
      }
      const INTEREST = /(trial|subscription|plan|model|tier|entitle|quota|credit)/i;
      const out = {};
      (function walk(node, path, depth) {
        if (!node || typeof node !== 'object' || depth > 14) return;
        for (const key of Object.keys(node)) {
          const val = node[key];
          const next = path ? path + '.' + key : key;
          if (val && typeof val === 'object') walk(val, next, depth + 1);
          else if (INTEREST.test(key)) out[next] = val;
        }
      })(rawParse(entry.text), '', 0);
      console.log('[Notion Unlock] dump', entry.url, out);
      return out;
    },

    /**
     * EXPERIMENTAL. Inject entries into the empty `models: []` array.
     *
     * The server withholds the catalogue, so this only repopulates the menu
     * visually — Notion can still reject the chosen model server-side. Call
     * with no argument to use a default guessed shape, an array for a custom
     * one, or false to turn seeding back off.
     */
    setModels(list) {
      let value = list;
      if (value === undefined) {
        value = [
          { id: 'anthropic-opus-5', name: 'Opus 5', description: 'For your hardest tasks' },
          { id: 'anthropic-sonnet-5', name: 'Sonnet 5', description: 'Claude' },
          { id: 'openai-gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'For your hardest tasks' }
        ];
      }
      try {
        if (value === false || value === null) {
          localStorage.removeItem(SEED_KEY);
          console.log('[Notion Unlock] model seeding OFF — reloading');
        } else {
          rawSetItem.call(localStorage, SEED_KEY, JSON.stringify(value));
          console.log('[Notion Unlock] seeding', value.length, 'models — reloading');
        }
      } catch (_) {}
      location.reload();
    },

    /**
     * Hunt for the model catalogue. The picker renders but lists only "Auto",
     * so the model array arrives from somewhere we are not patching yet.
     * Reports every model-ish key and every array of model-ish objects,
     * including empty ones — an empty array is the interesting case.
     */
    models() {
      const MODEL_KEY = /(model|llm|inference_option|assistant_option)/i;
      const rows = [];

      recorder.forEach((entry) => {
        if (!entry.text) return;
        let parsed;
        try { parsed = rawParse(entry.text); } catch (_) { return; }

        (function walk(node, path, depth) {
          if (!node || typeof node !== 'object' || depth > 14) return;

          if (Array.isArray(node)) {
            if (MODEL_KEY.test(path)) {
              rows.push({
                endpoint: entry.url,
                path: path,
                type: 'array',
                length: node.length,
                sample: node.length ? JSON.stringify(node[0]).slice(0, 120) : '(EMPTY)'
              });
            }
            node.forEach((item, i) => walk(item, path + '[' + i + ']', depth + 1));
            return;
          }

          for (const key of Object.keys(node)) {
            const val = node[key];
            const next = path ? path + '.' + key : key;
            if (val && typeof val === 'object') {
              walk(val, next, depth + 1);
            } else if (MODEL_KEY.test(key)) {
              rows.push({
                endpoint: entry.url, path: next, type: typeof val,
                length: '', sample: String(val).slice(0, 120)
              });
            }
          }
        })(parsed, '', 0);
      });

      if (!rows.length) {
        console.warn('[Notion Unlock] no model fields recorded. Open the picker, then rerun.');
        return [];
      }
      console.table(rows);
      console.log('[Notion Unlock] empty arrays above are the likely culprit.');
      return rows;
    },

    /**
     * Same as dump(), but runs the patcher first so you see what Notion
     * ACTUALLY received. dump() intentionally shows the original response.
     */
    verify(fragment) {
      const entry = recorder.find((e) => e.url.indexOf(fragment) !== -1);
      if (!entry || !entry.text) {
        console.warn('[Notion Unlock] nothing usable recorded for', fragment);
        return null;
      }
      const parsed = rawParse(entry.text);
      patchPlanNode(parsed, 0);
      const INTEREST = /(trial|subscription|plan|model|tier|entitle)/i;
      const out = {};
      (function walk(node, path, depth) {
        if (!node || typeof node !== 'object' || depth > 14) return;
        for (const key of Object.keys(node)) {
          const val = node[key];
          const next = path ? path + '.' + key : key;
          if (val && typeof val === 'object') walk(val, next, depth + 1);
          else if (INTEREST.test(key) || INTEREST.test(path)) out[next] = val;
        }
      })(parsed, '', 0);
      console.log('[Notion Unlock] verify (AFTER patch)', entry.url, out);
      return out;
    },

    /**
     * How string tier fields are rewritten:
     *   'strip' (default) — "business_trial" -> "business"
     *   'off'             — leave tier strings alone
     *   any string        — force that literal, e.g. setTier('free')
     */
    setTier(mode) {
      try { rawSetItem.call(localStorage, TIER_MODE_KEY, mode); } catch (_) {}
      console.log('[Notion Unlock] tier mode →', mode, '— reloading');
      location.reload();
    },

    /** Toggle the subscription rewrite (on by default) and reload. */
    setPlanPatch(on) {
      try { rawSetItem.call(localStorage, PLAN_FLAG_KEY, on ? 'on' : 'off'); } catch (_) {}
      console.log('[Notion Unlock] plan patch →', on ? 'ON' : 'OFF', '— reloading');
      location.reload();
    },
  };

  console.log('[Notion Unlock] armed — gates:', Object.keys(GATES).length, '| debug: __notionUnlock.scan()');
})();
