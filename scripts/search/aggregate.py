"""Combine per-tracker JSON outputs into a single ``results.json`` artifact.

Strategy:
- Drop entries without a magnet link (we can't beam those).
- Deduplicate by info_hash (keep the one with most seeders).
- Score each entry by a mix of seeders and rough quality keywords.
- Keep only the top-N for the UI.
"""

from __future__ import annotations

import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import RESULTS_DIR, env, log  # noqa: E402

TOP_N = 5
QUALITY_BOOST = (
    ("2160p", 6),
    ("4k", 6),
    ("uhd", 5),
    ("1080p", 4),
    ("bluray", 3),
    ("blu-ray", 3),
    ("bdrip", 3),
    ("web-dl", 2),
    ("webdl", 2),
    ("hdrip", 1),
    ("720p", 1),
    ("dvdrip", 0),
    ("camrip", -3),
    ("ts ", -3),
    ("hdcam", -3),
    ("ts.", -3),
)


def load_all() -> list[dict]:
    items: list[dict] = []
    for path in sorted(glob.glob(os.path.join(RESULTS_DIR, "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:  # noqa: BLE001
            log(f"aggregate: skipping {path} ({e})")
            continue
        if isinstance(data, list):
            items.extend(data)
    return items


def relevance_score(query: str, title: str) -> int:
    q_tokens = [t for t in re.split(r"\W+", query.lower()) if t]
    t_lower = title.lower()
    return sum(1 for t in q_tokens if t in t_lower)


def quality_score(title: str) -> int:
    t = title.lower()
    return sum(b for tag, b in QUALITY_BOOST if tag in t)


def main() -> int:
    query = env("QUERY")
    items = load_all()
    log(f"aggregate: loaded {len(items)} raw item(s)")

    # Drop unusable entries. Some trackers (e.g. apibay's stub rows) hand us
    # ``seeders=null`` which made the previous ``isinstance(int)`` filter
    # silently throw the row away — normalise to 0 instead so the magnet
    # is at least surfaced and the user can decide.
    cleaned: list[dict] = []
    for it in items:
        if not it.get("magnet") or not it.get("title"):
            continue
        seeders = it.get("seeders")
        if not isinstance(seeders, int):
            try:
                it["seeders"] = int(seeders) if seeders is not None else 0
            except (TypeError, ValueError):
                it["seeders"] = 0
        leechers = it.get("leechers")
        if not isinstance(leechers, int):
            try:
                it["leechers"] = int(leechers) if leechers is not None else 0
            except (TypeError, ValueError):
                it["leechers"] = 0
        cleaned.append(it)
    items = cleaned

    # Deduplicate by info_hash (or magnet) — prefer the entry with most seeders.
    by_key: dict[str, dict] = {}
    for it in items:
        key = (it.get("info_hash") or it.get("magnet") or "").lower()
        if not key:
            continue
        existing = by_key.get(key)
        if existing is None or it["seeders"] > existing["seeders"]:
            by_key[key] = it
    deduped = list(by_key.values())
    log(f"aggregate: {len(deduped)} after dedup")

    def score(it: dict) -> tuple:
        rel = relevance_score(query, it["title"]) if query else 0
        return (
            rel,
            it["seeders"],
            quality_score(it["title"]),
            it.get("size", 0),
        )

    deduped.sort(key=score, reverse=True)
    top = deduped[:TOP_N]
    log(f"aggregate: writing top {len(top)} into results.json")
    # Atomic write: a partial results.json from a crashed run was previously
    # picked up by the UI and rendered as «nothing found». Write+rename keeps
    # the previous file in place if json.dump throws halfway through.
    tmp = "results.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, indent=2)
    os.replace(tmp, "results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
