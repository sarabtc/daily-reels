---
name: instagram-daily-videos
description: >
  Generates six unique Hebrew-subtitled short videos every day and schedules them to Instagram Reels,
  TikTok and YouTube Shorts through the Buffer API, unattended via GitHub Actions. Use this skill for
  first-time setup, manual runs, changing the schedule or the call to action, adding music, writing new
  topics, or debugging a failed run. Triggers on "תעלה סרטונים", "תזמן סרטונים", "הרץ אינסטגרם",
  "סרטונים יומיים", "רילס", "setup instagram videos", "instagram automation", "daily reels".
---

# Daily Reels Automation

Six videos a day, posted at **07:45, 10:30, 13:15, 16:00, 19:00, 22:00** Israel time to
Instagram, TikTok and YouTube Shorts. Runs on GitHub Actions, so the user's computer can be off.

Every video: 1080×1920, ~60s, English neural voiceover, **Hebrew captions**, calm music bed,
stock footage that cuts on every caption change.

The product being sold is a **self-discipline guide**. Every video shatters one limiting
belief and installs one empowering belief. That is not decoration — `validate_content.js`
rejects a topic that does not declare both.

## The four caption rules

These exist because they were the original complaints. Do not relax them.

1. A caption is on screen **only while the narrator is speaking it**. Never before.
2. A caption is **one line**, never two or three.
3. A caption is **4–6 Hebrew words**. Not fewer, not more.
4. The clip **cuts on every caption change**, on the same frame.

Enforced by `lib/text.js` (splitting, merging, auto-fitting the font so one line
always fits) and by the per-beat timeline in `render_video.js`. Because each beat has
its own audio file, a caption's on-screen span *is* its audio span — it cannot drift.

## Content rules

`references/content-rules.md` is the single source of truth: video structure, the eleven
survival motivators, hook rules, plain-Hebrew rules, the 10x factual-value requirement,
the fear block, and the exact CTA wording. `generate_content.js` injects that file into
its prompt and `validate_content.js` checks against it. **Edit that file, not the prompt.**

The CTA lives in `lib/content.js` and is never generated:

- **Instagram** (goal: comments) — `תגיבו "אני" אם הגעתם עד לכאן,` / `וקבלו את המדריך לפיתוח משמעת עצמית 👇`
- **TikTok / YouTube** (no DM-on-comment) — `הקישור בפרופיל מחכה לכם עכשיו,` / `לחצו וקבלו את המדריך המלא 👇`

Two cuts are rendered per topic for this reason. The segment cache makes the second
cut nearly free.

---

## Phase 1 — First-time setup

### 1.1 Scaffold the project

```bash
mkdir -p ~/Documents/daily-reels && cd ~/Documents/daily-reels
cp -R ~/.claude/skills/instagram-daily-videos/{scripts,content,references,assets,package.json} .
mkdir -p .github/workflows && cp assets/workflows/daily-reels.yml .github/workflows/
npm install
```

Node 18+ is required. ffmpeg comes from the `ffmpeg-static` package, so no system
install is needed on macOS; the workflow installs the apt package on Linux.

### 1.2 Keys

| Variable | Required | Where |
|---|---|---|
| `PIXABAY_KEY` | yes | pixabay.com → sign up → API → copy key |
| `BUFFER_TOKEN` | yes | publish.buffer.com → Settings → Integrations & API |
| `BUFFER_CHANNEL_INSTAGRAM` | yes | `npm run channels` |
| `BUFFER_CHANNEL_TIKTOK` | optional | `npm run channels` |
| `BUFFER_CHANNEL_YOUTUBE` | optional | `npm run channels` |
| `ANTHROPIC_API_KEY` | strongly recommended | without it, content comes from the 6-topic seed bank and repeats |
| `JAMENDO_CLIENT_ID` | optional | real music instead of the synthesised bed |
| `BRAND_HANDLE` | optional | e.g. `@ryze.il`, shown on screen |

Write them to `.env` in the project root, then:

```bash
npm run channels
```

That prints every Buffer channel id. Paste the ones you need into `.env`.

### 1.3 Test locally

```bash
npm run validate      # content rules pass
npm run dry-run       # renders, schedules nothing, keeps the mp4s in out/
```

Watch one of the files in `out/`. Confirm captions appear only on speech.
`out/<name>/render.json` lists every caption with its word count and exact timing.

### 1.4 Ship it

