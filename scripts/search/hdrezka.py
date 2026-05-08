"""HDRezka search. Requires HDREZKA_COOKIES (Netscape cookies.txt).

HDRezka (hdrezka.ag / rezka.ag) is a major Russian-language movie and
series database.  Access requires bypassing Cloudflare protection —
the most reliable method is injecting browser cookies exported from
Firefox (Chrome's app-bound encryption makes cookie extraction harder
in CI/CD environments).

The scraper searches by title, then for each result attempts to
extract the stream URL via the internal ``get_stream`` API endpoint,
which returns direct .m3u8 URLs when provided with a valid translator
ID and season/episode parameters.

References:
  - HdRezkaApi (Python): https://github.com/SuperZombi/HdRezkaApi
  - go-hdrezka (Go):      https://github.com/n0madic/go-hdrezka
"""

from __future__ import annotations

import os
import re
import sys

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from media_common import (  # noqa: E402
    STATUS_BLOCKED,
    STATUS_FAILED,
    STATUS_NO_RESULTS,
    STATUS_OK,
    STATUS_SKIPPED,
    cookies_from_env,
    detect_quality,
    env,
    log,
    make_stream_item,
    write_results,
    write_status,
)

TRACKER_LABEL = "HDRezka"
TRACKER_SLUG = "hdrezka"
TOP_N = 10

# HDRezka frequently changes domains; try known mirrors in order.
BASE_HOSTS: tuple[str, ...] = (
    "https://hdrezka.ag",
    "https://rezka.ag",
    "https://hdrezka.me",
    "https://hdrezka.tv",
)

BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/121.0.0.0 Safari/537.36"
    ),
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;q=0.9,"
        "image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
}

# Internal API endpoint for stream URL extraction.
_STREAM_API_PATH = "/ajax/get_cdn_stream/"

# Regex patterns for parsing.
_M3U8_RE = re.compile(r'"file"\s*:\s*"([^"]+\.m3u8[^"]*)"')
_TRANSLATOR_RE = re.compile(
    r'data-translator_id="(\d+)"[^>]*>\s*([^<]+)\s*<'
)
_EPISODE_RE = re.compile(r'data-episode_id="(\d+)"')
_SEASON_RE = re.compile(r'data-season_id="(\d+)"')


def _find_base(session: requests.Session) -> str | None:
    """Try each mirror until one returns a 200 with real content."""
    for base in BASE_HOSTS:
        try:
            r = session.get(base, timeout=15, headers=BROWSER_HEADERS)
        except Exception as e:  # noqa: BLE001
            log(f"hdrezka: mirror {base} unreachable: {e}")
            continue
        if r.status_code == 403:
            log(f"hdrezka: mirror {base} returned 403 (Cloudflare)")
            continue
        if r.status_code == 200 and len(r.text) > 500:
            log(f"hdrezka: using mirror {base}")
            return base
        log(f"hdrezka: mirror {base} returned HTTP {r.status_code}")
    return None


def _search(
    session: requests.Session, base: str, query: str
) -> list[dict]:
    """Search HDRezka and parse the results page."""
    url = f"{base}/search/"
    try:
        r = session.get(
            url,
            params={"do": "search", "subaction": "search", "q": query},
            timeout=20,
            headers=BROWSER_HEADERS,
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"hdrezka: search error: {e}")
        return []

    soup = BeautifulSoup(r.text, "lxml")
    items: list[dict] = []

    # HDRezka search results are in <div class="b-content__inline_item"
    # data-url="..."> blocks.
    for div in soup.select("div.b-content__inline_item"):
        data_url = div.get("data-url") or ""
        link_tag = div.select_one("a.b-content__inline_item-link")
        if not link_tag:
            continue
        title = link_tag.get_text(strip=True)
        href = link_tag.get("href") or data_url
        if not title or not href:
            continue

        # Extract translator IDs from the result item.
        translators: list[tuple[str, str]] = []
        for m in _TRANSLATOR_RE.finditer(str(div)):
            translators.append((m.group(1), m.group(2).strip()))

        # Detect if it's a movie or a series.
        is_series = bool(div.select_one("div.b-content__inline_item-link span"))

        items.append({
            "title": title,
            "url": href,
            "translators": translators,
            "is_series": is_series,
        })

    # Fallback: try alternate selectors for different page layouts.
    if not items:
        for a_tag in soup.select("a[href*='/films/'], a[href*='/series/']"):
            title = a_tag.get_text(strip=True)
            href = a_tag.get("href", "")
            if title and href:
                items.append({
                    "title": title,
                    "url": href,
                    "translators": [],
                    "is_series": "/series/" in href,
                })

    return items


