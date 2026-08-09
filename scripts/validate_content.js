'use strict';
/*
 * validate_content.js — hard gate on the rules in references/content-rules.md.
 *
 * The renderer auto-repairs captions so a live run never dies. This validator
 * does the opposite: it fails loudly, so bad content is fixed at the source
 * instead of being quietly reshaped every night.
 *
 * Usage: node validate_content.js content/seed_topics.json
 */

const fs = require('fs');
const { lintCaption, wordCount, stripEmoji } = require('./lib/text');

const SECTIONS = {
  hook: [1, 2],
  value: [10, 14],
  beliefShift: [2, 3],
  fear: [2, 3],
};

const MOTIVATORS = [
  'fear', 'status', 'money', 'simplicity', 'saving',
  'opportunity', 'security', 'control', 'anger', 'freedom', 'belonging',
];

// A value beat counts as "concrete" when it names a quantity or a time unit —
// a rough but effective proxy for "the viewer can do this today".
const NUMBERY = new RegExp('(' + [
  '\\d',
  'אחד', 'אחת', 'שתי', 'שני', 'שניים', 'שלוש', 'שלושה', 'ארבע', 'ארבעה',
  'חמש', 'חמישה', 'חמשת', 'שש', 'שישה', 'שבע', 'שבעה', 'שמונה', 'תשע',
  'עשר', 'עשרה', 'עשרים', 'שלושים', 'חמישים', 'מאה', 'אלף', 'חצי', 'רבע',
  'דקה', 'דקות', 'שניה', 'שניות', 'שעה', 'שעות', 'שעתיים',
  'יום', 'יומיים', 'ימים', 'שבוע', 'שבועיים', 'שבועות',
  'חודש', 'חודשים', 'שנה', 'שנים', 'פעם', 'פעמיים', 'פעמים', 'אחוז',
].join('|') + ')');

// Loan words and jargon that break the "clear to a third grader" rule.
const BANNED = [
  'פוקוס', 'פרודוקטיביות', 'אופטימיזציה', 'מומנטום', 'קונסיסטנטיות',
  'אימפקט', 'מיינדסט', 'פרדיגמה', 'תודעתי', 'אפקטיביות', 'רלוונטיות',
  'אינטנסיביות', 'פרואקטיבי', 'ולידציה', 'סינרגיה',
];

function validateBeat(b, where, problems) {
  if (!b || typeof b !== 'object') { problems.push(`${where}: not an object`); return; }
  if (!b.en || !b.en.trim()) problems.push(`${where}: missing "en"`);
  if (!b.he || !b.he.trim()) problems.push(`${where}: missing "he"`);
  if (!b.query || !b.query.trim()) problems.push(`${where}: missing "query"`);

  if (b.he) lintCaption(b.he).forEach((p) => problems.push(`${where}: ${p} — "${b.he}"`));

  if (b.en) {
    const n = b.en.trim().split(/\s+/).length;
    if (n < 4) problems.push(`${where}: English narration is only ${n} words (need 4-10)`);
    if (n > 12) problems.push(`${where}: English narration is ${n} words (max 12)`);
  }
  if (b.query) {
    const n = b.query.trim().split(/\s+/).length;
    if (n < 2 || n > 5) problems.push(`${where}: query should be 2-5 words — "${b.query}"`);
    if (/[֐-׿]/.test(b.query)) problems.push(`${where}: query must be English — "${b.query}"`);
  }
  const hit = BANNED.find((w) => (b.he || '').includes(w));
  if (hit) problems.push(`${where}: banned jargon "${hit}" — rewrite in plain Hebrew`);
  if (/[\u{1F300}-\u{1FAFF}]/u.test(b.he || '')) problems.push(`${where}: beats must not contain emoji`);
}

function validateTopic(t) {
  const problems = [];
  if (!t || typeof t !== 'object') return ['topic is not an object'];
  if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) problems.push('id must be kebab-case ascii');
  if (!t.limitingBelief) problems.push('missing limitingBelief');
  if (!t.empoweringBelief) problems.push('missing empoweringBelief');

  const mots = t.motivators || [];
  if (!Array.isArray(mots) || mots.length < 1 || mots.length > 2) {
    problems.push('motivators must be an array of 1-2 entries');
  } else {
    mots.filter((m) => !MOTIVATORS.includes(m))
      .forEach((m) => problems.push(`unknown motivator "${m}" (use: ${MOTIVATORS.join(', ')})`));
  }

  for (const [name, [min, max]] of Object.entries(SECTIONS)) {
    const arr = t[name];
    if (!Array.isArray(arr)) { problems.push(`missing section "${name}"`); continue; }
    if (arr.length < min || arr.length > max) {
      problems.push(`"${name}" has ${arr.length} beats (need ${min}-${max})`);
    }
    arr.forEach((b, i) => validateBeat(b, `${name}[${i}]`, problems));
  }

  // 10x factual value: at least five value beats must carry a number or a
  // measurable action, otherwise the video is inspiration with no instruction.
  const value = Array.isArray(t.value) ? t.value : [];
  const concrete = value.filter((b) => NUMBERY.test(b.he || ''));
  if (concrete.length < 5) {
    problems.push(`only ${concrete.length} value beats are concrete (need at least 5 with a number or measurable action)`);
  }

  const caps = t.captions || {};
  ['instagram', 'tiktok', 'youtube'].forEach((p) => {
    if (!caps[p] || !caps[p].trim()) problems.push(`missing captions.${p}`);
  });
  if (!t.youtubeTitle || !t.youtubeTitle.trim()) problems.push('missing youtubeTitle');
  if (t.youtubeTitle && t.youtubeTitle.length > 95) problems.push('youtubeTitle longer than 95 chars');

  // Unique queries keep the footage from looking repetitive.
  const queries = new Set();
  [...(t.hook || []), ...value, ...(t.beliefShift || []), ...(t.fear || [])]
    .forEach((b) => b && b.query && queries.add(b.query.toLowerCase().trim()));
  if (queries.size < 8) problems.push(`only ${queries.size} distinct stock queries (need at least 8)`);

  return problems;
}

module.exports = { validateTopic, MOTIVATORS, BANNED };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node validate_content.js <topics.json>'); process.exit(1); }
  const topics = JSON.parse(fs.readFileSync(file, 'utf8'));
  let failed = 0;
  topics.forEach((t, i) => {
    const problems = validateTopic(t);
    if (problems.length) {
      failed += 1;
      console.log(`\n✗ [${i}] ${t && t.id ? t.id : '(no id)'}`);
      problems.forEach((p) => console.log(`    ${p}`));
    } else {
      const beats = ['hook', 'value', 'beliefShift', 'fear'].reduce((a, k) => a + (t[k] || []).length, 0);
      console.log(`✓ [${i}] ${t.id} — ${beats} beats, motivators: ${(t.motivators || []).join(', ')}`);
    }
  });
  console.log(`\n${topics.length - failed}/${topics.length} topics valid`);
  process.exit(failed ? 1 : 0);
}
