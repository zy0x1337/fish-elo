"""Elo ratings, placement (provisional K), and snapshot-based historical analytics.

The single correctness invariant (learned the hard way): historical replays — 24h
trend deltas and rank-change (``rank_delta``) — are reconstructed by **undoing the
per-match rating *changes* stored on each match snapshot**, on the exact same scale as
the persisted "now" ratings. Because placement uses a higher K, the applied swings are
not what a standard-K recompute would produce; mixing a standard-K replay for the past
with provisional-K values for the present produces phantom movement (e.g. the day's
biggest gainer shown *losing* rank). Undoing stored changes never mixes scales.
"""

import json
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path

from . import storage

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FISH_FILE = DATA_DIR / "fish.json"

K_FACTOR = 32          # settled fish
K_PROVISIONAL = 64     # during the placement phase
PLACEMENT_GAMES = 10   # matches before a fish settles
INITIAL_RATING = 1500  # debut for fish not present at seed time
SEED_MIN, SEED_MAX = 1000, 2200  # popularity-seeded initial rating range

TREND_1H = 3600
TREND_24H = 24 * 3600

_ANALYTICS_CACHE_KEY = "analytics"

_fish_cache: list[dict] | None = None
_fish_by_id_cache: dict[str, dict] | None = None


# ---------------------------------------------------------------------------
# Catalog (read-only, shipped file)
# ---------------------------------------------------------------------------
def load_fish() -> list[dict]:
    global _fish_cache
    if _fish_cache is not None:
        return _fish_cache
    if not FISH_FILE.exists():
        _fish_cache = []
        return _fish_cache
    with open(FISH_FILE, encoding="utf-8") as f:
        data = json.load(f)
    _fish_cache = data.get("fish", []) if data else []
    return _fish_cache


def fish_by_id(fish_id: str) -> dict | None:
    global _fish_by_id_cache
    if _fish_by_id_cache is None:
        _fish_by_id_cache = {f["id"]: f for f in load_fish()}
    return _fish_by_id_cache.get(fish_id)


def seed_rating(fish: dict) -> float:
    """Map ``popularity`` (0-100) monotonically, log-scaled, into ``SEED_MIN..SEED_MAX``."""
    pop = max(0, fish.get("popularity", 0))
    frac = math.log1p(pop) / math.log1p(100)
    return round(SEED_MIN + frac * (SEED_MAX - SEED_MIN), 1)


def _default_record(fish_id: str) -> dict:
    fish = fish_by_id(fish_id)
    rating = seed_rating(fish) if fish else INITIAL_RATING
    return {"rating": rating, "wins": 0, "losses": 0}


# ---------------------------------------------------------------------------
# Elo math
# ---------------------------------------------------------------------------
def expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def k_for(games_played: int) -> int:
    """Provisional K during placement so new fish converge quickly, then settle."""
    return K_PROVISIONAL if games_played < PLACEMENT_GAMES else K_FACTOR


def update_elo(winner_rating, loser_rating, k_w, k_l) -> tuple[float, float]:
    e_w = expected_score(winner_rating, loser_rating)
    new_w = winner_rating + k_w * (1.0 - e_w)
    new_l = loser_rating + k_l * (0.0 - (1.0 - e_w))
    return round(new_w, 1), round(new_l, 1)


