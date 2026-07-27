import random
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import storage
from .elo import INITIAL_RATING, get_elo_info, load_fish, load_ratings, record_match

app = FastAPI(title="Fish Elo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

FRONTEND_DIR = Path(__file__).resolve().parent.parent.parent / "frontend"

RATE_LIMIT_SECS = 0.5
_vote_ratelimit: dict[str, float] = {}

MATCHUP_TTL = 600
_recent_pairs: list[tuple[str, str]] = []
RECENT_PAIR_LIMIT = 50


def _cleanup_ratelimit():
    now = time.time()
    old = [ip for ip, ts in _vote_ratelimit.items() if now - ts > RATE_LIMIT_SECS * 2]
    for ip in old:
        del _vote_ratelimit[ip]


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


class VoteRequest(BaseModel):
    winner_id: str
    loser_id: str
    matchup_token: str


@app.get("/api/rankings")
async def get_rankings():
    fish_list = load_fish()
    elo_data = load_ratings()
    ratings = elo_data.get("ratings", {})

    result = []
    for fish in fish_list:
        r = ratings.get(
            fish["id"], {"rating": INITIAL_RATING, "wins": 0, "losses": 0}
        )
        result.append(
            {
                **fish,
                "elo": r["rating"],
                "wins": r.get("wins", 0),
                "losses": r.get("losses", 0),
            }
        )

    result.sort(key=lambda f: f["elo"], reverse=True)
    return {"fish": result}


@app.get("/api/matchup")
async def get_matchup():
    fish_list = load_fish()
    if len(fish_list) < 2:
        raise HTTPException(status_code=503, detail="Not enough fish")

    elo_data = load_ratings()
    ratings = elo_data.get("ratings", {})

    _cleanup_ratelimit()

    for _ in range(20):
        a, b = random.sample(fish_list, 2)
        pair = tuple(sorted([a["id"], b["id"]]))
        if pair not in _recent_pairs:
            break

    _recent_pairs.append(pair)
    if len(_recent_pairs) > RECENT_PAIR_LIMIT:
        _recent_pairs.pop(0)

    token = uuid.uuid4().hex
    storage.save_matchup(token, a["id"], b["id"], MATCHUP_TTL)

    elo_a = ratings.get(a["id"], {}).get("rating", INITIAL_RATING)
    elo_b = ratings.get(b["id"], {}).get("rating", INITIAL_RATING)

    return {
        "fish_a": {
            **a,
            "elo": elo_a,
            "wins": ratings.get(a["id"], {}).get("wins", 0),
            "losses": ratings.get(a["id"], {}).get("losses", 0),
        },
        "fish_b": {
            **b,
            "elo": elo_b,
            "wins": ratings.get(b["id"], {}).get("wins", 0),
            "losses": ratings.get(b["id"], {}).get("losses", 0),
        },
        "matchup_token": token,
        "elo_diff": round(abs(elo_a - elo_b), 1),
    }


@app.post("/api/vote")
async def vote(vote: VoteRequest, request: Request):
    if vote.winner_id == vote.loser_id:
        raise HTTPException(status_code=400, detail="Winner and loser must be different")

    ip = _get_client_ip(request)
    now = time.time()
    last = _vote_ratelimit.get(ip, 0)
    if now - last < RATE_LIMIT_SECS:
        raise HTTPException(status_code=429, detail="Too many requests. Please wait.")
    _vote_ratelimit[ip] = now

    matchup = storage.get_matchup(vote.matchup_token)
    if matchup is None:
        raise HTTPException(status_code=400, detail="Invalid or expired matchup token")

    a_id, b_id = matchup
    vote_ids = {vote.winner_id, vote.loser_id}
    if vote_ids != {a_id, b_id}:
        raise HTTPException(status_code=400, detail="Vote does not match the current matchup")

    storage.delete_matchup(vote.matchup_token)

    try:
        return record_match(vote.winner_id, vote.loser_id)
    except ValueError as e:
        detail = str(e)
        if "busy" in detail or "try again" in detail:
            raise HTTPException(status_code=503, detail=detail)
        raise HTTPException(status_code=404, detail=detail)


@app.get("/api/elo-info")
async def elo_info():
    return get_elo_info()


@app.get("/api/health")
async def health():
    return {"status": "ok", "message": "Fish Elo is running!"}


app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