The repo must be **public** — video hosting uses GitHub Release assets, which Buffer
fetches over a public URL, and Actions minutes are unlimited for public repos.

```bash
git init && git add . && git commit -m "Daily reels automation"
gh repo create daily-reels --public --source=. --push
```

Add the same keys as repository secrets:

```bash
gh secret set PIXABAY_KEY
gh secret set BUFFER_TOKEN
gh secret set BUFFER_CHANNEL_INSTAGRAM
gh secret set ANTHROPIC_API_KEY
```

Then trigger the first real run:

```bash
gh workflow run daily-reels.yml --field force=true
```

---

## Phase 2 — Everyday operations

```bash
npm run run                    # respects the once-a-day guard
npm run force                  # run again today
npm run generate               # write content/today.json without rendering
gh workflow run daily-reels.yml --field force=true    # run on GitHub, computer off

# Fill a specific day instead of today — use this when setting up late in the
# day and the first post should be tomorrow at 07:45 rather than this afternoon.
SCHEDULE_DATE=tomorrow FORCE_RUN=true node scripts/main.js
SCHEDULE_DATE=2026-08-12 FORCE_RUN=true node scripts/main.js
```

**Change the schedule** — `SLOTS` in `scripts/main.js`.
**Change the CTA** — `CTA` in `scripts/lib/content.js`, then `npm run dry-run` to confirm
each line is still 4–6 words (`ctaIsIntact()` fails the run otherwise).
**Change the content rules** — `references/content-rules.md`.
**Add your own music** — drop mp3 files into `assets/music/`. They rotate per video and
are auto-levelled; they take priority over Jamendo and the synthesised bed.
**Change the voice** — `TTS_VOICE` / `TTS_RATE` env vars, e.g. `en-US-GuyNeural`.

---

## Architecture

```
scripts/
  main.js               orchestrator: generate -> render 2 cuts -> host -> schedule 6 slots
  generate_content.js   fresh topics daily (Anthropic -> OpenAI -> seed bank), uniqueness ledger
  validate_content.js   hard gate on references/content-rules.md
  render_video.js       timeline, clips, captions, music, mux
  schedule_buffer.js    GitHub Release hosting + Buffer GraphQL createPost
  lib/
    text.js             the 4-6 word one-line rule, splitting, font auto-fit
    tts.js              per-beat Edge neural TTS, cached
    ffmpeg.js           binary resolution + duration (no ffprobe needed)
    music.js            local files -> Jamendo -> synthesised ambient pad
    pixabay.js          clip pool: one search per query, a distinct hit per caption
    content.js          the fixed CTA and per-platform assembly
content/
  seed_topics.json      6 hand-written topics; day-one fallback and the quality template
  used_ledger.json      every shipped topic, so nothing repeats
  state.json            once-a-day guard
```

### Why per-beat TTS

The original build synthesised the whole script at once and estimated each caption's
start from cumulative word offsets. Small errors accumulated and captions appeared
before the narrator reached them. Now every beat is its own audio file and the timeline
is assembled from real measured durations, so the bug is structurally impossible.

### Why video hosting is needed

The Buffer API does not accept file uploads. Its docs state an asset url "must point to
a publicly accessible file". `schedule_buffer.js` uploads the mp4 as a GitHub Release
asset and passes that URL, falling back to catbox.moe / 0x0.st.

---

## Troubleshooting

**`dueAt must be in the future`** — a forced run after a slot passed. `slotTimes()` rolls
past slots to tomorrow; if Buffer still refuses, the slot is under two minutes away.

**Captions outside 4–6 words** — the renderer warns and auto-fixes. Run
`node scripts/validate_content.js content/today.json` to see which beat is at fault.

**`No Pixabay footage for "..."`** — the query was too abstract. Queries must be visual
and concrete: `man running empty street`, not `success mindset`.

**No music** — impossible by design; the chain ends in a synthesised pad. If the bed
sounds wrong, drop real mp3s into `assets/music/`.

**`No Hebrew-capable bold font found`** — Linux only: `apt-get install fonts-dejavu-core`.

**Content repeats** — `ANTHROPIC_API_KEY` is not set, so it is cycling the 6 seed topics.

**YouTube rejects the post** — `youtubeTitle` is required and must be under 95 characters;
`categoryId` defaults to 22 (People & Blogs), override with `YOUTUBE_CATEGORY_ID`.
