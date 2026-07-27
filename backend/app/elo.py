"""Elo rating system for freshwater fish head-to-head matchups."""

import json
import math
import random
import time
from datetime import datetime, timezone
from pathlib import Path

from . import storage

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FISH_FILE = DATA_DIR / "fish.json"

K_FACTOR = 32
INITIAL_RATING = 1500


def load_fish() -> list[dict]:
    if not FISH_FILE.exists():
        return []
    with open(FISH_FILE, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("fish", []) if data else []


def expected_score(rating_a: float, rating_b: float) -> float:
    return 1.0 / (1.0 + 10.0 ** ((rating_b - rating_a) / 400.0))


def update_elo(winner_rating: float, loser_rating: float) -> tuple[float, float]:
    e_w = expected_score(winner_rating, loser_rating)
    e_l = 1.0 - e_w
    new_w = winner_rating + K_FACTOR * (1.0 - e_w)
    new_l = loser_rating + K_FACTOR * (0.0 - e_l)
    return round(new_w, 1), round(new_l, 1)


def load_ratings() -> dict:
    elo_data = storage.read_elo()
    if elo_data and elo_data.get("ratings"):
        return elo_data

    fish_list = load_fish()
    if not fish_list:
        return {"ratings": {}, "matches": []}

    ratings = {}
    for fish in fish_list:
        ratings[fish["id"]] = {
            "rating": INITIAL_RATING,
            "wins": 0,
            "losses": 0,
        }

    return {"ratings": ratings, "matches": []}


def save_ratings(elo_data: dict) -> None:
    storage.write_elo(elo_data)


def get_elo_info() -> dict:
    return {
        "k_factor": K_FACTOR,
        "initial_rating": INITIAL_RATING,
        "expected_formula": "E_A = 1 / (1 + 10^((R_B - R_A) / 400))",
        "update_formula": "R_A_new = R_A + K * (S_A - E_A)",
        "simple": (
            "Every fish starts with a rating of 1500. "
            "When you pick a winner, the winner takes points from the loser "
            "- like in a fighting game where beating a stronger opponent earns more rank. "
            "Upsets pay big. Safe bets pay little. "
            "Simple: win = up, lose = down. The bigger the gap, the bigger the swing."
        ),
        "example": (
            "Angelfish (1800 Elo) vs Neon Tetra (1200 Elo): "
            "Angelfish is the heavy favorite. If Angelfish wins (as expected), it gains only +3. "
            "But if Neon Tetra wins the upset, it jumps +29 and Angelfish drops 29. "
            "The system rewards surprising outcomes."
        ),
        "technical": (
            "E_A is the expected score for fish A. "
            "A 400-point gap means the stronger fish is 10x more likely to win. "
            "K = 32 is the maximum point swing per match. "
            "S_A is 1 for a win, 0 for a loss. "
            "All fish start at 1500 Elo."
        ),
    }


def record_match(winner_id: str, loser_id: str) -> dict:
    for attempt in range(5):
        token = storage.acquire_lock()
        if token:
            try:
                elo_data = load_ratings()
                ratings = elo_data.get("ratings", {})
                matches = elo_data.get("matches", [])

                if winner_id not in ratings:
                    ratings[winner_id] = {"rating": INITIAL_RATING, "wins": 0, "losses": 0}
                if loser_id not in ratings:
                    ratings[loser_id] = {"rating": INITIAL_RATING, "wins": 0, "losses": 0}

                winner = ratings[winner_id]
                loser = ratings[loser_id]

                old_w, old_l = winner["rating"], loser["rating"]
                new_w, new_l = update_elo(old_w, old_l)

                winner["rating"] = new_w
                winner["wins"] = winner.get("wins", 0) + 1
                loser["rating"] = new_l
                loser["losses"] = loser.get("losses", 0) + 1

                match = {
                    "winner": winner_id,
                    "loser": loser_id,
                    "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                matches.append(match)

                save_ratings({"ratings": ratings, "matches": matches})

                return {
                    "winner": {"id": winner_id, "rating": new_w, "change": round(new_w - old_w, 1)},
                    "loser": {"id": loser_id, "rating": new_l, "change": round(new_l - old_l, 1)},
                }
            finally:
                storage.release_lock(token)

        time.sleep(0.05 + random.random() * 0.15)

    raise ValueError("Server busy, please try again")
