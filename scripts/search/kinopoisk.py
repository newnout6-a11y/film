"""Kinopoisk metadata search. Requires KINOPOISK_API_KEY.

Uses the Kinopoisk API Unofficial (kinopoisk.dev / kinopoiskapiunofficial)
to fetch movie metadata — title, year, rating, poster, Kinopoisk ID.
This does **not** provide video streams (those require yt-dlp + cookies
and optionally Widevine DRM decryption, handled by the download workflow).

The metadata is useful for:
  - Cross-referencing with Bazon/VideoCDN/Kodik by Kinopoisk ID
  - Displaying rich movie info in the UI
  - Providing the ``KINOPOISK_ID`` env var for other search scripts

References:
  - https://pypi.org/project/kinopoisk-api-unofficial-client/
  - https://github.com/ramusus/kinopoiskpy
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
    env,
    log,
    make_stream_item,
    write_results,
    write_status,
)

TRACKER_LABEL = "Кинопоиск"
TRACKER_SLUG = "kinopoisk"

# Two known API bases for Kinopoisk Unofficial.
API_HOSTS: tuple[str, ...] = (
    "https://api.kinopoisk.dev",
    "https://kinopoiskapiunofficial.tk",
)

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"


def _api_search(
    session: requests.Session,
    token: str,
    query: str,
) -> list[dict]:
    """Search Kinopoisk API for movies matching the query."""
    results: list[dict] = []
    headers = {
        "User-Agent": USER_AGENT,
        "X-API-KEY": token,
        "Accept": "application/json",
    }

    # Try kinopoisk.dev first (more reliable in 2025+).
    for base in API_HOSTS:
        try:
            r = session.get(
                f"{base}/v1.4/movie/search",
                params={"query": query, "limit": 10},
                headers=headers,
                timeout=20,
            )
            if r.status_code == 403:
                log(f"kinopoisk: {base} returned 403 (bad API key?)")
                continue
            r.raise_for_status()
            data = r.json()
            # kinopoisk.dev returns {"docs": [...], "total": N, ...}
            items = data.get("docs") or data.get("films") or data.get("items") or []
            if isinstance(items, list):
                results.extend(items)
                log(f"kinopoisk: {base} returned {len(items)} result(s)")
                break
        except Exception as e:  # noqa: BLE001
            log(f"kinopoisk: {base} search error: {e}")
            continue

    return results


def _parse_results(raw: list[dict]) -> list[dict]:
    """Convert raw Kinopoisk API results into our standard format."""
    items: list[dict] = []
    seen_ids: set[str] = set()

    for entry in raw:
        kp_id = str(
            entry.get("id")
            or entry.get("kinopoiskId")
            or entry.get("filmId")
            or ""
        )
        if kp_id in seen_ids:
            continue
        seen_ids.add(kp_id)

        title = (
            entry.get("name") or entry.get("nameRu") or entry.get("title") or ""
        )
        title_en = entry.get("nameEn") or entry.get("titleEn") or entry.get("originalName") or ""
        if not title and not title_en:
            continue

        display_title = f"{title} ({entry.get('year', '')})" if title else f"{title_en} ({entry.get('year', '')})"

        year = entry.get("year") or ""
        rating = entry.get("rating") or entry.get("ratingKinopoisk") or entry.get("ratingImdb") or ""
        if isinstance(rating, dict):
            rating = rating.get("kp") or rating.get("imdb") or ""
        poster = entry.get("poster") or entry.get("posterUrl") or entry.get("posterUrlPreview") or ""
        if isinstance(poster, dict):
            poster = poster.get("url") or poster.get("previewUrl") or ""

        description = entry.get("description") or entry.get("shortDescription") or ""
        genres = entry.get("genres") or []
        if isinstance(genres, list) and genres:
            if isinstance(genres[0], dict):
                genres = [g.get("name", "") for g in genres if isinstance(g, dict)]
            else:
                genres = [str(g) for g in genres]
        else:
            genres = []

        # Build the Kinopoisk URL — this is what the download workflow
        # will use with yt-dlp + cookies.
        kp_url = f"https://www.kinopoisk.ru/film/{kp_id}/"

        items.append(
            make_stream_item(
                title=display_title,
                stream_url=kp_url,
                quality="",
                translation="",
                tracker=TRACKER_LABEL,
                url=kp_url,
                kinopoisk_id=kp_id or None,
                extra={
                    "title_en": title_en,
                    "year": str(year),
                    "rating": str(rating),
                    "poster": poster,
                    "description": (description or "")[:200],
                    "genres": genres,
                    "type": "kinopoisk_metadata",
                },
            )
        )

    return items


def main() -> int:
    query = env("QUERY")
    token = env("KINOPOISK_API_KEY")

    if not query:
        log("kinopoisk: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="пустой запрос",
        )
        return 0

    if not token:
        log("kinopoisk: no KINOPOISK_API_KEY, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_SKIPPED,
            reason="нет KINOPOISK_API_KEY в Настройках",
        )
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    log(f"kinopoisk: searching {query!r}")
    raw = _api_search(session, token, query)
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
    # Deduplicate by Kinopoisk ID.
    by_id: dict[str, dict] = {}
    for it in items:
        kp_id = str(it.get("kinopoisk_id", ""))
        if kp_id and kp_id not in by_id:
            by_id[kp_id] = it
    items = list(by_id.values())

    log(f"kinopoisk: {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    write_status(
        TRACKER_SLUG,
        label=TRACKER_LABEL,
        status=STATUS_OK if items else STATUS_NO_RESULTS,
        count=len(items),
    )

    # Also output the first Kinopoisk ID for other scripts to use.
    if items:
        kp_id = items[0].get("kinopoisk_id", "")
        if kp_id:
            out_path = os.environ.get("GITHUB_OUTPUT", "")
            if out_path:
                with open(out_path, "a", encoding="utf-8") as f:
                    f.write(f"kinopoisk_id={kp_id}\n")
            log(f"kinopoisk: first match KP-ID = {kp_id}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
