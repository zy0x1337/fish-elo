# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Aqua Elo is a "which fish do you prefer" voting site for freshwater aquarium species.
Visitors are shown two fish and pick one; each vote updates both fish's Elo ratings, which
drive a live leaderboard, a stats ticker, and a separate **Daily Battle** sandbox tournament.
A FastAPI backend serves both the JSON API and the static frontend from a single process,
deployed to Vercel as one Python serverless function (Fluid Compute) with Upstash Redis.

**The single most important non-feature requirement is cost:** a vote and a page load must
each cost as few Upstash commands as possible. Treat the per-action command budget below as
a contract, not a suggestion — if a change would raise any hot-path command count, justify it.

## Commands

```bash
pip install -r backend/requirements.txt          # runtime
pip install -r backend/requirements-dev.txt      # pytest + httpx (tests)
uvicorn backend.app.main:app --reload            # serves API + frontend at http://localhost:8000/

python -m pytest backend/tests/ -q               # full suite
python -m pytest backend/tests/test_analytics.py::test_rank_delta_uses_snapshot_scale_not_standard_k
node --check frontend/script.js                  # frontend has no build; syntax-check only
python -m backend.app.seed                        # regenerate fish.json from the enrichment table
```

There is no frontend build, bundler, or linter — `index.html` + `script.js` + `style.css` are
plain static files (dependency-free vanilla JS, no CDN).

## Catalog / images

`backend/data/fish.json` is the read-only catalog. **The image files in `frontend/images/` and
their `imageCredit` blocks are committed source data** — don't re-source them. `seed.py` holds a
per-`id` enrichment table (scientific name, genre, size, temperament, difficulty, water type,
popularity) and *derives* tags, tank size, and pH/temp ranges from it, preserving each entry's
`image`/`imageCredit`. Editing catalog content means editing the `ENRICH` table and re-running
`python -m backend.app.seed` (idempotent), not hand-editing `fish.json`.

## Architecture

**Single deployable unit.** `vercel.json` routes every request to `backend/app/main.py` and
bundles `frontend/**` + `backend/data/**`. `main.py` resolves `FRONTEND_DIR` by walking up from
its own path, so the `backend/app/` next-to-`frontend/` layout is load-bearing — moving files
means updating the `Path` computations in `main.py`, `elo.py`, `storage.py`, and `daily.py`.

**`storage.py` — the persistence + cost layer.** Backend is chosen at call time by the presence
of an Upstash REST URL env var, accepting **both** `KV_REST_API_*` and `UPSTASH_REDIS_REST_*`
naming schemes (a Vercel integration may set only one; missing both would silently fall back to
ephemeral local files and reset all data every deploy). Local dev uses JSON files in
`backend/data/`. Key design points, all in service of the command budget:
- **State is split.** `ratings` (`{id: {rating, wins, losses}}`) is a tiny dict rewritten per
  vote; `matches` is an append-only list (`RPUSH`, never rewritten). A vote never serializes
  history. **Never reintroduce a single `{ratings, matches}` blob.**
- **Single-command atomics.** Matchup tokens redeem with `GETDEL` (not GET+DEL). The write lock
  releases with a Lua compare-and-delete `EVAL` (race-free). Acquire with `SET NX EX 3`.
- **In-process read cache** (`_cache`, 60s short / 600s long TTL). Vercel Fluid keeps instances
  warm so a module-level cache survives across requests. Writers invalidate it (`acquire_lock`
  drops the ratings cache so the read-modify-write starts fresh). **Caches are for cost, never
  correctness** — cold deploys start empty and instances don't share memory; Redis is the source
  of truth. Any new persisted state must implement **both** the Redis and local-file paths.

**`elo.py` — ratings + snapshot analytics.** `K_FACTOR=32`, provisional `K_PROVISIONAL=64` for a
fish's first `PLACEMENT_GAMES=10` matches (marked `placing`/`NEW`). Catalog fish are seeded from
`popularity` (log-scaled into 1000–2200); genuinely new fish debut at 1500. `record_match` is the
only writer of ratings — lock, read-modify-write the small `ratings` key, append one match, unlock.
Each match stores **per-fish rating snapshots** (`winner_rating`, `loser_rating`, `winner_change`,
`loser_change`, `timestamp`).

