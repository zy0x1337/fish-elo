"""Storage abstraction: JSON files locally, Upstash Redis in production."""

import json
import os
import threading
import uuid

from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ELO_FILE = DATA_DIR / "elo.json"

_local_lock = threading.Lock()
_local_lock_owner: str | None = None


def _is_vercel() -> bool:
    return bool(os.environ.get("KV_REST_API_URL"))


def _get_upstash():
    from upstash_redis import Redis

    return Redis(
        url=os.environ["KV_REST_API_URL"],
        token=os.environ["KV_REST_API_TOKEN"],
    )


def read_elo() -> dict | None:
    if _is_vercel():
        r = _get_upstash()
        raw = r.get("elo_data")
        return json.loads(raw) if raw else None
    else:
        if not ELO_FILE.exists():
            return None
        with open(ELO_FILE, encoding="utf-8") as f:
            return json.load(f)


def write_elo(data: dict) -> None:
    if _is_vercel():
        r = _get_upstash()
        r.set("elo_data", json.dumps(data, ensure_ascii=False))
    else:
        elo_file = ELO_FILE
        elo_file.parent.mkdir(parents=True, exist_ok=True)
        if elo_file.exists():
            backup = elo_file.with_suffix(".json.bak")
            with open(elo_file, "rb") as src:
                with open(backup, "wb") as dst:
                    dst.write(src.read())
        with open(elo_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)


def acquire_lock() -> str | None:
    if _is_vercel():
        r = _get_upstash()
        token = uuid.uuid4().hex
        acquired = r.set("elo_lock", token, ex=3, nx=True)
        return token if acquired else None
    else:
        acquired = _local_lock.acquire(blocking=False)
        if acquired:
            global _local_lock_owner
            _local_lock_owner = str(uuid.uuid4())
            return _local_lock_owner
        return None


def release_lock(token: str) -> None:
    if _is_vercel():
        r = _get_upstash()
        current = r.get("elo_lock")
        if current == token:
            r.delete("elo_lock")
    else:
        global _local_lock_owner
        if _local_lock_owner == token:
            _local_lock_owner = None
            _local_lock.release()


_local_matchups: dict[str, tuple[str, str, float]] = {}


def save_matchup(token: str, a_id: str, b_id: str, ttl: int) -> None:
    key = f"matchup:{token}"
    data = json.dumps({"a": a_id, "b": b_id})
    if _is_vercel():
        r = _get_upstash()
        r.set(key, data, ex=ttl)
    else:
        import time as _time
        _local_matchups[key] = (a_id, b_id, _time.time() + ttl)


def get_matchup(token: str) -> tuple[str, str] | None:
    key = f"matchup:{token}"
    if _is_vercel():
        r = _get_upstash()
        raw = r.get(key)
        if raw:
            obj = json.loads(raw)
            return (obj["a"], obj["b"])
        return None
    else:
        import time as _time
        entry = _local_matchups.get(key)
        if entry and entry[2] > _time.time():
            return (entry[0], entry[1])
        return None


def delete_matchup(token: str) -> None:
    key = f"matchup:{token}"
    if _is_vercel():
        r = _get_upstash()
        r.delete(key)
    else:
        _local_matchups.pop(key, None)
