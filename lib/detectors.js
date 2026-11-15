// dsh-token-safety — tokenizer blind-spot detectors.
//
// Each detector runs a cheap keyword/regex "trigger" first. If the trigger
// misses, return null immediately (zero cost on the common path). Only when a
// blind spot is actually hit do we run the precise analysis, and we return a
// compact, conclusion-only fragment. All detectors are pure functions of the
// text — no IO, no state — so the caller can cache by the raw input string.

/** 1-based positions of every occurrence of `target` in `text`. */
function charPositions(text, target) {
  const positions = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === target) positions.push(i + 1);
  }
  return positions;
}

/** Word count (ASCII-ish split on non-letters). */
function wordCount(text) {
  const m = text.match(/[A-Za-z0-9]+/g);
  return m ? m.length : 0;
}

/**
 * ---- 1. Character / substring counting ----
 * "how many r in strawberry" · "count the l in hello" · "apple 里有几个 p"
 * Conclusion form:  `r@3,8,9 (共3个)`
 */
export function detectCharCount(text) {
  // English: "how many <char> in <word>" / "count the <char> in <word>" → [char, word]
  const en =
    text.match(/how many\s+['"]?([a-zA-Z])['"]?\s+in\s+['"]?([A-Za-z]+)['"]?/i) ||
    text.match(/count\s+(?:the\s+)?['"]?([a-zA-Z])['"]?\s+(?:in|of)\s+['"]?([A-Za-z]+)['"]?/i);
  if (en) {
    const target = en[1].toLowerCase();
    const word = en[2].toLowerCase();
    return charCountResult(word, target);
  }
  // Chinese: "<word>里有几个<target>" → [word, target]
  const cn = text.match(/([A-Za-z]+)\s*里\s*有\s*(?:几个|多少)\s*([a-zA-Z])\s*(?:字|字母|字符)?/);
  if (cn) {
    const word = cn[1].toLowerCase();
    const target = cn[2].toLowerCase();
    return charCountResult(word, target);
  }
  return null;
}

/** Shared conclusion builder: `r<target>@<positions> (共N个)` or null if absent. */
function charCountResult(word, target) {
  if (!target || word.length < 1) return null;
  const positions = charPositions(word, target);
  if (positions.length === 0) return null;
  return `${target}@${positions.join(',')} (共${positions.length}个)`;
}

/**
 * ---- 2. Numeric comparison ----
 * Decimals ("9.11 vs 9.9"), big integers, version numbers ("v1.2 vs v1.10").
 * Conclusion form:  `9.9>9.11`
 */
export function detectNumericComparison(text) {
  // Cheap trigger: two numeric/version-ish literals with a comparison word.
  const m =
    text.match(/(\d+(?:\.\d+)+)\s*(?:vs\.?|与|对比|和|against|versus)\s*(\d+(?:\.\d+)+)/i) ||
    text.match(/[vV]?(\d+\.\d+(?:\.\d+)*)\s*(?:vs\.?|比|和|与|against)\s*[vV]?(\d+\.\d+(?:\.\d+)*)/i) ||
    text.match(/(\d{6,})\s*(?:vs\.?|比|和|与|against)\s*(\d{6,})/i);
  if (!m) return null;
  const a = m[1];
  const b = m[2];
  // Compare numerically, avoiding float precision pitfalls for decimals.
  const cmp = compareDecimal(a, b);
  if (cmp === 0) return `${a}==${b}`;
  // Emit "larger>smaller" so the conclusion reads naturally.
  const [big, small] = cmp > 0 ? [a, b] : [b, a];
  return `${big}>${small}`;
}

/** Exact decimal compare (as bigint-scaled rationals) so 9.9 > 9.11 holds. */
function compareDecimal(a, b) {
  const toParts = (s) => {
    const [i = '0', f = '0'] = s.split('.');
    return { i, f };
  };
  const pa = toParts(a);
  const pb = toParts(b);
  const scale = Math.max(pa.f.length, pb.f.length);
  const intOf = (p) => BigInt(p.i) * BigInt(10 ** scale) + BigInt(p.f.padEnd(scale, '0'));
  const va = intOf(pa);
  const vb = intOf(pb);
  return va < vb ? -1 : va > vb ? 1 : 0;
}

/**
 * ---- 3. Text structure ----
 * Nth character, palindrome, word count.
 * Conclusion form:  `第5个字符=d` · `是回文` · `共4个单词`
 */
export function detectTextStructure(text) {
  const notes = [];
  // (a) "第 N 个字符" / "the Nth character"
  const nm = text.match(/(?:第|the\s*)\s*(\d+)\s*(?:个|st|nd|rd|th)?\s*(?:字符|字母|char(?:acter)?)/i) ||
            text.match(/(\d+)\s*(?:个)?\s*(?:字符|字母|char(?:acter)?)\s*(?:是|为|is)/i);
  if (nm) {
    // Which word/string does it refer to? Heuristic: the quoted/backticked
    // literal in the message, else the whole remaining message.
    const lit = text.match(/[`"'「]?\s*([a-zA-Z]{2,})\s*[`"'」]?/);
    const subject = (lit && lit[1]) || text;
    const idx = Number(nm[1]);
    if (idx >= 1 && idx <= subject.length) {
      notes.push(`第${idx}个字符=${subject[idx - 1]}`);
    }
  }
  // (b) palindrome — ask "is X a palindrome" / "X 是回文吗"
  if (/palindrome|回文/i.test(text)) {
    const lit = text.match(/[`"'「]?\s*([a-zA-Z]{2,})\s*[`"'」]?/);
    if (lit && lit[1]) {
      const s = lit[1].toLowerCase();
      const norm = s.replace(/[^a-z0-9]/g, '');
      const isPal = norm === [...norm].reverse().join('');
      notes.push(isPal ? '是回文' : '不是回文');
    }
  }
  // (c) "how many words" / "几个单词"
  if (/how many words|几个单词|多少个词|word count/i.test(text)) {
    notes.push(`共${wordCount(text)}个单词`);
  }
  return notes.length ? notes.join('；') : null;
}

/**
 * ---- 4. Special formats ----
 * Base64, URL, code fences. Pre-annotate structure so a chopped token stream
 * still conveys the boundary. Conclusion form:  `[Base64 len=16]` / `[URL 8段]`
 */
export function detectSpecialFormat(text) {
  const notes = [];
  // Base64 blobs: a run of 16+ base64 alphabet chars (possibly chunked).
  const b64 = text.match(/[A-Za-z0-9+/]{20,}={0,2}/);
  if (b64 && /base64|b64/i.test(text)) {
    notes.push(`[Base64 len=${b64[0].length}]`);
  }
  // URLs.
  const url = text.match(/https?:\/\/[^\s"'`<>()]+/gi);
  if (url) {
    const segments = url[0].split(/[/?#]/).filter(Boolean).length;
    notes.push(`[URL ${segments}段]`);
  }
  // Code fences: report fence presence & opening language.
  const fence = text.match(/```([A-Za-z0-9_+-]*)/);
  if (fence) {
    notes.push(fence[1] ? `[代码块${fence[1]}]` : '[代码块]');
  }
  return notes.length ? notes.join('；') : null;
}