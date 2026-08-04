"""End-to-end API tests via FastAPI's TestClient."""

import itertools

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app

_ip_counter = itertools.count(1)


def _vote(client, path, **body):
    """POST a vote from a unique client IP to sidestep the per-IP rate limiter."""
    return client.post(path, json=body, headers={"X-Forwarded-For": f"10.0.0.{next(_ip_counter)}"})


@pytest.fixture
def client():
    return TestClient(app)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["fish"] > 0


def test_matchup_and_vote_flow(client):
    m = client.get("/api/matchup").json()
    assert m["fish_a"]["id"] != m["fish_b"]["id"]
    assert "token" in m

    r = _vote(client, "/api/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token=m["token"])
    assert r.status_code == 200
    body = r.json()
    assert body["winner"]["change"] > 0
    assert body["loser"]["change"] < 0


def test_token_is_single_use(client):
    m = client.get("/api/matchup").json()
    args = dict(winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token=m["token"])
    assert _vote(client, "/api/vote", **args).status_code == 200
    # Re-using the same token must fail (GETDEL consumed it).
    assert _vote(client, "/api/vote", **args).status_code == 400


def test_vote_rejects_same_fish(client):
    m = client.get("/api/matchup").json()
    r = _vote(client, "/api/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_a"]["id"], token=m["token"])
    assert r.status_code == 400


def test_vote_rejects_mismatched_pair(client):
    m = client.get("/api/matchup").json()
    other = next(f for f in client.get("/api/rankings").json()["fish"]
                 if f["id"] not in (m["fish_a"]["id"], m["fish_b"]["id"]))
    r = _vote(client, "/api/vote", winner_id=m["fish_a"]["id"], loser_id=other["id"], token=m["token"])
    assert r.status_code == 400


def test_vote_rejects_bad_token(client):
    m = client.get("/api/matchup").json()
    r = _vote(client, "/api/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token="deadbeef")
    assert r.status_code == 400


def test_rankings_sorted_desc(client):
    fish = client.get("/api/rankings").json()["fish"]
    elos = [f["elo"] for f in fish]
    assert elos == sorted(elos, reverse=True)
    assert all("rank_delta" in f for f in fish)


def test_stats_shape(client):
    s = client.get("/api/stats").json()
    for key in ("total_votes", "visitors_online", "best_mover", "worst_mover"):
        assert key in s


def test_track_visitor(client):
    assert client.post("/api/track", json={"visitor_id": "v-123"}).status_code == 200
    assert client.get("/api/stats").json()["visitors_online"] >= 1


def test_daily_endpoints(client):
    d = client.get("/api/daily").json()
    assert len(d["contenders"]) >= 2

    m = client.get("/api/daily/matchup").json()
    assert m["fish_a"]["id"] != m["fish_b"]["id"]

    r = _vote(client, "/api/daily/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token=m["token"])
    assert r.status_code == 200


def test_daily_vote_rejects_global_token(client):
    # A global matchup token must not be redeemable at the daily endpoint.
    m = client.get("/api/matchup").json()
    r = _vote(client, "/api/daily/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token=m["token"])
    assert r.status_code == 400


def test_matchup_carries_head_to_head(client):
    m = client.get("/api/matchup").json()
    assert set(m["head_to_head"]) == {m["fish_a"]["id"], m["fish_b"]["id"]}


def test_manifest_is_served_with_the_right_type(client):
    r = client.get("/manifest.webmanifest")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/manifest+json")


def test_service_worker_is_served_from_the_root_scope(client):
    assert client.get("/sw.js").status_code == 200


def test_photos_are_cached_but_the_shell_revalidates(client):
    photo = client.get("/images/neon-tetra.jpg")
    assert "immutable" in photo.headers["cache-control"]
    assert "must-revalidate" in client.get("/script.js").headers["cache-control"]


def test_api_responses_are_not_cached(client):
    assert client.get("/api/stats").headers["cache-control"] == "no-store"


def test_security_headers_are_set(client):
    h = client.get("/").headers
    assert "default-src 'self'" in h["content-security-policy"]
    assert h["x-content-type-options"] == "nosniff"


def test_compare_returns_head_to_head_for_two_fish(client):
    fish = client.get("/api/rankings").json()["fish"]
    a, b = fish[0]["id"], fish[1]["id"]
    r = client.get(f"/api/compare?a={a}&b={b}")
    assert r.status_code == 200
    body = r.json()
    assert body["fish_a"]["id"] == a and body["fish_b"]["id"] == b
    assert set(body["head_to_head"]) == {a, b}
    assert "elo" in body["fish_a"]


def test_compare_rejects_same_fish(client):
    a = client.get("/api/rankings").json()["fish"][0]["id"]
    assert client.get(f"/api/compare?a={a}&b={a}").status_code == 400


def test_compare_rejects_unknown_fish(client):
    a = client.get("/api/rankings").json()["fish"][0]["id"]
    assert client.get(f"/api/compare?a={a}&b=not-a-fish").status_code == 404


def test_health_reports_local_storage_without_credentials(client):
    h = client.get("/api/health").json()
    assert h["storage"] == "local"        # conftest strips all Redis env vars
    assert h["env_present"] == []
    assert "redis_ok" not in h


def test_vote_response_carries_the_fresh_total(client):
    m = client.get("/api/matchup").json()
    r = _vote(client, "/api/vote", winner_id=m["fish_a"]["id"], loser_id=m["fish_b"]["id"], token=m["token"])
    assert r.status_code == 200
    assert r.json()["total_votes"] == 1

    m2 = client.get("/api/matchup").json()
    r2 = _vote(client, "/api/vote", winner_id=m2["fish_a"]["id"], loser_id=m2["fish_b"]["id"], token=m2["token"])
    assert r2.json()["total_votes"] == 2
