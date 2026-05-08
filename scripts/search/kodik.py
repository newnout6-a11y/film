"""Kodik search. Requires KODIK_API_TOKEN.

Kodik hosts one of the largest databases of anime, series, and movies.
The public API (https://kodikapi.com) returns structured JSON with
player embed URLs and quality/resolution metadata.  The ``link`` field
in each result points to an embed player (e.g.
``https://kodik.info/video/12345/720p``) from which a direct .m3u8
stream URL can be extracted.

This script searches by title and returns the best-quality stream for
each unique result.  If ``KINOPOISK_ID`` is set in the environment, an
additional lookup by Kinopoisk ID is performed for more precise matching.
"""

from __future__ import annotations

import os
import re
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

TRACKER_LABEL = "Kodik"
TRACKER_SLUG = "kodik"
BASE = "https://kodikapi.com"
TOP_N = 10

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"

# Regex to extract the direct stream URL from a Kodik player page.
# The player embeds a ``src`` attribute in a ``<iframe>`` or a
# ``file_url`` JS variable pointing to the .m3u8 manifest.
_STREAM_RE = re.compile(r'"file_url"\s*:\s*"([^"]+\.m3u8[^"]*)"')
_IFRAME_SRC_RE = re.compile(r'<iframe[^>]+src="([^"]+)"')


def _api_search(
    session: requests.Session,
    token: str,
    query: str,
    *,
    kinopoisk_id: str = "",
) -> list[dict]:
    """Search Kodik API by title and optionally by Kinopoisk ID."""
    results: list[dict] = []
    params: dict[str, str] = {"token": token}

    # Search by Kinopoisk ID first (more precise).
    if kinopoisk_id:
        params_kp = {**params, "kinopoisk_id": kinopoisk_id}
        try:
            r = session.get(f"{BASE}/search", params=params_kp, timeout=20)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and "results" in data:
                results.extend(data["results"])
                log(f"kodik: KP-ID search returned {len(data['results'])} result(s)")
        except Exception as e:  # noqa: BLE001
            log(f"kodik: KP-ID search error: {e}")

    # Search by title.
    params_title = {**params, "title": query}
    try:
        r = session.get(f"{BASE}/search", params=params_title, timeout=20)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and "results" in data:
            results.extend(data["results"])
            log(f"kodik: title search returned {len(data['results'])} result(s)")
    except Exception as e:  # noqa: BLE001
        log(f"kodik: title search error: {e}")

    return results


def _extract_stream_url(
    session: requests.Session, player_url: str
) -> str | None:
    """Attempt to extract the .m3u8 stream URL from a Kodik player page."""
    try:
        r = session.get(
            player_url,
            timeout=20,
            headers={
                "User-Agent": USER_AGENT,
                "Referer": "https://kodik.info/",
            },
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"kodik: player page error: {e}")
        return None

    # Try JS variable first.
    m = _STREAM_RE.search(r.text)
    if m:
        return m.group(1).replace("\\/", "/")

    # Fallback: look for an iframe src that might be the player itself.
    m = _IFRAME_SRC_RE.search(r.text)
    if m:
        iframe_url = m.group(1)
        if ".m3u8" in iframe_url:
            return iframe_url

    return None


def _parse_results(
    session: requests.Session, raw: list[dict]
) -> list[dict]:
    """Convert raw Kodik API results into our standard format."""
    items: list[dict] = []
    seen_ids: set[str] = set()

    for entry in raw:
        kodik_id = entry.get("id", "")
        if kodik_id in seen_ids:
            continue
        seen_ids.add(kodik_id)

        title = entry.get("title") or entry.get("title_orig") or ""
        if not title:
            continue

        link = entry.get("link") or ""
        if not link:
            continue

        # The link path often contains quality hints like /720p.
        quality = detect_quality(link) or detect_quality(
            entry.get("quality", "")
        )

        # Try to extract the direct .m3u8 URL from the player page.
        # If that fails, use the player embed URL as stream_url —
        # the download workflow can try yt-dlp on it.
        player_url = link
        if not player_url.startswith("http"):
            player_url = f"https:{link}" if link.startswith("//") else f"https://kodik.info{link}"

        stream_url = _extract_stream_url(session, player_url)
        if not stream_url:
            # Use the player URL — yt-dlp may be able to handle it.
            stream_url = player_url

        translation = ""
        translations = entry.get("translations") or []
        if isinstance(translations, list) and translations:
            translation = translations[0].get("title", "") if isinstance(translations[0], dict) else str(translations[0])
        elif isinstance(translations, dict):
            translation = translations.get("title", "")

        kinopoisk_id = entry.get("kinopoisk_id") or ""

        items.append(
            make_stream_item(
                title=title,
                stream_url=stream_url,
                quality=quality,
                translation=translation,
                tracker=TRACKER_LABEL,
                url=player_url,
                kinopoisk_id=kinopoisk_id or None,
            )
        )

    return items


def main() -> int:
    query = env("QUERY")
    token = env("KODIK_API_TOKEN")
    kinopoisk_id = env("KINOPOISK_ID")

    if not query:
        log("kodik: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="пустой запрос",
        )
        return 0

    if not token:
        log("kodik: no KODIK_API_TOKEN, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_SKIPPED,
            reason="нет KODIK_API_TOKEN в Настройках",
        )
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    log(f"kodik: searching {query!r}")
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

    items = _parse_results(session, raw)
    # Deduplicate by stream_url, keep highest quality.
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

    # Sort by quality descending, then title.
    items.sort(
        key=lambda x: (
            detect_quality(x.get("quality", "")),
            x.get("title", ""),
        ),
        reverse=True,
    )
    items = items[:TOP_N]

    log(f"kodik: {len(items)} usable result(s)")
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