def _get_stream_url(
    session: requests.Session,
    base: str,
    page_url: str,
    translator_id: str = "",
) -> str | None:
    """Request the internal stream API to get the .m3u8 URL."""
    # First, fetch the page to get translator_id if we don't have one.
    if not translator_id:
        try:
            r = session.get(page_url, timeout=20, headers=BROWSER_HEADERS)
            r.raise_for_status()
            matches = _TRANSLATOR_RE.findall(r.text)
            if matches:
                translator_id = matches[0][0]
        except Exception as e:  # noqa: BLE001
            log(f"hdrezka: page fetch for translator_id failed: {e}")
            return None

    if not translator_id:
        log("hdrezka: no translator_id found, cannot get stream")
        return None

    # Call the internal stream API.
    try:
        r = session.post(
            f"{base}{_STREAM_API_PATH}",
            data={
                "id": page_url.rstrip("/").split("/")[-1],
                "translator_id": translator_id,
                "action": "get_stream",
            },
            timeout=20,
            headers={
                **BROWSER_HEADERS,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": page_url,
            },
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"hdrezka: stream API error: {e}")
        return None

    # Parse the response for the .m3u8 URL.
    m = _M3U8_RE.search(r.text)
    if m:
        return m.group(1).replace("\\/", "/")

    # The response might be JSON with a ``url`` field.
    try:
        data = r.json()
        url = data.get("url") or data.get("file") or ""
        if url and (".m3u8" in url or ".mp4" in url):
            return url
    except Exception:  # noqa: BLE001
        pass

    return None


def main() -> int:
    query = env("QUERY")
    cookies = cookies_from_env("HDREZKA_COOKIES")

    if not query:
        log("hdrezka: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="пустой запрос",
        )
        return 0

    session = requests.Session()
    session.headers.update(BROWSER_HEADERS)

    # Apply cookies if available.
    if cookies:
        for k, v in cookies.items():
            session.cookies.set(k, v, domain=".hdrezka.ag")
            session.cookies.set(k, v, domain=".rezka.ag")
        log(f"hdrezka: using HDREZKA_COOKIES ({len(cookies)} cookies)")

    # Find a working mirror.
    base = _find_base(session)
    if not base:
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_BLOCKED,
            reason="ни одно зеркало HDRezka не отвечает (Cloudflare?)",
        )
        return 0

    log(f"hdrezka: searching {query!r}")
    raw = _search(session, base, query)
    if not raw:
        write_results(TRACKER_SLUG, [])
        write_status(
            TRACKER_SLUG,
            label=TRACKER_LABEL,
            status=STATUS_NO_RESULTS,
            reason="ничего не найдено",
        )
        return 0

    # For each result, try to extract the stream URL.
    items: list[dict] = []
    for entry in raw[:TOP_N]:
        page_url = entry["url"]
        if not page_url.startswith("http"):
            page_url = f"{base}{page_url}"

        translator_id = ""
        translation = ""
        if entry.get("translators"):
            translator_id, translation = entry["translators"][0]

        stream_url = _get_stream_url(
            session, base, page_url, translator_id=translator_id
        )
        if not stream_url:
            # Use the page URL — yt-dlp may handle it.
            stream_url = page_url

        quality = detect_quality(stream_url) or detect_quality(entry.get("title", ""))

        items.append(
            make_stream_item(
                title=entry["title"],
                stream_url=stream_url,
                quality=quality,
                translation=translation,
                tracker=TRACKER_LABEL,
                url=page_url,
            )
        )

    log(f"hdrezka: {len(items)} usable result(s)")
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
