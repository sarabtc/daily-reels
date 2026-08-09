'use strict';
/*
 * main.js — one run produces and schedules a full day of content.
 *
 * Six posts a day at 07:45, 10:30, 13:15, 16:00, 19:00 and 22:00 Israel time,
 * on Instagram, TikTok and YouTube Shorts.
 *
 * Two cuts are rendered per topic because the on-screen call to action differs:
 * Instagram asks for a comment (that is where the goal is comments), while
 * TikTok and YouTube point at the profile link (neither lets us auto-reply in
 * DM). Everything except the last two beats is shared, and the segment cache
 * means the second cut costs almost nothing.
 *
 * Usage:
 *   node scripts/main.js               # respects the once-a-day guard
 *   FORCE_RUN=true node scripts/main.js
 *   node scripts/main.js --dry-run     # render only, schedule nothing
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const { generateTopics, recordUsed } = require('./generate_content');
const { buildRenderContent, captionFor, ctaIsIntact } = require('./lib/content');
const { hostVideo, schedulePost } = require('./schedule_buffer');

const SLOTS = ['07:45', '10:30', '13:15', '16:00', '19:00', '22:00'];
const STATE_PATH = path.join(ROOT, 'content', 'state.json');
const OUT_ROOT = path.join(ROOT, 'out');
const BRAND = process.env.BRAND_HANDLE || '';
const TZ = 'Asia/Jerusalem';

const CHANNELS = [
  { service: 'instagram', env: 'BUFFER_CHANNEL_INSTAGRAM', cut: 'instagram' },
  { service: 'tiktok', env: 'BUFFER_CHANNEL_TIKTOK', cut: 'social' },
  { service: 'youtube', env: 'BUFFER_CHANNEL_YOUTUBE', cut: 'social' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todayInIsrael() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ });   // YYYY-MM-DD
}

/** Wall-clock fields of a UTC instant, as seen in Israel. */
function wallClock(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((a, p) => (a[p.type] = p.value, a), {});
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
}

/**
 * The UTC instant whose Israel wall clock is `dateStr` at `hhmm`.
 * Converges in two passes and is correct across daylight saving changes.
 */
function israelToUTC(dateStr, hhmm) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const target = Date.UTC(y, mo - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 3; i++) guess += target - wallClock(guess);
  return new Date(guess).toISOString();
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Slot times for `dateStr`. A slot already in the past rolls to the next day, so
 * a mid-day forced run never asks Buffer for a time that has been and gone.
 */
function slotTimes(dateStr) {
  const now = Date.now();
  return SLOTS.map((hhmm) => {
    let iso = israelToUTC(dateStr, hhmm);
    if (new Date(iso).getTime() <= now + 120000) {
      iso = israelToUTC(addDays(dateStr, 1), hhmm);
    }
    return { hhmm, iso };
  });
}

/**
 * Which day to fill. Defaults to today; SCHEDULE_DATE=YYYY-MM-DD or
 * SCHEDULE_DATE=tomorrow targets a specific day, which is what you want when
 * setting up mid-afternoon and the first post should be tomorrow at 07:45.
 */
function targetDate(today) {
  const raw = (process.env.SCHEDULE_DATE || '').trim();
  if (!raw) return today;
  if (raw === 'tomorrow') return addDays(today, 1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  throw new Error(`SCHEDULE_DATE must be YYYY-MM-DD or "tomorrow", got "${raw}"`);
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastRunDate: '' };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) { return { lastRunDate: '' }; }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
}

function render(content, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const contentPath = path.join(outDir, 'content.json');
  fs.writeFileSync(contentPath, JSON.stringify(content, null, 2));
  const r = spawnSync('node', [path.join(__dirname, 'render_video.js'), contentPath], {
    stdio: 'inherit', env: process.env, timeout: 20 * 60 * 1000,
  });
  if (r.status !== 0) throw new Error('render failed');
  return path.join(outDir, 'video.mp4');
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const today = todayInIsrael();
  const state = loadState();

  const ctaProblems = ctaIsIntact();
  if (ctaProblems.length) {
    ctaProblems.forEach((p) => console.error(`CTA rule violated: ${p}`));
    throw new Error('the CTA no longer satisfies the caption rules — fix lib/content.js');
  }

  if (!dryRun && process.env.FORCE_RUN !== 'true' && state.lastRunDate === today) {
    console.log(`Already ran today (${today}). Use FORCE_RUN=true to run again.`);
    return;
  }

  const active = CHANNELS.filter((c) => process.env[c.env]);
  if (!active.length && !dryRun) {
    throw new Error('No Buffer channels configured. Set at least BUFFER_CHANNEL_INSTAGRAM '
      + '(run: node scripts/schedule_buffer.js --channels)');
  }

  console.log(`=== Daily reels — ${today} ===`);
  console.log(`Channels: ${active.map((c) => c.service).join(', ') || '(dry run)'}`);

  const { topics, source } = await generateTopics(SLOTS.length);
  if (!topics.length) throw new Error('no topics available');
  console.log(`Topics: ${topics.length} from ${source}\n`);

  const forDay = targetDate(today);
  const times = slotTimes(forDay);
  if (forDay !== today) console.log(`Filling ${forDay} (SCHEDULE_DATE)`);
  const neededCuts = new Set(dryRun ? ['instagram', 'social'] : active.map((c) => c.cut));
  const shipped = [];

  for (let i = 0; i < topics.length && i < times.length; i++) {
    const topic = topics[i];
    const slot = times[i];
    console.log(`\n[${i + 1}/${times.length}] ${topic.id} -> ${slot.hhmm}`);

    try {
      const cuts = {};
      for (const cut of neededCuts) {
        const outDir = path.join(OUT_ROOT, `${today}_${i}_${cut}`);
        const content = buildRenderContent(topic, {
          outDir,
          platform: cut === 'instagram' ? 'instagram' : 'tiktok',
          brand: BRAND,
          musicIndex: i,
          voice: process.env.TTS_VOICE,
          rate: process.env.TTS_RATE,
        });
        cuts[cut] = render(content, outDir);
      }

      if (dryRun) {
        console.log(`  dry run — kept ${Object.values(cuts).join(', ')}`);
        shipped.push(topic);
        continue;
      }

      const hosted = {};
      for (const [cut, file] of Object.entries(cuts)) {
        hosted[cut] = await hostVideo(file, `reels-${today}`);
        console.log(`  hosted ${cut} -> ${hosted[cut]}`);
      }

      let ok = 0;
      for (const ch of active) {
        try {
          const post = await schedulePost({
            channelId: process.env[ch.env],
            service: ch.service,
            videoUrl: hosted[ch.cut],
            caption: captionFor(topic, ch.service),
            dueAt: slot.iso,
            topic,
          });
          console.log(`  ✓ ${ch.service} scheduled ${slot.hhmm} (post ${post?.id})`);
          ok += 1;
        } catch (e) {
          console.error(`  ✗ ${ch.service}: ${e.message}`);
        }
      }
      if (ok) shipped.push(topic);

      Object.values(cuts).forEach((f) => {
        try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch (_) {}
      });
    } catch (e) {
      console.error(`  ✗ ${topic.id}: ${e.message}`);
    }

    await sleep(1500);
  }

  if (shipped.length) recordUsed(shipped);
  if (!dryRun) saveState({ ...state, lastRunDate: today, lastShipped: shipped.length });

  console.log(`\n=== ${shipped.length}/${topics.length} topics shipped ===`);
  if (shipped.length < topics.length) process.exitCode = 1;
}

main().catch((e) => { console.error('Fatal:', e.message); process.exitCode = 1; });
