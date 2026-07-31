"""Aqua Elo — FastAPI app serving the JSON API and the static frontend.

Both the API (``/api/*``) and the vanilla frontend are served from one process, deployed
to Vercel as a single Python serverless function. Display reads (``/matchup``, ``/rankings``,
``/stats``, ``/daily``) are served from short-lived in-process caches between votes; the
write paths (``/vote``, ``/daily/vote``) hold to the per-action Redis command budget
documented in ``storage.py`` and ``elo.py``.
"""

import random
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import daily as daily_mod
from . import storage
from .elo import compute_analytics, get_elo_info, get_rankings, load_fish, record_match

app = FastAPI(title="Aqua Elo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

MATCHUP_TTL = 600
RATE_LIMIT_SECS = 0.5

# Per-process, best-effort only (not shared across serverless instances). The single-use
# matchup token (Redis-backed) is the real anti-fraud guarantee.
_recent_pairs: list[tuple[str, str]] = []
RECENT_PAIR_LIMIT = 50
_vote_ratelimit: dict[str, float] = {}


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


def _check_rate_limit(ip: str) -> None:
    now = time.time()
    for old in [k for k, ts in _vote_ratelimit.items() if now - ts > RATE_LIMIT_SECS * 4]:
        del _vote_ratelimit[old]
    if now - _vote_ratelimit.get(ip, 0.0) < RATE_LIMIT_SECS:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait.")
    _vote_ratelimit[ip] = now


def _public_fish(fish: dict, ratings: dict, trends: dict) -> dict:
    from .elo import _default_record

    rec = ratings.get(fish["id"]) or _default_record(fish["id"])
    t = trends.get(fish["id"], {})
    return {
        **fish,
        "elo": rec["rating"],
        "wins": rec.get("wins", 0),
        "losses": rec.get("losses", 0),
        "elo_delta_24h": t.get("elo_delta_24h", 0.0),
        "placing": t.get("placing", True),
    }


class VoteRequest(BaseModel):
    winner_id: str
    loser_id: str
    token: str


class DailyVoteRequest(BaseModel):
    winner_id: str
    loser_id: str
    token: str


class TrackRequest(BaseModel):
    visitor_id: str


# ---------------------------------------------------------------------------
# Global vote flow
# ---------------------------------------------------------------------------
@app.get("/api/matchup")
async def matchup():
    fish_list = load_fish()
    if len(fish_list) < 2:
        raise HTTPException(status_code=503, detail="Not enough fish")

    ratings = storage.read_ratings()
    trends = compute_analytics()["trends"]

    pair = None
    a = b = None
    for _ in range(20):
        a, b = random.sample(fish_list, 2)
        pair = tuple(sorted([a["id"], b["id"]]))
        if pair not in _recent_pairs:
            break
    _recent_pairs.append(pair)
    if len(_recent_pairs) > RECENT_PAIR_LIMIT:
        _recent_pairs.pop(0)

    token = uuid.uuid4().hex
    storage.save_matchup(token, {"a": a["id"], "b": b["id"]}, MATCHUP_TTL)

    fa = _public_fish(a, ratings, trends)
    fb = _public_fish(b, ratings, trends)
    return {
        "fish_a": fa,
        "fish_b": fb,
        "token": token,
        "elo_diff": round(abs(fa["elo"] - fb["elo"]), 1),
    }


@app.post("/api/vote")
async def vote(payload: VoteRequest, request: Request):
    if payload.winner_id == payload.loser_id:
        raise HTTPException(status_code=400, detail="Winner and loser must be different")

    _check_rate_limit(_client_ip(request))

    stored = storage.redeem_matchup(payload.token)  # GETDEL: single-use
    if stored is None:
        raise HTTPException(status_code=400, detail="Invalid or expired matchup token")
    if {payload.winner_id, payload.loser_id} != {stored["a"], stored["b"]}:
        raise HTTPException(status_code=400, detail="Vote does not match the current matchup")

    try:
        return record_match(payload.winner_id, payload.loser_id)
    except ValueError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/rankings")
async def rankings():
    return get_rankings()


@app.get("/api/stats")
async def stats():
    analytics = compute_analytics()
    return {
        "total_votes": analytics["total_votes"],
        "visitors_online": storage.visitors_online(time.time()),
        "best_mover": analytics["best_mover"],
        "worst_mover": analytics["worst_mover"],
    }


# ---------------------------------------------------------------------------
# Daily Battle (sandbox — never touches global Elo)
# ---------------------------------------------------------------------------
@app.get("/api/daily")
async def daily():
    return daily_mod.get_daily()


@app.get("/api/daily/matchup")
async def daily_matchup():
    now = datetime.now(timezone.utc)
    date = now.strftime("%Y-%m-%d")
    _, _, lineup = daily_mod.get_lineup(date)
    if len(lineup) < 2:
        raise HTTPException(status_code=503, detail="No daily lineup")

    a_id, b_id = random.sample(lineup, 2)
    token = uuid.uuid4().hex
    storage.save_matchup(token, {"a": a_id, "b": b_id, "daily": date}, MATCHUP_TTL)

    from .elo import fish_by_id

    return {
        "fish_a": fish_by_id(a_id),
        "fish_b": fish_by_id(b_id),
        "token": token,
        "date": date,
    }


@app.post("/api/daily/vote")
async def daily_vote(payload: DailyVoteRequest, request: Request):
    if payload.winner_id == payload.loser_id:
        raise HTTPException(status_code=400, detail="Winner and loser must be different")

    _check_rate_limit(_client_ip(request))

    stored = storage.redeem_matchup(payload.token)  # GETDEL: single-use
    if stored is None or "daily" not in stored:
        raise HTTPException(status_code=400, detail="Invalid or expired matchup token")

    date = stored["daily"]
    if {payload.winner_id, payload.loser_id} != {stored["a"], stored["b"]}:
        raise HTTPException(status_code=400, detail="Vote does not match the current matchup")
    if not daily_mod.valid_daily_pair(date, payload.winner_id, payload.loser_id):
        raise HTTPException(status_code=400, detail="Fish not in today's lineup")

    storage.append_daily_vote(date, payload.winner_id, payload.loser_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Visitor tracking + health
# ---------------------------------------------------------------------------
@app.post("/api/track")
async def track(payload: TrackRequest):
    storage.track_visitor(payload.visitor_id, time.time())
    return {"ok": True}


@app.get("/api/elo-info")
async def elo_info():
    return get_elo_info()


@app.get("/api/health")
async def health():
    return {"status": "ok", "fish": len(load_fish())}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