> **Analytics correctness invariant (do not violate):** 24h trend deltas and `rank_delta` are
> reconstructed by **undoing the stored per-match *changes*** — the same scale as the persisted
> "now" ratings. Because placement uses a higher K, actual swings differ from a standard-K
> recompute; mixing a standard-K replay for the past with provisional-K values for the present
> produces phantom movement (e.g. the day's biggest gainer shown *losing* rank). `_match_change`
> prefers the stored snapshot and only falls back to a standard-K recompute for legacy
> pre-snapshot records. Fish still placing (<10 games) have `rank_delta = None` (arrow suppressed).
> The Elo arrow (▲/▼) and rank arrow follow the **sign of their own value** — they can legitimately
> disagree. `test_rank_delta_uses_snapshot_scale_not_standard_k` pins this and fails if the replay
> reverts to standard-K.

**`daily.py` — Daily Battle sandbox** (never touches global Elo). Lineup for a UTC date is curated
via `daily_battles.json` (keyed `YYYY-MM-DD`) or auto-generated deterministically by hashing the
date (stable all day, no RNG). Only theme tags with ≥10 catalog fish are eligible, so the
"≥10 per theme" rule self-enforces across catalog edits. Sandbox votes go to `daily:<date>` (TTL,
3 days); standings count only votes where **both** fish are in that day's lineup and rank by the
**Wilson score lower bound** so a proven record beats a lucky 1–0.

## Vote flow and integrity

`GET /api/matchup` mints a single-use `token` (Redis `SET EX`, 600s) storing the pair. `POST /api/vote`
rejects winner==loser (400), votes faster than `RATE_LIMIT_SECS=0.5`/IP (429, IP from `X-Forwarded-For`),
unknown/expired tokens (400, consumed via `GETDEL`), and votes whose pair ≠ the token's pair (400).
`503` means the rating lock was contended; the frontend retries with backoff. `_recent_pairs` and
`_vote_ratelimit` are **per-process, best-effort** (not shared across serverless instances) — the
Redis-backed single-use token is the real anti-fraud guarantee.

## Per-action Redis command budget (hold to these)

- **Global vote** ≈ 6: `GETDEL` token + `SET NX` lock + `GET` ratings + `SET` ratings + `RPUSH` match + `EVAL` unlock.
- **Daily vote** ≈ 2: `GETDEL` token + `RPUSH` day list (+ one-time `EXPIRE`).
- **Matchup served** ≈ 1: token `SET`.
- **`/stats`** ≈ 0–1: served from caches between votes; `total_votes` is derived from the already-loaded match list (no `LLEN`).
- **`/track`** ≈ 2: `ZADD` + `ZREMRANGEBYSCORE`; throttled client-side to ≤1/30min (with new-UTC-day override).

## API surface

`GET /api/matchup` (both fish + token + `elo_diff` + `head_to_head`) · `POST /api/vote` · `GET /api/rankings` (elo + `rank_delta` + 24h trend + W/L) ·
`GET /api/compare` (`?a=&b=`, read-only head-to-head for any two fish — no token, reuses the cached analytics pass) ·
`GET /api/stats` (total votes, visitors online 24h, best/worst 24h mover) · `GET /api/daily` ·
`GET /api/daily/matchup` · `POST /api/daily/vote` · `POST /api/track` · `GET /api/elo-info` · `GET /api/health`.

## Frontend (`index.html` + `style.css` + `script.js` + `sw.js`)

Vanilla single-file SPA, four hash-routed tabs (Vote / Rankings / Daily / Your picks).

**Efficiency rules.** **Do not poll `/stats` on a timer** — refresh on load and after a vote only.
The Daily countdown is client-side `setInterval` and must never fetch per tick. `trackVisitor()`
throttles via `localStorage` (≤1/30min, override on a new UTC day, timestamp set before firing so
reloads dedupe) with a stable `visitor_id`. Exactly **one** matchup is prefetched (`topUpQueue`)
so the next pair is instant — that is the same number of `/matchup` calls, just earlier, and the
queue must not grow (each unused token is a wasted `SET`).

**Everything personal is device-local.** Vote counts, favourites, badges, day streak, daily
progress and theme live in `localStorage` (`aqua_you_v1`, `aqua_settings`, `aqua_daily_v1`) and are
never sent to the server — no endpoint and no Redis key exists for them, and none should be added.
The post-vote "crowd agreed / upset" line and the **Compare** block both read `head_to_head` from
the cached analytics pass (zero extra commands). The share card is a self-contained SVG rasterised
to PNG on the client — no photos in it, so the canvas never taints. **Ratings are sealed until you
vote** — the Elo number and the odds label reveal only after a pick, so the vote is about the fish,
not the number. Rankings/daily tables and the favourites list use small **thumbnails**
(`/images/thumbs/<id>.jpg`), not the full photos.

See **Design & voice** below before touching any of this.

## PWA (`sw.js` + `manifest.webmanifest`)

Three caches: shell (precached on install, then stale-while-revalidate so a deploy lands on the
next load without a manual `VERSION` bump), photos (cache-first, capped at 240 — full photos and
the 106 thumbnails share it), and read-only API GETs (`/rankings`, `/daily`, `/elo-info`, `/stats`,
stale-while-revalidate so the app opens offline). **`/api/matchup` and `/api/vote` are never
cached** — a matchup token is single-use. `/api/compare` is not in the cached set (network-only).
Because the SW answers API reads from cache, a successful fetch is not proof of a connection:
`setOnline()` always ANDs with `navigator.onLine`. Failed votes go to a local outbox and retry on
`online`, dropped after 9 minutes since the token TTL is 10.

Icons in `frontend/icons/` are rendered from `tools/assets/*.svg` by `tools/render.mjs`; the
per-species thumbnails in `frontend/images/thumbs/` are rendered from the full photos by
`tools/thumbs.mjs` (both headless Chromium) and **committed** — `tools/` is dev-only, never
deployed. Re-run `tools/thumbs.mjs` after adding a fish photo.

`main.py` sets the security headers and the cache policy for static files: photos and icons get a
year (`immutable`), the shell must revalidate, and `/api/*` is `no-store`. `mimetypes.add_type`
for `.webmanifest` is required — without it the manifest is served as octet-stream and the install
prompt never appears.

## Design & voice (read before touching the UI)

This is a **just-for-fun poll for the aquarium community** — treat it as one. It doesn't need to
sound big, and it must never read as machine-made. **The bar: nobody who lands here should think
"AI" or "slop."** That is a hard requirement, not a nice-to-have. When you add or change anything
visible, hold it to the rules below; if a change would fail them, don't ship it.

**The identity is a printed field guide, not a web dashboard.** Warm paper, ink-coloured serif
display type (a *system* serif stack — never download a web font), hairline and hairline-double
rules, tabular numbers, one coral accent plus one muted teal. The fish **photos are the hero**;
every bit of chrome recedes so they carry the page. Match this when adding components — reuse the
existing CSS tokens and idiom rather than importing a new look.

**Concrete tells to avoid (this is what "AI slop" looks like — do not produce it):**
- Neon-on-near-black "dashboard" palettes, glowing accents, or a cyan/purple/indigo gradient hero.
- Glassmorphism (blurred translucent cards), heavy drop shadows, or everything on a gradient.
- Emoji in headings, buttons, stat labels, or nav; three-emoji "✨ feature ✨" bullet rows.
- Generic bold sans-serif everywhere with wide letter-spacing standing in for design.
- Marketing hype: "revolutionary", "seamless", "powered by AI", superlatives, exclamation marks,
  invented testimonials or fake counts. If a sentence is trying to impress, cut it.
- Filler and hedging in copy. Say the concrete thing once.

**Voice.** Plain, dry, a little understated. Short sentences. British-ish spelling matches the
existing copy (favourite, colour). Own that it's a sandbox — e.g. "ratings move with every vote,
so the board is never final." Always credit the photographers. No hype, no emoji.

**Restraint and motion.** One accent colour does the work; if you reach for a second, stop.
Motion is subtle and earns its place — the pick stamp, the water ring, the loser fading to
grayscale — and **every animation must be gated behind `@media (prefers-reduced-motion: reduce)`**.

**Accessibility is part of not-being-slop, not a separate checkbox.** Real `:focus-visible` rings,
correct `aria-*` on tabs/dialog, full keyboard paths (arrow-key voting, Enter/Space on rows, Esc
closes the dossier), `sr-only` labels, and a theme that is styled deliberately in **both**
directions. `[hidden] { display: none !important }` is load-bearing — several components set
`display`, which would otherwise beat the attribute.

**No dependencies, no CDN, no build.** Vanilla HTML/CSS/JS stays vanilla. Anything pulled from a
third-party origin is both a slop tell and a privacy/perf regression — inline it or don't add it.

## Deploy / env

- Set `KV_REST_API_URL`/`KV_REST_API_TOKEN` **or** `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`
  for production Redis; neither set → local-file dev mode. Recommend **Upstash pay-as-you-go** so
  exceeding the free command budget degrades to cents of overage instead of a hard cutoff that rejects votes.
- `elo.json`, `elo.json.bak`, and `.env` are gitignored — never commit rating state or secrets.
- Upstash bills separately from Vercel (Fluid Active CPU / memory / invocations). Caching analytics is
  also the main CPU saver: don't replay the whole match log per request.
