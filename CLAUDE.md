# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Fish Elo is a "which fish do you prefer" voting site for freshwater aquarium species.
Users are shown two random fish and pick one; each vote updates both fish's Elo ratings,
which drive a live leaderboard. A FastAPI backend serves both the JSON API and the static
frontend from a single process; it deploys to Vercel as one Python serverless function.

## Commands

Run the app locally (from repo root):

```bash
pip install -r backend/requirements.txt
uvicorn backend.app.main:app --reload
```

The server serves the API under `/api/*` and mounts the `frontend/` directory at `/`,
so the whole app is at `http://localhost:8000/`. There is no separate frontend build,
bundler, dev server, linter, or test suite — the frontend is plain static
`index.html` + `script.js` + `style.css`.

`backend/app/seed_images.py` regenerates `backend/data/fish.json` and copies images from
an external `aquaguide` project. It hardcodes Windows author paths (`C:\Users\...`) and is
**not runnable in this environment** — treat `fish.json` and `frontend/images/` as committed
source data, and edit `fish.json` by hand for content changes.

## Architecture

**Single deployable unit.** `vercel.json` routes every request to `backend/app/main.py`
and bundles `frontend/**` and `backend/data/**` as included files. `main.py` resolves
`FRONTEND_DIR` by walking up from its own path, so the directory layout (`backend/app/`
next to `frontend/`) is load-bearing — don't move files without updating those `Path`
computations in `main.py`, `elo.py`, and `storage.py`.

**Storage is environment-switched, not injected.** `storage.py` is the single abstraction
over persistence and picks its backend at call time based on `os.environ["KV_REST_API_URL"]`:

- **Local:** JSON files in `backend/data/` (`elo.json`, plus a `.json.bak` written on each
  save), an in-process `threading.Lock`, and an in-memory dict for matchup tokens.
- **Vercel:** Upstash Redis (`upstash-redis`) — key `elo_data` for ratings/matches, `elo_lock`
  for a 3-second `SET NX EX` lock, and `matchup:<token>` keys with TTL.

Both backends expose the same functions (`read_elo`/`write_elo`, `acquire_lock`/`release_lock`,
`save_matchup`/`get_matchup`/`delete_matchup`). Any new persisted state must implement **both**
paths or it will silently work locally and break in production.

**Elo domain logic** lives in `elo.py`. `INITIAL_RATING = 1500`, `K_FACTOR = 32`.
`record_match()` is the only writer of ratings: it acquires the storage lock, does a
read-modify-write of the full `elo_data` blob (ratings + append-only match log), and releases
the lock, retrying up to 5 times with jittered backoff before raising `ValueError("Server busy")`.
Ratings for a fish are lazily created on first appearance rather than pre-seeded.

**`load_fish()` (static roster) vs `load_ratings()` (mutable scores)** are deliberately
separate. `fish.json` is the source of truth for *which* fish exist and their metadata;
ratings live only in storage. `get_rankings` and `get_matchup` join the two at request time,
defaulting any fish absent from ratings to a fresh 1500 record.

## Vote flow and its integrity checks

The vote path is designed so a client can't fabricate matchups or spam:

1. `GET /api/matchup` picks two distinct fish (avoiding the last ~50 pairs via the
   in-process `_recent_pairs` list), mints a `matchup_token`, and stores `token -> (a_id, b_id)`
   with a 600s TTL.
2. `POST /api/vote` requires that token. It rejects: winner == loser (400), votes faster than
   `RATE_LIMIT_SECS = 0.5` per client IP (429, IP from `X-Forwarded-For`), unknown/expired tokens
   (400), and votes whose `{winner, loser}` set doesn't match the token's stored pair (400).
   On success the token is deleted (single-use), then `record_match` runs.
3. `503` from `/api/vote` means the rating lock was contended; the frontend retries with backoff.

Note `_recent_pairs` and `_vote_ratelimit` are **per-process, in-memory** — on Vercel's
serverless model they don't persist or share across invocations, so they're best-effort only.
The token check (backed by Redis) is the real integrity guarantee.

## API surface

- `GET /api/rankings` — all fish joined with ratings, sorted by Elo desc.
- `GET /api/matchup` — two fish + `matchup_token` + `elo_diff`.
- `POST /api/vote` — body `{winner_id, loser_id, matchup_token}`; returns each fish's new rating and change.
- `GET /api/elo-info` — human + technical explanation of the Elo math (rendered directly in the frontend).
- `GET /api/health`

The frontend (`script.js`) is a single-file vanilla-JS SPA with two tabs (Vote / Rankings),
keyboard controls (←/→ to vote, space to skip), and optimistic UI that shows rating deltas
before loading the next matchup.

## Conventions

- `elo.json`, `elo.json.bak`, and `.env` are gitignored — never commit rating state or secrets.
- Fish entries in `fish.json` use `id` (slug), `name`, `tags` (max 6), `image` path, and an
  optional `imageCredit` object; the frontend surfaces the credit as a camera-icon tooltip, so
  preserve it when editing fish that have it.
