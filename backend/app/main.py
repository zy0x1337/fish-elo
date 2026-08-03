"""Aqua Elo — FastAPI app serving the JSON API and the static frontend.

Both the API (``/api/*``) and the vanilla frontend are served from one process, deployed
to Vercel as a single Python serverless function. Display reads (``/matchup``, ``/rankings``,
``/stats``, ``/daily``) are served from short-lived in-process caches between votes; the
write paths (``/vote``, ``/daily/vote``) hold to the per-action Redis command budget
documented in ``storage.py`` and ``elo.py``.
"""

import mimetypes
import random
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.responses import Response

from . import daily as daily_mod
from . import storage
from .elo import (
    compute_analytics,
    fish_by_id,
    get_elo_info,
    get_rankings,
    head_to_head,
    load_fish,
    record_match,
)

# Not in every Python's mimetypes table; without this the manifest is served as
# application/octet-stream and the install prompt never appears.
mimetypes.add_type("application/manifest+json", ".webmanifest")

app = FastAPI(title="Aqua Elo")

app.add_middleware(GZipMiddleware, minimum_size=800)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

CSP = (
    "default-src 'self'; "
    "img-src 'self' data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; "
    "connect-src 'self'; "
    "font-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response

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
    analytics = compute_analytics()
    trends = analytics["trends"]

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
        # From the same cached analytics pass — no extra Redis commands.
        "head_to_head": head_to_head(analytics.get("pairs", {}), a["id"], b["id"]),
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


@app.get("/api/compare")
async def compare(a: str, b: str):
    """Head-to-head between any two fish. Read-only, no token: it never records a vote.

    Reuses the cached analytics pass (the ``pairs`` map and trends), so between votes this
    costs no extra Redis commands beyond the shared ratings/matches reads already cached.
    """
    if a == b:
        raise HTTPException(status_code=400, detail="Pick two different fish")
    fa, fb = fish_by_id(a), fish_by_id(b)
    if fa is None or fb is None:
        raise HTTPException(status_code=404, detail="Unknown fish")

    ratings = storage.read_ratings()
    analytics = compute_analytics()
    trends = analytics["trends"]
    pa = _public_fish(fa, ratings, trends)
    pb = _public_fish(fb, ratings, trends)
    return {
        "fish_a": pa,
        "fish_b": pb,
        "head_to_head": head_to_head(analytics.get("pairs", {}), a, b),
        "elo_diff": round(abs(pa["elo"] - pb["elo"]), 1),
    }


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


class FrontendFiles(StaticFiles):
    """Static frontend with cache headers tuned for a single-function deploy.

    Photos and icons never change under their own name, so they get a year at the edge.
    The shell (HTML/CSS/JS) and the service worker must revalidate, otherwise a deploy
    can leave a stale app cached on the client.
    """

    IMMUTABLE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".svg", ".ico")

    def file_response(self, full_path, stat_result, scope, status_code=200) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        path = str(full_path)
        if ("/images/" in path or "/icons/" in path) and path.endswith(self.IMMUTABLE_SUFFIXES):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "public, max-age=0, must-revalidate"
        return response


app.mount("/", FrontendFiles(directory=FRONTEND_DIR, html=True), name="frontend")
