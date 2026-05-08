"""Pirate Bay search via apibay.org JSON API. No login required.

apibay.org sits behind Cloudflare and intermittently hard-blocks GitHub
Actions IP ranges with HTTP 403 (we observed this on 2026-05). Real
browsers don't see the block, so we hedge by:

  1. Sending a fully-spelled-out browser User-Agent + Accept-Language so the
     WAF heuristic classifies us as a normal client.
  2. Trying a list of mirrors in sequence — apibay.org first, then
     thepiratebay-style proxies that expose the same q.php contract.
  3. Logging *why* each attempt failed so the workflow log has actionable
     output ("Cloudflare 403 from <host>") instead of a generic stack
     trace. The previous run silently said
     ``apibay: error fetching results: 403 Client Error`` and then quietly
     wrote zero rows.

apibay is now a *best-effort* tracker — the new ``rutor.py`` covers the
"public, no-login" niche from runners that can't reach apibay.
"""

from __future__ import annotations

import sys

import requests

from common import env, log, to_magnet, write_results

TRACKER_LABEL = "Pirate Bay"
TRACKER_SLUG = "apibay"

# Endpoints that share the apibay q.php contract (JSON array of items with
# ``info_hash``, ``name``, ``seeders``, ``leechers``, ``size``, ``id``).
# Order matters: we stop at the first 200 OK.
JSON_ENDPOINTS: tuple[str, ...] = (
    "https://apibay.org/q.php",
    "https://piratebay.live/q.php",
    "https://thehiddenbay.com/q.php",
)

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
    "Referer": "https://thepiratebay.org/",
    "Connection": "keep-alive",
}


def fetch_json(query: str) -> list[dict] | None:
    last = ""
    for base in JSON_ENDPOINTS:
        try:
            r = requests.get(
                base,
                params={"q": query, "cat": "0"},
                timeout=15,
                headers=BROWSER_HEADERS,
            )
        except Exception as e:  # noqa: BLE001
            last = f"{base}: {type(e).__name__}: {e}"
            log(f"apibay: mirror unreachable — {last}")
            continue
        if r.status_code == 403:
            last = f"{base}: HTTP 403 (Cloudflare block on Actions IP)"
            log(f"apibay: {last}")
            continue
        if r.status_code >= 400:
            last = f"{base}: HTTP {r.status_code}"
            log(f"apibay: {last}")
            continue
        try:
            data = r.json()
        except Exception as e:  # noqa: BLE001
            last = f"{base}: not JSON ({type(e).__name__})"
            log(f"apibay: {last}; body[:120]={r.text[:120]!r}")
            continue
        if not isinstance(data, list):
            last = f"{base}: payload is not a list ({type(data).__name__})"
            log(f"apibay: {last}")
            continue
        log(f"apibay: got {len(data)} raw row(s) from {base}")
        return data
    log(
        "apibay: every mirror failed (last: "
        f"{last}). Public results still come from rutor.py."
    )
    return None


def main() -> int:
    query = env("QUERY")
    if not query:
        log("apibay: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"apibay: searching {query!r}")
    data = fetch_json(query)
    if data is None:
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
