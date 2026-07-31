"""Daily Battle: a themed sandbox tournament that never touches the global Elo.

The lineup for a UTC day is either **curated** (``daily_battles.json`` keyed by date) or
**auto-generated deterministically** from the date alone — the date is hashed to pick the
theme genre and to order candidates, so the lineup is stable for the whole day with no RNG
and no shared mutable state. Sandbox votes are stored per-day with a TTL; standings rank by
the Wilson score lower bound on win-rate so a proven record beats a lucky 1-0.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import storage
from .elo import load_fish

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CURATED_FILE = DATA_DIR / "daily_battles.json"

LINEUP_SIZE = 10

# Pretty theme name -> catalog tag. Only themes with >=10 tagged fish are eligible, so
# the ">=10 per theme" invariant holds automatically regardless of catalog edits.
THEMES = {
    "Cichlid Clash": "cichlid",
    "Tetra Tournament": "tetra",
    "Catfish Cage Match": "catfish",
    "Nano Fish Faceoff": "nano",
    "Schooling Species Showdown": "schooling",
    "Community Tank Classics": "community",
    "Planted-Tank Favorites": "planted",
    "Centerpiece Showdown": "centerpiece",
    "Beginner's Best": "beginner",
    "Bottom-Dweller Brawl": "bottom-dweller",
}


def today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _seconds_left_in_day(now: datetime) -> int:
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((tomorrow - now).total_seconds())


def _date_hash(date: str, salt: str = "") -> int:
    return int(hashlib.sha256(f"{date}:{salt}".encode()).hexdigest(), 16)


def _eligible_themes() -> list[tuple[str, str]]:
    fish = load_fish()
    out = []
    for name, tag in THEMES.items():
        if sum(1 for f in fish if tag in f.get("tags", [])) >= LINEUP_SIZE:
            out.append((name, tag))
    return out


def _load_curated() -> dict:
    if not CURATED_FILE.exists():
        return {}
    with open(CURATED_FILE, encoding="utf-8") as f:
        return json.load(f) or {}


def _auto_lineup(date: str) -> tuple[str, str, list[str]]:
    """Deterministically pick a theme and order candidates for ``date``."""
    themes = _eligible_themes()
    if not themes:
        fish = load_fish()
        ordered = sorted(fish, key=lambda f: _date_hash(date, f["id"]))
        return "Daily Battle", "", [f["id"] for f in ordered[:LINEUP_SIZE]]

    name, tag = themes[_date_hash(date) % len(themes)]
    candidates = [f for f in load_fish() if tag in f.get("tags", [])]
    candidates.sort(key=lambda f: _date_hash(date, f["id"]))
    return name, tag, [f["id"] for f in candidates[:LINEUP_SIZE]]


def get_lineup(date: str) -> tuple[str, str, list[str]]:
    """Return ``(theme_name, tag, [fish_id, ...])`` for a date (curated or auto)."""
    curated = _load_curated().get(date)
    if curated and curated.get("fish"):
        ids = {f["id"] for f in load_fish()}
        lineup = [fid for fid in curated["fish"] if fid in ids]
        if len(lineup) >= 2:
            return curated.get("theme", "Daily Battle"), curated.get("tag", ""), lineup
    return _auto_lineup(date)


def _wilson_lower_bound(wins: int, n: int, z: float = 1.96) -> float:
    """Lower bound of the Wilson score interval for a Bernoulli win-rate."""
    if n == 0:
        return 0.0
    p = wins / n
    denom = 1 + z * z / n
    centre = p + z * z / (2 * n)
    margin = z * ((p * (1 - p) + z * z / (4 * n)) / n) ** 0.5
    return (centre - margin) / denom


def _standings(date: str, lineup: list[str]) -> list[dict]:
    """Tally sandbox votes for a day into Wilson-ranked standings. Only votes where
    *both* fish are in the lineup count, so a re-curated day can't leak stale results."""
    lineup_set = set(lineup)
    wins = {fid: 0 for fid in lineup}
    losses = {fid: 0 for fid in lineup}

    for v in storage.read_daily_votes(date):
        w, l = v.get("w"), v.get("l")
        if w in lineup_set and l in lineup_set:
            wins[w] += 1
            losses[l] += 1

    from .elo import fish_by_id

    rows = []
    for fid in lineup:
        n = wins[fid] + losses[fid]
        fish = fish_by_id(fid) or {"id": fid, "name": fid, "image": ""}
        rows.append(
            {
                "id": fid,
                "name": fish.get("name", fid),
                "image": fish.get("image", ""),
                "wins": wins[fid],
                "losses": losses[fid],
                "score": round(_wilson_lower_bound(wins[fid], n), 4),
            }
        )
    rows.sort(key=lambda r: (r["score"], r["wins"]), reverse=True)
    return rows


def _yesterday_champion(now: datetime) -> dict | None:
    date = (now - timedelta(days=1)).strftime("%Y-%m-%d")
    _, _, lineup = get_lineup(date)
    standings = _standings(date, lineup)
    if standings and (standings[0]["wins"] + standings[0]["losses"]) > 0:
        return standings[0]
    return None


def get_daily(now: datetime | None = None) -> dict:
    """Full Daily Battle payload for the current UTC day."""
    if now is None:
        now = datetime.now(timezone.utc)
    date = now.strftime("%Y-%m-%d")
    theme, tag, lineup = get_lineup(date)
    return {
        "date": date,
        "theme": theme,
        "tag": tag,
        "contenders": _standings(date, lineup),
        "yesterday_champion": _yesterday_champion(now),
        "seconds_left": _seconds_left_in_day(now),
    }


def valid_daily_pair(date: str, a_id: str, b_id: str) -> bool:
    _, _, lineup = get_lineup(date)
    return a_id in lineup and b_id in lineup and a_id != b_id
