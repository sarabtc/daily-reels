'use strict';
/*
 * ffmpeg.js — locate the binaries and run them.
 *
 * Resolution order:
 *   1. FFMPEG_PATH env var (set by main.js / CI)
 *   2. system ffmpeg on PATH (GitHub Actions installs it via apt)
 *   3. the ffmpeg-static npm package (works on macOS arm64 with no Homebrew)
 *
 * ffprobe is deliberately NOT required: the ffprobe-static binary is broken on
 * darwin/arm64, and ffmpeg alone can report a file's duration.
 */

const { spawnSync, execFileSync } = require('child_process');

function resolveFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch (_) { /* not on PATH */ }
  try {
    const p = require('ffmpeg-static');
    if (p) return p;
  } catch (_) { /* package not installed */ }
  throw new Error('ffmpeg not found. Install it, set FFMPEG_PATH, or run: npm i ffmpeg-static');
}

const FFMPEG = resolveFfmpeg();

/** Run ffmpeg, throwing with real stderr on failure. */
function ff(args, cwd) {
  const r = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed (${r.status}):\n${(r.stderr || '').slice(-1500)}`);
  }
  return r.stdout;
}

/** Duration in seconds, parsed from ffmpeg's own decode report. */
function duration(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const err = r.stderr || '';
  const last = [...err.matchAll(/time=(\d+):(\d\d):(\d\d\.\d+)/g)].pop();
  if (last) return (+last[1]) * 3600 + (+last[2]) * 60 + parseFloat(last[3]);
  const d = err.match(/Duration:\s*(\d+):(\d\d):(\d\d\.\d+)/);
  if (d) return (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]);
  throw new Error(`could not read duration of ${file}:\n${err.slice(-400)}`);
}

/** ASS timestamp: H:MM:SS.cc */
function tc(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

module.exports = { FFMPEG, ff, duration, tc };
