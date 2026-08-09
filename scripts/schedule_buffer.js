'use strict';
/*
 * schedule_buffer.js — hosts the rendered video and schedules it in Buffer.
 *
 * Buffer never accepts a file upload: the API docs are explicit that an asset
 * url "must point to a publicly accessible file", which Buffer then fetches.
 * So the video needs a real public home first.
 *
 * Hosting order:
 *   1. GitHub Release asset — stable, free, permanent, already authenticated
 *      inside the Action. Requires the repo to be public.
 *   2. catbox.moe / 0x0.st — throwaway fallbacks if GitHub is unavailable.
 *
 * Verified against the Buffer GraphQL API (developers.buffer.com):
 *   createPost(input: { channelId, text, dueAt, schedulingType, mode,
 *                       assets: [{ video: { url, metadata:{ thumbnailOffset } } }],
 *                       metadata: { instagram|tiktok|youtube: {...} } })
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

// Loaded here as well as in main.js, because this file is also a CLI
// (`node scripts/schedule_buffer.js --channels`) with no other entry point.
require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const GRAPHQL_HOST = 'api.buffer.com';

// ---------------------------------------------------------------- Buffer API

function gql(query, variables) {
  const token = process.env.BUFFER_TOKEN;
  if (!token) return Promise.reject(new Error('BUFFER_TOKEN is not set'));
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ query, variables }));
    const req = https.request({
      hostname: GRAPHQL_HOST, path: '/graphql', method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(text); }
        catch (e) { return reject(new Error(`Buffer returned non-JSON (${res.statusCode}): ${text.slice(0, 200)}`)); }
        if (parsed.errors) return reject(new Error(parsed.errors[0].message));
        resolve(parsed.data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Every channel on the account.
 *
 * Note the field is `type`, not `serviceType` — asking for the latter makes the
 * API fail with an opaque internal fetch error rather than a validation error.
 */
async function listChannels() {
  const acc = await gql(`query { account { id organizations { id name } } }`);
  const orgs = acc?.account?.organizations || [];
  const out = [];
  for (const org of orgs) {
    const data = await gql(
      `query Ch($input: ChannelsInput!) {
         channels(input: $input) { id name service type isDisconnected isLocked }
       }`,
      { input: { organizationId: org.id } }
    );
    (data?.channels || []).forEach((c) => out.push({ ...c, organization: org.name, organizationId: org.id }));
  }
  return out;
}

// ------------------------------------------------------------- video hosting

