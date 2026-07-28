import { config } from '../lib/config.js';
import { getDb } from '../db/index.js';
import { getSettings } from '../lib/settings.js';

// AI via Ollama.
//
// Configuration is deliberately just two things: a host and a model name, both set on
// the Settings page (falling back to OLLAMA_URL / OLLAMA_MODEL). Whatever that host
// serves is what gets used — Fitberg does not second-guess the choice.
//
// The one design constraint that does matter: prompts are assembled from compact
// numeric summaries rather than raw sample streams. A small model has neither the
// context window nor the arithmetic to read 5000 samples, and would hallucinate
// confidently if asked to.

const REQUEST_TIMEOUT_MS = 180000;

/** Where to talk to, and what to ask for. Saved settings beat the environment. */
async function target() {
  try {
    const db = await getDb();
    const { ollamaUrl, ollamaModel } = getSettings(db);
    return { url: ollamaUrl, model: ollamaModel };
  } catch {
    return { url: config.ollama.url, model: config.ollama.model };
  }
}

export async function ollamaStatus() {
  if (!config.ollama.enabled) {
    return { available: false, reason: 'disabled by configuration (OLLAMA_ENABLED=0)' };
  }
  const { url: baseUrl, model: configured } = await target();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { available: false, reason: `Ollama returned HTTP ${response.status}` };

    const data = await response.json();
    const models = (data.models || []).map((m) => m.name);

    // Tags carry a variant suffix (`qwen3.5:cloud`, `llama3.2:3b`), so an exact
    // match wins and otherwise the base name is enough.
    const resolved = models.find((m) => m === configured)
      ?? models.find((m) => m.split(':')[0] === configured.split(':')[0])
      ?? null;

    if (!resolved) {
      return {
        available: false,
        url: baseUrl,
        model: configured,
        models,
        modelInstalled: false,
        reason: `model "${configured}" is not available on ${baseUrl}`,
        hint: models.length
          ? `Available there: ${models.join(', ')}`
          : 'That host has no models. Pull one, e.g. ollama pull llama3.2:3b',
      };
    }

    return {
      available: true,
      url: baseUrl,
      model: resolved,
      modelInstalled: true,
      models,
      reason: null,
    };
  } catch (err) {
    return {
      available: false,
      url: baseUrl,
      model: configured,
      models: [],
      reason: `cannot reach Ollama at ${baseUrl} (${err.message})`,
      hint: 'On Linux with Ollama running on the host, try http://172.17.0.1:11434',
    };
  }
}

// Cache of the configured model name resolved to a concrete tag on the host.
//
// This exists because /api/generate requires the *exact* tag. Someone who sets
// OLLAMA_MODEL=qwen3.5 when the host serves `qwen3.5:cloud` (or llama3.2 vs
// `llama3.2:3b`) would otherwise get a status of "available" — because the status
// check matches on the base name — followed by a 404 on every single request.
let resolvedModel = null;

/** Map the configured model name onto a tag the host will actually accept. */
export async function resolveModel() {
  if (resolvedModel) return resolvedModel;

  const { url: baseUrl, model: configured } = await target();
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const data = await response.json();
      const models = (data.models || []).map((m) => m.name);
      resolvedModel = models.find((m) => m === configured)
        ?? models.find((m) => m.split(':')[0] === configured.split(':')[0])
        ?? configured;
      return resolvedModel;
    }
  } catch { /* fall through and try the configured name as-is */ }

  return configured;
}

/** Forget the cached tag, so a pulled or removed model is picked up. */
export function invalidateModelCache() {
  resolvedModel = null;
}

/**
 * Single-turn generation.
 * @param {string} prompt
 * @param {{system?:string, format?:'json', temperature?:number, model?:string}} [opts]
 */
export async function generate(prompt, opts = {}) {
  if (!config.ollama.enabled) throw new Error('AI features are disabled (OLLAMA_ENABLED=0)');

  const { url: baseUrl } = await target();
  const model = opts.model || await resolveModel();

  const body = {
    model,
    prompt,
    stream: false,
    options: {
      temperature: opts.temperature ?? 0.4,
      // Generous by default because several capable models emit chain-of-thought
      // before the answer. Those tokens are stripped from the *output* below, but
      // they are already spent against this budget — a tight limit truncates the
      // real answer mid-sentence and looks like a broken app. Length is controlled
      // by the prompt asking for brevity, not by starving the generation.
      num_predict: opts.maxTokens ?? 2000,
    },
  };
  if (opts.system) body.system = opts.system;
  if (opts.format === 'json') body.format = 'json';

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    // A 404 means the tag we cached no longer exists on the host (model removed,
    // or the host swapped). Drop the cache so the next call re-resolves.
    if (response.status === 404) invalidateModelCache();
    throw new Error(`Ollama HTTP ${response.status} for model "${model}": ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  return {
    text: stripThinking(data.response || ''),
    model: data.model,
    evalCount: data.eval_count,
    durationMs: Math.round((data.total_duration || 0) / 1e6),
  };
}

/**
 * Several capable open models emit chain-of-thought in <think> tags. Users want
 * the answer, not the deliberation.
 */
function stripThinking(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
}

/** Parse JSON from a model response, tolerating fences and surrounding prose. */
export function parseJsonResponse(text) {
  const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to brace extraction */ }

  const start = cleaned.search(/[{[]/);
  if (start === -1) return null;
  const openChar = cleaned[start];
  const closeChar = openChar === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(closeChar);
  if (end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
