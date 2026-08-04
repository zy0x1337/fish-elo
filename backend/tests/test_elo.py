"""Elo math, placement K, snapshot recording, and the flat starting rating."""

from backend.app import elo, storage


def test_expected_score_symmetry():
    assert elo.expected_score(1500, 1500) == 0.5
    for a, b in [(1600, 1400), (1200, 1800), (1500, 1500)]:
        assert abs(elo.expected_score(a, b) + elo.expected_score(b, a) - 1.0) < 1e-9


def test_equal_rating_equal_k_is_zero_sum():
    new_w, new_l = elo.update_elo(1500, 1500, elo.K_FACTOR, elo.K_FACTOR)
    assert new_w == 1516.0 and new_l == 1484.0
    assert (new_w - 1500) == -(new_l - 1500)  # zero-sum at equal K


def test_upset_pays_more_than_expected_win():
    # Beating a much stronger opponent gains more than beating a weaker one.
    underdog_gain = elo.update_elo(1400, 1800, elo.K_FACTOR, elo.K_FACTOR)[0] - 1400
    favorite_gain = elo.update_elo(1800, 1400, elo.K_FACTOR, elo.K_FACTOR)[0] - 1800
    assert underdog_gain > favorite_gain


def test_provisional_k_during_placement():
    assert elo.k_for(0) == elo.K_PROVISIONAL
    assert elo.k_for(elo.PLACEMENT_GAMES - 1) == elo.K_PROVISIONAL
    assert elo.k_for(elo.PLACEMENT_GAMES) == elo.K_FACTOR
    assert elo.k_for(50) == elo.K_FACTOR


def test_every_fish_starts_at_the_same_base_rating():
    ratings = {f["id"]: elo._default_record(f["id"])["rating"] for f in elo.load_fish()}
    assert set(ratings.values()) == {elo.INITIAL_RATING}
    # An unknown id (only ever seen in the match log) also debuts at the base.
    assert elo._default_record("not-in-catalog")["rating"] == elo.INITIAL_RATING


def test_record_match_persists_snapshot_fields():
    fish = elo.load_fish()
    a, b = fish[0]["id"], fish[1]["id"]
    result = elo.record_match(a, b)

    assert result["winner"]["id"] == a
    assert result["winner"]["change"] > 0
    assert result["loser"]["change"] < 0

    matches = storage.read_matches(use_cache=False)
    assert len(matches) == 1
    m = matches[0]
    for field in ("winner", "loser", "winner_rating", "loser_rating",
                  "winner_change", "loser_change", "timestamp"):
        assert field in m, f"missing snapshot field {field}"

    ratings = storage.read_ratings(use_cache=False)
    assert ratings[a]["wins"] == 1
    assert ratings[b]["losses"] == 1


def test_first_match_uses_provisional_k():
    # A fresh pair's first match should swing by the provisional K, not the settled K.
    # Equal starting ratings make the expected score 0.5, so the swing is exactly K/2.
    storage.write_ratings({
        "test-a": {"rating": elo.INITIAL_RATING, "wins": 0, "losses": 0},
        "test-b": {"rating": elo.INITIAL_RATING, "wins": 0, "losses": 0},
    })
    # Only present in ratings, not catalog — analytics/record handle unknown ids fine.
    result = elo.record_match("test-a", "test-b")
    assert result["winner"]["change"] == elo.K_PROVISIONAL / 2