function ghRequest(host, pathName, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: pathName, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`GitHub ${res.statusCode}: ${text.slice(0, 300)}`));
        try { resolve(JSON.parse(text)); } catch (e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Upload the file as a GitHub Release asset and return its public URL. */
async function hostOnGitHubRelease(filePath, tag) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;      // "owner/name", set by Actions
  if (!token || !repo) return null;

  const [owner, name] = repo.split('/');
  const api = { Authorization: `Bearer ${token}`, 'User-Agent': 'daily-reels', Accept: 'application/vnd.github+json' };

  let release;
  try {
    release = await ghRequest('api.github.com', `/repos/${owner}/${name}/releases/tags/${tag}`, 'GET', api);
  } catch (_) {
    const body = Buffer.from(JSON.stringify({
      tag_name: tag, name: tag, body: 'Rendered reels for this date.', prerelease: true,
    }));
    release = await ghRequest('api.github.com', `/repos/${owner}/${name}/releases`, 'POST',
      { ...api, 'Content-Type': 'application/json', 'Content-Length': body.length }, body);
  }
  if (!release || !release.id) return null;

  const data = fs.readFileSync(filePath);
  const assetName = `${Date.now()}_${path.basename(filePath)}`;
  const asset = await ghRequest('uploads.github.com',
    `/repos/${owner}/${name}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    'POST', { ...api, 'Content-Type': 'video/mp4', 'Content-Length': data.length }, data);

  return asset && asset.browser_download_url ? asset.browser_download_url : null;
}

/** Throwaway hosts, used only when the GitHub route is unavailable. */
function hostOnFallback(filePath) {
  const attempts = [
    () => execFileSync('curl', ['-sS', '-f', '--max-time', '300',
      '-F', 'reqtype=fileupload', '-F', `fileToUpload=@${filePath}`,
      'https://catbox.moe/user/api.php'], { encoding: 'utf8' }).trim(),
    () => execFileSync('curl', ['-sS', '-f', '--max-time', '300',
      '-F', `file=@${filePath}`, 'https://0x0.st'], { encoding: 'utf8' }).trim(),
  ];
  for (const attempt of attempts) {
    try {
      const url = attempt();
      if (/^https?:\/\//.test(url)) return url;
    } catch (e) { /* try the next host */ }
  }
  return null;
}

async function hostVideo(filePath, tag) {
  try {
    const url = await hostOnGitHubRelease(filePath, tag);
    if (url) return url;
  } catch (e) {
    console.warn(`  host: GitHub release failed (${e.message})`);
  }
  const url = hostOnFallback(filePath);
  if (!url) throw new Error('could not host the video anywhere — Buffer needs a public URL');
  return url;
}

// ------------------------------------------------------------ post scheduling

// Every member of the PostActionPayload union is listed explicitly. Relying on
// a shared `... on MutationError` fragment is not safe here: that type is not in
// this schema, so a quota or validation failure would come back with no fields
// set and read as a silent success.
const MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      __typename
      ... on PostActionSuccess { post { id status dueAt } }
      ... on NotFoundError { message }
      ... on UnauthorizedError { message }
      ... on UnexpectedError { message }
      ... on RestProxyError { message }
      ... on LimitReachedError { message }
      ... on InvalidInputError { message }
    }
  }`;

/** Per-service metadata, exactly as the Buffer schema defines it. */
function metadataFor(service, topic) {
  if (service === 'instagram') {
    return { instagram: { type: 'reel', shouldShareToFeed: true } };
  }
  if (service === 'youtube') {
    return {
      youtube: {
        title: (topic.youtubeTitle || '').slice(0, 95),
        categoryId: process.env.YOUTUBE_CATEGORY_ID || '22',   // People & Blogs
        privacy: 'public',
        madeForKids: false,
      },
    };
  }
  if (service === 'tiktok') return { tiktok: {} };
  return {};
}

// Buffer fetches the asset itself, and a freshly uploaded release asset is not
// always readable on the first try — one channel can fail while the others
// accept the very same URL. These are worth retrying; a bad channel id is not.
const TRANSIENT = /could not be read|timed out|timeout|temporarily|try again|502|503|504/i;

async function schedulePost(args) {
  const attempts = args.draft ? 1 : 3;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await createPostOnce(args);
    } catch (e) {
      lastError = e;
      if (i === attempts - 1 || !TRANSIENT.test(e.message)) throw e;
      const wait = 8000 * (i + 1);
      console.warn(`  ${args.service}: ${e.message} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

async function createPostOnce({ channelId, service, videoUrl, caption, dueAt, topic, draft }) {
  const input = {
    channelId,
    text: caption,
    dueAt,
    schedulingType: 'automatic',
    mode: 'customScheduled',
    assets: [{ video: { url: videoUrl, metadata: { thumbnailOffset: 1200 } } }],
    metadata: metadataFor(service, topic),
  };
  // A draft lands in Buffer for review and never publishes on its own — the
  // safe way to prove the whole path works before anything goes out live.
  if (draft) input.saveToDraft = true;
  const data = await gql(MUTATION, { input });
  const payload = data?.createPost;
  if (!payload) throw new Error('Buffer returned an empty createPost payload');
  if (payload.__typename !== 'PostActionSuccess') {
    throw new Error(`${payload.__typename}: ${payload.message || 'no detail given'}`);
  }
  if (!payload.post?.id) throw new Error('Buffer reported success but returned no post');
  return payload.post;
}

module.exports = { gql, listChannels, hostVideo, schedulePost };

if (require.main === module) {
  if (process.argv.includes('--channels')) {
    listChannels().then((cs) => {
      if (!cs.length) return console.log('No channels found. Is BUFFER_TOKEN correct?');
      console.log('\nChannel IDs — put these in .env / GitHub secrets:\n');
      cs.forEach((c) => {
        const warn = c.isDisconnected ? '  ⚠ DISCONNECTED' : c.isLocked ? '  ⚠ LOCKED' : '';
        console.log(`  ${c.service.padEnd(12)} ${c.id}   ${c.name}${warn}`);
      });
      console.log('');
      const line = (svc, env) => {
        const hit = cs.find((c) => c.service === svc && !c.isDisconnected);
        if (hit) console.log(`  ${env}=${hit.id}`);
      };
      line('instagram', 'BUFFER_CHANNEL_INSTAGRAM');
      line('tiktok', 'BUFFER_CHANNEL_TIKTOK');
      line('youtube', 'BUFFER_CHANNEL_YOUTUBE');
      console.log('');
    }).catch((e) => { console.error('ERROR', e.message); process.exit(1); });
  } else {
    console.log('Usage: node schedule_buffer.js --channels');
  }
}
