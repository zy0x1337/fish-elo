"""Test isolation: force the local-file backend into a temp dir and clear all caches."""

import pytest

from backend.app import storage


@pytest.fixture(autouse=True)
def isolated_storage(tmp_path, monkeypatch):
    # Never touch a real Redis during tests.
    for var in (
        "KV_REST_API_URL",
        "KV_REST_API_TOKEN",
        "UPSTASH_REDIS_REST_URL",
        "UPSTASH_REDIS_REST_TOKEN",
    ):
        monkeypatch.delenv(var, raising=False)

    monkeypatch.setattr(storage, "ELO_FILE", tmp_path / "elo.json")
    storage.reset_local_state()

    # Reset the API's per-process best-effort state so tests don't bleed into each other.
    from backend.app import main
    main._vote_ratelimit.clear()
    main._recent_pairs.clear()

    yield
    storage.reset_local_state()
