'use strict';
/*
 * tts.js — per-BEAT voiceover.
 *
 * Why per beat and not one long take:
 *   The original build synthesised the whole script in one pass and then guessed
 *   each caption's start from cumulative word-boundary offsets. Any drift there
 *   made captions appear before the narrator reached them — the exact bug being
 *   fixed. Rendering one audio file per beat makes a caption's on-screen span
 *   equal to that beat's real audio length, by construction. It cannot drift.
 *
 * Files are cached by md5(text|voice|rate) so re-runs and the fixed CTA are
 * synthesised once, ever.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const { duration } = require('./ffmpeg');

const DEFAULT_VOICE = 'en-US-ChristopherNeural';   // deep, calm, authoritative
const DEFAULT_RATE = '+12%';                       // keeps a 21-beat script near 60s

function synth(text, voice, rate, outPath) {
  return new Promise((resolve, reject) => {
    (async () => {
      const tts = new MsEdgeTTS();
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text, { rate });
      const out = fs.createWriteStream(outPath);
      let bytes = 0;
      audioStream.on('data', (c) => { bytes += c.length; out.write(c); });
      audioStream.on('error', reject);
      audioStream.on('end', () => {
        out.end();
        out.on('finish', () => (bytes > 0 ? resolve() : reject(new Error('TTS returned no audio'))));
      });
    })().catch(reject);
  });
}

/**
 * Synthesise one beat. Returns { file, dur }.
 * Retries once — the Edge endpoint occasionally drops a socket.
 */
async function speakBeat(text, cacheDir, opts = {}) {
  const voice = opts.voice || DEFAULT_VOICE;
  const rate = opts.rate || DEFAULT_RATE;
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const hash = crypto.createHash('md5').update(`${clean}|${voice}|${rate}`).digest('hex').slice(0, 16);
  const file = path.join(cacheDir, `tts_${hash}.mp3`);

  if (fs.existsSync(file) && fs.statSync(file).size > 512) {
    return { file, dur: duration(file), cached: true };
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  try {
    await synth(clean, voice, rate, file);
  } catch (e) {
    try { fs.unlinkSync(file); } catch (_) {}
    await new Promise((r) => setTimeout(r, 1500));
    await synth(clean, voice, rate, file);
  }
  return { file, dur: duration(file), cached: false };
}

module.exports = { speakBeat, DEFAULT_VOICE, DEFAULT_RATE };
