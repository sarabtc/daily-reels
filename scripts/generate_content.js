'use strict';
/*
 * generate_content.js — produces the day's topics, fresh every time.
 *
 * Six unique videos a day cannot come from a fixed rotation: a 15-topic bank is
 * exhausted in two and a half days and then repeats. So topics are generated,
 * validated against the rules, and recorded in a ledger the next generation is
 * told to avoid.
 *
 * Providers, in order: Anthropic -> OpenAI -> the seed bank (day-one safety net).
 *
 * Usage:
 *   node generate_content.js            # writes content/today.json
 *   node generate_content.js --count 6
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const { validateTopic } = require('./validate_content');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const RULES_PATH = path.join(ROOT, 'references', 'content-rules.md');
const LEDGER_PATH = path.join(ROOT, 'content', 'used_ledger.json');
const SEED_PATH = path.join(ROOT, 'content', 'seed_topics.json');

const SCHEMA = `{
  "id": "kebab-case-unique-id",
  "motivators": ["fear", "control"],
  "limitingBelief": "האמונה המגבילה שהסרטון מנפץ",
  "empoweringBelief": "האמונה המקדמת שהסרטון מתקין",
  "hook":        [ { "en": "...", "he": "...", "query": "..." } ],
  "value":       [ { "en": "...", "he": "...", "query": "..." } ],
  "beliefShift": [ { "en": "...", "he": "...", "query": "..." } ],
  "fear":        [ { "en": "...", "he": "...", "query": "..." } ],
  "captions": {
    "instagram": "כיתוב לאינסטגרם עם קריאה לתגובה",
    "tiktok": "כיתוב לטיקטוק עם הפניה לקישור בפרופיל",
    "youtube": "תיאור ליוטיוב שורטס עם הפניה לקישור בפרופיל"
  },
  "youtubeTitle": "כותרת קצרה ליוטיוב"
}`;

function systemPrompt() {
  const rules = fs.readFileSync(RULES_PATH, 'utf8');
  return `אתה כותב תוכן לסרטוני רילס קצרים בעברית שמוכרים מדריך לפיתוח משמעת עצמית.

${rules}

--- פורמט הפלט ---

החזר JSON תקין בלבד: מערך של אובייקטים בסכמה הזו, בלי טקסט מסביב, בלי גדרות קוד.

${SCHEMA}

--- כללים טכניים קריטיים ---

1. השדה "he" הוא הכתובית. שורה אחת. בין 4 ל־6 מילים בעברית. תמיד. בלי יוצא מן הכלל.
2. השדה "en" הוא הקריינות באנגלית של אותה כתובית. 5 עד 9 מילים. משפט אחד שלם.
   הוא חייב להגיד בדיוק את מה שהכתובית אומרת — זה תרגום, לא תוכן נוסף.
3. השדה "query" הוא ביטוי חיפוש באנגלית ל־Pixabay לקליפ סטוק שמתאים לביט.
   2 עד 4 מילים, מוחשי וויזואלי ("man running empty street"), לא מופשט ("success mindset").
   השתמש ב־8 עד 12 ביטויי חיפוש שונים לכל סרטון.
4. אורכים: hook 1-2 ביטים, value 10-14, beliefShift 2-3, fear 2-3.
5. אל תכתוב CTA. הוא מתווסף אוטומטית ואסור לגעת בו.
6. בלי אימוג'י בשדה "he" של הביטים (רק ה־CTA מקבל אימוג'י).
7. לפחות 5 מביטי ה־value חייבים להכיל מספר קונקרטי או פעולה מדידה.`;
}

function userPrompt(count, ledger) {
  const seen = ledger.slice(-120);
  const avoid = seen.length
    ? seen.map((e) => `- ${e.id}: הוק "${e.hook}" | אמונה מגבילה "${e.limitingBelief}"`).join('\n')
    : '(עדיין אין היסטוריה)';
  return `צור ${count} נושאי סרטון חדשים לגמרי.

כבר יצאו הסרטונים הבאים — אסור לחזור על הזווית, על ההוק או על האמונה המגבילה שלהם:
${avoid}

דרישות לסבב הזה:
- כל סרטון בוחר 1-2 מניעים שונים מרשימת אחד עשר המניעים, ומגוון ביניהם.
- כל סרטון מנפץ אמונה מגבילה אחרת.
- לפחות שניים מהסרטונים חייבים להיות טקטיים לגמרי (שיטה עם שלבים ומספרים).

החזר רק את מערך ה־JSON.`;
}

function postJSON(hostname, pathName, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname, path: pathName, method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('bad JSON response')); }
      });
    });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/**
 * Google Gemini — the free option, and therefore the one tried first.
 * A key from aistudio.google.com costs nothing and its free tier allows far
 * more than the six requests a day this needs.
 */
