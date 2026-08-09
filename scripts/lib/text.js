'use strict';
/*
 * text.js — Hebrew subtitle rules.
 *
 * Hard rules enforced here (the user's spec):
 *   1. Every subtitle is ONE line. Never two, never three.
 *   2. Every subtitle has between MIN_WORDS and MAX_WORDS Hebrew words (4-6).
 *   3. A one-line subtitle must physically fit inside the 1080px frame, so the
 *      font size is auto-fitted per line instead of letting libass wrap it.
 */

const MIN_WORDS = 4;
const MAX_WORDS = 6;

// Screen / typography constants (must match render_video.js).
const FRAME_W = 1080;
const SAFE_W = 940;          // usable width; leaves a margin on both sides
const FONT_MAX = 64;
const FONT_MIN = 40;

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

/** Remove emoji — libass cannot render them in color, they are overlaid as PNGs. */
function stripEmoji(t) {
  return String(t || '').replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

/** Collapse to a single physical line: no newlines, no double spaces. */
function oneLine(t) {
  return String(t || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const PUNCT = /^[\s"'“”„,.!?;:()\[\]־–—-]+|[\s"'“”„,.!?;:()\[\]־–—-]+$/g;

/**
 * Split into words, keeping each word EXACTLY as written.
 *
 * Punctuation must survive: the CTA is specified as תגיבו "אני" ... and losing
 * those quotation marks changes what the line asks the viewer to comment. So
 * tokens are returned verbatim and punctuation is only stripped for the purpose
 * of deciding whether a token counts as a word.
 */
function words(t) {
  return stripEmoji(oneLine(t))
    .split(' ')
    .filter((tok) => tok.replace(PUNCT, '').length > 0);
}

function wordCount(t) {
  return words(t).length;
}

/**
 * Estimated rendered width in px for Arial-Bold-ish Hebrew at a given size.
 * Hebrew glyphs are wider than the Latin average, so we weight per char class.
 */
function estimateWidth(text, fontSize) {
  const t = stripEmoji(oneLine(text));
  let em = 0;
  for (const ch of t) {
    if (ch === ' ') em += 0.28;
    else if (/[֐-׿]/.test(ch)) em += 0.56;      // Hebrew letter
    else if (/[0-9]/.test(ch)) em += 0.56;
    else if (/[.,!?;:'"״׳()\[\]-]/.test(ch)) em += 0.30;   // punctuation
    else em += 0.52;                                       // Latin fallback
  }
  return em * fontSize;
}

/** Largest font size (FONT_MIN..FONT_MAX) at which the line fits on one row. */
function fitFontSize(text) {
  for (let fs = FONT_MAX; fs >= FONT_MIN; fs -= 1) {
    if (estimateWidth(text, fs) <= SAFE_W) return fs;
  }
  return FONT_MIN;
}

/**
 * Split a word list into groups of MIN_WORDS..MAX_WORDS, as evenly as possible.
 * Returns an array of arrays. Never produces a group smaller than MIN_WORDS
 * unless the whole input is smaller than MIN_WORDS.
 */
function balancedGroups(ws) {
  const n = ws.length;
  if (n <= MAX_WORDS) return [ws];

  // Choose the group count that keeps every group inside [MIN, MAX].
  let groups = Math.ceil(n / MAX_WORDS);
  while (groups * MIN_WORDS > n && groups > 1) groups -= 1;   // avoid starving groups
  while (Math.ceil(n / groups) > MAX_WORDS) groups += 1;

  const base = Math.floor(n / groups);
  let extra = n % groups;
  const out = [];
  let i = 0;
  for (let g = 0; g < groups; g++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra -= 1;
    out.push(ws.slice(i, i + size));
    i += size;
  }
  return out;
}

/**
 * Normalise a list of caption candidates into subtitle lines that all obey the
 * 1-line / 4-6-word rule.
 *
 * Input:  [{ he, ...meta }, ...]
 * Output: [{ he, fontSize, parentIndex, shareStart, shareEnd, ...meta }, ...]
 *
 * shareStart/shareEnd are 0..1 fractions of the PARENT beat's speech interval,
 * so the caller can subdivide a beat's audio when one beat produced several
 * lines. A beat that produced exactly one line has share 0..1.
 *
 * Too-long lines are split. Too-short lines are merged forward when the merge
 * still fits in MAX_WORDS; a trailing runt that cannot merge is kept as-is
 * (rendering a slightly short line beats dropping the narration).
 */
function normaliseCaptions(items) {
  const out = [];

  items.forEach((item, parentIndex) => {
    const ws = words(item.he);
    const groups = balancedGroups(ws);
    const total = ws.length || 1;
    let consumed = 0;

    groups.forEach((g) => {
      const start = consumed / total;
      consumed += g.length;
      const end = consumed / total;
      out.push({
        ...item,
        he: g.join(' '),
        parentIndex,
        shareStart: start,
        shareEnd: end,
        _words: g.length,
      });
    });
  });

  // Merge runts forward inside the same parent beat only — merging across beats
  // would desync the caption from the audio it belongs to.
  const merged = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const next = out[i + 1];
    if (
      cur._words < MIN_WORDS &&
      next &&
      next.parentIndex === cur.parentIndex &&
      cur._words + next._words <= MAX_WORDS
    ) {
      merged.push({
        ...cur,
        he: cur.he + ' ' + next.he,
        shareEnd: next.shareEnd,
        _words: cur._words + next._words,
      });
      i += 1;                                   // skip the consumed neighbour
    } else {
      merged.push(cur);
    }
  }

  return merged.map((m) => {
    const he = oneLine(m.he);
    return { ...m, he, fontSize: fitFontSize(he) };
  });
}

/** Authoring-time check. Returns a list of human-readable problems. */
function lintCaption(he) {
  const problems = [];
  const raw = String(he || '');
  if (/[\r\n]/.test(raw)) problems.push('contains a line break — captions must be one line');
  const n = wordCount(raw);
  if (n < MIN_WORDS) problems.push(`only ${n} words — minimum is ${MIN_WORDS}`);
  if (n > MAX_WORDS) problems.push(`${n} words — maximum is ${MAX_WORDS}`);
  if (estimateWidth(raw, FONT_MIN) > SAFE_W) problems.push('too wide to fit on one line even at the minimum font size');
  return problems;
}

module.exports = {
  MIN_WORDS, MAX_WORDS, FRAME_W, SAFE_W, FONT_MAX, FONT_MIN,
  stripEmoji, oneLine, words, wordCount,
  estimateWidth, fitFontSize, balancedGroups,
  normaliseCaptions, lintCaption,
};
