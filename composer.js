/**
 * In-page model + reasoning-effort picker.
 *
 * Both are written to the agent thread record (inject.js), which is what the
 * server runs the chat with; the trial hides Notion's own model menu. The
 * block at the top always shows what the server record says, not what was
 * picked, so a pick the server refused is visible.
 *
 * Runs in the ISOLATED world for chrome.storage access and talks to inject.js
 * (MAIN world) over window.postMessage. UI lives in a shadow root so Notion's
 * stylesheet cannot reach it.
 */
(function () {
  'use strict';

  if (window.__notionEffortComposer) return;
  window.__notionEffortComposer = true;

  const merge = globalThis.NOTION_EFFORT_MERGE_CATALOGUE || (() => globalThis.NOTION_EFFORT_MODELS || []);
  const normName = globalThis.NOTION_EFFORT_NORMALIZE_NAME || ((n) => String(n || '').toLowerCase());

  // Ids learned at runtime (Notion's catalogue, or request id + menu label),
  // persisted so a new model is recognised from the first request next time.
  let learned = [];
  let MODELS = merge(learned);

  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
  const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];
  // Notion's full scale, for showing a model's range (Grok 4.6: Low–XHigh).
  const EFFORT_SCALE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const RANGE_LABELS = Object.assign({ minimal: 'Minimal', xhigh: 'XHigh' }, EFFORT_LABELS);
  const EFFORT_HINTS = {
    low: 'Fastest, least thinking',
    medium: 'Balanced',
    high: 'More thinking, slower',
    max: 'Most thinking, slowest',
  };

  const state = {
    effort: null, // null = leave Notion's own choice alone
    model: null, // codename; null = Notion's Auto
    open: false,
    swaps: 0,
    lastApplied: null,
    menuModel: null,
    seen: null,
    agent: null,
    agentPref: null,
    policy: null, // workspace allowed-models write (inject.js applyPolicy)
    spaceModels: null, // codenames the workspace offers (getAvailableModels), null = not read yet
    spaceInfo: {}, // codename -> limits from the workspace catalogue (efforts, default, flags)
    limitsOpen: false,
    oldChatUrl: null, // last page whose AI chat sent runInferenceTranscript (classic chat)
  };

  function modelById(id) {
    return MODELS.find((m) => m.model === id) || null;
  }

  /** A pick the catalogue has since marked restricted falls back to Auto. */
  function enforcePickable() {
    if (!state.model) return;
    const m = modelById(state.model);
    if (m && m.restricted) {
      state.model = null;
      chrome.storage.local.set({ selectedModel: null });
    }
  }

  /** Effort ceilings per model, so inject.js can lower an unsupported ask. */
  function effortsByModel() {
    const map = {};
    MODELS.forEach((m) => {
      // null = ceiling unknown (learned model): leave it out so nothing is clamped.
      if (Array.isArray(m.efforts)) map[m.model] = m.efforts;
    });
    return map;
  }

  function learn(entries) {
    let added = 0;
    entries.forEach((e) => {
      if (!e || !e.model) return;
      const had = learned.find((l) => l.model === e.model);
      if (had) {
        // The workspace catalogue is authoritative: refresh what it says.
        if (e.source !== 'workspace') return;
        const efforts = Array.isArray(e.efforts) ? e.efforts : null;
        if (had.name === e.name && JSON.stringify(had.efforts) === JSON.stringify(efforts) && had.family === e.family) return;
        Object.assign(had, { name: e.name || had.name, efforts: efforts, family: e.family || had.family, source: 'workspace' });
        added++;
        return;
      }
      learned.push({
        model: e.model,
        name: e.name || e.model,
        efforts: e.efforts || null,
        family: e.family || undefined,
        source: e.source || 'catalogue',
      });
      added++;
    });
    if (!added) return false;
    MODELS = merge(learned);
    enforcePickable();
    chrome.storage.local.set({ learnedModels: learned });
    pushSettings();
    return true;
  }

  // ------------------------------------------------------- Notion's own menu

  const AUTO_LABEL = /^auto$/i;
  const MODEL_WORD = /(opus|sonnet|haiku|fable|claude|gpt|gemini|grok|kimi|deepseek|glm)/i;

  /**
   * The label on Notion's model button next to the composer ("Auto",
   * "Opus 5.5", ...). Read by text, not class names, so a redesign of the menu
   * does not break it. Returns null when nothing model-like is on screen.
   */
  function readMenuModel() {
    const found = findComposer();
    if (!found) return null;
    let node = found.el;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      const buttons = node.querySelectorAll('button, [role="button"], [aria-haspopup]');
      for (const b of buttons) {
        const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40) continue;
        if (AUTO_LABEL.test(text)) return 'Auto';
        if (MODELS.some((m) => normName(m.name) === normName(text))) return text;
        if (MODEL_WORD.test(text)) return text;
      }
    }
    return null;
  }

  /**
   * A request id we do not know, sent while the menu names a model: that pairs
   * the codename with its display name (this is how Opus 5.5 gets its id).
   * Never done for "Auto", and never over a name that already has an id.
   */
  function learnFromMenu(id, label) {
    if (!id || !label || AUTO_LABEL.test(label) || modelById(id)) return;
    if (MODELS.some((m) => normName(m.name) === normName(label))) return;
    if (learn([{ model: id, name: label, source: 'menu' }])) {
      console.log('[Notion Effort] learned', id, '=', label, '(from Notion model menu)');
    }
  }

  // ---------------------------------------------------------------- shadow UI

  const host = document.createElement('div');
  host.id = 'notion-effort-picker';
  host.style.cssText = 'position:fixed;z-index:2147483000;top:0;left:0;width:0;height:0;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }

      .pill {
        position: fixed;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 8px 0 7px;
        border-radius: 7px;
        border: 1px solid rgba(255,255,255,0.13);
        background: #252525;
        color: #e9e9e7;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        transition: background 120ms ease, border-color 120ms ease;
      }
      .pill:hover { background: #2f2f2f; }
      .pill.ok { border-color: rgba(76,183,130,0.7); }
      .pill.warn { border-color: rgba(214,167,74,0.7); }
      .pill.err { border-color: rgba(235,100,95,0.7); }
      .pill .eff {
        font-size: 10px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        padding: 2px 4px;
        border-radius: 4px;
        background: rgba(255,255,255,0.09);
        color: #bdbdb8;
      }
      .pill .eff.on { background: #3b6ef0; color: #fff; }
      /* Picked, but the chat runs something else: picked struck out, real next to it. */
      .pill .eff.was, .pill .pwant { text-decoration: line-through; opacity: 0.55; }
      .pill .eff.was { background: rgba(255,255,255,0.09); color: #bdbdb8; }
      .pill .pwant { color: #bdbdb8; }
      .pill .real {
        font-size: 10px; letter-spacing: 0.03em; text-transform: uppercase;
        padding: 2px 4px; border-radius: 4px;
        background: rgba(255,255,255,0.16); color: #e9e9e7;
      }
      .pill .real::before { content: '→ '; }
      .pill .real.err { background: #eb645f; color: #fff; }
      .pill .real.warn { background: #d6a74a; color: #1d1d1d; }
      .model .mmeta b.err { color: #eb645f; }
      .model .mmeta b.warn { color: #d6a74a; }
      .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: #5c5c5c; }
      .pill .dot.ok { background: #4cb782; }
      .pill .dot.warn { background: #d6a74a; }
      .pill .dot.err { background: #eb645f; }

      .menu {
        position: fixed;
        width: 300px;
        max-height: calc(100vh - 16px);
        display: flex;
        flex-direction: column;
        background: #252525;
        border: 1px solid rgba(255,255,255,0.11);
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.55);
        overflow: hidden;
        color: #e9e9e7;
      }
      .head {
        padding: 9px 10px 5px;
        font-size: 11px;
        font-weight: 600;
        color: #8b8b87;
      }
      .seg { display: flex; gap: 3px; padding: 0 8px 8px; flex: none; }
      .seg button {
        flex: 1; height: 28px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
        background: #2c2c2c; color: #d4d4d0; font-size: 12px; cursor: pointer; padding: 0;
      }
      .seg button:hover { background: #353535; }
      .seg button.sel { background: #3b6ef0; border-color: #3b6ef0; color: #fff; }
      .seg button.na { opacity: .38; }
      .effnote { padding: 0 10px 6px; font-size: 11px; color: #8a8f98; flex: none; }
      .effnote:empty { display: none; }
      .search { padding: 0 8px 6px; flex: none; }
      .search input {
        width: 100%; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
        background: #1d1d1d; color: #e9e9e7; font-size: 12.5px; padding: 0 8px; outline: none;
      }
      .search input:focus { border-color: #3b6ef0; }
      .mlist { padding: 0 6px 6px; overflow-y: auto; flex: 1 1 auto; min-height: 60px; }
      .mlist .row { padding: 5px 8px; font-size: 13px; }
      .mlist .empty { padding: 8px; font-size: 12px; color: #71716e; }
      .head { flex: none; }
      .model { flex: none; }
      .pnote { padding: 0 10px 6px; font-size: 11px; line-height: 1.35; color: #8a8f98; flex: none; }
      .pnote:empty { display: none; }
      .pnote.bad { color: #d9a44a; }
      .row .cur { font-size: 10px; color: #6f95f5; flex: none; }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13.5px;
      }
      .row:hover { background: rgba(255,255,255,0.055); }
      .row.sel { background: rgba(255,255,255,0.075); }
      .row .name { flex: none; }
      .row .hint { flex: 1; font-size: 11px; color: #71716e; text-align: right; }
      .row .check { color: #e9e9e7; flex: none; }
      .mlist .note { padding: 2px 8px 6px; font-size: 11px; line-height: 1.35; color: #d9a44a; }
      .mlist .note.ok { color: #8a8f98; }
      .mlist .grp { padding: 7px 8px 2px; font-size: 10.5px; color: #6f6f6b; text-transform: uppercase; letter-spacing: .04em; }

      .model {
        padding: 9px 10px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .model .lbl { font-size: 11px; font-weight: 600; color: #8b8b87; }
      .model .mname { margin-top: 4px; font-size: 14px; font-weight: 600; color: #e9e9e7; }
      .model .mmeta { margin-top: 2px; font-size: 11px; color: #8b8b87; }
      .model .mmeta b { color: #e9e9e7; font-weight: 600; }
      .model .mmeta .warn { color: #d6a74a; }
      .pill .chk {
        font-size: 11px; font-weight: 700; line-height: 1;
        padding: 2px 4px; border-radius: 4px; background: rgba(255,255,255,0.12); color: #e9e9e7;
      }
      .pill .chk.ok { background: #2f7d57; color: #fff; }
      .pill .chk.warn { background: #d6a74a; color: #1d1d1d; }
      .pill .chk.err { background: #eb645f; color: #fff; }
      .model .mcheck { margin-top: 6px; padding: 5px 7px; border-radius: 6px; font-size: 12px; font-weight: 600;
        background: rgba(255,255,255,0.06); color: #c8c8c4; }
      .model .mcheck.ok { background: rgba(76,183,130,0.16); color: #7fc99a; }
      .model .mcheck.warn { background: rgba(214,167,74,0.16); color: #e3bd6f; }
      .model .mcheck.err { background: rgba(235,100,95,0.18); color: #f19a96; }
      .foot {
        flex: none;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding: 7px 10px;
        font-size: 11.5px;
        color: #8b8b87;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .foot .sd { width: 6px; height: 6px; border-radius: 50%; background: #5c5c5c; flex: none; }
      .foot .sd.ok { background: #4cb782; }
      .foot .sd.warn { background: #d6a74a; }
      .foot .sd.err { background: #eb645f; }
      .foot .txt { flex: 1; }
      .logbtn, .logcopy {
        flex: none; font: inherit; font-size: 11px; color: #c8c8c4; cursor: pointer;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 5px; padding: 2px 7px;
      }
      .logbtn:hover, .logcopy:hover { background: rgba(255,255,255,0.12); }
      .logbtn[aria-expanded="true"] { background: #1f4fd1; border-color: #1f4fd1; color: #fff; }
      .log {
        flex: none; border-top: 1px solid rgba(255,255,255,0.08);
        display: flex; flex-direction: column; max-height: 220px;
      }
      .logbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px 4px; font-size: 11px; color: #8b8b87;
      }
      .logbody {
        overflow-y: auto; padding: 0 10px 8px; user-select: text;
        font: 11px/1.45 ui-monospace, Consolas, monospace; color: #c8c8c4;
      }
      .logbody .row { white-space: pre-wrap; word-break: break-word; }
      .logbody .t { color: #6f6f6b; }
      .logbody .k { color: #8fb3ff; }
      .logbody .bad { color: #eb8a86; }
      .logbody .good { color: #7fc99a; }
      .runs { flex: none; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; max-height: 260px; }
      .limits { flex: none; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; max-height: 420px; }
      .credits { padding: 4px 10px 6px; display: flex; flex-direction: column; gap: 6px; flex: none; max-height: 190px; overflow-y: auto; }
      .credits .cnote { font-size: 11px; line-height: 1.35; color: #8b8b87; }
      .credits .ccard { border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 6px 8px; }
      .credits .ctitle { font-size: 11px; font-weight: 600; color: #c8c8c4; margin-bottom: 4px; }
      .credits .cpct { font-size: 12px; font-weight: 600; color: #e9e9e7; }
      .credits .cbar { height: 6px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; margin: 3px 0 5px; }
      .credits .cbar > i { display: block; height: 100%; background: #4cb782; }
      .credits .cbar.warn > i { background: #d6a74a; }
      .credits .cbar.bad > i { background: #eb645f; }
      .credits .crow { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: #8b8b87; }
      .credits .crow b { color: #e9e9e7; font-weight: 500; text-align: right; word-break: break-word; }
      .limbody { overflow-y: auto; padding: 0 10px 8px; font-size: 11.5px; color: #c8c8c4; }
      .limbody .lrow { display: flex; align-items: baseline; gap: 6px; padding: 2px 0; }
      .limbody .lname { flex: none; max-width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .limbody .lbar { flex: 1; color: #71716e; font-size: 10.5px; letter-spacing: .02em; }
      .limbody .lbar b { color: #a9d9bd; font-weight: 600; }
      .limbody .lbar i { color: #d6a74a; font-style: normal; }
      .limbody .lflag { flex: none; font-size: 10px; color: #d6a74a; }
      .limbody .lflag.bad { color: #eb8a86; }
      .limbody .lgap { color: #71716e; font-size: 10.5px; padding: 2px 0; }
      .limbar { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px 4px; font-size: 11px; color: #8b8b87; gap: 8px; }
      .limsum { font-size: 10.5px; color: #8f8f8b; text-align: right; }
      .runsbody { overflow-y: auto; padding: 0 10px 8px; user-select: text; font-size: 12px; color: #c8c8c4; }
      .runsbody .run { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
      .runsbody .run:last-child { border-bottom: 0; }
      .runsbody .rtop { display: flex; justify-content: space-between; gap: 8px; }
      .runsbody .rname { font-weight: 600; color: #ececea; }
      .runsbody .rtime { color: #6f6f6b; font-size: 11px; flex: none; }
      .runsbody .rsub { color: #8b8b87; font-size: 11px; margin-top: 2px; word-break: break-word; }
      .runsbody .ok { color: #7fc99a; }
      .runsbody .no { color: #eb8a86; }
      .watch { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #c8c8c4; cursor: pointer; }
      .watchnote { padding: 0 10px 6px; font-size: 11px; color: #d6a74a; }
      .runs { max-height: 260px; }
      .oldrow { flex: none; padding: 8px 10px 0; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid rgba(255,255,255,0.08); }
      .oldrow .oldbtn, .oldrow .findbtn { width: 100%; padding: 6px 8px; text-align: center; }
      .oldnote { font-size: 11px; line-height: 1.35; color: #d6a74a; }
      .oldnew { display: flex; gap: 4px; }
      .oldnew input {
        flex: 1; min-width: 0; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
        background: #1d1d1d; color: #e9e9e7; font-size: 12px; padding: 0 8px; outline: none;
      }
      .oldnew input:focus { border-color: #3b6ef0; }
      .oldnew .createbtn { width: auto; flex: none; padding: 4px 8px; }
      .oldnew .createbtn:disabled { opacity: 0.5; cursor: default; }
      .hidden { display: none !important; }
    </style>

    <button class="pill" type="button" part="pill">
      <span class="dot"></span>
      <span class="chk hidden"></span>
      <span class="pwant hidden"></span>
      <span class="pname">Effort</span>
      <span class="eff">Auto</span>
      <span class="real hidden"></span>
    </button>

    <div class="menu hidden">
      <div class="model">
        <div class="lbl">Model in this chat (from Notion server)</div>
        <div class="mname">Send a message to see the model</div>
        <div class="mmeta"></div>
        <div class="mcheck hidden"></div>
      </div>
      <div class="head">Reasoning effort</div>
      <div class="seg"></div>
      <div class="effnote"></div>
      <div class="head">Model</div>
      <div class="pnote"></div>
      <div class="search"><input type="text" placeholder="Search models…" spellcheck="false"></div>
      <div class="mlist"></div>
      <div class="runs hidden">
        <div class="logbar"><span>Which model answered (newest first)</span><label class="watch"><input type="checkbox" class="watchbox"> Watch only</label></div>
        <div class="watchnote hidden">Watch only: the extension changes nothing. Set the model in Notion Settings → Notion AI → Model controls.</div>
        <div class="runsbody"></div>
      </div>
      <div class="log hidden">
        <div class="logbar"><span>What happened (newest last)</span><button class="logcopy" type="button">Copy</button></div>
        <div class="logbody"></div>
      </div>
      <div class="limits hidden">
        <div class="logbar"><span>Credits &amp; limits</span><span class="limsum"></span></div>
        <div class="credits"></div>
        <div class="limbody"></div>
      </div>
      <div class="oldrow">
        <div class="oldnew">
          <input class="oldmsg" type="text" placeholder="First message (empty = Hi)" spellcheck="false">
          <button class="logbtn oldbtn createbtn" type="button">New old AI chat</button>
        </div>
        <button class="logbtn findbtn" type="button" title="Looks for your onboarding chat (Welcome to Notion) in every page of your chat lists and opens it. If there is none, creates a new classic chat (first message from the field above)">Find onboarding chat or create</button>
        <div class="oldnote hidden"></div>
      </div>
      <div class="foot">
        <span class="sd"></span>
        <span class="txt">No AI requests seen yet — send a message</span>
        <button class="logbtn chatbtn" type="button" aria-expanded="false">Chat</button>
        <button class="logbtn limbtn" type="button" aria-expanded="false">Limits</button>
        <button class="logbtn logtgl" type="button" aria-expanded="false">Log</button>
      </div>
    </div>
  `;

  const pill = shadow.querySelector('.pill');
  const pillEff = shadow.querySelector('.eff');
  const pillDot = shadow.querySelector('.dot');
  const pillName = shadow.querySelector('.pname');
  const pillWant = shadow.querySelector('.pwant');
  const pillReal = shadow.querySelector('.real');
  const modelLbl = shadow.querySelector('.model .lbl');
  const modelName = shadow.querySelector('.mname');
  const modelMeta = shadow.querySelector('.mmeta');
  const pillChk = shadow.querySelector('.pill .chk');
  const mCheck = shadow.querySelector('.mcheck');
  const menu = shadow.querySelector('.menu');
  const seg = shadow.querySelector('.seg');
  const effNote = shadow.querySelector('.effnote');
  const pNote = shadow.querySelector('.pnote');
  const search = shadow.querySelector('.search input');
  const mlist = shadow.querySelector('.mlist');
  const footDot = shadow.querySelector('.sd');
  const footTxt = shadow.querySelector('.txt');
  const logBox = shadow.querySelector('.log');
  const logBody = shadow.querySelector('.logbody');
  // '.logbtn:not(.chatbtn)' used to match the Limits button first, so Log never toggled.
  const logBtn = shadow.querySelector('.logtgl');
  const chatBtn = shadow.querySelector('.chatbtn');
  const oldBtn = shadow.querySelector('.oldbtn');
  const oldNote = shadow.querySelector('.oldnote');
  const findBtn = shadow.querySelector('.findbtn');
  const createBtn = shadow.querySelector('.createbtn');
  const oldMsg = shadow.querySelector('.oldmsg');
  const runsBox = shadow.querySelector('.runs');
  const runsBody = shadow.querySelector('.runsbody');
  const limBox = shadow.querySelector('.limits');
  const limBody = shadow.querySelector('.limbody');
  const creditsBox = shadow.querySelector('.credits');
  const limSum = shadow.querySelector('.limsum');
  const limBtn = shadow.querySelector('.limbtn');
  const watchBox = shadow.querySelector('.watchbox');
  const watchNote = shadow.querySelector('.watchnote');
  let runs = [];
  let watchOnly = false;
  let runsOpen = false;

  function renderRuns() {
    watchBox.checked = watchOnly;
    watchNote.classList.toggle('hidden', !watchOnly);
    runsBody.textContent = '';
    if (!runs.length) {
      runsBody.textContent = 'Send a message: each one shows here with the model that really answered.';
      return;
    }
    runs.slice().reverse().forEach((r) => {
      const row = document.createElement('div');
      row.className = 'run';
      const top = document.createElement('div');
      top.className = 'rtop';
      const name = document.createElement('span');
      name.className = 'rname';
      const known = r.ran && modelById(r.ran);
      const label = known ? known.name : r.ranName;
      name.textContent = r.ran ? label + (r.effort ? ' · ' + r.effort : '') : 'waiting for the answer…';
      const time = document.createElement('span');
      time.className = 'rtime';
      time.textContent = new Date(r.at).toLocaleTimeString() + (r.isNew ? ' · new chat' : '');
      top.append(name, time);
      const sub = document.createElement('div');
      sub.className = 'rsub';
      sub.textContent = (r.ran && label !== r.ran ? 'id ' + r.ran + ' · ' : '') +
        (r.selection ? 'selection ' + r.selection + ' · ' : '') +
        'workspace allowed: ' + r.allowed +
        (r.picked ? ' · panel pick: ' + (modelById(r.picked) ? modelById(r.picked).name : r.picked) : '') +
        (r.watchOnly ? ' · watch only' : '');
      row.append(top, sub);
      if (r.inList != null) {
        const v = document.createElement('div');
        v.className = 'rsub ' + (r.inList ? 'ok' : 'no');
        v.textContent = r.inList ? 'In the allowed list ✓' : 'NOT in the allowed list: Notion chose it itself';
        row.appendChild(v);
      }
      if (r.fix) {
        const f = document.createElement('div');
        f.className = 'rsub ok';
        f.textContent = r.fix;
        row.appendChild(f);
      }
      runsBody.appendChild(row);
    });
  }

  /** Effort ceiling and flags as the workspace catalogue reported them. */
  // ---------------------------------------------------------------- credits
  //
  // Usage figures Notion sent (inject.js keeps every answer whose fields look
  // like credits / usage / limits / reset time). Shown as found: a percent bar
  // when the numbers allow it, then the fields themselves, dates as local time.
  let usageEntries = [];
  let usageNote = null;
  const PCT_RE = /percent|pct/i;
  const WHEN_RE = /reset|expire|until|end|start|renew|time|date|period|at$/i;

  function whenText(ms) {
    if (!isFinite(ms)) return '?';
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    const h = Math.floor(abs / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const rel = h >= 48 ? Math.round(h / 24) + ' d' : h ? h + ' h ' + m + ' min' : m + ' min';
    return new Date(ms).toLocaleString() + (diff >= 0 ? ' (in ' + rel + ')' : ' (' + rel + ' ago)');
  }
  function usageKey(path) {
    const parts = String(path).replace(/\[\d+\]/g, '').split('.').filter(Boolean);
    return parts.slice(-2).join(' › ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  }
  function usageValue(path, v) {
    if (typeof v === 'number' && WHEN_RE.test(path) && v > 1e9) return whenText(v > 1e12 ? v : v * 1000);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return whenText(Date.parse(v));
    if (typeof v === 'number' && PCT_RE.test(path)) return Math.round((v <= 1 && !Number.isInteger(v) ? v * 100 : v) * 10) / 10 + '%';
    if (typeof v === 'number') return v.toLocaleString();
    return String(v);
  }
  function usagePercent(fields) {
    const num = (re, not) => fields.find((f) => typeof f.value === 'number' && re.test(f.path) && !(not && not.test(f.path)));
    const pct = num(PCT_RE);
    if (pct) return pct.value <= 1 && !Number.isInteger(pct.value) ? pct.value * 100 : pct.value;
    const lim = num(/(limit|total|quota|allowance|max|cap)/i, /(used|consumed|spent|remaining|percent|pct|reset)/i);
    const used = num(/(used|consumed|spent)/i, /percent|pct/i);
    if (used && lim && lim.value > 0) return (used.value / lim.value) * 100;
    const rem = num(/remaining/i, /percent|pct/i);
    if (rem && lim && lim.value > 0) return (1 - rem.value / lim.value) * 100;
    return null;
  }
  function renderCredits() {
    creditsBox.textContent = '';
    if (!usageEntries.length) {
      const p = document.createElement('div');
      p.className = 'cnote';
      p.textContent = usageNote || 'Credits: reading usage from Notion…';
      creditsBox.appendChild(p);
      return;
    }
    usageEntries.forEach((e) => {
      const card = document.createElement('div');
      card.className = 'ccard';
      const title = document.createElement('div');
      title.className = 'ctitle';
      title.textContent = 'Credits · ' + String(e.url).replace(/^\/api\/v3\//, '') + ' · ' + new Date(e.at).toLocaleTimeString();
      card.appendChild(title);
      const pct = usagePercent(e.fields || []);
      if (pct != null && isFinite(pct)) {
        const p = Math.max(0, Math.min(100, pct));
        const line = document.createElement('div');
        line.className = 'cpct';
        line.textContent = Math.round(p) + '% used · ' + Math.round(100 - p) + '% left';
        const bar = document.createElement('div');
        bar.className = 'cbar' + (p >= 90 ? ' bad' : p >= 70 ? ' warn' : '');
        const fill = document.createElement('i');
        fill.style.width = p + '%';
        bar.appendChild(fill);
        card.append(line, bar);
      }
      (e.fields || []).slice(0, 14).forEach((f) => {
        const row = document.createElement('div');
        row.className = 'crow';
        const k = document.createElement('span');
        k.textContent = usageKey(f.path);
        k.title = f.path;
        const v = document.createElement('b');
        v.textContent = usageValue(f.path, f.value);
        row.append(k, v);
        card.appendChild(row);
      });
      creditsBox.appendChild(card);
    });
    if (usageNote) {
      const n = document.createElement('div');
      n.className = 'cnote';
      n.textContent = usageNote;
      creditsBox.appendChild(n);
    }
  }

  function limitsOf(id) {
    const info = state.spaceInfo[id];
    const m = modelById(id);
    const efforts = info && info.efforts ? info.efforts : m && Array.isArray(m.efforts) ? m.efforts : null;
    return { info: info || null, efforts: efforts, name: m ? m.name : id };
  }

  function effortSpan(efforts) {
    const e = EFFORT_SCALE.filter((x) => (efforts || []).indexOf(x) !== -1);
    if (!efforts) return 'unknown';
    if (!efforts.length) return 'no effort';
    if (!e.length) return efforts.join(', ');
    return e.length === 1 ? RANGE_LABELS[e[0]] : RANGE_LABELS[e[0]] + '–' + RANGE_LABELS[e[e.length - 1]];
  }

  /**
   * One row per model the picker offers: its effort ceiling, the effort the
   * server picks when nothing is written, and Notion's own limit flags. Marks
   * the picked model's row and says whether the picked effort clears its ceiling.
   */
  function renderLimits() {
    if (!state.limitsOpen) return;
    limBody.textContent = '';
    const offered = state.spaceModels;
    const rows = MODELS
      .filter((m) => (!offered || offered.indexOf(m.model) !== -1))
      .sort((a, b) => (a.family === b.family ? 0 : a.family < b.family ? -1 : 1));
    let nearLimit = 0;
    let blocked = 0;
    if (!rows.length) {
      limBody.textContent = 'No workspace catalogue read yet. Send a message first.';
      limSum.textContent = '';
      return;
    }
    rows.forEach((m) => {
      const L = limitsOf(m.model);
      const info = L.info || {};
      const row = document.createElement('div');
      row.className = 'lrow';
      const name = document.createElement('span');
      name.className = 'lname';
      name.textContent = m.name + (m.model === state.model ? ' (picked)' : '');
      name.title = m.model;
      const bar = document.createElement('span');
      bar.className = 'lbar';
      // The ceiling, with the default effort named: that is what a reset lands on.
      bar.append(effortSpan(L.efforts));
      if (info.defaultEffort) {
        bar.append(' · default ');
        const d = document.createElement('b');
        d.textContent = E(info.defaultEffort);
        bar.append(d);
      }
      const want = state.effort && m.model === (state.model || (state.agent && state.agent.model)) ? state.effort : null;
      if (want && Array.isArray(L.efforts) && L.efforts.indexOf(want) === -1) {
        bar.append(' · ');
        const w = document.createElement('i');
        w.textContent = E(want) + ' not supported';
        w.title = 'the nearest lower one is sent instead';
        bar.append(w);
      }
      row.append(name, bar);
      const flags = [];
      if (info.rateLimit) { flags.push('near rate limit'); nearLimit++; }
      if (info.outage) { flags.push('off (Notion outage)'); blocked++; }
      if (info.disabled) { flags.push('off for this workspace'); blocked++; }
      if (info.optIn) flags.push('opt-in');
      if (info.credit) flags.push('uses credits');
      if (flags.length) {
        const f = document.createElement('span');
        f.className = 'lflag' + (info.rateLimit || info.outage || info.disabled ? ' bad' : '');
        f.textContent = flags.join(', ');
        row.appendChild(f);
      }
      limBody.appendChild(row);
    });
    const sums = [];
    if (nearLimit) sums.push(nearLimit + ' near rate limit');
    if (blocked) sums.push(blocked + ' unavailable');
    if (!sums.length) sums.push('all ' + rows.length + ' available');
    limSum.textContent = sums.join(' · ');
  }

  limBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.limitsOpen = !state.limitsOpen;
    limBtn.setAttribute('aria-expanded', String(state.limitsOpen));
    limBox.classList.toggle('hidden', !state.limitsOpen);
    if (state.limitsOpen) {
      window.postMessage({ type: 'NOTION_EFFORT_SPACE_MODELS_REQUEST' }, '*');
      window.postMessage({ type: 'NOTION_EFFORT_USAGE_REQUEST' }, '*');
      renderCredits();
    }
    renderLimits();
  });

  chatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runsOpen = !runsOpen;
    chatBtn.setAttribute('aria-expanded', String(runsOpen));
    runsBox.classList.toggle('hidden', !runsOpen);
    if (runsOpen) {
      window.postMessage({ type: 'NOTION_EFFORT_RUNS_REQUEST' }, '*');
    }
    renderRuns();
  });
  // ------------------------------------------------------------ old AI chat
  //
  // The classic Notion AI chat sends /api/v3/runInferenceTranscript: that is
  // where model and effort get swapped. The new chat (agent threads) carries
  // neither. inject.js reports the page of every runInferenceTranscript call
  // (NOTION_EFFORT_OLD_CHAT). The button goes to that chat and presses
  // Notion's own "New chat" button in its header, so Notion itself creates
  // the next chat. Since 2.77 that is only the fallback: the button first
  // asks inject.js to create the classic chat itself (first message included).
  const NOTION_ORIGINS = ['https://app.notion.com', 'https://www.notion.so', 'https://notion.so'];
  const PENDING_KEY = 'oldChatPending';
  const PENDING_TTL = 30000;
  const NEW_CHAT_LABEL = /^(new (ai )?chat|start (a )?new chat|новый чат|создать чат)$/i;

  function isNotionUrl(href) {
    try {
      const o = new URL(href).origin;
      return o === location.origin || NOTION_ORIGINS.indexOf(o) !== -1;
    } catch (e) {
      return false;
    }
  }
  /** Same chat: same origin + path and the same thread (?t=). */
  function sameChat(a, b) {
    try {
      const x = new URL(a), y = new URL(b);
      return x.origin === y.origin && x.pathname === y.pathname && x.searchParams.get('t') === y.searchParams.get('t');
    } catch (e) {
      return false;
    }
  }
  function renderOldChat(note) {
    oldBtn.title = 'Creates a new classic Notion AI chat itself (first message from the field, empty = Hi) and opens it' +
      (state.oldChatUrl ? '. Fallback: ' + state.oldChatUrl : '');
    oldNote.textContent = note || '';
    oldNote.classList.toggle('hidden', !note);
  }
  function labelOf(el) {
    return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ');
  }
  /** Notion's own "New chat" control: matched by its label, topmost visible one wins. */
  function findNewChatButton() {
    let best = null;
    document.querySelectorAll('[role="button"], button, a').forEach((el) => {
      if (!NEW_CHAT_LABEL.test(labelOf(el))) return;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > window.innerHeight) return;
      if (!best || r.top < best.top) best = { el, top: r.top };
    });
    return best ? best.el : null;
  }
  function clickNewChat(timeoutMs) {
    return new Promise((resolve) => {
      const started = Date.now();
      (function tick() {
        const btn = findNewChatButton();
        if (btn) {
          btn.click();
          resolve(true);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(tick, 300);
      })();
    });
  }
  async function newChatHere(timeoutMs) {
    const ok = await clickNewChat(timeoutMs);
    if (ok) return;
    setOpen(true);
    renderOldChat('Notion\'s "New chat" button was not found on this page. Press it in the chat header yourself.');
  }
  function openOldChat() {
    renderOldChat();
    const saved = state.oldChatUrl;
    if (!saved || !isNotionUrl(saved)) {
      renderOldChat('No classic chat known yet in this Notion (browser and desktop remember separately). Press "Find onboarding chat", or open the classic chat yourself and send one message there: the footer should then say "patched" or "already matched". After that this button makes new ones from there.');
      return;
    }
    setOpen(false);
    if (sameChat(saved, location.href)) {
      newChatHere(8000);
      return;
    }
    // Remember the intent across the page load, then go to the classic chat.
    let gone = false;
    const go = () => {
      if (gone) return;
      gone = true;
      location.assign(saved);
    };
    try {
      chrome.storage.local.set({ [PENDING_KEY]: { at: Date.now(), url: saved } }, go);
    } catch (e) {}
    setTimeout(go, 400);
  }
  function resumePendingNewChat(pending) {
    if (!pending || !pending.at || Date.now() - pending.at > PENDING_TTL) return;
    chrome.storage.local.set({ [PENDING_KEY]: null });
    if (!sameChat(pending.url, location.href)) return;
    newChatHere(15000);
  }

  // Onboarding chat: inject.js looks it up in the chat list Notion loaded.
  let findTimer = 0;
  function chatUrlFor(id) {
    // Same address shape as the classic chat seen so far, with this thread.
    try {
      if (state.oldChatUrl) {
        const u = new URL(state.oldChatUrl);
        if (u.searchParams.has('t')) {
          u.searchParams.set('t', id);
          u.hash = '';
          return u.href;
        }
      }
    } catch (e) {}
    return location.origin + '/chat?t=' + id;
  }
  function onOnboarding(d) {
    clearTimeout(findTimer);
    if (!d.found || !d.id) {
      // Not there: make a classic chat instead, so the button always ends in a chat.
      const where = d.reason === 'no-list'
        ? 'Notion has not loaded your chat list in this tab'
        : 'not among ' + (d.total != null ? d.total : d.listed != null ? d.listed : 'the') + ' chats' + (d.pages ? ' (' + d.pages + ' list pages)' : '');
      renderOldChat('No onboarding chat: ' + where + '. Creating a new classic chat…');
      createOldChatNow(true);
      return;
    }
    const url = chatUrlFor(d.id);
    if (sameChat(url, location.href)) {
      renderOldChat('You are in the onboarding chat already.');
      return;
    }
    renderOldChat('Opening "' + (d.title || 'onboarding chat') + '"…');
    setOpen(false);
    location.assign(url);
  }
  findBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renderOldChat('Looking for the onboarding chat in all your chat lists…');
    clearTimeout(findTimer);
    findTimer = setTimeout(() => renderOldChat('No answer from the page script. Reload the Notion tab and try again.'), 60000);
    window.postMessage({ type: 'NOTION_EFFORT_FIND_ONBOARDING' }, '*');
  });


  // Create a classic chat: inject.js sends the first message itself
  // (runInferenceTranscript with createThread) and reports back, then the
  // new chat is opened.
  let createTimer = 0;
  function setCreating(on) {
    createBtn.disabled = on;
    createBtn.textContent = on ? 'Creating…' : 'New old AI chat';
  }
  function armCreateTimer(ms) {
    clearTimeout(createTimer);
    createTimer = setTimeout(() => {
      setCreating(false);
      renderOldChat('No answer from the page script. Reload the Notion tab and try again.');
    }, ms);
  }
  function createOldChatNow(keepNote) {
    if (createBtn.disabled) return;
    setCreating(true);
    if (keepNote !== true) renderOldChat('Creating a classic chat…');
    armCreateTimer(10000);
    window.postMessage({ type: 'NOTION_EFFORT_CREATE_OLD_CHAT', text: oldMsg.value }, '*');
  }
  function onOldChatCreate(d) {
    if (d.status === 'sending') {
      armCreateTimer(60000);
      return;
    }
    if (d.status === 'verifying') {
      armCreateTimer(30000);
      renderOldChat('Checking that Notion saved the chat…');
      return;
    }
    if (d.status === 'answering') {
      armCreateTimer(160000);
      renderOldChat('Chat created, Notion is writing the first answer. It opens when the answer is done.');
      return;
    }
    if (d.status === 'busy') {
      renderOldChat('A classic chat is being created already, wait for it.');
      return;
    }
    clearTimeout(createTimer);
    setCreating(false);
    if (d.status === 'created' && d.id) {
      oldMsg.value = '';
      renderOldChat('Created and saved by Notion' + (d.timedOut ? ' (the answer is still running)' : '') + '. Opening…');
      setOpen(false);
      const url = chatUrlFor(d.id);
      let gone = false;
      const go = () => {
        if (gone) return;
        gone = true;
        location.assign(url);
      };
      try {
        chrome.storage.local.set({ oldChatOpened: { at: Date.now(), id: d.id, type: d.recordType || null } }, go);
      } catch (x) {}
      setTimeout(go, 400);
      return;
    }
    if (state.oldChatUrl && isNotionUrl(state.oldChatUrl)) {
      // Direct creation failed: go the old way (open the known classic chat
      // and press Notion's New chat there). The reason is in Log.
      openOldChat();
      return;
    }
    const hint = d.fromTemplate
      ? ''
      : ' No classic chat request was seen in this browser yet, so a default one was sent. Send one message in a classic chat (footer says "patched" or "already matched") and try again.';
    renderOldChat('Could not create a classic chat: ' + (d.error || 'unknown error') + '.' +
      (d.tried ? ' Tried: ' + d.tried + '.' : '') + hint + ' Steps: Log; details: copy(__notionEffortOldChatDiag()).');
  }
  createBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    createOldChatNow();
  });
  oldMsg.addEventListener('click', (e) => e.stopPropagation());

  // After opening a freshly created chat: if Notion says it cannot open it,
  // say so in the panel instead of leaving a dead page.
  const NO_ACCESS = /(don.t|do not) have access to this chat|нет доступа к этому чату/i;
  function checkOpenedOldChat(opened) {
    if (!opened || !opened.at || Date.now() - opened.at > 60000) return;
    chrome.storage.local.set({ oldChatOpened: null });
    if (location.href.replace(/-/g, '').indexOf(opened.id) === -1) return;
    const started = Date.now();
    (function tick() {
      if (NO_ACCESS.test(document.body ? document.body.innerText || '' : '')) {
        setOpen(true);
        renderOldChat('The chat was created and Notion saved it (' + (opened.type || 'type ?') + ', id ' + opened.id.slice(0, 8) +
          '), but this address does not open it. Open any classic Notion AI chat once and send a message there: the button then learns the right address. Details: Log.');
        window.postMessage({ type: 'NOTION_EFFORT_OLD_CHAT_DEAD', id: opened.id, url: location.href, recordType: opened.type || null }, '*');
        return;
      }
      if (Date.now() - started < 12000) setTimeout(tick, 500);
    })();
  }
  ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut'].forEach((t) =>
    oldMsg.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === 'keydown' && e.key === 'Escape') { setOpen(false); return; }
      if (t === 'keydown' && e.key === 'Enter') {
        e.preventDefault();
        createOldChatNow();
      }
    })
  );

  watchBox.addEventListener('click', (e) => e.stopPropagation());
  shadow.querySelector('.watch').addEventListener('click', (e) => e.stopPropagation());
  watchBox.addEventListener('change', () => {
    window.postMessage({ type: 'NOTION_EFFORT_WATCH_ONLY', on: watchBox.checked }, '*');
  });
  const logCopy = shadow.querySelector('.logcopy');
  let traceEntries = [];
  let logOpen = false;

  const traceLine = (t) => new Date(t.at).toLocaleTimeString() + '  ' + t.kind + '  ' + t.text;

  function renderLog() {
    const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 20;
    logBody.textContent = '';
    if (!traceEntries.length) {
      logBody.textContent = 'Nothing yet. Pick a model and send a message.';
      return;
    }
    traceEntries.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'row';
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = new Date(t.at).toLocaleTimeString() + ' ';
      const kind = document.createElement('span');
      kind.className = 'k';
      kind.textContent = t.kind + ' ';
      const text = document.createElement('span');
      text.textContent = t.text;
      if (/FAILED|≠|NOT |not confirmed|skipped/.test(t.text)) text.className = 'bad';
      else if (/✓/.test(t.text)) text.className = 'good';
      row.append(time, kind, text);
      logBody.appendChild(row);
    });
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
  }

  logBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    logBtn.setAttribute('aria-expanded', String(logOpen));
    logBox.classList.toggle('hidden', !logOpen);
    if (logOpen) {
      window.postMessage({ type: 'NOTION_EFFORT_TRACE_REQUEST' }, '*');
      renderLog();
      logBody.scrollTop = logBody.scrollHeight;
    }
  });
  logCopy.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = traceEntries.map(traceLine).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      logCopy.textContent = 'Copied';
      setTimeout(() => { logCopy.textContent = 'Copy'; }, 1200);
    }, () => {});
  });
  try {
    modelLbl.textContent =
      'Model in this chat (from Notion server) · v' + chrome.runtime.getManifest().version;
  } catch (e) {}

  // ------------------------------------------------------------------ render

  /**
   * A verdict is evidence about one specific effort. If the selection has moved
   * on, the old result is not "still true" — showing it would let a stale
   * reading vouch for a setting it was never measured against.
   */
  function currentVerdict() {
    const la = state.lastApplied;
    if (!la) return null;
    if (!state.effort) return la.effort ? null : la;
    return la.requested === state.effort ? la : null;
  }

  /**
   * The model block reads thread.agent_provider — the record Notion's server
   * wrote for this chat — so it names the model that actually answers, not the
   * one the menu or this extension would like it to be.
   */
  /** Did our write to *this* thread go through? */
  function wroteThisThread(ag) {
    const ap = state.agentPref;
    return !!(ap && ap.status === 'ok' && ap.detail && ag &&
      String(ap.detail.thread || '').replace(/-/g, '') === String(ag.thread || '').replace(/-/g, ''));
  }

  function nameOf(id) {
    const m = modelById(id);
    return m ? m.name : id;
  }

  /** The effort inject.js sends for a pick: the nearest lower one the model takes. */
  function sentEffort(effort, m) {
    const sup = m && Array.isArray(m.efforts) ? m.efforts : null;
    if (!effort || !sup || sup.indexOf(effort) !== -1) return effort;
    if (!sup.length) return null;
    const rank = (x) => EFFORT_SCALE.indexOf(x);
    const real = sup.filter((x) => rank(x) !== -1).sort((a, b) => rank(a) - rank(b));
    const lower = real.filter((x) => rank(x) <= rank(effort));
    return lower.length ? lower.pop() : real[0] || sup[0];
  }

  /** What the picker asks for that this chat's record does not show yet. */
  function pendingText(ag) {
    const out = [];
    if (state.model && ag.model && ag.model !== state.model) out.push(nameOf(state.model) + ' on next message');
    // Compare with what is actually sent: Max on Grok 4.6 goes out as xhigh.
    const sent = sentEffort(state.effort, modelById(state.model || ag.model));
    if (sent && ag.reasoningEffort && sent !== ag.reasoningEffort) {
      const e = sent.toUpperCase();
      // Auto pinned this chat to a model the policy now blocks: the server
      // re-routes every message at the default effort and refuses to unpin it.
      const pinned = ag.sticky && ag.sticky.model && state.model && ag.sticky.model !== state.model;
      out.push(wroteThisThread(ag)
        ? 'server kept ' + ag.reasoningEffort.toUpperCase() + ', ' + e + ' ignored' +
          (pinned ? ' (chat pinned to ' + nameOf(ag.sticky.model) + ' by Auto: start a new chat)' : '')
        : e + ' on next message');
    }
    return out.join(' · ');
  }

  function renderModel() {
    const ag = state.agent;
    if (!ag || !ag.model) return;
    const m = modelById(ag.model);
    modelName.textContent = (m ? m.name : ag.model) + (ag.modelSelection === 'auto' ? ' (Auto)' : '');
    modelMeta.textContent = '';
    modelMeta.append('id: ' + ag.model + ' · effort ');
    const b = document.createElement('b');
    b.textContent = (ag.reasoningEffort || '?').toUpperCase();
    const cs = chatStatus();
    const sw = swapOf(cs);
    if (sw.effort) b.className = cs.level;
    modelMeta.append(b);
    const want = sw.effort || sw.model
      ? 'picked ' + [sw.model ? nameOf(state.model) : '', sw.effort ? E(sentEffort(state.effort, modelById(state.model || ag.model))) : '']
        .filter(Boolean).join(' / ') + (cs.level === 'err' ? ': server swapped it' : ': may not stick')
      : pendingText(ag);
    if (want) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = ' · ' + want;
      modelMeta.append(w);
    }
    modelMeta.title = 'thread: ' + ag.thread + '\nselection: ' + ag.modelSelection;
  }

  const E = (x) => (x ? (RANGE_LABELS[x] || x) : '?');

  /** The newest chat send for this thread, as inject.js measured it. */
  function lastRunFor(thread) {
    const key = String(thread || '').replace(/-/g, '').toLowerCase();
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].thread === key) return runs[i];
    return null;
  }

  /**
   * One verdict for the whole panel, from the chat record and the last send:
   *   ok   (green)  the chat answered with the picked model and effort
   *   warn (yellow) works, but not exactly as picked (model limit, pending, risky chat)
   *   err  (red)    wrong model or effort, or a write failed
   *   null (grey)   nothing picked / nothing to judge yet
   */
  function chatStatus() {
    const ag = state.agent;
    const pol = state.policy;
    const ap = state.agentPref;
    if (pol && pol.status === 'error') return { level: 'err', text: 'Model not set: ' + ((pol.detail && pol.detail.error) || 'error') };
    if (!ag || !ag.model) return null;
    if (ap && ap.status === 'error' && wroteThisThreadId(ap, ag)) {
      return { level: 'err', text: 'Effort write failed' + (ap.detail && ap.detail.http ? ' (' + ap.detail.http + ')' : '') };
    }
    const want = state.model;
    const wantEff = sentEffort(state.effort, modelById(want || ag.model)) || null;
    if (!want && !wantEff) {
      const mc = modelCheck();
      if (mc && mc.level) return { level: mc.level, text: mc.text + ' · ' + E(ag.reasoningEffort) };
      return { level: null, text: "Notion's choice: " + nameOf(ag.model) + ' · ' + E(ag.reasoningEffort) };
    }
    const limited = !!state.effort && !!wantEff && wantEff !== state.effort
      ? ' (' + E(state.effort) + ' not supported, ' + E(wantEff) + ' used)' : '';
    const blocked = ag.sticky && ag.sticky.model && want && ag.sticky.model !== want ? ag.sticky.model : null;
    const run = lastRunFor(ag.thread);
    const forPick = run && !run.watchOnly && (run.picked || null) === (want || null) && (run.wantEffort || null) === wantEff;
    if (forPick && !run.ran) return { level: null, text: 'Waiting for the answer…' };
    if (!forPick) {
      // Nothing sent with this pick yet: the record says what the next message starts from.
      const pending = [];
      if (want && ag.model !== want) pending.push(nameOf(want));
      if (wantEff && ag.reasoningEffort !== wantEff) pending.push(E(wantEff));
      if (!pending.length) return { level: limited ? 'warn' : 'ok', text: nameOf(ag.model) + ' · ' + E(ag.reasoningEffort) + limited };
      if (blocked) {
        return { level: 'warn', text: 'Swap risk: Auto remembered ' + nameOf(blocked) + ' for this chat (blocked now), so the server may reset ' +
          E(wantEff) + ' to ' + E(ag.reasoningEffort) + '. Start a new chat' };
      }
      return { level: null, text: pending.join(' · ') + ' on next message' };
    }
    if (want && run.ran !== want) {
      return { level: 'err', text: 'Swapped: ' + nameOf(run.ran) + ' answered instead of ' + nameOf(want) };
    }
    if (wantEff && run.effort !== wantEff) {
      return { level: 'err', text: 'Swapped: ' + E(wantEff) + ' → ' + E(run.effort) + ' by the server' +
        (blocked ? ' (chat remembers ' + nameOf(blocked) + ' from Auto). Start a new chat' : '') };
    }
    return { level: limited ? 'warn' : 'ok', text: nameOf(run.ran) + ' · ' + E(run.effort || wantEff) + (limited || ' ✓') };
  }

  // ---------------------------------------------- is it the right model?
  //
  // After every answer: the model that really answered (agent chat: the chat
  // record 4 s / 15 s after the send; classic chat: the model named in the
  // answer stream) against the model that was picked for that send: the
  // panel's pick, or else the label on Notion's own model menu at send time.
  // Auto everywhere = nothing to compare, the answer is just reported.
  const menuAtSend = {}; // run key -> Notion menu label when that send went out
  function runKey(r) {
    return r.thread + '|' + r.at;
  }
  function noteMenuForRuns() {
    let now;
    runs.forEach((r) => {
      const k = runKey(r);
      if (k in menuAtSend) return;
      if (now === undefined) now = readMenuModel();
      menuAtSend[k] = now;
    });
  }
  function idForLabel(label) {
    const m = MODELS.find((x) => normName(x.name) === normName(label));
    return m ? m.model : null;
  }
  function wantFromMenu(label) {
    if (!label || AUTO_LABEL.test(label)) return null;
    return { id: idForLabel(label), label: label, from: 'Notion menu' };
  }
  /** true / false, or null when the names cannot be matched either way. */
  function sameModel(want, ranId) {
    if (want.id) return want.id === ranId;
    const m = modelById(ranId);
    if (!m) return normName(ranId) === normName(want.label) ? true : null;
    return normName(m.name) === normName(want.label);
  }
  function modelCheck() {
    const run = state.agent && state.agent.thread ? lastRunFor(state.agent.thread) : null;
    const la = state.lastApplied;
    const runAt = run ? Date.parse(run.at) || 0 : 0;
    const laAt = la && la.at ? la.at : 0;
    let want = null;
    let ranId = null;
    if (run && runAt >= laAt) {
      want = run.picked
        ? { id: run.picked, label: nameOf(run.picked), from: 'the panel' }
        : wantFromMenu(menuAtSend[runKey(run)]);
      if (!run.ran) {
        return { level: null, text: 'Checking which model answers' + (want ? ' (picked ' + want.label + ')' : '') + '…', ranId: null };
      }
      ranId = run.ran;
    } else if (la) {
      if (la.status === 'error') return null;
      want = state.model
        ? { id: state.model, label: nameOf(state.model), from: 'the panel' }
        : wantFromMenu(la.menu);
      ranId = la.actual || null;
      if (!ranId) {
        return want
          ? { level: null, text: 'Picked ' + want.label + ' · the answer did not name its model, cannot check', ranId: null }
          : null;
      }
    } else {
      return null;
    }
    const ran = nameOf(ranId);
    if (!want) return { level: null, text: 'Auto: ' + ran + ' answered', ranId: ranId };
    const same = sameModel(want, ranId);
    if (same === true) return { level: 'ok', text: '✓ Right model: ' + ran + ' answered', ranId: ranId };
    if (same === false) {
      return { level: 'err', text: '✗ Wrong model: ' + ran + ' answered, ' + want.label + ' was picked in ' + want.from, ranId: ranId };
    }
    return { level: 'warn', text: '? ' + ran + ' (' + ranId + ') answered, ' + want.label + ' was picked: names do not match up', ranId: ranId };
  }
  let lastCheckText = '';
  function renderCheck() {
    const mc = modelCheck();
    const show = !!(mc && mc.ranId);
    pillChk.classList.toggle('hidden', !show);
    pillChk.textContent = !show ? '' : mc.level === 'ok' ? '✓' : mc.level === 'err' ? '✗' : mc.level === 'warn' ? '?' : '·';
    paint(pillChk, show ? mc.level : null);
    mCheck.classList.toggle('hidden', !mc);
    mCheck.textContent = mc ? mc.text : '';
    paint(mCheck, mc ? mc.level : null);
    if (mc && mc.level && mc.text !== lastCheckText) console.log('[Notion Effort] ' + mc.text);
    lastCheckText = mc ? mc.text : '';
    return mc;
  }

  function wroteThisThreadId(ap, ag) {
    return !!(ap && ap.detail && ag && String(ap.detail.thread || '').replace(/-/g, '') === String(ag.thread || '').replace(/-/g, ''));
  }

  function paint(el, level) {
    el.classList.toggle('ok', level === 'ok');
    el.classList.toggle('warn', level === 'warn');
    el.classList.toggle('err', level === 'err');
  }

  function renderPill() {
    const ag = state.agent;
    const m = ag && ag.model ? modelById(ag.model) : null;
    const mc = renderCheck();
    pillName.textContent = m ? m.name : ag && ag.model ? ag.model : mc && mc.ranId ? nameOf(mc.ranId) : 'Effort';
    pillEff.textContent = state.effort ? EFFORT_LABELS[state.effort] : 'Auto';
    pillEff.classList.toggle('on', !!state.effort);

    // The chat record (thread.agent_provider) echoes model and effort back, so
    // green means the server ran exactly the pick.
    const cs = chatStatus();
    // What runs in this chat differs from the pick: show the pick struck out
    // and the real value next to it, so a swap reads at a glance.
    const sw = swapOf(cs);
    pillWant.classList.toggle('hidden', !sw.model);
    pillWant.textContent = sw.model ? nameOf(state.model) : '';
    pillEff.classList.toggle('was', !!sw.effort);
    pillEff.classList.toggle('on', !!state.effort && !sw.effort);
    pillReal.classList.toggle('hidden', !sw.effort);
    pillReal.textContent = sw.effort ? E(ag.reasoningEffort) : '';
    paint(pillReal, sw.effort && cs ? cs.level : null);
    if (cs) {
      const level = mc && mc.level === 'err' ? 'err' : cs.level;
      paint(pill, level);
      paint(pillDot, level);
      pill.title = (mc ? mc.text + '\n' : '') + (cs.text || '');
      return;
    }
    pill.title = mc ? mc.text : '';
    if (mc && mc.level) {
      paint(pill, mc.level);
      paint(pillDot, mc.level);
      return;
    }
    const v = currentVerdict();
    const st = v && v.effortStatus;
    const bad = (v && v.status === 'error') || st === 'mismatch';
    paint(pill, bad ? 'err' : v && state.effort ? 'warn' : null);
    paint(pillDot, bad ? 'err' : v && state.effort ? 'warn' : null);
  }

  /**
   * Which parts of the pick the chat is not running. Only once the chat has
   * answered with this pick (red/yellow) or Auto pinned it elsewhere: before the
   * first message a different record value is just the old state.
   */
  function swapOf(cs) {
    const ag = state.agent;
    if (!ag || !ag.model || !cs || (cs.level !== 'err' && cs.level !== 'warn')) return { model: false, effort: false };
    const wantEff = sentEffort(state.effort, modelById(state.model || ag.model)) || null;
    return {
      model: !!state.model && ag.model !== state.model,
      effort: !!wantEff && !!ag.reasoningEffort && ag.reasoningEffort !== wantEff,
    };
  }

  function renderFoot() {
    renderModel();
    const v = currentVerdict();
    footDot.classList.toggle('err', !!v && (v.status === 'error' || v.effortStatus === 'mismatch'));
    footDot.classList.toggle(
      'warn',
      !!v && v.status !== 'error' && v.effortStatus !== 'mismatch' && !!v.effort
    );

    if (!v || state.agent) {
      // New agent chat: no request carries the model, but the thread record
      // says what the server assigned. Report it as Notion's choice, and be
      // explicit that the extension's own effort did not reach this chat.
      const ag = state.agent;
      if (ag && (ag.model || ag.reasoningEffort)) {
        const ap = state.agentPref;
        const pol = state.policy;
        const cs = chatStatus() || { level: null, text: nameOf(ag.model) + ' · ' + E(ag.reasoningEffort) };
        footTxt.textContent = cs.text;
        footTxt.title = 'Set by Notion for this chat (thread.agent_provider)\n' +
          'model: ' + ag.model + '\nselection: ' + ag.modelSelection +
          '\nreasoningEffort: ' + ag.reasoningEffort + '\nthread: ' + ag.thread +
          (ag.sticky ? '\nAuto pinned to: ' + ag.sticky.model + ' / ' + ag.sticky.reasoningEffort : '') +
          (ap ? '\neffort write: ' + ap.status + ' ' + JSON.stringify(ap.detail || {}) : '') +
          (pol ? '\nallowed models: ' + pol.status + ' ' + JSON.stringify(pol.detail || {}) : '');
        paint(footDot, cs.level);
        return;
      }
      // Say which of the three it is: nothing AI-like went out at all, it went
      // out in a shape we could not patch, or it was patched and is in flight.
      const sn = state.seen;
      if (sn && sn.reason !== 'patched' && sn.reason !== 'already matched') {
        footTxt.textContent = 'AI request seen, not patched: ' + sn.reason;
        footTxt.title = sn.via + ' ' + sn.url;
        return;
      }
      footTxt.textContent = state.swaps
        ? state.swaps + ' requests patched'
        : 'No AI requests seen yet — send a message';
      return;
    }

    if (v.status === 'error') {
      footTxt.textContent = 'Rejected by server' + (v.code ? ' (' + v.code + ')' : '');
      return;
    }

    // The id the server named beats the one we sent: "Auto" resolves to a real
    // model only in the response, and a quiet substitution shows up only there.
    const isAuto = v.modelState === 'auto';
    const shownId = v.actual || (isAuto ? null : v.model);
    const m = modelById(shownId);
    const ran = m ? m.name : shownId || (isAuto ? 'Auto' : 'unknown model');

    // State how firmly the model is established, rather than printing a bare
    // name that looks equally certain whether it rests on one stray field or on
    // several agreeing ones. The exact paths go in the tooltip so the claim can
    // be audited instead of taken on faith.
    const ev = v.modelEvidence;
    let ranLabel = ran;
    const sentM = v.model && !isAuto ? modelById(v.model) : null;
    if (v.actual && v.model && !isAuto && v.actual !== v.model) {
      ranLabel = ran + ' (asked ' + (sentM ? sentM.name : v.model) + ')';
    } else if (isAuto && v.actual) {
      ranLabel = 'Auto → ' + ran;
    } else if (ev && ev.conflicting && ev.conflicting.length) {
      ranLabel = 'model unclear: ' + ev.conflicting.join(' / ');
    } else if (ev && ev.agreeing > 1 && ev.matchesRequest) {
      ranLabel = ran + ' (confirmed ×' + ev.agreeing + ' + request)';
    } else if (ev && ev.agreeing > 1) {
      ranLabel = ran + ' (confirmed ×' + ev.agreeing + ')';
    } else if (ev && ev.agreeing === 1) {
      ranLabel = ran + ' (single mention)';
    }
    const tip = [];
    if (v.model) tip.push('Request model id: ' + v.model);
    if (state.menuModel) tip.push('Notion menu: ' + state.menuModel);
    if (ev && ev.paths && ev.paths.length) tip.push('Model id reported at: ' + ev.paths.join('\n'));
    footTxt.title = tip.join('\n');

    if (!v.effort) {
      footTxt.textContent = 'Server ran ' + ranLabel;
      return;
    }

    // Model check. 'unknown' => Notion is on a model outside our catalogue, so
    // there was no effort ceiling to clamp against — flag it and show the id so
    // it can be added. 'absent' => the request carried no model field at all,
    // which is not a problem: the effort still went out, we just can't name the
    // model or clamp it. Only 'unknown' should look like a warning.
    if (v.modelState === 'unknown') {
      const id = v.model || 'unrecognised model';
      footTxt.textContent = id + ' · ' + v.effort + ' sent (unknown model, not clamped)';
      return;
    }
    if (v.modelState === 'absent') {
      footTxt.textContent = v.effort + ' sent (no model in request)';
      return;
    }
    if (isAuto) {
      footTxt.textContent = ranLabel + ' · ' + v.effort + ' sent (Auto, not clamped)';
      return;
    }
    // A lowered effort is not the one that was asked for, and hiding that would
    // be the same quiet substitution the model swap used to make.
    const asked =
      v.requested && v.requested !== v.effort
        ? v.requested + ' → ' + v.effort + ' (model limit)'
        : v.effort;
    const proof =
      v.effortStatus === 'verified'
        ? ''
        : v.effortStatus === 'mismatch'
          ? ', ran ' + v.effortActual
          : ' (unconfirmed)';
    footTxt.textContent = ranLabel + ' · ' + asked + proof;
  }

  function checkMark() {
    // Drawn rather than typed: a check glyph is missing from some of the fonts
    // Notion loads and renders as tofu.
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'check');
    check.setAttribute('viewBox', '0 0 12 12');
    check.setAttribute('width', '12');
    check.setAttribute('height', '12');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 6.5 4.5 9.5 10.5 2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    check.appendChild(path);
    return check;
  }

  /** Efforts the picked (or running) model takes; null = unknown, anything goes. */
  function modelEfforts() {
    const m = modelById(state.model || (state.agent && state.agent.model));
    return m && Array.isArray(m.efforts) ? m.efforts : null;
  }

  function effortRange(m) {
    if (!Array.isArray(m.efforts)) return '';
    if (!m.efforts.length) return 'no effort';
    const e = EFFORT_SCALE.filter((x) => m.efforts.indexOf(x) !== -1);
    if (!e.length) return '';
    const l = (x) => RANGE_LABELS[x];
    return e.length === 1 ? l(e[0]) : l(e[0]) + '–' + l(e[e.length - 1]);
  }

  function renderPolicyNote() {
    const pol = state.policy;
    let msg = '';
    let bad = false;
    if (pol && pol.status === 'pending') msg = 'Setting workspace allowed models…';
    else if (pol && pol.status === 'error') {
      bad = true;
      msg = 'Could not set allowed models: ' + ((pol.detail && pol.detail.error) || 'error');
    } else if (state.model) {
      msg = 'Workspace allows only ' + nameOf(state.model) + '. Auto restores your list.';
    }
    const r = state.restore;
    if (r && r.status === 'error') {
      msg += (msg ? ' ' : '') + 'Could not restore the model list in another workspace: ' + (r.detail.error || 'error');
    }
    pNote.textContent = msg;
    pNote.classList.toggle('bad', bad);
  }

  function renderModelList() {
    renderPolicyNote();
    const keepScroll = mlist.scrollTop;
    mlist.textContent = '';
    const labels = globalThis.NOTION_EFFORT_FAMILY_LABELS || {};
    const order = globalThis.NOTION_EFFORT_FAMILY_ORDER || [];
    const running = state.agent && state.agent.model;
    const offered = state.spaceModels;
    const q = normName(search.value);
    const usable = MODELS.filter((m) => !m.restricted && (!offered || offered.indexOf(m.model) !== -1))
      .filter((m) => !q || normName(m.name).indexOf(q) !== -1 || m.model.indexOf(q) !== -1 ||
        normName(labels[m.family] || '').indexOf(q) !== -1);
    const rows = [];
    if (!q) rows.push({ id: null, label: 'Auto', hint: "Notion's choice" });
    order.concat(usable.map((m) => m.family).filter((f) => order.indexOf(f) === -1))
      .filter((f, i, a) => a.indexOf(f) === i)
      .forEach((f) => {
        const group = usable.filter((m) => m.family === f);
        if (!group.length) return;
        rows.push({ group: labels[f] || f });
        group.forEach((m) => rows.push({ id: m.model, label: m.name, hint: effortRange(m) }));
      });
    let selRow = null;
    rows.forEach((r) => {
      if (r.group) {
        const g = document.createElement('div');
        g.className = 'grp';
        g.textContent = r.group;
        mlist.appendChild(g);
        return;
      }
      const row = document.createElement('div');
      row.className = 'row' + (r.id === state.model ? ' sel' : '');
      if (r.id) row.title = r.id;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.label;
      row.appendChild(name);
      if (r.id && r.id === running) {
        const cur = document.createElement('span');
        cur.className = 'cur';
        cur.textContent = 'this chat';
        row.appendChild(cur);
      }
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = r.hint;
      row.appendChild(hint);
      if (r.id === state.model) { row.appendChild(checkMark()); selRow = row; }
      row.addEventListener('click', () => selectModel(r.id));
      mlist.appendChild(row);
    });
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No model matches';
      mlist.appendChild(e);
    }
    mlist.scrollTop = keepScroll;
    return selRow;
  }

  function renderEffort() {
    seg.textContent = '';
    const allowed = modelEfforts();
    [null].concat(EFFORT_ORDER).forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = id ? EFFORT_LABELS[id] : 'Auto';
      b.title = id ? EFFORT_HINTS[id] : "Notion's own choice";
      const na = !!id && !!allowed && allowed.indexOf(id) === -1;
      b.className = (id === state.effort ? 'sel' : '') + (na ? ' na' : '');
      b.addEventListener('click', () => selectEffort(id));
      seg.appendChild(b);
    });
    const m = modelById(state.model || (state.agent && state.agent.model));
    let note = '';
    if (m && allowed && state.effort && allowed.indexOf(state.effort) === -1) {
      note = allowed.length
        ? m.name + ' supports ' + effortRange(m) + ': the nearest lower one is used'
        : m.name + ' has no effort setting';
    }
    effNote.textContent = note;
  }

  function renderList(scrollToSel) {
    renderEffort();
    const selRow = renderModelList();
    if (scrollToSel && selRow) selRow.scrollIntoView({ block: 'nearest' });
  }

  // ----------------------------------------------------------------- actions

  function pushSettings() {
    window.postMessage(
      {
        type: 'NOTION_EFFORT_SETTINGS',
        effort: state.effort,
        model: state.model,
        maxIntelligence: true,
        // Lets the response scanner tell a real model id from arbitrary strings
        // that merely sit under a "model"-ish key.
        knownModels: MODELS.map((m) => m.model).filter(Boolean),
        effortsByModel: effortsByModel(),
      },
      '*'
    );
  }

  function selectModel(id) {
    state.model = id;
    chrome.storage.local.set({ selectedModel: id });
    pushSettings();
    renderList();
    renderFoot();
  }

  function selectEffort(id) {
    state.effort = id;
    state.lastApplied = null;
    chrome.storage.local.set({ selectedEffort: id });
    pushSettings();
    renderPill();
    renderList();
    renderFoot();
  }

  function setOpen(open) {
    state.open = open;
    menu.classList.toggle('hidden', !open);
    if (open) {
      search.value = '';
      renderList(true);
      position();
      setTimeout(() => search.focus({ preventScroll: true }), 0);
    }
  }

  ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut'].forEach((t) =>
    search.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === 'keydown' && e.key === 'Escape') { setOpen(false); return; }
      if (t === 'keydown' && e.key === 'Enter') {
        e.preventDefault();
        const first = mlist.querySelector('.row');
        if (first) first.click();
        return;
      }
      if (t === 'input') renderModelList();
    })
  );

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!state.open);
  });
  // Capture phase runs before the menu's own handlers, so stopPropagation
  // inside the shadow root cannot guard this. Test the composed path instead,
  // otherwise every in-menu click closes the menu.
  document.addEventListener(
    'click',
    (e) => {
      if (!state.open) return;
      if (e.composedPath && e.composedPath().indexOf(host) !== -1) return;
      setOpen(false);
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) setOpen(false);
  });

  // --------------------------------------------------------------- placement

  /**
   * Anchor by geometry rather than Notion's class names: find the visible
   * composer textbox and sit just above its right edge. Falls back to a fixed
   * corner slot when no composer is on screen.
   */
  function findComposer() {
    const boxes = document.querySelectorAll('[contenteditable="true"][role="textbox"], textarea');
    let best = null;
    boxes.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 16) return;
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      if (!best || r.bottom > best.rect.bottom) best = { el, rect: r };
    });
    return best;
  }

  function position() {
    const found = findComposer();
    const pw = pill.offsetWidth || 90;
    let left, top;

    if (found) {
      const r = found.rect;
      left = Math.max(8, r.right - pw);
      top = r.top - 36;
      if (top < 8) top = Math.min(window.innerHeight - 40, r.bottom + 8);
    } else {
      left = window.innerWidth - pw - 24;
      top = window.innerHeight - 64;
    }

    pill.style.left = left + 'px';
    pill.style.top = top + 'px';

    if (state.open) {
      const mw = 300;
      const mh = menu.offsetHeight || 300;
      let ml = Math.min(left, window.innerWidth - mw - 8);
      let mt = top - mh - 8;
      if (mt < 8) mt = Math.min(top + 36, window.innerHeight - mh - 8);
      menu.style.left = Math.max(8, ml) + 'px';
      menu.style.top = Math.max(8, mt) + 'px';
    }
  }

  let raf = 0;
  function schedulePosition() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      position();
    });
  }

  window.addEventListener('resize', schedulePosition, { passive: true });
  window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  new MutationObserver(schedulePosition).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ------------------------------------------------------------------- wiring

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === 'NOTION_EFFORT_TRACE') {
      traceEntries.push(e.data.entry);
      if (traceEntries.length > 150) traceEntries.shift();
      if (logOpen) renderLog();
    }
    if (e.data.type === 'NOTION_EFFORT_RUNS' && Array.isArray(e.data.runs)) {
      runs = e.data.runs.slice();
      noteMenuForRuns();
      watchOnly = !!e.data.watchOnly;
      renderRuns();
      renderPill();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_TRACE_ALL' && Array.isArray(e.data.entries)) {
      traceEntries = e.data.entries.slice();
      if (logOpen) renderLog();
    }

    if (e.data.type === 'NOTION_EFFORT_AGENT') {
      state.agent = {
        thread: e.data.thread,
        model: e.data.model,
        modelSelection: e.data.modelSelection,
        reasoningEffort: e.data.reasoningEffort,
        sticky: e.data.sticky || null,
      };
      renderList();
      renderPill();
      renderFoot();
      position();
    }

    if (e.data.type === 'NOTION_EFFORT_POLICY') {
      // Putting back another workspace's list is not about this chat's model.
      const p = { status: e.data.status, detail: e.data.detail || {} };
      if (p.detail.restore) state.restore = p;
      else state.policy = p;
      renderList();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_AGENT_PREF') {
      state.agentPref = { status: e.data.status, detail: e.data.detail };
      renderList();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_SEEN') {
      state.seen = { url: e.data.url, via: e.data.via, reason: e.data.reason };
      if (!currentVerdict()) renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_ONBOARDING') onOnboarding(e.data);
    if (e.data.type === 'NOTION_EFFORT_OLD_CHAT_CREATE') onOldChatCreate(e.data);
    if (e.data.type === 'NOTION_EFFORT_USAGE' && Array.isArray(e.data.entries)) {
      usageEntries = e.data.entries;
      usageNote = e.data.note || null;
      if (state.limitsOpen) renderCredits();
    }

    if (e.data.type === 'NOTION_EFFORT_OLD_CHAT' && typeof e.data.href === 'string' && isNotionUrl(e.data.href)) {
      if (state.oldChatUrl !== e.data.href) {
        state.oldChatUrl = e.data.href;
        chrome.storage.local.set({ oldChatUrl: e.data.href });
        renderOldChat();
      }
    }

    if (e.data.type === 'NOTION_EFFORT_SPACE_MODELS' && Array.isArray(e.data.models)) {
      e.data.models.forEach((m) => {
        if (!m || !m.model) return;
        state.spaceInfo[m.model] = {
          efforts: Array.isArray(m.efforts) ? m.efforts : null,
          defaultEffort: m.defaultEffort || null,
          rateLimit: m.rateLimit, outage: m.outage, disabled: m.disabled, credit: m.credit, optIn: m.optIn,
        };
      });
      state.spaceModels = e.data.models.map((m) => m.model);
      learn(e.data.models.map((m) => Object.assign({ source: 'workspace' }, m)));
      if (state.open) renderList();
      renderLimits();
    }

    if (e.data.type === 'NOTION_EFFORT_CATALOGUE' && Array.isArray(e.data.models)) {
      if (learn(e.data.models)) renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_APPLIED') {
      state.swaps = e.data.swaps || state.swaps;
      // Read on every report: the menu can change between messages, and with
      // effort on Auto there is no 'pending' report to read it at.
      state.menuModel = readMenuModel() || state.menuModel;
      if (e.data.modelState === 'unknown') learnFromMenu(e.data.model, state.menuModel);
      const prevApplied = state.lastApplied;
      const sameSend = !!prevApplied && prevApplied.status === 'pending' && e.data.status !== 'pending';
      state.lastApplied = {
        at: sameSend ? prevApplied.at : Date.now(),
        menu: sameSend ? prevApplied.menu : state.menuModel,
        model: e.data.model,
        actual: e.data.actual || null,
        effort: e.data.effort,
        requested: e.data.requestedEffort || e.data.effort,
        status: e.data.status,
        code: e.data.code,
        effortStatus: e.data.effortStatus || null,
        effortActual: e.data.effortActual || null,
        // Re-derived: learnFromMenu may have just made an unknown id known.
        modelState:
          e.data.modelState === 'unknown' && modelById(e.data.model)
            ? 'known'
            : e.data.modelState || 'known',
        modelEvidence: e.data.modelEvidence || null,
      };
      renderPill();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_PONG') {
      state.swaps = e.data.swappedCount || 0;
      if (!state.lastApplied) renderFoot();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.selectedModel) state.model = changes.selectedModel.newValue || null;
    if (changes.selectedEffort) {
      state.effort = changes.selectedEffort.newValue || null;
      // A verdict belongs to the effort it was measured for. Switching from
      // another context (popup) must not leave it standing next to a new one.
      state.lastApplied = null;
    }
    renderPill();
    renderFoot();
    if (state.open) renderList();
  });

  chrome.storage.local.get(['selectedEffort', 'selectedModel', 'learnedModels', 'oldChatUrl', 'oldChatOpened', PENDING_KEY], (data) => {
    state.effort = data.selectedEffort || null;
    state.model = data.selectedModel || null;
    state.oldChatUrl = data.oldChatUrl || null;
    renderOldChat();
    resumePendingNewChat(data[PENDING_KEY]);
    setTimeout(() => checkOpenedOldChat(data.oldChatOpened), 1500);
    if (Array.isArray(data.learnedModels)) {
      learned = data.learnedModels.filter((l) => l && l.model);
      MODELS = merge(learned);
    }
    enforcePickable();
    pushSettings();
    // unlock.js may have read the catalogue before this script was listening.
    window.postMessage({ type: 'NOTION_EFFORT_CATALOGUE_REQUEST' }, '*');
    window.postMessage({ type: 'NOTION_EFFORT_AGENT_REQUEST' }, '*');
    window.postMessage({ type: 'NOTION_EFFORT_SPACE_MODELS_REQUEST' }, '*');
    renderPill();
    renderFoot();
    position();
  });

  function mount() {
    if (!document.body || host.isConnected) return;
    document.body.appendChild(host);
    position();
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  setInterval(mount, 2000);
})();