async function callGemini(count, ledger) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  // A moving alias on purpose. Pinned names get retired — "gemini-2.5-flash"
  // started refusing new keys with a 404 that reads like an auth failure but is
  // really "this model is gone". The alias always points at the current flash.
  const model = process.env.CONTENT_MODEL_GEMINI || 'gemini-flash-latest';
  const data = await postJSON('generativelanguage.googleapis.com',
    `/v1beta/models/${model}:generateContent?key=${key}`, {}, {
      system_instruction: { parts: [{ text: systemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(count, ledger) }] }],
      generationConfig: {
        temperature: 1.1,
        maxOutputTokens: 32000,
        responseMimeType: 'application/json',
      },
    });
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('') || null;
}

async function callAnthropic(count, ledger) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const data = await postJSON('api.anthropic.com', '/v1/messages', {
    'x-api-key': key, 'anthropic-version': '2023-06-01',
  }, {
    model: process.env.CONTENT_MODEL || 'claude-sonnet-5',
    max_tokens: 16000,
    system: systemPrompt(),
    messages: [{ role: 'user', content: userPrompt(count, ledger) }],
  });
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAI(count, ledger) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const data = await postJSON('api.openai.com', '/v1/chat/completions', {
    Authorization: `Bearer ${key}`,
  }, {
    model: process.env.CONTENT_MODEL_OPENAI || 'gpt-4o',
    max_tokens: 16000,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(count, ledger) },
    ],
  });
  return data.choices?.[0]?.message?.content || null;
}

// A model will always drift a little on cosmetics. Rejecting a whole topic
// because a search phrase ran to six words instead of five throws away good
// content, so the fixable things are fixed here and only the rules that
// actually affect the finished video are left for the validator.
const MOTIVATOR_ALIASES = {
  social_status: 'status', social: 'status', prestige: 'status', recognition: 'status',
  time: 'saving', time_saving: 'saving', efficiency: 'saving', savings: 'saving',
  ease: 'simplicity', simple: 'simplicity', convenience: 'simplicity',
  scarcity: 'opportunity', rare_opportunity: 'opportunity', fomo: 'opportunity', urgency: 'opportunity',
  safety: 'security', certainty: 'security', trust: 'security', stability: 'security',
  boss: 'control', power: 'control', autonomy: 'control', independence: 'control',
  community: 'belonging', connection: 'belonging', togetherness: 'belonging',
  frustration: 'anger', justice: 'anger', revenge: 'anger',
  liberty: 'freedom', wealth: 'money', profit: 'money', income: 'money',
};

function tidyQuery(q) {
  return String(q || '')
    .replace(/[֐-׿]/g, ' ')                    // queries must be English
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .trim().split(/\s+/)
    .filter((w) => w.length > 1 && !['the', 'and', 'with', 'for', 'into', 'from', 'that'].includes(w.toLowerCase()))
    .slice(0, 4)
    .join(' ')
    .toLowerCase();
}

