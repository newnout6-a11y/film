"""Bazon search. Requires BAZON_API_TOKEN.

Bazon (bazonapi.ru / api-movies/bazon) is a cross-reference API that
maps Kinopoisk IDs, IMDb IDs, and TMDb IDs to direct stream sources.
This makes it a critical piece of a universal parser: given a
Kinopoisk ID from the search results, Bazon instantly returns the
corresponding video streams.

If ``KINOPOISK_ID`` is set in the environment, Bazon searches by that
ID (most precise).  Otherwise it falls back to a text-based search.

References:
  - https://github.com/API-Movies/bazon
"""

from __future__ import annotations

import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from media_common import (  # noqa: E402
    STATUS_BLOCKED,
    STATUS_FAILED,
    STATUS_NO_RESULTS,
    STATUS_OK,
    STATUS_SKIPPED,
    detect_quality,
    env,
    log,
    make_stream_item,
    write_results,
    write_status,
)

TRACKER_LABEL = "Bazon"
TRACKER_SLUG = "bazon"
BASE = "https://bazonapi.ru/api"
TOP_N = 10

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"


def _api_search(
    session: requests.Session,
    token: str,
    query: str,
    *,
    kinopoisk_id: str = "",
) -> list[dict]:
    """Search Bazon API by Kinopoisk ID (preferred) or title."""
    results: list[dict] = []
    headers = {"User-Agent": USER_AGENT}

    # Search by Kinopoisk ID — most precise.
    if kinopoisk_id:
        try:
            r = session.get(
                f"{BASE}/search",
                params={"token": token, "kp": kinopoisk_id},
                headers=headers,
                timeout=20,
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                results.extend(data)
                log(f"bazon: KP-ID search returned {len(data)} result(s)")
            elif isinstance(data, dict):
                # API may return a single object or wrap in a key.
                items = data.get("results") or data.get("data") or []
                if isinstance(items, list):
                    results.extend(items)
                elif data.get("id") or data.get("kp_id"):
                    results.append(data)
                log(f"bazon: KP-ID search returned {len(results)} result(s)")
        except Exception as e:  # noqa: BLE001
            log(f"bazon: KP-ID search error: {e}")

    # Fallback: text search.
    if not results:
        try:
            r = session.get(
                f"{BASE}/search",
                params={"token": token, "title": query},
                headers=headers,
                timeout=20,
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list):
                results.extend(data)
            elif isinstance(data, dict):
                items = data.get("results") or data.get("data") or []
                if isinstance(items, list):
                    results.extend(items)
                elif data.get("id") or data.get("kp_id"):
                    results.append(data)
            log(f"bazon: title search returned {len(results)} result(s)")
        except Exception as e:  # noqa: BLE001
            log(f"bazon: title search error: {e}")

    return results


def _parse_results(raw: list[dict]) -> list[dict]:
    """Convert raw Bazon API results into our standard format."""
    items: list[dict] = []
    seen_ids: set[str] = set()

    for entry in raw:
        entry_id = str(
            entry.get("id")
            or entry.get("kp_id")
            or entry.get("imdb_id")
            or ""
        )
        if entry_id in seen_ids:
            continue
        seen_ids.add(entry_id)

        title = entry.get("ru_title") or entry.get("title") or entry.get("name") or ""
        if not title:
            continue

        # Bazon returns stream info in various fields depending on
        # the API version.  Try the most common ones.
        stream_url = (
            entry.get("iframe_src")
            or entry.get("file_url")
            or entry.get("stream_url")
            or entry.get("url")
            or entry.get("link")
            or ""
        )
        if not stream_url:
            # Some entries have a ``sources`` list with quality variants.
            sources = entry.get("sources") or entry.get("files") or []
            if isinstance(sources, list) and sources:
                best = sources[0]
                if isinstance(best, dict):
                    stream_url = best.get("url") or best.get("file") or ""
                elif isinstance(best, str):
                    stream_url = best
        if not stream_url:
            continue

        quality = (
            detect_quality(stream_url)
            or detect_quality(entry.get("quality", ""))
        )

        translation = entry.get("translation") or entry.get("translator") or ""
        if isinstance(translation, dict):
            translation = translation.get("title", "") or str(translation.get("id", ""))

        kinopoisk_id = entry.get("kp_id") or entry.get("kinopoisk_id") or ""
        imdb_id = entry.get("imdb_id") or ""

        extra = {}
        if imdb_id:
            extra["imdb_id"] = imdb_id

        items.append(
            make_stream_item(
                title=title,
                stream_url=stream_url,
                quality=quality,
                translation=str(translation),
                tracker=TRACKER_LABEL,
                url=entry.get("iframe_src") or f"https://bazonapi.ru/movies/{entry_id}",
                kinopoisk_id=kinopoisk_id or None,
                extra=extra or None,
            )
        )

    return items


def main() -> int:
    query = env("QUERY")
    token = env("BAZON_API_TOKEN")
    kinopoisk_id = env("KINOPOISK_ID")

    if not query:
        log("bazon: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="пустой запрос",
        )
        return 0

    if not token:
        log("bazon: no BAZON_API_TOKEN, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_SKIPPED,
            reason="нет BAZON_API_TOKEN в Настройках",
        )
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    log(f"bazon: searching {query!r}")
    raw = _api_search(session, token, query, kinopoisk_id=kinopoisk_id)
    if not raw:
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="ничего не найдено",
        )
        return 0

    items = _parse_results(raw)
    # Deduplicate by stream_url.
    by_url: dict[str, dict] = {}
    for it in items:
        key = it["stream_url"]
        existing = by_url.get(key)
        if existing is None:
            by_url[key] = it
        elif detect_quality(it.get("quality", "")) > detect_quality(
            existing.get("quality", "")
        ):
            by_url[key] = it
    items = list(by_url.values())

    items.sort(
        key=lambda x: (
            detect_quality(x.get("quality", "")),
            x.get("title", ""),
        ),
        reverse=True,
    )
    items = items[:TOP_N]

    log(f"bazon: {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    write_status(
        TRACKER_SLUG,
        label=TRACKER_LABEL,
        status=STATUS_OK if items else STATUS_NO_RESULTS,
        count=len(items),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
