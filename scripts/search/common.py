"""Shared helpers for tracker search scripts.

Each tracker module reads QUERY from env, optionally reads its credentials,
fetches and parses results, and writes ``results/<tracker>.json``. The
``aggregate`` step then merges them into a single ``results.json`` artifact.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.parse
from typing import Any

# Public BitTorrent trackers we attach to every magnet link so that DHT-only
# results bootstrap quickly on the runner.
PUBLIC_TRACKERS: tuple[str, ...] = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
)

RESULTS_DIR = "results"


def log(msg: str) -> None:
    """Print to stderr — keeps stdout clean for any potential JSON output."""
    print(msg, file=sys.stderr, flush=True)


def write_results(tracker_slug: str, items: list[dict[str, Any]]) -> None:
    os.makedirs(RESULTS_DIR, exist_ok=True)
    path = os.path.join(RESULTS_DIR, f"{tracker_slug}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    log(f"{tracker_slug}: wrote {len(items)} item(s) to {path}")


def to_magnet(info_hash: str, title: str | None = None) -> str | None:
    """Build a magnet URI from a 40-char hex info_hash."""
    if not info_hash:
        return None
    h = info_hash.strip().lower()
    if len(h) != 40 or not all(c in "0123456789abcdef" for c in h):
        return None
    parts = [f"xt=urn:btih:{h}"]
    if title:
        parts.append("dn=" + urllib.parse.quote_plus(title))
    for tr in PUBLIC_TRACKERS:
        parts.append("tr=" + urllib.parse.quote_plus(tr))
    return "magnet:?" + "&".join(parts)


# ---------- bencode (minimal, just enough to read .torrent files) ----------


def _bdecode(data: bytes, idx: int = 0):
    c = data[idx]
    if c == ord("i"):
        end = data.index(b"e", idx)
        return int(data[idx + 1 : end]), end + 1
    if ord("0") <= c <= ord("9"):
        colon = data.index(b":", idx)
        length = int(data[idx:colon])
        return data[colon + 1 : colon + 1 + length], colon + 1 + length
    if c == ord("l"):
        idx += 1
        out: list = []
        while data[idx] != ord("e"):
            v, idx = _bdecode(data, idx)
            out.append(v)
        return out, idx + 1
    if c == ord("d"):
        idx += 1
        out_d: dict = {}
        while data[idx] != ord("e"):
            k, idx = _bdecode(data, idx)
            v, idx = _bdecode(data, idx)
            out_d[k] = v
        return out_d, idx + 1
    raise ValueError(f"bencode: unexpected byte {c!r} at {idx}")


def _bencode(v) -> bytes:
    if isinstance(v, int):
        return f"i{v}e".encode()
    if isinstance(v, bytes):
        return f"{len(v)}:".encode() + v
    if isinstance(v, list):
        return b"l" + b"".join(_bencode(x) for x in v) + b"e"
    if isinstance(v, dict):
        items = sorted(v.items(), key=lambda kv: kv[0])
        return b"d" + b"".join(_bencode(k) + _bencode(val) for k, val in items) + b"e"
    raise TypeError(f"bencode: cannot encode {type(v).__name__}")


def torrent_info_hash(torrent_bytes: bytes) -> str | None:
    """SHA-1 of the bencoded info dict from a .torrent file."""
    try:
        obj, _ = _bdecode(torrent_bytes)
        if not isinstance(obj, dict) or b"info" not in obj:
            return None
        return hashlib.sha1(_bencode(obj[b"info"])).hexdigest()
    except Exception as e:  # noqa: BLE001
        log(f"torrent_info_hash: parse failed ({e})")
        return None


# ---------- size parsing ----------

_SIZE_UNITS = {
    "b": 1,
    "kb": 1024,
    "mb": 1024**2,
    "gb": 1024**3,
    "tb": 1024**4,
    "к": 1024,
    "м": 1024**2,
    "г": 1024**3,
    "т": 1024**4,
    "кб": 1024,
    "мб": 1024**2,
    "гб": 1024**3,
    "тб": 1024**4,
}


def parse_size(text: str) -> int:
    """Parse strings like '1.5 GB', '700 MB', '1,2 ГБ' into bytes."""
    if not text:
        return 0
    s = text.strip().lower().replace("\xa0", " ").replace(",", ".")
    s = s.replace("\u00a0", " ")
    # Pull out the numeric prefix and the unit suffix.
    num = []
    i = 0
    while i < len(s) and (s[i].isdigit() or s[i] == "."):
        num.append(s[i])
        i += 1
    try:
        value = float("".join(num)) if num else 0.0
    except ValueError:
        value = 0.0
    unit = s[i:].strip()
    mult = _SIZE_UNITS.get(unit) or _SIZE_UNITS.get(unit.split()[0] if unit else "", 1)
    return int(value * mult)


def parse_int(text: str) -> int:
    if not text:
        return 0
    digits = "".join(c for c in text if c.isdigit())
    return int(digits) if digits else 0


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()
