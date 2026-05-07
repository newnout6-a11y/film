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

    # Drop unusable entries.
    items = [
        it
        for it in items
        if it.get("magnet")
        and it.get("title")
        and isinstance(it.get("seeders"), int)
    ]

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
    with open("results.json", "w", encoding="utf-8") as f:
        json.dump(top, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
