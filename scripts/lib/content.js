'use strict';
/*
 * content.js — assembles a topic into the exact beat list a render needs.
 *
 * The CTA is defined here and nowhere else. It is never generated, never
 * rephrased, never shortened. Instagram gets the "comment אני" CTA because the
 * goal there is comments; TikTok and YouTube Shorts get the link-in-bio CTA
 * because neither lets us auto-reply to a comment in DM.
 */

const { wordCount } = require('./text');

// Two beats, one caption line each, six Hebrew words each.
const CTA = {
  instagram: [
    {
      en: 'Comment the word me if you made it this far.',
      he: 'תגיבו "אני" אם הגעתם עד לכאן,',
      query: 'sunrise mountain top success',
    },
    {
      en: 'And get the guide to building real self discipline.',
      he: 'וקבלו את המדריך לפיתוח משמעת עצמית 👇',
      query: 'golden sunrise horizon hope',
    },
  ],
  social: [
    {
      en: 'The link in my profile is waiting for you right now.',
      he: 'הקישור בפרופיל מחכה לכם עכשיו,',
      query: 'sunrise mountain top success',
    },
    {
      en: 'Tap it and get the full guide.',
      he: 'לחצו וקבלו את המדריך המלא 👇',
      query: 'golden sunrise horizon hope',
    },
  ],
};

const PLATFORM_CTA = {
  instagram: 'instagram',
  tiktok: 'social',
  youtube: 'social',
};

/** Beats in their fixed narrative order, CTA excluded. */
function bodyBeats(topic) {
  return [
    ...(topic.hook || []),
    ...(topic.value || []),
    ...(topic.beliefShift || []),
    ...(topic.fear || []),
  ];
}

/**
 * Build the render payload for one topic on one platform.
 * `variant` is 'instagram' (comment CTA) or 'social' (link-in-bio CTA).
 */
function buildRenderContent(topic, { outDir, platform, brand, musicIndex, voice, rate }) {
  const variant = PLATFORM_CTA[platform] || 'social';
  return {
    outDir,
    brand: brand || '',
    voice,
    rate,
    musicIndex: musicIndex || 0,
    beats: bodyBeats(topic).map((b) => ({ en: b.en, he: b.he, query: b.query })),
    cta: CTA[variant].map((b) => ({ ...b })),
  };
}

/** Per-platform post caption. Instagram drives comments; the others drive the bio link. */
function captionFor(topic, platform) {
  const c = topic.captions || {};
  if (c[platform]) return c[platform];
  const base = c.instagram || topic.caption || '';
  if (platform === 'instagram') return base;
  return `${base}\n\nהמדריך המלא בקישור בפרופיל 👆`;
}

/** Sanity check used by both the validator and the generator. */
function ctaIsIntact() {
  const problems = [];
  for (const [name, beats] of Object.entries(CTA)) {
    beats.forEach((b, i) => {
      const n = wordCount(b.he);
      if (n < 4 || n > 6) problems.push(`CTA ${name}[${i}] has ${n} Hebrew words (need 4-6): "${b.he}"`);
      if (/[\r\n]/.test(b.he)) problems.push(`CTA ${name}[${i}] contains a line break`);
    });
  }
  return problems;
}

module.exports = { CTA, PLATFORM_CTA, bodyBeats, buildRenderContent, captionFor, ctaIsIntact };
