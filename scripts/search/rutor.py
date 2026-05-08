"""rutor.info search.

No login required. Rutor is one of the few public Russian-friendly trackers
that consistently responds 200 to GitHub Actions IPs (apibay.org / 1337x.to
have been hard-blocking the runners with Cloudflare 403). Each search-
results row already carries a `magnet:?xt=urn:btih:...` link plus seeders /
leechers / size, so we don't need to fetch any per-topic page to extract
the info_hash — that keeps this scraper fast (one HTTP round-trip total).

Page structure (as of 2025-late):

    <table id="news_table">          # tracker news / banner
    <table>                          # search-form spacer
    <table>                          # results <-- this one
        <tr>            -- header row
        <tr>            -- result 1
            <td>date</td>
            <td>            -- title cell
                <a href="magnet:?...">...</a>
                <a href="/torrent/{id}/...">{title}</a>
            </td>
            <td>{comments_count}</td>   -- optional, sometimes missing
            <td>{size}</td>
            <td>{seeders}&nbsp;{leechers}</td>
        </tr>
        ...
    <table>                          # footer

Rutor sometimes drops the comments column for fresh torrents — those rows
have 4 cells instead of 5. We index from the right (size, seeders/leechers
are always in the last two cells) so the layout shift doesn't break us.
"""

from __future__ import annotations

import os
import re
import sys

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    env,
    log,
    parse_int,
    parse_size,
    to_magnet,
    write_results,
)

TRACKER_LABEL = "Rutor"
TRACKER_SLUG = "rutor"

# Primary domain plus officially-announced mirrors. We try them in order
# until one returns a 200 with the results table. Both .info and .is were
# reachable from GitHub Actions runners during testing.
BASE_HOSTS: tuple[str, ...] = (
    "https://rutor.info",
    "https://rutor.is",
    "http://rutor.info",
)

# Mozilla-flavoured headers — rutor's reverse-proxy occasionally serves a
# stripped-down page (or a captcha) to non-browser User-Agents.
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

# /search/<page>/<category>/<options>/<sort>/<query>
# - page=0     -> first page
# - category=0 -> all
# - options=0  -> default flags
# - sort=2     -> by seeders descending
SEARCH_PATH_TEMPLATE = "/search/0/0/000/2/{query}"

TOP_N = 10
_INFO_HASH_RE = re.compile(r"btih:([0-9A-Fa-f]{40})")


def fetch_html(query: str) -> str | None:
    """Try each known rutor mirror until one returns the search page."""
    last = ""
    import urllib.parse

    encoded = urllib.parse.quote(query, safe="")
    for base in BASE_HOSTS:
        url = f"{base}{SEARCH_PATH_TEMPLATE.format(query=encoded)}"
        try:
            r = requests.get(url, timeout=20, headers=BROWSER_HEADERS)
        except Exception as e:  # noqa: BLE001
            last = f"{base}: {e}"
            log(f"rutor: mirror failed {last}")
            continue
        if r.status_code != 200:
            last = f"{base}: HTTP {r.status_code}"
            log(f"rutor: mirror failed {last}")
            continue
        # rutor pages are explicitly utf-8 (despite a legacy cp1251 fallback
        # in some places) — let requests' charset-detect handle it.
        text = r.text
        if not text or len(text) < 200:
            last = f"{base}: short body ({len(text)})"
            log(f"rutor: {last}")
            continue
        log(f"rutor: fetched {len(text)} bytes from {base}")
        return text
    log(f"rutor: all mirrors failed (last: {last})")
    return None


def parse_search(html: str) -> list[dict]:
    """Extract result rows from the third <table> (results table).

    Falls back to scanning *every* table for rows that contain a
    `magnet:?xt=urn:btih:...` link, so we still return data when rutor
    rearranges the page layout (it has, historically, every couple of years).
    """
    soup = BeautifulSoup(html, "lxml")
    candidate_rows: list = []
    # Preferred: the third table on the page is the results table.
    tables = soup.find_all("table")
    for t in tables:
        rows = t.find_all("tr")
        if len(rows) < 5:
            continue
        if t.select_one('a[href^="magnet:"]'):
            candidate_rows = rows
            break
    if not candidate_rows:
        # Fall back to the entire document — happens on the empty-result
        # page where rutor renders a single "ничего не найдено" cell.
        candidate_rows = soup.find_all("tr")

    out: list[dict] = []
    seen: set[str] = set()
    for row in candidate_rows:
        magnet_a = row.select_one('a[href^="magnet:"]')
        if not magnet_a:
            continue
        magnet_href = magnet_a.get("href") or ""
        m_hash = _INFO_HASH_RE.search(magnet_href)
        if not m_hash:
            continue
        info_hash = m_hash.group(1).lower()
        if info_hash in seen:
            continue
        seen.add(info_hash)

        title_a = row.select_one('a[href^="/torrent/"]')
        title = title_a.get_text(" ", strip=True) if title_a else ""
        if not title:
            continue
        topic_id = ""
        href = (title_a.get("href") if title_a else "") or ""
        m_id = re.search(r"/torrent/(\d+)", href)
        if m_id:
            topic_id = m_id.group(1)

        cells = row.find_all("td")
        if not cells:
            continue
        # Last cell holds "<seeders>&nbsp;<leechers>" (sometimes split into
        # two <span>s). Second-to-last cell holds size like "1.46 GB".
        seeders = leechers = 0
        last_text = cells[-1].get_text(" ", strip=True).replace("\xa0", " ")
        nums = re.findall(r"\d+", last_text)
        if len(nums) >= 2:
            seeders, leechers = int(nums[0]), int(nums[1])
        elif len(nums) == 1:
            seeders = int(nums[0])
        size_text = cells[-2].get_text(" ", strip=True) if len(cells) >= 2 else ""

        # Build the canonical magnet (drop tracker list rutor stuffs in,
        # re-add ours from PUBLIC_TRACKERS so all magnets in results.json
        # bootstrap from the same public swarm).
        magnet = to_magnet(info_hash, title)
        if not magnet:
            continue

        url = f"https://rutor.info/torrent/{topic_id}" if topic_id else "https://rutor.info/"
        out.append(
            {
                "title": title,
                "size": parse_size(size_text),
                "seeders": seeders,
                "leechers": leechers,
                "tracker": TRACKER_LABEL,
                "magnet": magnet,
                "url": url,
                "info_hash": info_hash,
            }
        )
    return out


def main() -> int:
    query = env("QUERY")
    if not query:
        log("rutor: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"rutor: searching {query!r}")
    html = fetch_html(query)
    if html is None:
        write_results(TRACKER_SLUG, [])
        return 0

    rows = parse_search(html)
    rows.sort(key=lambda x: x["seeders"], reverse=True)
    rows = rows[:TOP_N]
    log(f"rutor: parsed {len(rows)} usable result(s)")
    write_results(TRACKER_SLUG, rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