# ---------------------------------------------------------------------------
# Recording a match (the only writer of global ratings)
# ---------------------------------------------------------------------------
def record_match(winner_id: str, loser_id: str) -> dict:
    """Acquire the lock, read-modify-write the small ratings key, append one snapshot.

    Command budget (production): GETDEL token (caller) + SET NX lock + GET ratings +
    SET ratings + RPUSH match + EVAL unlock ≈ 6 commands per vote.
    """
    for _ in range(40):  # ~2s of retries, under the 3s lock TTL
        token = storage.acquire_lock()
        if token:
            try:
                ratings = storage.read_ratings(use_cache=False)

                if winner_id not in ratings:
                    ratings[winner_id] = _default_record(winner_id)
                if loser_id not in ratings:
                    ratings[loser_id] = _default_record(loser_id)

                winner, loser = ratings[winner_id], ratings[loser_id]
                w_games = winner["wins"] + winner["losses"]
                l_games = loser["wins"] + loser["losses"]

                old_w, old_l = winner["rating"], loser["rating"]
                new_w, new_l = update_elo(old_w, old_l, k_for(w_games), k_for(l_games))

                winner["rating"], loser["rating"] = new_w, new_l
                winner["wins"] += 1
                loser["losses"] += 1

                storage.write_ratings(ratings)
                storage.append_match(
                    {
                        "winner": winner_id,
                        "loser": loser_id,
                        "winner_rating": new_w,
                        "loser_rating": new_l,
                        "winner_change": round(new_w - old_w, 1),
                        "loser_change": round(new_l - old_l, 1),
                        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    }
                )
                storage.invalidate_cache(_ANALYTICS_CACHE_KEY)

                return {
                    "winner": {"id": winner_id, "rating": new_w, "change": round(new_w - old_w, 1)},
                    "loser": {"id": loser_id, "rating": new_l, "change": round(new_l - old_l, 1)},
                }
            finally:
                storage.release_lock(token)

        time.sleep(0.02 + random.random() * 0.03)

    raise ValueError("Server busy, please try again")


# ---------------------------------------------------------------------------
# Snapshot-based analytics
# ---------------------------------------------------------------------------
def _match_change(match: dict, fish_id: str) -> float:
    """The Elo change this match applied to ``fish_id``, preferring the stored snapshot.

    Falls back to a standard-K recompute ONLY for legacy pre-snapshot records that lack
    ``winner_change``/``loser_change`` — never for records that carry snapshots.
    """
    if match["winner"] == fish_id:
        if "winner_change" in match:
            return match["winner_change"]
    elif match["loser"] == fish_id:
        if "loser_change" in match:
            return match["loser_change"]
    else:
        return 0.0

    # Legacy fallback: recompute from the snapshot ratings at standard K.
    wr = match.get("winner_rating")
    lr = match.get("loser_rating")
    if wr is None or lr is None:
        return 0.0
    # Snapshots store post-match ratings; approximate the change from pre-match expectation.
    e_w = expected_score(wr, lr)
    if match["winner"] == fish_id:
        return round(K_FACTOR * (1.0 - e_w), 1)
    return round(-K_FACTOR * (1.0 - e_w), 1)


def _parse_ts(match: dict) -> float:
    try:
        return datetime.fromisoformat(match["timestamp"]).timestamp()
    except (KeyError, ValueError):
        return 0.0


def compute_analytics(now: float | None = None, use_cache: bool = True) -> dict:
    """Return per-fish trend deltas and rank deltas plus aggregates, from snapshots.

    ``rank_delta`` > 0 means the fish moved *up* the leaderboard vs 24h ago. Ratings
    "as of 24h ago" are reconstructed by subtracting the changes that each match in the
    last 24h applied — the same scale as the persisted current ratings.
    """
    if now is None:
        now = time.time()
    if use_cache:
        cached = storage._cache_get(_ANALYTICS_CACHE_KEY)
        if cached is not None:
            return cached

    ratings = storage.read_ratings()
    matches = storage.read_matches()

    fish_list = load_fish()
    ids = [f["id"] for f in fish_list]
    for m in matches:  # include any fish that somehow only exists in the log
        for side in ("winner", "loser"):
            if m[side] not in ids:
                ids.append(m[side])

    current = {fid: ratings.get(fid, _default_record(fid))["rating"] for fid in ids}
    games = {
        fid: ratings.get(fid, {}).get("wins", 0) + ratings.get(fid, {}).get("losses", 0)
        for fid in ids
    }

    rating_24h_ago = dict(current)
    delta_1h = {fid: 0.0 for fid in ids}
    delta_24h = {fid: 0.0 for fid in ids}
    cut_1h, cut_24h = now - TREND_1H, now - TREND_24H

    for m in matches:
        ts = _parse_ts(m)
        if ts < cut_24h:
            continue
        for fid in (m["winner"], m["loser"]):
            ch = _match_change(m, fid)
            rating_24h_ago[fid] = round(rating_24h_ago[fid] - ch, 1)
            delta_24h[fid] += ch
            if ts >= cut_1h:
                delta_1h[fid] += ch

    rank_now = _ranks(current)
    rank_past = _ranks(rating_24h_ago)

    trends = {}
    for fid in ids:
        placing = games[fid] < PLACEMENT_GAMES
        # A fish still in placement has a meaningless pre-debut rank — suppress the arrow.
        rank_delta = None if placing else (rank_past[fid] - rank_now[fid])
        trends[fid] = {
            "elo_delta_1h": round(delta_1h[fid], 1),
            "elo_delta_24h": round(delta_24h[fid], 1),
            "rank_delta": rank_delta,
            "placing": placing,
        }

    movers = [(fid, delta_24h[fid]) for fid in ids if delta_24h[fid] != 0]
    best = max(movers, key=lambda x: x[1], default=None)
    worst = min(movers, key=lambda x: x[1], default=None)

    result = {
        "trends": trends,
        "total_votes": len(matches),  # derived from the already-loaded list, no LLEN
        "best_mover": _mover(best),
        "worst_mover": _mover(worst),
    }
    storage._cache_set(_ANALYTICS_CACHE_KEY, result)
    return result


