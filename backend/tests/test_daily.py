"""Daily Battle: deterministic lineups, theme eligibility, Wilson standings, sandbox scope."""

from datetime import datetime, timezone

from backend.app import daily, storage


def test_lineup_is_deterministic_for_a_date():
    a = daily.get_lineup("2025-06-15")
    b = daily.get_lineup("2025-06-15")
    assert a == b
    # Different days generally differ (at least the ordering/theme).
    assert daily.get_lineup("2025-06-16") != a or daily.get_lineup("2025-07-01") != a


def test_eligible_themes_have_enough_fish():
    fish = daily.load_fish()
    for name, tag in daily._eligible_themes():
        n = sum(1 for f in fish if tag in f.get("tags", []))
        assert n >= daily.LINEUP_SIZE, f"{name} only has {n} fish"


def test_curated_lineup_overrides_auto():
    theme, tag, lineup = daily.get_lineup("2024-01-01")
    assert theme == "New Year Nano Faceoff"
    assert "neon-tetra" in lineup


def test_wilson_prefers_proven_record():
    strong = daily._wilson_lower_bound(5, 5)
    lucky = daily._wilson_lower_bound(1, 1)
    assert strong > lucky
    assert daily._wilson_lower_bound(0, 0) == 0.0


def test_standings_only_count_in_lineup_pairs():
    date = "2025-06-15"
    _, _, lineup = daily.get_lineup(date)
    a, b = lineup[0], lineup[1]

    storage.append_daily_vote(date, a, b)              # counts
    storage.append_daily_vote(date, a, "not-in-lineup")  # ignored
    storage.append_daily_vote(date, "outsider", b)       # ignored

    standings = {r["id"]: r for r in daily._standings(date, lineup)}
    assert standings[a]["wins"] == 1
    assert standings[b]["losses"] == 1
    # The winner of the only valid vote tops the standings.
    assert daily._standings(date, lineup)[0]["id"] == a


def test_daily_pair_validation():
    date = "2025-06-15"
    _, _, lineup = daily.get_lineup(date)
    assert daily.valid_daily_pair(date, lineup[0], lineup[1]) is True
    assert daily.valid_daily_pair(date, lineup[0], lineup[0]) is False
    assert daily.valid_daily_pair(date, lineup[0], "not-a-fish") is False


def test_get_daily_shape():
    now = datetime(2025, 6, 15, 12, 0, 0, tzinfo=timezone.utc)
    payload = daily.get_daily(now)
    assert payload["date"] == "2025-06-15"
    assert 0 < payload["seconds_left"] <= 86400
    assert len(payload["contenders"]) >= 2
