"""Snapshot-based analytics: trends reflect stored changes, and the §6 rank-delta
regression that pins historical replay to the persisted (provisional-K) scale."""

from datetime import datetime, timezone

from backend.app import elo, storage


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def test_trends_reflect_stored_changes():
    now = 1_000_000.0
    storage.write_ratings({
        "neon-tetra": {"rating": 1600.0, "wins": 12, "losses": 3},
        "guppy": {"rating": 1400.0, "wins": 3, "losses": 12},
    })
    storage.append_match({
        "winner": "neon-tetra", "loser": "guppy",
        "winner_rating": 1600.0, "loser_rating": 1400.0,
        "winner_change": 12.0, "loser_change": -12.0,
        "timestamp": _iso(now - 1800),  # within the 1h window
    })

    a = elo.compute_analytics(now=now, use_cache=False)
    assert a["trends"]["neon-tetra"]["elo_delta_1h"] == 12.0
    assert a["trends"]["neon-tetra"]["elo_delta_24h"] == 12.0
    assert a["trends"]["guppy"]["elo_delta_24h"] == -12.0
    assert a["total_votes"] == 1
    assert a["best_mover"]["id"] == "neon-tetra"
    assert a["worst_mover"]["id"] == "guppy"


def test_1h_window_excludes_older_matches():
    now = 1_000_000.0
    storage.write_ratings({
        "neon-tetra": {"rating": 1600.0, "wins": 12, "losses": 3},
        "guppy": {"rating": 1400.0, "wins": 3, "losses": 12},
    })
    storage.append_match({
        "winner": "neon-tetra", "loser": "guppy",
        "winner_rating": 1600.0, "loser_rating": 1400.0,
        "winner_change": 12.0, "loser_change": -12.0,
        "timestamp": _iso(now - 3 * 3600),  # 3h ago: in 24h window, out of 1h
    })
    a = elo.compute_analytics(now=now, use_cache=False)
    assert a["trends"]["neon-tetra"]["elo_delta_1h"] == 0.0
    assert a["trends"]["neon-tetra"]["elo_delta_24h"] == 12.0


def test_rank_delta_uses_snapshot_scale_not_standard_k():
    """§6 regression: reconstruct the 24h-ago ranking by *undoing the stored per-match
    changes* (provisional-K scale), never a standard-K recompute.

    Scenario — three settled fish, current order A > C > B:
      * A won two placement-era matches vs a far-weaker B, each applying a large stored
        change of +45 (provisional K). Undoing them puts A at 1650-90 = 1560, i.e. *below*
        C (1640) 24h ago -> A climbed from rank 2 to rank 1 (rank_delta +1); C fell -1.
      * A standard-K recompute from the snapshot ratings (A 1650 vs B 1200, E_A≈0.93) would
        undo only ≈2.2 per match, leaving A at ≈1645.5 > C 24h ago -> rank_delta 0.

    Pinning to +1/-1 fails the moment someone reverts the replay to standard-K.
    """
    now = 1_000_000.0
    A, B, C = "neon-tetra", "guppy", "cardinal-tetra"
    storage.write_ratings({
        A: {"rating": 1650.0, "wins": 12, "losses": 3},   # settled (>=10 games)
        C: {"rating": 1640.0, "wins": 8, "losses": 5},    # settled, no recent matches
        B: {"rating": 1200.0, "wins": 1, "losses": 14},
    })
    for _ in range(2):
        storage.append_match({
            "winner": A, "loser": B,
            "winner_rating": 1650.0, "loser_rating": 1200.0,  # feeds the standard-K fallback
            "winner_change": 45.0, "loser_change": -45.0,     # actual provisional-K swing
            "timestamp": _iso(now - 2 * 3600),
        })

    trends = elo.compute_analytics(now=now, use_cache=False)["trends"]

    # Ground truth from the snapshot scale: A overtakes C, C drops.
    assert trends[A]["rank_delta"] == 1
    assert trends[C]["rank_delta"] == -1

    # Sanity: the standard-K recompute the invariant forbids would have said "no move".
    standard_A_24h = 1650.0 - 2 * round(elo.K_FACTOR * (1 - elo.expected_score(1650, 1200)), 1)
    assert standard_A_24h > 1640.0  # would rank A above C 24h ago -> rank_delta 0


def test_placement_fish_have_suppressed_rank_arrow():
    now = 1_000_000.0
    storage.write_ratings({
        "neon-tetra": {"rating": 1600.0, "wins": 3, "losses": 2},  # 5 games: still placing
    })
    storage.append_match({
        "winner": "neon-tetra", "loser": "guppy",
        "winner_rating": 1600.0, "loser_rating": 1400.0,
        "winner_change": 30.0, "loser_change": -30.0,
        "timestamp": _iso(now - 600),
    })
    trends = elo.compute_analytics(now=now, use_cache=False)["trends"]
    assert trends["neon-tetra"]["placing"] is True
    assert trends["neon-tetra"]["rank_delta"] is None


def test_head_to_head_pairs_are_counted_per_direction():
    """The matchup payload's crowd split comes from this map, built in the same pass
    over the match log — so it must never depend on which id is 'a' and which is 'b'."""
    now = 1_000_000.0
    for _ in range(3):
        storage.append_match({
            "winner": "guppy", "loser": "neon-tetra",
            "winner_rating": 1510.0, "loser_rating": 1490.0,
            "winner_change": 10.0, "loser_change": -10.0,
            "timestamp": _iso(now - 600),
        })
    storage.append_match({
        "winner": "neon-tetra", "loser": "guppy",
        "winner_rating": 1500.0, "loser_rating": 1500.0,
        "winner_change": 10.0, "loser_change": -10.0,
        "timestamp": _iso(now - 300),
    })

    pairs = elo.compute_analytics(now=now, use_cache=False)["pairs"]
    assert elo.head_to_head(pairs, "guppy", "neon-tetra") == {"guppy": 3, "neon-tetra": 1}
    assert elo.head_to_head(pairs, "neon-tetra", "guppy") == {"neon-tetra": 1, "guppy": 3}
    assert elo.head_to_head(pairs, "guppy", "discus") == {"guppy": 0, "discus": 0}
