// dsh-token-safety — host plugin.
//
// Registers an `agent/pre-step` (waterfall) listener: right before a proposed
// step is sent to the model, inspect the incoming user messages. Run cheap
// blind-spot triggers; if nothing fires, pass the messages through untouched
// (zero overhead). When a blind spot is hit, run the precise analysis and
// append a compact `[精确验证参考]` fragment to the tail of the last user
// message. Results are cached per unique string within a bounded LRU.

import { detectCharCount, detectNumericComparison, detectTextStructure, detectSpecialFormat } from './detectors.js';

export const name = 'dsh-token-safety';

/**
 * Optional settings surface. DSH profiles ship `@deepseek-ai/schemastery` via
 * the base bundle, so we try to expose a real `Config` (drives the settings
 * page) but fall back gracefully when it is not resolvable — the plugin still
 * loads and uses `DEFAULT_CONFIG`.
 */
export let Config = null;
try {
  const { default: z } = await import('@deepseek-ai/schemastery');
  Config = z.object({
    enabled: z.boolean().default(true).volatile(),
    charCount: z.boolean().default(true).volatile(),
    numericComparison: z.boolean().default(true).volatile(),
    textStructure: z.boolean().default(true).volatile(),
    specialFormat: z.boolean().default(true).volatile(),
    maxCache: z.number().default(512).volatile(),
  });
} catch {
  /* schemastery unavailable — rely on DEFAULT_CONFIG */
}

/** Simple bounded LRU for string → computed fragment. */
function makeLru(limit) {
  const map = new Map();
  return {
    get(k) {
      if (!map.has(k)) return undefined;
      const v = map.get(k);
      map.delete(k);
      map.set(k, v); // refresh recency
      return v;
    },
    set(k, v) {
      map.delete(k);
      map.set(k, v);
      if (map.size > limit) {
        // evict oldest
        map.delete(map.keys().next().value);
      }
    },
    clear() {
      map.clear();
    },
  };
}

/** Flatten a user message's content to plain text (string or block array). */
function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .join('');
  }
  return '';
}

/** Append a text fragment to a content value (string or block array). */
function appendToContent(content, fragment) {
  const pad = fragment ? `\n\n[精确验证参考] ${fragment}` : '';
  if (typeof content === 'string') {
    return [{ type: 'text', text: content + pad }];
  }
  if (Array.isArray(content)) {
    return [...content, { type: 'text', text: pad.trimStart() }];
  }
  return [{ type: 'text', text: pad.trimStart() }];
}

/** Run every enabled detector; join non-null results. */
function analyze(text, cfg) {
  const out = [];
  if (cfg.charCount) {
    const r = detectCharCount(text);
    if (r) out.push(r);
  }
  if (cfg.numericComparison) {
    const r = detectNumericComparison(text);
    if (r) out.push(r);
  }
  if (cfg.textStructure) {
    const r = detectTextStructure(text);
    if (r) out.push(r);
  }
  if (cfg.specialFormat) {
    const r = detectSpecialFormat(text);
    if (r) out.push(r);
  }
  return out.length ? out.join('；') : null;
}

const DEFAULT_CONFIG = {
  enabled: true,
  charCount: true,
  numericComparison: true,
  textStructure: true,
  specialFormat: true,
  maxCache: 512,
};

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const cache = makeLru(Number(cfg.maxCache) || DEFAULT_CONFIG.maxCache);
  const disposers = [];

  const on = (eventName, handler) => {
    const d = ctx.on(eventName, handler);
    if (disposers.length < 1000) disposers.push(d);
    return d;
  };

  on('agent/pre-step', async (payload, next) => {
    // Always let the host decide; we only replace messages when a blind spot
    // actually fires. next() preserves the current messages on the fast path.
    const messages = payload?.messages;
    if (!cfg.enabled || !Array.isArray(messages) || messages.length === 0) {
      return next ? next() : { kind: 'enter', messages };
    }
    // Only the last user message is fresh input; leave history untouched.
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') {
      return next ? next() : { kind: 'enter', messages };
    }
    const text = textOfContent(last.content);
    if (!text || text.length > 20000) {
      // Too long (or empty) to scan cheaply — pass through.
      return next ? next() : { kind: 'enter', messages };
    }
    // Cache hit → reuse the fragment without re-running analysis.
    let fragment = cache.get(text);
    if (fragment === undefined) {
      fragment = analyze(text, cfg) || null;
      cache.set(text, fragment);
    }
    if (!fragment) {
      // No blind spot → zero-cost pass-through.
      return next ? next() : { kind: 'enter', messages };
    }
    // Blind spot hit → inject. Keep a stable reference to the other messages.
    const injected = messages.slice(0, -1).concat({
      ...last,
      content: appendToContent(last.content, fragment),
    });
    return { kind: 'enter', messages: injected };
  });

  // Bounded lifetime: no explicit turn end to hook cheaply; LRU cap bounds
  // memory. Return a dispose that tears down the listeners.
  return () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d();
        else if (d && typeof d.dispose === 'function') d.dispose();
      } catch {
        /* ignore teardown errors */
      }
    }
  };
}