def _ranks(rating_map: dict) -> dict:
    """Map fish id -> 1-based rank (1 = highest rating). Ties broken by id for stability."""
    order = sorted(rating_map, key=lambda fid: (-rating_map[fid], fid))
    return {fid: i + 1 for i, fid in enumerate(order)}


def _mover(entry) -> dict | None:
    if entry is None:
        return None
    fid, change = entry
    fish = fish_by_id(fid)
    return {
        "id": fid,
        "name": fish["name"] if fish else fid,
        "image": fish.get("image", "") if fish else "",
        "change": round(change, 1),
    }


# ---------------------------------------------------------------------------
# Rankings (catalog joined with ratings + trends)
# ---------------------------------------------------------------------------
def get_rankings() -> dict:
    ratings = storage.read_ratings()
    analytics = compute_analytics()
    trends = analytics["trends"]

    rows = []
    for fish in load_fish():
        rec = ratings.get(fish["id"]) or _default_record(fish["id"])
        t = trends.get(fish["id"], {})
        rows.append(
            {
                **fish,
                "elo": rec["rating"],
                "wins": rec.get("wins", 0),
                "losses": rec.get("losses", 0),
                "elo_delta_1h": t.get("elo_delta_1h", 0.0),
                "elo_delta_24h": t.get("elo_delta_24h", 0.0),
                "rank_delta": t.get("rank_delta"),
                "placing": t.get("placing", (rec.get("wins", 0) + rec.get("losses", 0)) < PLACEMENT_GAMES),
            }
        )

    rows.sort(key=lambda f: f["elo"], reverse=True)
    return {"fish": rows, "total_votes": analytics["total_votes"]}


def get_elo_info() -> dict:
    return {
        "k_factor": K_FACTOR,
        "k_provisional": K_PROVISIONAL,
        "placement_games": PLACEMENT_GAMES,
        "seed_range": [SEED_MIN, SEED_MAX],
        "expected_formula": "E_A = 1 / (1 + 10^((R_B - R_A) / 400))",
        "update_formula": "R_A_new = R_A + K * (S_A - E_A)",
        "simple": (
            "Fish are seeded by how popular they are, then every vote nudges the ratings. "
            "Beating a stronger fish earns more points than beating a weaker one - upsets pay big, "
            "safe bets pay little. Win = up, lose = down; the bigger the gap, the bigger the swing."
        ),
        "example": (
            "Angelfish (1800) vs Neon Tetra (1200): Angelfish is the heavy favorite. "
            "If Angelfish wins as expected it gains only +3, but if Neon Tetra pulls the upset "
            "it jumps +29 while Angelfish drops 29. The system rewards surprises."
        ),
        "technical": (
            f"E_A is fish A's expected score. A 400-point gap means the stronger fish is 10x "
            f"more likely to win. Newly added fish start at {INITIAL_RATING} and spend their first "
            f"{PLACEMENT_GAMES} matches at a higher K ({K_PROVISIONAL}) so they converge quickly, "
            f"then settle to K = {K_FACTOR}. Catalog fish are seeded from popularity into "
            f"{SEED_MIN}-{SEED_MAX}."
        ),
    }
