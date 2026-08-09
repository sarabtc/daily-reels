'use strict';
/*
 * pixabay.js — stock footage pool.
 *
 * Every caption change must also change the clip. With ~20 captions per video
 * and 6 videos a day that would be 120 downloads a day if each caption fetched
 * its own file. Instead:
 *
 *   - beats are grouped by search query, so one query is fetched once;
 *   - each query yields many hits, and beats sharing a query are handed
 *     DIFFERENT hits (and different in-clip offsets) round-robin;
 *   - raw downloads are cached on disk by hit id and reused across the run.
 *
 * The result is a visually distinct clip per caption at a fraction of the
 * bandwidth.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const API = 'https://pixabay.com/api/videos/';
const MAX_BYTES = 45 * 1024 * 1024;         // skip enormous masters
const MIN_HEIGHT = 1080;                    // enough for a 1080x1920 crop

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'daily-reels/2.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url.split('?')[0]}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** Score a hit by how many query words appear in its tags. */
function score(hit, queryWords) {
  const tags = String(hit.tags || '').toLowerCase();
  return queryWords.reduce((a, w) => a + (tags.includes(w) ? 1 : 0), 0);
}

/**
 * Choose the file variant to download.
 *
 * The output is 1080x1920 cropped from a landscape source, so anything past
 * ~1080 lines of height is thrown away by the scaler. Pixabay serves 4K masters
 * for many clips; downloading those would cost bandwidth and encode time for no
 * visible gain. So: the SMALLEST variant that still has at least 1080 lines,
 * falling back to the tallest available when nothing reaches that.
 */
function pickVariant(hit) {
  const vs = hit.videos || {};
  const usable = ['large', 'medium', 'small', 'tiny']
    .map((k) => vs[k])
    .filter((v) => v && v.url && (!v.size || v.size <= MAX_BYTES));
  if (!usable.length) return null;

  const enough = usable.filter((v) => (v.height || 0) >= MIN_HEIGHT);
  if (enough.length) {
    return enough.reduce((best, v) => ((v.height || 0) < (best.height || 0) ? v : best), enough[0]);
  }
  return usable.reduce((best, v) => ((v.height || 0) > (best.height || 0) ? v : best), usable[0]);
}

class ClipPool {
  constructor({ apiKey, cacheDir }) {
    this.apiKey = apiKey;
    this.cacheDir = cacheDir;
    this.byQuery = new Map();       // query -> hits[]
    this.cursor = new Map();        // query -> next hit index
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  async search(query) {
    if (this.byQuery.has(query)) return this.byQuery.get(query);
    const url = `${API}?key=${this.apiKey}&q=${encodeURIComponent(query)}`
      + '&per_page=50&safesearch=true&order=popular';
    let hits = [];
    try {
      const data = JSON.parse((await get(url)).toString());
      hits = data.hits || [];
    } catch (e) {
      console.warn(`  pixabay: "${query}" failed (${e.message})`);
    }
    const qw = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    hits = hits
      .map((h) => ({ ...h, _score: score(h, qw), _variant: pickVariant(h) }))
      .filter((h) => h._variant)
      .sort((a, b) => b._score - a._score);
    this.byQuery.set(query, hits);
    this.cursor.set(query, 0);
    return hits;
  }

  /**
   * Reserve the next distinct hit for `query`. Falls back to the generic pool
   * if a query returns nothing, so a bad search term never fails a render.
   */
  async take(query, fallbackQuery = 'calm nature cinematic') {
    let hits = await this.search(query);
    let key = query;
    if (!hits.length) {
      hits = await this.search(fallbackQuery);
      key = fallbackQuery;
      if (!hits.length) throw new Error(`no Pixabay footage for "${query}" or the fallback`);
    }
    const i = this.cursor.get(key) || 0;
    this.cursor.set(key, i + 1);
    const hit = hits[i % hits.length];
    // How many times we have wrapped around decides the in-clip offset, so a
    // reused hit is shown from a different moment.
    const wrap = Math.floor(i / hits.length);
    return { hit, variant: hit._variant, reuse: wrap };
  }

  /** Download a hit's file once; returns the local path. */
  async fetchFile(hit, variant) {
    const file = path.join(this.cacheDir, `pb_${hit.id}.mp4`);
    if (fs.existsSync(file) && fs.statSync(file).size > 4096) return file;
    const buf = await get(variant.url);
    fs.writeFileSync(file, buf);
    return file;
  }
}

module.exports = { ClipPool };
