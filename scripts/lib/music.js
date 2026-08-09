'use strict';
/*
 * music.js — every video gets a calm music bed. No exceptions.
 *
 * Pixabay's public API covers images and videos only — there is no music
 * endpoint — so the bed is resolved through a chain that always terminates in
 * something playable:
 *
 *   1. assets/music/*.mp3|m4a|wav   — tracks you dropped in, rotated per video
 *   2. Jamendo API                  — optional, needs JAMENDO_CLIENT_ID (free)
 *   3. synthesised ambient pad      — generated with ffmpeg, always available
 *
 * The synthesised bed is a slow four-chord loop (Am - F - C - G) built from sine
 * voices with a cosine swell that reaches zero at every chord change, so the
 * chords cross-fade instead of clicking.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { ff } = require('./ffmpeg');

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg)$/i;

// Am - F - C - G, one chord per bar. [bass, three upper voices]
const CHORDS = [
  { bass: 110.00, voices: [220.00, 261.63, 329.63] },
  { bass: 87.31,  voices: [174.61, 220.00, 261.63] },
  { bass: 130.81, voices: [261.63, 329.63, 392.00] },
  { bass: 98.00,  voices: [196.00, 246.94, 293.66] },
];
const BAR = 8;                                  // seconds per chord
const LOOP = CHORDS.length * BAR;               // 32s loop

function padExpression() {
  // Swell is zero at both ends of each bar => silent crossover, no clicks.
  const env = `(0.5-0.5*cos(2*PI*mod(t,${BAR})/${BAR}))`;
  const parts = CHORDS.map((c, i) => {
    const lo = i * BAR;
    const hi = (i + 1) * BAR;
    const voices = c.voices.map((f) => `sin(2*PI*${f}*t)`).join('+');
    const bass = `1.6*sin(2*PI*${c.bass}*t)`;
    return `between(mod(t,${LOOP}),${lo},${hi})*(${voices}+${bass})`;
  });
  return `0.06*${env}*(${parts.join('+')})`;
}

/** Render a calm ambient bed of `seconds` length to outPath. */
function synthesiseBed(outPath, seconds) {
  const expr = padExpression();
  const loops = Math.ceil(seconds / LOOP) + 1;
  // The expression contains commas (mod(t,8), between(...)) which would be read
  // as filter separators, so it is wrapped in ffmpeg's own single quotes. There
  // is no shell involved here — ffmpeg strips these itself.
  ff([
    '-f', 'lavfi',
    '-i', `aevalsrc=exprs='${expr}':s=44100:d=${(LOOP * loops).toFixed(2)}`,
    '-af', [
      'lowpass=f=1400',                 // take the edge off the sines
      'aecho=0.8:0.85:420|780:0.28|0.18', // space
      'atrim=0:' + seconds.toFixed(2),
      'asetpts=N/SR/TB',
    ].join(','),
    '-ac', '2', '-ar', '44100', '-c:a', 'libmp3lame', '-q:a', '4',
    outPath,
  ]);
  return outPath;
}

function listLocalTracks(assetsDir) {
  const dir = path.join(assetsDir, 'music');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => AUDIO_EXT.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'daily-reels/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return getJSON(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(new Error('bad JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    https.get(url, { headers: { 'User-Agent': 'daily-reels/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return download(res.headers.location, outPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode)); }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(outPath)));
    }).on('error', (e) => { file.close(); reject(e); });
  });
}

/** Calm instrumental tracks from Jamendo, if a client id is configured. */
async function fromJamendo(cacheDir, index) {
  const id = process.env.JAMENDO_CLIENT_ID;
  if (!id) return null;
  const tags = ['ambient', 'calm', 'relaxing', 'cinematic', 'lounge', 'chillout'];
  const tag = tags[index % tags.length];
  const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${id}&format=json&limit=25`
    + `&tags=${encodeURIComponent(tag)}&vocalinstrumental=instrumental`
    + `&audioformat=mp32&order=popularity_total&include=licenses`;
  try {
    const data = await getJSON(url);
    const list = (data && data.results) || [];
    if (!list.length) return null;
    const pick = list[index % list.length];
    if (!pick || !pick.audio) return null;
    const out = path.join(cacheDir, `jamendo_${pick.id}.mp3`);
    if (!fs.existsSync(out)) await download(pick.audio, out);
    return { file: out, source: `jamendo:${pick.name}` };
  } catch (e) {
    console.warn(`  music: jamendo lookup failed (${e.message}); falling back`);
    return null;
  }
}

/**
 * Resolve the music bed for one video.
 * `index` varies the pick so consecutive videos never share a track.
 * Always returns { file, source } — never null.
 */
async function resolveBed({ assetsDir, cacheDir, seconds, index = 0 }) {
  fs.mkdirSync(cacheDir, { recursive: true });

  const local = listLocalTracks(assetsDir);
  if (local.length) {
    const file = local[index % local.length];
    return { file, source: `local:${path.basename(file)}` };
  }

  const jam = await fromJamendo(cacheDir, index);
  if (jam) return jam;

  const out = path.join(cacheDir, `bed_${Math.ceil(seconds)}.mp3`);
  if (!fs.existsSync(out)) synthesiseBed(out, Math.max(seconds + 4, 20));
  return { file: out, source: 'synth:ambient-pad' };
}

module.exports = { resolveBed, synthesiseBed, listLocalTracks };
