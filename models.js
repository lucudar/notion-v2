/**
 * Single source of truth for the model catalogue.
 * Loaded as a content script before composer.js, so the
 * in-page picker and the catalogue can never drift apart.
 *
 * `model` values are Notion's internal codenames sent as config.value.model.
 * The picker offers every model of the workspace catalogue except
 * `restricted: true` (Fable 5 / 5.1, GPT-6 Astra and GPT-6.1 Terra:
 * trial_not_allowed / the workspace's ai_provider_restrictions reject the
 * policy write, so the server swaps the pick — never offer them).
 */
(function () {
  'use strict';

  const MODELS = [
    { model: "orange-mousse", name: "GPT-5.6 Sol", family: "openai", efforts: ["medium", "high"], speed: 3, intelligence: 5, cost: 5 },
    { model: "onico", picker: true, name: "GPT-6 Sol", family: "openai", efforts: ["low", "medium", "high", "max"], speed: 3, intelligence: 5, cost: 5 },
    { model: "orlando-quinn", name: "GPT-6 Astra", family: "openai", efforts: ["low", "medium", "high", "max"], speed: 4, intelligence: 4, cost: 3, restricted: true },
    { model: "omniberry-sundae", picker: true, name: "GPT-6.1 Sol", family: "openai", efforts: null, speed: 4, intelligence: 4, cost: 3 },
    // GPT-6.1 Terra: letting the picker near it ends with the server swapping
    // the pick to it and the allowed-models write rejected (HTTP 400,
    // "must match workspace ai_provider_restrictions"). Blocked by id and,
    // in case Notion ships effort-suffixed ids, by display name too.
    { model: "ortinique-oken", name: "GPT-6.1 Terra", family: "openai", efforts: null, speed: 4, intelligence: 4, cost: 3, restricted: true },
    { model: "omodi", picker: true, name: "GPT-6 Luna", family: "openai", efforts: ["low", "medium", "high", "max"], speed: 5, intelligence: 3, cost: 2 },
    { model: "orchid-muffin", picker: true, name: "GPT-5.6 Terra", family: "openai", efforts: ["medium", "high"], speed: 4, intelligence: 4, cost: 4 },
    { model: "olive-jellyroll", name: "GPT-5.6 Luna", family: "openai", efforts: ["medium", "high"], speed: 5, intelligence: 3, cost: 2 },
    { model: "oatmeal-cookie", name: "GPT-5.2", family: "openai", efforts: ["medium", "high"], speed: 4, intelligence: 4, cost: 3 },
    { model: "oval-kumquat-medium", name: "GPT-5.4", family: "openai", efforts: ["medium", "high"], speed: 4, intelligence: 5, cost: 4 },
    { model: "opal-quince-medium", name: "GPT-5.5", family: "openai", efforts: ["medium", "high"], speed: 4, intelligence: 5, cost: 5 },
    { model: "oregon-grape-medium", name: "GPT-5.4 Mini", family: "openai", efforts: ["medium"], speed: 5, intelligence: 2, cost: 2 },
    { model: "otaheite-apple-medium", name: "GPT-5.4 Nano", family: "openai", efforts: ["medium"], speed: 5, intelligence: 1, cost: 1 },
    { model: "almond-croissant-low", name: "Sonnet 4.6", family: "anthropic", efforts: ["low", "medium", "high", "max"], speed: 3, intelligence: 5, cost: 4 },
    { model: "angel-cake-high", name: "Sonnet 5", family: "anthropic", efforts: ["high"], speed: 3, intelligence: 5, cost: 3 },
    { model: "avocado-froyo-medium", name: "Opus 4.6", family: "anthropic", efforts: ["medium"], speed: 2, intelligence: 5, cost: 5 },
    { model: "apricot-sorbet-high", name: "Opus 4.7", family: "anthropic", efforts: ["high"], speed: 2, intelligence: 5, cost: 5 },
    { model: "ambrosia-tart-high", name: "Opus 4.8", family: "anthropic", efforts: ["low", "medium", "high", "max"], speed: 2, intelligence: 5, cost: 5 },
    { model: "acai-budino-high", name: "Fable 5", family: "anthropic", efforts: ["high"], speed: 2, intelligence: 5, cost: 5, restricted: true },
    { model: "agave-flan", picker: true, name: "Opus 5", family: "anthropic", efforts: ["low", "medium", "high", "max"], speed: 2, intelligence: 5, cost: 5 },
    // Codenames from getAvailableModels / zeroRetentionModels (2026-09-29).
    // Notion also offers "xhigh" / "none"; the picker only has low…max.
    { model: "albuquerque-quinn", picker: true, name: "Opus 5.5", family: "anthropic", efforts: ["low", "medium", "high", "max"], speed: 2, intelligence: 5, cost: 5 },
    { model: "assam-chai", name: "Fable 5.1", family: "anthropic", efforts: null, speed: 2, intelligence: 5, cost: 5, restricted: true },
    { model: "anthropic-haiku-4.5", name: "Haiku 4.5", family: "anthropic", efforts: [], speed: 5, intelligence: 2, cost: 2 },
    { model: "vertex-gemini-3.6-flash", name: "Gemini 3.6 Flash", family: "gemini", efforts: null, speed: 5, intelligence: 3, cost: 3 },
    { model: "vertex-gemini-3.5-flash", name: "Gemini 3.5 Flash", family: "gemini", efforts: ["low", "medium", "high"], speed: 5, intelligence: 3, cost: 3 },
    { model: "galette-medium-thinking", name: "Gemini 3.1 Pro", family: "gemini", efforts: ["low", "medium"], speed: 3, intelligence: 4, cost: 3 },
    { model: "gingerbread", name: "Gemini 3 Flash", family: "gemini", efforts: [], speed: 5, intelligence: 2, cost: 2 },
    { model: "xigua-mochi-medium", name: "Grok 4.3", family: "xai", efforts: ["low", "medium", "high"], speed: 3, intelligence: 5, cost: 4 },
    { model: "strawberry-whoopiepie", name: "Grok 4.5", family: "xai", efforts: ["low", "medium", "high"], speed: 3, intelligence: 5, cost: 4 },
    { model: "soursop-shortcake", picker: true, name: "Grok 4.6", family: "xai", efforts: null, speed: 3, intelligence: 5, cost: 4 },
    { model: "xinomavro-cake", name: "Grok Build 0.1", family: "xai", efforts: [], speed: 3, intelligence: 5, cost: 4 },
    { model: "fireworks-kimi-k2.6", name: "Kimi K2.6", family: "mystery", efforts: [], speed: 5, intelligence: 4, cost: 2 },
    { model: "fireworks-kimi-k2.7", name: "Kimi K2.7 Code", family: "mystery", efforts: [], speed: 5, intelligence: 4, cost: 2 },
    { model: "fireworks-kimi-k3", name: "Kimi K3", family: "mystery", efforts: ["low", "high", "max"], speed: 3, intelligence: 5, cost: 5 },
    { model: "baseten-deepseek-v4-pro", name: "DeepSeek V4 Pro", family: "mystery", efforts: ["low", "medium", "high", "max"], speed: 3, intelligence: 5, cost: 4 },
    { model: "baseten-deepseek-v4-flash", name: "DeepSeek V4 Flash", family: "mystery", efforts: null, speed: 5, intelligence: 4, cost: 2 },
    { model: "baseten-deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", family: "mystery", efforts: null, speed: 5, intelligence: 4, cost: 2 },
    { model: "baseten-glm-5.3", name: "GLM 5.3", family: "mystery", efforts: null, speed: 3, intelligence: 5, cost: 3 },
    { model: "baseten-glm-5.3-flash", name: "GLM 5.3 Flash", family: "mystery", efforts: null, speed: 5, intelligence: 4, cost: 2 },
    { model: "baseten-glm-5.2", name: "GLM 5.2", family: "mystery", efforts: ["high", "max"], speed: 3, intelligence: 5, cost: 3 },
  ];

  const FAMILY_ICON_FILES = {
    openai: "family-openai.png",
    anthropic: "family-anthropic.png",
    gemini: "family-gemini.png",
    xai: "family-grok.png",
    mystery: "family-deepseek.png",
  };

  const FAMILY_LABELS = {
    anthropic: "Claude",
    openai: "OpenAI",
    gemini: "Gemini",
    xai: "Grok",
    mystery: "Open models",
  };

  const FAMILY_ORDER = ["anthropic", "openai", "gemini", "xai", "mystery"];

  /** "Claude Opus 5.5" / "opus-5.5" / "Opus 5.5" all compare equal. */
  function normalizeName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/\bclaude\b/g, "")
      .replace(/[^a-z0-9.]+/g, " ")
      .trim();
  }

  function guessFamily(name) {
    const n = normalizeName(name);
    if (/opus|sonnet|haiku|fable/.test(n)) return "anthropic";
    if (/gpt|\bo\d/.test(n)) return "openai";
    if (/gemini/.test(n)) return "gemini";
    if (/grok/.test(n)) return "xai";
    return "mystery";
  }

  // Models never offered, whatever id they arrive under (mergeCatalogue marks
  // them restricted; the picker filters those out).
  const BLOCKED_NAMES = ["GPT-6.1 Terra"];

  /**
   * Static catalogue + ids learned at runtime ({ model, name, efforts? }).
   * A learned id whose name matches a placeholder (`model: null`) fills it in;
   * anything else is appended with `efforts: null` = ceiling unknown, no clamp.
   * Placeholders still without an id are dropped from the result.
   */
  function mergeCatalogue(learned) {
    const out = MODELS.map((m) => Object.assign({}, m));
    (learned || []).forEach((l) => {
      if (!l || typeof l.model !== "string" || !l.model) return;
      const efforts = Array.isArray(l.efforts) && l.efforts.length ? l.efforts : null;
      const same = out.find((m) => m.model === l.model);
      if (same) {
        // The workspace catalogue is Notion's own list: it wins over the
        // static one (which had Grok 4.6 / GPT-6.1 Sol unknown, GPT-5.6 Sol low).
        if (efforts && (!same.efforts || l.source === 'workspace')) same.efforts = efforts;
        if (l.source === 'workspace' && l.name && l.name !== l.model) same.name = l.name;
        if (l.optIn) same.restricted = true;
        return;
      }
      const slot = out.find((m) => !m.model && normalizeName(m.name) === normalizeName(l.name));
      if (slot) {
        slot.model = l.model;
        if (efforts) slot.efforts = efforts;
        slot.learned = l.source || true;
        return;
      }
      out.push({
        model: l.model,
        name: l.name || l.model,
        family: l.family || guessFamily(l.name),
        efforts: efforts,
        learned: l.source || true,
      });
    });
    const blocked = BLOCKED_NAMES.map(normalizeName);
    out.forEach((m) => {
      if (blocked.indexOf(normalizeName(m.name)) !== -1) m.restricted = true;
    });
    return out.filter((m) => m.model);
  }

  globalThis.NOTION_EFFORT_MODELS = MODELS;
  globalThis.NOTION_EFFORT_NORMALIZE_NAME = normalizeName;
  globalThis.NOTION_EFFORT_MERGE_CATALOGUE = mergeCatalogue;
  globalThis.NOTION_EFFORT_FAMILY_ICON_FILES = FAMILY_ICON_FILES;
  globalThis.NOTION_EFFORT_FAMILY_LABELS = FAMILY_LABELS;
  globalThis.NOTION_EFFORT_FAMILY_ORDER = FAMILY_ORDER;
})();
