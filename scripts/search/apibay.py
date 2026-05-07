"""Pirate Bay search via apibay.org JSON API. No login required."""

from __future__ import annotations

import sys

import requests

from common import env, log, to_magnet, write_results

TRACKER_LABEL = "Pirate Bay"
TRACKER_SLUG = "apibay"


def main() -> int:
    query = env("QUERY")
    if not query:
        log("apibay: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"apibay: searching {query!r}")
    try:
        r = requests.get(
            "https://apibay.org/q.php",
            params={"q": query, "cat": "0"},
            timeout=20,
            headers={"User-Agent": "film-beamer-search/1.0"},
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:  # noqa: BLE001
        log(f"apibay: error fetching results: {e}")
        write_results(TRACKER_SLUG, [])
        return 0

    items = []
    for it in data:
        info_hash = (it.get("info_hash") or "").lower()
        # apibay returns a stub row when no results match.
        if info_hash in ("", "0", "0" * 40):
            continue
        name = (it.get("name") or "").strip()
        magnet = to_magnet(info_hash, name)
        if not magnet:
            continue
        items.append(
            {
                "title": name,
                "size": int(it.get("size") or 0),
                "seeders": int(it.get("seeders") or 0),
                "leechers": int(it.get("leechers") or 0),
                "tracker": TRACKER_LABEL,
                "magnet": magnet,
                "url": f"https://thepiratebay.org/description.php?id={it.get('id', '')}",
                "info_hash": info_hash,
            }
        )

    log(f"apibay: parsed {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    return 0


if __name__ == "__main__":
    sys.path.insert(0, __file__.rsplit("/", 1)[0])
    sys.exit(main())