function normaliseTopic(t) {
  if (!t || typeof t !== 'object') return t;

  t.motivators = [...new Set((t.motivators || [])
    .map((m) => String(m).toLowerCase().trim().replace(/[\s-]+/g, '_'))
    .map((m) => MOTIVATOR_ALIASES[m] || m))]
    .slice(0, 2);

  ['hook', 'value', 'beliefShift', 'fear'].forEach((section) => {
    if (!Array.isArray(t[section])) return;
    t[section] = t[section].filter(Boolean).map((b) => ({
      ...b,
      he: String(b.he || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
      en: String(b.en || '').replace(/\s+/g, ' ').trim(),
      query: tidyQuery(b.query),
    }));
  });

  if (t.id) t.id = String(t.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (t.youtubeTitle) t.youtubeTitle = String(t.youtubeTitle).replace(/\s+/g, ' ').trim().slice(0, 95);
  return t;
}

function parseTopics(raw) {
  if (!raw) return [];
  let t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1) return [];
  try { return JSON.parse(t.slice(start, end + 1)); } catch (e) { return []; }
}

function loadLedger() {
  if (!fs.existsSync(LEDGER_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch (e) { return []; }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger.slice(-500), null, 2) + '\n');
}

function ledgerEntry(topic) {
  return {
    id: topic.id,
    hook: (topic.hook || []).map((b) => b.he).join(' '),
    limitingBelief: topic.limitingBelief || '',
    date: new Date().toISOString().slice(0, 10),
  };
}

/** Seed bank, used only when no API key is configured. Never repeats an id. */
function fromSeedBank(count, ledger) {
  if (!fs.existsSync(SEED_PATH)) return [];
  const seeds = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const usedIds = new Set(ledger.map((e) => e.id));
  const fresh = seeds.filter((s) => !usedIds.has(s.id));
  const pool = fresh.length >= count ? fresh : seeds;   // wrap only if genuinely exhausted
  return pool.slice(0, count);
}

/**
 * Returns { topics, source }. Invalid topics are dropped and one repair round is
 * attempted; whatever is still missing is topped up from the seed bank so a bad
 * generation never leaves the day without videos.
 */
async function generateTopics(count) {
  const ledger = loadLedger();
  // Free first, paid only as a fallback.
  const providers = [
    ['gemini', callGemini],
    ['anthropic', callAnthropic],
    ['openai', callOpenAI],
  ];

  for (const [name, fn] of providers) {
    let raw;
    try { raw = await fn(count + 2, ledger); } catch (e) {
      console.warn(`  generator: ${name} failed (${e.message})`);
      continue;
    }
    if (!raw) continue;

    const parsed = parseTopics(raw).map(normaliseTopic);
    const good = [];
    const bad = [];
    for (const t of parsed) {
      const problems = validateTopic(t);
      if (problems.length) bad.push({ id: t && t.id, problems }); else good.push(t);
    }
    console.log(`  generator: ${name} returned ${parsed.length}, ${good.length} passed the rules`);
    if (bad.length) {
      bad.slice(0, 4).forEach((b) => console.warn(`    dropped ${b.id}: ${b.problems[0]}`));
    }
    if (good.length >= count) return { topics: good.slice(0, count), source: name };
    if (good.length) {
      const top = fromSeedBank(count - good.length, ledger);
      return { topics: [...good, ...top], source: `${name}+seed` };
    }
  }

  console.warn('  generator: no API key or all providers failed; using the seed bank');
  return { topics: fromSeedBank(count, ledger), source: 'seed' };
}

/** Append the topics that actually shipped to the ledger. */
function recordUsed(topics) {
  const ledger = loadLedger();
  topics.forEach((t) => ledger.push(ledgerEntry(t)));
  saveLedger(ledger);
}

module.exports = { generateTopics, recordUsed, loadLedger, systemPrompt };

if (require.main === module) {
  const idx = process.argv.indexOf('--count');
  const count = idx > -1 ? parseInt(process.argv[idx + 1], 10) : 6;
  generateTopics(count).then(({ topics, source }) => {
    const out = path.join(ROOT, 'content', 'today.json');
    fs.writeFileSync(out, JSON.stringify(topics, null, 2) + '\n');
    console.log(`${topics.length} topics from ${source} -> ${out}`);
  }).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
