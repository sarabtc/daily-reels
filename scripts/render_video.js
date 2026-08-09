'use strict';
/*
 * render_video.js — builds one 1080x1920 vertical video.
 *
 * Usage: node render_video.js <content.json>
 *
 * content.json:
 * {
 *   "outDir": "/abs/path",
 *   "beats":  [ { "en": "...", "he": "ארבע עד שש מילים", "query": "stock search" } ],
 *   "cta":    [ { "en": "...", "he": "...", "query": "..." } ],
 *   "brand":  "@ryze.il",
 *   "voice":  "en-US-ChristopherNeural",
 *   "musicIndex": 0
 * }
 *
 * The three rules this file exists to enforce:
 *   1. A caption is on screen ONLY while the narrator is saying it.
 *   2. A caption is always ONE line of 4-6 Hebrew words.
 *   3. The clip cuts on every caption change, at exactly the same timestamp.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { ff, duration, tc } = require('./lib/ffmpeg');
const { speakBeat } = require('./lib/tts');
const { normaliseCaptions, stripEmoji } = require('./lib/text');
const { resolveBed } = require('./lib/music');
const { ClipPool } = require('./lib/pixabay');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const W = 1080, H = 1920, FPS = 30;
const LEAD_IN = 0.35;      // silence before the first word — lets the clip land first
const GAP = 0.26;          // breath between beats
const TAIL = 1.30;         // hold after the last word
const HOLD = 0.06;         // how long a caption lingers after its audio ends
const CLEAR = 0.06;        // guaranteed blank time before the next caption
// GAP - HOLD leaves ~0.2s with no caption between beats: long enough to read as
// a deliberate cut rather than a two-frame flicker, short enough to stay tight.

const SKILL_DIR = path.join(__dirname, '..');
const ASSETS = path.join(SKILL_DIR, 'assets');

const FONT_CANDIDATES = [
  ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'Arial'],
  ['/Library/Fonts/Arial Bold.ttf', 'Arial'],
  ['C:/Windows/Fonts/arialbd.ttf', 'Arial'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ['/usr/share/fonts/truetype/noto/NotoSansHebrew-Bold.ttf', 'Noto Sans Hebrew'],
  ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', 'Arial Unicode MS'],
];

function findFont() {
  for (const [file, family] of FONT_CANDIDATES) {
    if (fs.existsSync(file)) return { file, family };
  }
  throw new Error('No Hebrew-capable bold font found. On Linux: apt-get install fonts-dejavu-core');
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'daily-reels/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, outPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { fs.writeFileSync(outPath, Buffer.concat(chunks)); resolve(outPath); });
    }).on('error', reject);
  });
}

/** The 👇 in the CTA has to be a real colour image — libass renders emoji black. */
async function ensurePointDownEmoji() {
  const dir = path.join(ASSETS, 'emoji');
  const file = path.join(dir, 'point_down.png');
  if (fs.existsSync(file) && fs.statSync(file).size > 512) return file;
  fs.mkdirSync(dir, { recursive: true });
  const sources = [
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/128/emoji_u1f447.png',
    'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f447.png',
  ];
  for (const url of sources) {
    try { await download(url, file); if (fs.statSync(file).size > 512) return file; } catch (_) {}
  }
  console.warn('  emoji: could not fetch 👇 image; rendering the CTA without it');
  return null;
}

/** Silence of `sec` seconds as a normalised wav. */
function silence(file, sec) {
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', sec.toFixed(3),
    '-c:a', 'pcm_s16le', file]);
  return file;
}

