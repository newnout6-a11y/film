"""VideoCDN search. Requires VIDEOCDN_API_TOKEN.

VideoCDN (videocdn.tv) provides a structured REST API with endpoints
for movies, TV series episodes, and translations.  The API returns
direct stream URLs (.m3u8 / .mp4) with quality and translation metadata.

API docs: https://videocdn.tv/docs/api
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

TRACKER_LABEL = "VideoCDN"
TRACKER_SLUG = "videocdn"
BASE = "https://videocdn.tv/api"
TOP_N = 10

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"

# VideoCDN returns stream URLs in the ``iframe_src`` or ``file_url`` fields.
# The URL pattern is typically:
#   https://[subdomain].videocdn.tv/[hash]/movies/[id]/[quality]/playlist.m3u8
_M3U8_RE = re.compile(r"https?://[^\s\"']+\.m3u8[^\s\"']*")


def _api_search(
    session: requests.Session,
    token: str,
    query: str,
    *,
    kinopoisk_id: str = "",
) -> list[dict]:
    """Search VideoCDN API by title and optionally by Kinopoisk ID."""
    results: list[dict] = []
    headers = {"User-Agent": USER_AGENT}

    # Search by Kinopoisk ID for precision.
    if kinopoisk_id:
        try:
            r = session.get(
                f"{BASE}/movies",
                params={"api_token": token, "kinopoisk_id": kinopoisk_id},
                headers=headers,
                timeout=20,
            )
            r.raise_for_status()
            data = r.json()
            if isinstance(data, dict) and "data" in data:
                items = data["data"]
                if isinstance(items, list):
                    results.extend(items)
                    log(f"videocdn: KP-ID search returned {len(items)} result(s)")
                elif isinstance(items, dict):
                    results.append(items)
                    log("videocdn: KP-ID search returned 1 result")
        except Exception as e:  # noqa: BLE001
            log(f"videocdn: KP-ID search error: {e}")

    # Search by title.
    try:
        r = session.get(
            f"{BASE}/movies",
            params={"api_token": token, "query": query},
            headers=headers,
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and "data" in data:
            items = data["data"]
            if isinstance(items, list):
                results.extend(items)
                log(f"videocdn: title search returned {len(items)} result(s)")
            elif isinstance(items, dict):
                results.append(items)
                log("videocdn: title search returned 1 result")
    except Exception as e:  # noqa: BLE001
        log(f"videocdn: title search error: {e}")

    return results


def _extract_stream(iframe_src: str) -> str:
    """Best-effort extraction of .m3u8 URL from an iframe_src value.

    VideoCDN iframe_src is often already a direct .m3u8 URL or a
    player page that embeds one.
    """
    if not iframe_src:
        return ""
    # Already a direct stream URL.
    if ".m3u8" in iframe_src or ".mp4" in iframe_src:
        return iframe_src
    # The iframe_src might be a player embed URL — return it as-is;
    # the download workflow can use yt-dlp on it.
    return iframe_src


def _parse_results(raw: list[dict]) -> list[dict]:
    """Convert raw VideoCDN API results into our standard format."""
    items: list[dict] = []
    seen_ids: set[str] = set()

    for entry in raw:
        vc_id = str(entry.get("id") or entry.get("kinopoisk_id") or "")
        if vc_id in seen_ids:
            continue
        seen_ids.add(vc_id)

        title = entry.get("ru_title") or entry.get("en_title") or entry.get("title") or ""
        if not title:
            continue

        # VideoCDN provides iframe_src with the player URL.
        iframe_src = entry.get("iframe_src") or entry.get("file_url") or ""
        stream_url = _extract_stream(iframe_src)
        if not stream_url:
            continue

        # Quality detection from the stream URL or dedicated field.
        quality = (
            detect_quality(stream_url)
            or detect_quality(entry.get("quality", ""))
            or detect_quality(entry.get("media", {}).get("quality", "") if isinstance(entry.get("media"), dict) else "")
        )

        # Translation info.
        translation = ""
        translations = entry.get("translations") or []
        if isinstance(translations, list) and translations:
            if isinstance(translations[0], dict):
                translation = translations[0].get("title", "") or str(translations[0].get("id", ""))
            else:
                translation = str(translations[0])

        kinopoisk_id = entry.get("kinopoisk_id") or entry.get("kp_id") or ""

        # Season/episode for TV series.
        season = entry.get("season") or entry.get("season_num")
        episode = entry.get("episode") or entry.get("episode_num")

        # Convert season/episode to int if they're strings.
        if isinstance(season, str):
            try:
                season = int(season)
            except (ValueError, TypeError):
                season = None
        if isinstance(episode, str):
            try:
                episode = int(episode)
            except (ValueError, TypeError):
                episode = None

        items.append(
            make_stream_item(
                title=title,
                stream_url=stream_url,
                quality=quality,
                translation=translation,
                tracker=TRACKER_LABEL,
                url=iframe_src or f"https://videocdn.tv/movies/{vc_id}",
                kinopoisk_id=kinopoisk_id or None,
                season=season,
                episode=episode,
            )
        )

    return items


def main() -> int:
    query = env("QUERY")
    token = env("VIDEOCDN_API_TOKEN")
    kinopoisk_id = env("KINOPOISK_ID")

    if not query:
        log("videocdn: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="пустой запрос",
        )
        return 0

    if not token:
        log("videocdn: no VIDEOCDN_API_TOKEN, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_SKIPPED,
            reason="нет VIDEOCDN_API_TOKEN в Настройках",
        )
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    log(f"videocdn: searching {query!r}")
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

    items.sort(
        key=lambda x: (
            detect_quality(x.get("quality", "")),
            x.get("title", ""),
        ),
        reverse=True,
    )
    items = items[:TOP_N]

    log(f"videocdn: {len(items)} usable result(s)")
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
