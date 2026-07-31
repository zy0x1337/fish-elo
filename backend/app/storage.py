"""Storage abstraction: JSON files locally, Upstash Redis in production.

Every Redis operation counts against the Upstash monthly command budget, so this
module is designed so each hot path spends as few commands as possible:

- **State is split.** ``ratings`` is a tiny dict rewritten per vote; ``matches`` is
  an append-only list (``RPUSH``, never rewritten). A vote never serializes history.
- **Single-command atomics.** Matchup tokens redeem with ``GETDEL`` (not GET+DEL).
  The write lock releases with a Lua compare-and-delete ``EVAL`` (race-free, one command).
- **Reads are cached in-process** (Vercel Fluid Compute keeps instances warm). Display
  reads tolerate short staleness; writers invalidate the cache so votes act on fresh data.

The backend is selected at call time by the presence of an Upstash REST URL env var,
accepting **both** the ``KV_REST_API_*`` and ``UPSTASH_REDIS_REST_*`` naming schemes so a
Vercel integration that sets only one pair still uses Redis instead of silently falling
back to ephemeral local files (which would reset all data every deploy).
"""

import json
import os
import threading
import time
import uuid
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ELO_FILE = DATA_DIR / "elo.json"

RATINGS_KEY = "ratings"
MATCHES_KEY = "matches"
LOCK_KEY = "elo_lock"
VISITORS_KEY = "visitors"

# Lua compare-and-delete: release the lock only if we still own it (one round trip).
_UNLOCK_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"

# ---------------------------------------------------------------------------
# In-process read cache (cost optimization only — Redis is the source of truth).
# ---------------------------------------------------------------------------
CACHE_TTL_SHORT = 60.0   # ratings + recent matches: leaderboard tolerates <=60s staleness
CACHE_TTL_LONG = 600.0   # immutable data

_cache: dict[str, tuple[float, object]] = {}
_cache_lock = threading.Lock()


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry[0] > time.time():
            return entry[1]
    return None


def _cache_set(key: str, value, ttl: float = CACHE_TTL_SHORT):
    with _cache_lock:
        _cache[key] = (time.time() + ttl, value)


def invalidate_cache(*keys: str) -> None:
    """Drop cached reads. Called by writers before a read-modify-write and by tests."""
    with _cache_lock:
        if keys:
            for k in keys:
                _cache.pop(k, None)
        else:
            _cache.clear()


# ---------------------------------------------------------------------------
# Backend selection
# ---------------------------------------------------------------------------
def _redis_env() -> tuple[str, str] | None:
    url = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("KV_REST_API_TOKEN") or os.environ.get("UPSTASH_REDIS_REST_TOKEN")
    if url and token:
        return url, token
    return None


def _is_redis() -> bool:
    return _redis_env() is not None


def _get_redis():
    from upstash_redis import Redis

    url, token = _redis_env()
    return Redis(url=url, token=token)


# ---------------------------------------------------------------------------
# Local-file backend state
# ---------------------------------------------------------------------------
_local_lock = threading.Lock()
_local_lock_owner: str | None = None
_local_matchups: dict[str, tuple[dict, float]] = {}
_local_daily: dict[str, list[str]] = {}
_local_visitors: dict[str, float] = {}


def _read_local() -> dict:
    if not ELO_FILE.exists():
        return {"ratings": {}, "matches": []}
    with open(ELO_FILE, encoding="utf-8") as f:
        return json.load(f)