function toWav(src, dst) {
  ff(['-i', src, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', dst]);
  return dst;
}

(async () => {
  const contentPath = process.argv[2];
  if (!contentPath) { console.error('Usage: node render_video.js <content.json>'); process.exit(1); }
  const C = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

  const OUT_DIR = C.outDir;
  if (!OUT_DIR) throw new Error('content.json needs "outDir"');
  const WORK = path.join(OUT_DIR, '.work');
  const CACHE = path.join(SKILL_DIR, '.cache');
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(CACHE, { recursive: true });

  const PIXABAY_KEY = process.env.PIXABAY_KEY || process.env.PIXABAY_API_KEY;
  if (!PIXABAY_KEY) throw new Error('PIXABAY_KEY is not set (.env or environment)');

  const beats = [...(C.beats || []), ...(C.cta || [])];
  if (!beats.length) throw new Error('content.json has no beats');

  // ---- 1. voiceover, one file per beat -------------------------------------
  console.log(`Voicing ${beats.length} beats...`);
  const ttsDir = path.join(CACHE, 'tts');
  for (const b of beats) {
    const { file, dur } = await speakBeat(b.en, ttsDir, { voice: C.voice, rate: C.rate });
    b._audio = file;
    b._dur = dur;
  }

  // ---- 2. timeline ---------------------------------------------------------
  // Built from the real audio lengths, so a caption can never precede its words.
  let t = LEAD_IN;
  beats.forEach((b) => { b.speechStart = t; b.speechEnd = t + b._dur; t = b.speechEnd + GAP; });
  const TOTAL = +(t - GAP + TAIL).toFixed(3);

  // ---- 3. captions: one line, 4-6 words, sized to fit ----------------------
  const caps = normaliseCaptions(beats.map((b, i) => ({ he: b.he, query: b.query, beat: i })));
  caps.forEach((c) => {
    const b = beats[c.parentIndex];
    const len = b.speechEnd - b.speechStart;
    c.start = b.speechStart + len * c.shareStart;
    c.end = b.speechStart + len * c.shareEnd;
  });
  // Caption i shows [start, end+HOLD] but always clears before caption i+1.
  caps.forEach((c, i) => {
    const next = caps[i + 1];
    const limit = next ? next.start - CLEAR : TOTAL;
    c.subStart = c.start;
    c.subEnd = Math.max(c.start + 0.35, Math.min(c.end + HOLD, limit));
  });
  // Clip i runs from this caption's start to the next caption's start, so the
  // cut and the caption change land on the very same frame. Clip 0 covers the
  // lead-in; the last clip runs to the end of the video.
  caps.forEach((c, i) => {
    c.clipStart = i === 0 ? 0 : c.start;
    c.clipEnd = i < caps.length - 1 ? caps[i + 1].start : TOTAL;
  });

  console.log(`${caps.length} captions, ${TOTAL.toFixed(2)}s total`);
  const bad = caps.filter((c) => c._words < 4 || c._words > 6);
  if (bad.length) console.warn(`  note: ${bad.length} caption(s) outside 4-6 words after auto-fix`);

  // ---- 4. one distinct clip per caption ------------------------------------
  const pool = new ClipPool({ apiKey: PIXABAY_KEY, cacheDir: path.join(CACHE, 'clips') });
  const segCache = path.join(CACHE, 'segments');
  fs.mkdirSync(segCache, { recursive: true });
  const listLines = [];
  let reused = 0;

  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    const dur = Math.max(0.7, c.clipEnd - c.clipStart);
    const seg = path.join(WORK, `seg${String(i).padStart(3, '0')}.mp4`);
    listLines.push(`file '${path.basename(seg)}'`);

    const { hit, variant, reuse } = await pool.take(c.query);
    const raw = await pool.fetchFile(hit, variant);
    const rawDur = duration(raw);
    // A reused hit is shown from a later moment so it does not read as a repeat.
    const offset = rawDur > dur + 1 ? Math.min((reuse * 3.1) % (rawDur - dur), rawDur - dur) : 0;
    const zoomIn = i % 2 === 0;

    // The Instagram and TikTok cuts of a topic share every beat except the CTA,
    // so an already-encoded segment with identical inputs is simply reused.
    const key = crypto.createHash('md5')
      .update(`${hit.id}|${offset.toFixed(2)}|${dur.toFixed(3)}|${zoomIn}|${W}x${H}@${FPS}`)
      .digest('hex').slice(0, 16);
    const cached = path.join(segCache, `${key}.mp4`);

    if (fs.existsSync(cached) && fs.statSync(cached).size > 4096) {
      fs.copyFileSync(cached, seg);
      reused += 1;
      continue;
    }

    const bigW = Math.round(W * 1.25), bigH = Math.round(H * 1.25);
    const z = zoomIn ? 'min(1.0+0.0012*on,1.22)' : 'max(1.22-0.0012*on,1.0)';
    ff(['-stream_loop', '-1', '-i', raw, '-ss', offset.toFixed(2), '-t', dur.toFixed(3),
      '-vf', `scale=${bigW}:${bigH}:force_original_aspect_ratio=increase,crop=${bigW}:${bigH},`
        + `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},`
        + 'setsar=1,format=yuv420p',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', seg]);
    fs.copyFileSync(seg, cached);
    console.log(`  clip ${i + 1}/${caps.length} "${c.query}" #${hit.id} ${dur.toFixed(2)}s`);
  }
  if (reused) console.log(`  reused ${reused} cached segment(s)`);

  fs.writeFileSync(path.join(WORK, 'list.txt'), listLines.join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'novoice.mp4'], WORK);

  // ---- 5. voice track assembled to match the timeline exactly --------------
  const aParts = [];
  aParts.push(silence(path.join(WORK, 'sil_lead.wav'), LEAD_IN));
  beats.forEach((b, i) => {
    aParts.push(toWav(b._audio, path.join(WORK, `v${String(i).padStart(3, '0')}.wav`)));
    aParts.push(silence(path.join(WORK, `gap${String(i).padStart(3, '0')}.wav`),
      i === beats.length - 1 ? TAIL : GAP));
  });
  fs.writeFileSync(path.join(WORK, 'alist.txt'),
    aParts.map((p) => `file '${path.basename(p)}'`).join('\n'));
  ff(['-f', 'concat', '-safe', '0', '-i', 'alist.txt', '-c', 'copy', 'voice.wav'], WORK);

  // ---- 6. music bed --------------------------------------------------------
  const bed = await resolveBed({
    assetsDir: ASSETS, cacheDir: path.join(CACHE, 'music'),
    seconds: TOTAL, index: C.musicIndex || 0,
  });
  console.log(`Music: ${bed.source}`);
  fs.copyFileSync(bed.file, path.join(WORK, path.extname(bed.file) === '.wav' ? 'bg.wav' : 'bg.mp3'));
  const bgName = fs.existsSync(path.join(WORK, 'bg.wav')) ? 'bg.wav' : 'bg.mp3';

  // ---- 7. subtitles --------------------------------------------------------
  const font = findFont();
  fs.copyFileSync(font.file, path.join(WORK, path.basename(font.file)));

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${font.family},58,&H00FFFFFF,&H000000FF,&H00000000,&HA0000000,-1,0,0,0,100,100,0,0,1,4,3,5,60,60,0,1
Style: Brand,${font.family},38,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,8,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // U+202B / U+202C force right-to-left so commas and periods land correctly.
  const rtl = (s) => '\u202B' + stripEmoji(s) + '\u202C';
  const events = caps.map((c) =>
    `Dialogue: 0,${tc(c.subStart)},${tc(c.subEnd)},Cap,,0,0,0,,`
    + `{\\an5\\pos(540,960)\\fs${c.fontSize}\\fad(90,60)}${rtl(c.he)}`
  );
  if (C.brand) {
    events.unshift(`Dialogue: 0,${tc(0)},${tc(TOTAL)},Brand,,0,0,0,,{\\an8\\pos(540,1700)}${C.brand}`);
  }
  fs.writeFileSync(path.join(WORK, 'subs.ass'), header + events.join('\n') + '\n', 'utf8');

  // ---- 8. final mux --------------------------------------------------------
  // The 👇 emoji is overlaid as a colour PNG under the last caption line.
  const emojiFile = /\u{1F447}/u.test(beats.map((b) => b.he).join(''))
    ? await ensurePointDownEmoji() : null;
  let emojiIdx = -1;
  const inputs = ['-i', 'novoice.mp4', '-i', 'voice.wav', '-stream_loop', '-1', '-i', bgName];
  if (emojiFile) {
    fs.copyFileSync(emojiFile, path.join(WORK, 'emoji.png'));
    inputs.push('-loop', '1', '-i', 'emoji.png');
    emojiIdx = 3;
  }

  let vf = `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.28:t=fill,`
    + `ass=subs.ass:fontsdir=.[vs];`;
  if (emojiFile) {
    const last = caps[caps.length - 1];
    vf += `[${emojiIdx}:v]scale=76:76[em];`
      + `[vs][em]overlay=(W-w)/2:1040:enable='between(t,${last.subStart.toFixed(2)},${last.subEnd.toFixed(2)})'[v];`;
  } else {
    vf += '[vs]null[v];';
  }

  // The bed is normalised to a fixed loudness so a track you drop in yourself
  // sits at the same level as the synthesised one. The fade-in is short on
  // purpose: the hook is the most important second of the video and it should
  // not open in silence.
  const af = '[1:a]volume=1.0,alimiter=limit=0.97[voice];'
    + `[2:a]loudnorm=I=-30:TP=-3,afade=t=in:st=0:d=1.2,`
    + `afade=t=out:st=${Math.max(0, TOTAL - 2.0).toFixed(2)}:d=2.0[bg];`
    + '[voice][bg]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]';

  console.log('Rendering final video...');
  ff([...inputs, '-filter_complex', vf + af, '-map', '[v]', '-map', '[a]',
    '-t', String(TOTAL), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-r', String(FPS),
    '-movflags', '+faststart', 'final.mp4'], WORK);

  const outFile = path.join(OUT_DIR, 'video.mp4');
  fs.copyFileSync(path.join(WORK, 'final.mp4'), outFile);

  const meta = {
    file: outFile,
    seconds: duration(outFile),
    captions: caps.map((c) => ({ he: c.he, words: c._words, from: +c.subStart.toFixed(2), to: +c.subEnd.toFixed(2) })),
    music: bed.source,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'render.json'), JSON.stringify(meta, null, 2));
  console.log(`DONE -> ${outFile} (${meta.seconds.toFixed(2)}s)`);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
