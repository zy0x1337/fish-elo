# Aqua Elo

A head-to-head voting site for freshwater aquarium fish. You get two species, you pick the
one you like better, and every vote nudges both Elo ratings. There is a leaderboard, a
separate themed board that resets daily, and a device-local record of what you picked.

It is a just-for-fun poll for the aquarium community — nothing more serious than that.

## Running it

```bash
pip install -r backend/requirements.txt          # runtime
pip install -r backend/requirements-dev.txt      # pytest + httpx
uvicorn backend.app.main:app --reload            # API + frontend on http://localhost:8000/

python -m pytest backend/tests/ -q               # tests
node --check frontend/script.js                  # no frontend build, syntax check only
python -m backend.app.seed                       # regenerate fish.json from the enrichment table
```

Without Upstash credentials the app writes JSON files into `backend/data/` and runs entirely
offline — no external services needed for development.

## Layout

```
backend/app/    main.py (API + static), elo.py, daily.py, storage.py, seed.py
backend/data/   fish.json (catalog), daily_battles.json (curated lineups)
frontend/       index.html, style.css, script.js, sw.js, manifest.webmanifest, images/, icons/
tools/          asset rendering + screenshot helpers (dev only, not deployed)
```

The whole thing deploys to Vercel as one Python function; `vercel.json` routes every request
to `main.py`, which serves the API under `/api/*` and the static frontend for everything else.

## PWA

`manifest.webmanifest` plus `sw.js` make the site installable and usable offline:

- the app shell is precached on install and refreshed in the background, so a deploy lands
  on the next load without bumping a cache version by hand;
- fish photos are cached on first view, capped at 140 entries;
- `/api/rankings`, `/api/daily`, `/api/elo-info` and `/api/stats` are stale-while-revalidate,
  so the leaderboard opens without a connection;
- matchup and vote requests are never cached — a matchup token is single-use.

Votes that fail because the connection dropped go into a small local outbox and are retried
when the browser comes back online, as long as the token has not expired (10 minutes).

## Regenerating the icons

The brand mark lives in `tools/assets/*.svg`. The PNGs in `frontend/icons/` are rendered from
them with headless Chromium and committed:

```bash
node tools/render.mjs '[{"src":"tools/assets/mark.svg","out":"frontend/icons/icon-512.png","w":512,"h":512}]'
```

Playwright is not a project dependency; point `PLAYWRIGHT_MODULE` at an installed copy if it
is not resolvable from the repo.

## Environment

Set either pair for production Redis:

- `KV_REST_API_URL` / `KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`

With neither set the app falls back to local files, which on a serverless deploy means data
is lost on every deploy — so make sure one pair is configured in production.

`elo.json`, `elo.json.bak` and `.env` are gitignored; rating state and secrets never go into
the repo.

## Cost

Upstash bills per command, so the hot paths are kept deliberately small: a vote costs about
six commands, a served matchup one, and `/stats` usually zero because it is answered from an
in-process cache between votes. `CLAUDE.md` documents the budget in detail — worth reading
before changing anything on a vote or page-load path.