def _write_local(data: dict) -> None:
    ELO_FILE.parent.mkdir(parents=True, exist_ok=True)
    if ELO_FILE.exists():
        backup = ELO_FILE.with_suffix(".json.bak")
        with open(ELO_FILE, "rb") as src, open(backup, "wb") as dst:
            dst.write(src.read())
    with open(ELO_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Ratings (small dict, read/written per vote)
# ---------------------------------------------------------------------------
def read_ratings(use_cache: bool = True) -> dict:
    """Return ``{id: {rating, wins, losses}}``. Cached for display reads."""
    if use_cache:
        cached = _cache_get(RATINGS_KEY)
        if cached is not None:
            return cached

    if _is_redis():
        raw = _get_redis().get(RATINGS_KEY)
        ratings = json.loads(raw) if raw else {}
    else:
        ratings = _read_local().get("ratings", {})

    _cache_set(RATINGS_KEY, ratings)
    return ratings


def write_ratings(ratings: dict) -> None:
    if _is_redis():
        _get_redis().set(RATINGS_KEY, json.dumps(ratings, ensure_ascii=False))
    else:
        data = _read_local()
        data["ratings"] = ratings
        _write_local(data)
    _cache_set(RATINGS_KEY, ratings)


# ---------------------------------------------------------------------------
# Matches (append-only log of per-vote snapshots)
# ---------------------------------------------------------------------------
def append_match(match: dict) -> None:
    """Append one match snapshot. One ``RPUSH`` in production; never rewrites history."""
    if _is_redis():
        _get_redis().rpush(MATCHES_KEY, json.dumps(match, ensure_ascii=False))
    else:
        data = _read_local()
        data.setdefault("matches", []).append(match)
        _write_local(data)
    invalidate_cache(MATCHES_KEY)


def read_matches(use_cache: bool = True) -> list[dict]:
    """Return the full match log (list of snapshot dicts). Cached for analytics."""
    if use_cache:
        cached = _cache_get(MATCHES_KEY)
        if cached is not None:
            return cached

    if _is_redis():
        raw = _get_redis().lrange(MATCHES_KEY, 0, -1)
        matches = [json.loads(m) for m in raw] if raw else []
    else:
        matches = _read_local().get("matches", [])

    _cache_set(MATCHES_KEY, matches)
    return matches


# ---------------------------------------------------------------------------
# Write lock (single-command acquire, Lua compare-and-delete release)
# ---------------------------------------------------------------------------
def acquire_lock() -> str | None:
    """Try once to acquire the rating write lock. Invalidates the ratings cache on
    success so the read-modify-write starts from fresh Redis state."""
    if _is_redis():
        token = uuid.uuid4().hex
        if _get_redis().set(LOCK_KEY, token, ex=3, nx=True):
            invalidate_cache(RATINGS_KEY)
            return token
        return None

    if _local_lock.acquire(blocking=False):
        global _local_lock_owner
        _local_lock_owner = uuid.uuid4().hex
        invalidate_cache(RATINGS_KEY)
        return _local_lock_owner
    return None


def release_lock(token: str) -> None:
    if _is_redis():
        _get_redis().eval(_UNLOCK_LUA, [LOCK_KEY], [token])
        return

    global _local_lock_owner
    if _local_lock_owner == token:
        _local_lock_owner = None
        _local_lock.release()


# ---------------------------------------------------------------------------
# Matchup tokens (anti-double-vote; single-use via GETDEL)
# ---------------------------------------------------------------------------
def save_matchup(token: str, payload: dict, ttl: int) -> None:
    key = f"matchup:{token}"
    if _is_redis():
        _get_redis().set(key, json.dumps(payload), ex=ttl)
    else:
        _local_matchups[key] = (payload, time.time() + ttl)


def redeem_matchup(token: str) -> dict | None:
    """Fetch and delete a matchup token in one command (``GETDEL``). Single-use."""
    key = f"matchup:{token}"
    if _is_redis():
        raw = _get_redis().getdel(key)
        return json.loads(raw) if raw else None

    entry = _local_matchups.pop(key, None)
    if entry and entry[1] > time.time():
        return entry[0]
    return None


# ---------------------------------------------------------------------------
# Daily Battle sandbox votes (per-day list, TTL'd; never touches global Elo)
# ---------------------------------------------------------------------------
DAILY_TTL = 3 * 24 * 3600  # keep 3 days


def append_daily_vote(date: str, winner: str, loser: str) -> None:
    """Append a sandbox vote to ``daily:<date>``. One ``RPUSH`` (+ one ``EXPIRE`` the
    first time the day's list is created)."""
    entry = json.dumps({"w": winner, "l": loser})
    key = f"daily:{date}"
    if _is_redis():
        r = _get_redis()
        length = r.rpush(key, entry)
        if length == 1:
            r.expire(key, DAILY_TTL)
    else:
        _local_daily.setdefault(key, []).append(entry)
    invalidate_cache(key)


def read_daily_votes(date: str, use_cache: bool = True) -> list[dict]:
    key = f"daily:{date}"
    if use_cache:
        cached = _cache_get(key)
        if cached is not None:
            return cached

    if _is_redis():
        raw = _get_redis().lrange(key, 0, -1)
        votes = [json.loads(v) for v in raw] if raw else []
    else:
        votes = [json.loads(v) for v in _local_daily.get(key, [])]

    _cache_set(key, votes)
    return votes


# ---------------------------------------------------------------------------
# Visitor tracking (24h rolling unique count via a sorted set)
# ---------------------------------------------------------------------------
def track_visitor(visitor_id: str, now: float, window: float = 24 * 3600) -> None:
    """Record a visitor ping and prune the 24h window. ~2 commands (ZADD + ZREMRANGEBYSCORE)."""
    cutoff = now - window
    if _is_redis():
        r = _get_redis()
        r.zadd(VISITORS_KEY, {visitor_id: now})
        r.zremrangebyscore(VISITORS_KEY, 0, cutoff)
    else:
        _local_visitors[visitor_id] = now
        for vid in [v for v, ts in _local_visitors.items() if ts < cutoff]:
            del _local_visitors[vid]
    invalidate_cache(VISITORS_KEY)


def visitors_online(now: float, window: float = 24 * 3600) -> int:
    """Count unique visitors in the last 24h. Cached (~1 ``ZCARD``)."""
    cached = _cache_get(VISITORS_KEY)
    if cached is not None:
        return cached

    cutoff = now - window
    if _is_redis():
        count = _get_redis().zcount(VISITORS_KEY, cutoff, "+inf")
    else:
        count = sum(1 for ts in _local_visitors.values() if ts >= cutoff)

    _cache_set(VISITORS_KEY, count)
    return count


# ---------------------------------------------------------------------------
# Test / dev helpers
# ---------------------------------------------------------------------------
def reset_local_state() -> None:
    """Clear all in-process state (local backend + caches). For tests only."""
    global _local_lock_owner
    _local_matchups.clear()
    _local_daily.clear()
    _local_visitors.clear()
    if _local_lock_owner is not None:
        _local_lock_owner = None
        if _local_lock.locked():
            _local_lock.release()
    invalidate_cache()
