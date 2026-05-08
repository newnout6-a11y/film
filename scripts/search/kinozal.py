"""Kinozal.tv search. Requires KINOZAL_USERNAME / KINOZAL_PASSWORD."""

from __future__ import annotations

import os
import re
import sys

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    cookies_from_env,
    env,
    log,
    parse_int,
    parse_size,
    to_magnet,
    torrent_info_hash,
    write_results,
)

TRACKER_LABEL = "Kinozal"
TRACKER_SLUG = "kinozal"
BASE = "https://kinozal.tv"
TOP_N = 8

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"


def login(session: requests.Session, username: str, password: str) -> bool:
    payload = {"username": username, "password": password, "returnto": ""}
    try:
        r = session.post(
            f"{BASE}/takelogin.php",
            data=payload,
            timeout=20,
            allow_redirects=True,
        )
    except Exception as e:  # noqa: BLE001
        log(f"kinozal: login error: {e}")
        return False
    cookies = session.cookies.get_dict()
    if "uid" in cookies and "pass" in cookies:
        log("kinozal: login OK")
        return True
    log("kinozal: login failed — check KINOZAL_USERNAME / KINOZAL_PASSWORD")
    return False


def is_logged_in(session: requests.Session) -> bool:
    """Kinozal browse.php returns the login form (HTTP 200, but the markup
    contains <form action="/takelogin.php">) when the session has expired,
    so a status-code check isn't enough. We probe a known-restricted page
    and look for the login form marker in the body."""
    try:
        r = session.get(f"{BASE}/browse.php", timeout=15)
    except Exception as e:  # noqa: BLE001
        log(f"kinozal: probe error: {e}")
        return False
    if r.status_code != 200:
        return False
    # `t_peer` is the search-results table; if we hit the login wall the
    # response replaces it with the takelogin form. Check both signals so
    # we don't false-positive on empty result pages.
    body = r.text
    if "takelogin.php" in body and "browse.php" not in body:
        return False
    return True


def parse_search(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    # Kinozal frequently flips between `table.t_peer`, `table.tabledark` and
    # plain table layouts depending on the skin / mobile vs desktop. Match
    # any row that contains a details-link — it's the only invariant.
    rows = (
        soup.select("table.t_peer tr")
        or soup.select("table.tabledark tr")
        or soup.select("table.bordered tr")
        or soup.select("table tr")
    )
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        title_a = row.select_one('a[href*="/details.php?id="]')
        if not title_a:
            continue
        href = title_a.get("href") or ""
        m = re.search(r"id=(\d+)", href)
        if not m:
            continue
        topic_id = m.group(1)
        if topic_id in seen:
            continue
        seen.add(topic_id)
        title = title_a.get_text(strip=True)
        if not title:
            continue
        cells = row.find_all("td")
        if len(cells) < 5:
            continue
        # Kinozal layout: ... | size | seeders | leechers | downloaded
        # The trailing four cells are stable across skins.
        size_text = cells[-4].get_text(" ", strip=True) if len(cells) >= 4 else ""
        seeders_text = cells[-3].get_text(strip=True) if len(cells) >= 3 else ""
        leechers_text = cells[-2].get_text(strip=True) if len(cells) >= 2 else ""
        out.append(
            {
                "title": title,
                "topic_id": topic_id,
                "size": parse_size(size_text),
                "seeders": parse_int(seeders_text),
                "leechers": parse_int(leechers_text),
            }
        )
    return out


_HASH_RE = re.compile(r"([0-9A-Fa-f]{40})")


def fetch_info_hash(session: requests.Session, topic_id: str) -> str | None:
    """Kinozal exposes the info_hash on /get_srv_details.php?id=X&action=2."""
    try:
        r = session.get(
            f"{BASE}/get_srv_details.php",
            params={"id": topic_id, "action": "2"},
            timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"kinozal: srv_details {topic_id} error: {e}")
        return None
    m = _HASH_RE.search(r.text)
    if m:
        return m.group(1).lower()
    # Fallback: download the .torrent.
    try:
        r = session.get(
            f"{BASE}/download.php",
            params={"id": topic_id},
            timeout=30,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"kinozal: download {topic_id} error: {e}")
        return None
    return torrent_info_hash(r.content)


def main() -> int:
    query = env("QUERY")
    user = env("KINOZAL_USERNAME")
    pwd = env("KINOZAL_PASSWORD")
    cookies = cookies_from_env("KINOZAL_COOKIES")
    if not query:
        log("kinozal: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0
    if not (user and pwd) and not cookies:
        log(
            "kinozal: no credentials, skipping (set KINOZAL_USERNAME / "
            "KINOZAL_PASSWORD or paste a Netscape KINOZAL_COOKIES blob)"
        )
        write_results(TRACKER_SLUG, [])
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    authed = False
    if cookies:
        for k, v in cookies.items():
            session.cookies.set(k, v, domain=".kinozal.tv")
        if is_logged_in(session):
            log(f"kinozal: authenticated via KINOZAL_COOKIES ({len(cookies)} cookies)")
            authed = True
        else:
            log("kinozal: cookies present but session probe failed; trying takelogin.php")
    if not authed and user and pwd:
        if login(session, user, pwd):
            authed = True
    if not authed:
        log("kinozal: not authenticated, skipping")
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"kinozal: searching {query!r}")
    try:
        r = session.get(f"{BASE}/browse.php", params={"s": query}, timeout=25)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"kinozal: search error: {e}")
        write_results(TRACKER_SLUG, [])
        return 0

    rows = parse_search(r.text)
    log(f"kinozal: parsed {len(rows)} row(s)")
    rows.sort(key=lambda x: x["seeders"], reverse=True)
    rows = rows[:TOP_N]

    items: list[dict] = []
    for row in rows:
        info_hash = fetch_info_hash(session, row["topic_id"])
        magnet = to_magnet(info_hash, row["title"]) if info_hash else None
        if not magnet:
            continue
        items.append(
            {
                "title": row["title"],
                "size": row["size"],
                "seeders": row["seeders"],
                "leechers": row["leechers"],
                "tracker": TRACKER_LABEL,
                "magnet": magnet,
                "url": f"{BASE}/details.php?id={row['topic_id']}",
                "info_hash": info_hash,
            }
        )

    log(f"kinozal: {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
