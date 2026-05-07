"""RuTracker search. Requires RUTRACKER_USERNAME / RUTRACKER_PASSWORD."""

from __future__ import annotations

import os
import re
import sys

import requests
from bs4 import BeautifulSoup

# Make ``common`` importable when invoked directly via ``python scripts/.../...py``.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    env,
    log,
    parse_int,
    parse_size,
    to_magnet,
    torrent_info_hash,
    write_results,
)

TRACKER_LABEL = "RuTracker"
TRACKER_SLUG = "rutracker"
BASE = "https://rutracker.org/forum"
TOP_N = 8  # how many top-by-seeders to enrich with info_hash

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"


def login(session: requests.Session, username: str, password: str) -> bool:
    """RuTracker uses cp1251 forms and a plain POST against login.php."""
    # The form encodes its values as windows-1251, including the submit-button
    # label "вход". The site cookie returns are independent of encoding.
    payload = {
        "login_username": username.encode("windows-1251", "ignore"),
        "login_password": password.encode("windows-1251", "ignore"),
        "login": "Вход".encode("windows-1251"),
    }
    try:
        r = session.post(
            f"{BASE}/login.php",
            data=payload,
            timeout=20,
            allow_redirects=True,
        )
    except Exception as e:  # noqa: BLE001
        log(f"rutracker: login error: {e}")
        return False
    # Successful login sets the bb_session cookie.
    cookies = session.cookies.get_dict()
    if any(k.startswith("bb_session") for k in cookies) or "bb_data" in cookies:
        log("rutracker: login OK")
        return True
    log(
        "rutracker: login failed — check RUTRACKER_USERNAME / RUTRACKER_PASSWORD"
    )
    return False


def parse_search(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    rows = soup.select("tr.hl-tr") or soup.select("tr.tCenter")
    out: list[dict] = []
    for row in rows:
        title_a = row.select_one("a.tLink") or row.select_one("a.tlink")
        if not title_a:
            continue
        href = title_a.get("href") or ""
        m = re.search(r"viewtopic\.php\?t=(\d+)", href)
        if not m:
            continue
        topic_id = m.group(1)
        title = title_a.get_text(strip=True)

        size_cell = row.select_one("td.tor-size, .tor-size")
        size_bytes = 0
        if size_cell:
            ts = size_cell.get("data-ts_text") or ""
            size_bytes = parse_int(ts) or parse_size(size_cell.get_text(" ", strip=True))

        seeders = 0
        seed_cell = row.select_one("b.seedmed, .seedmed, td.row4.nowrap b")
        if seed_cell:
            seeders = parse_int(seed_cell.get_text(strip=True))
        else:
            cell = row.select("td")
            if len(cell) >= 7:
                seeders = parse_int(cell[6].get_text(strip=True))

        leechers = 0
        leech_cell = row.select_one("td.leechmed, .leechmed")
        if leech_cell:
            leechers = parse_int(leech_cell.get_text(strip=True))

        out.append(
            {
                "title": title,
                "topic_id": topic_id,
                "size": size_bytes,
                "seeders": seeders,
                "leechers": leechers,
            }
        )
    return out


_INFO_HASH_RE = re.compile(
    r'<span\s+id="tor-hash"[^>]*>([0-9a-fA-F]{40})</span>'
)


def fetch_info_hash(session: requests.Session, topic_id: str) -> str | None:
    """Pull info_hash either from the topic page or from the .torrent file."""
    try:
        r = session.get(
            f"{BASE}/viewtopic.php?t={topic_id}",
            timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"rutracker: viewtopic {topic_id} error: {e}")
        return None
    html = r.text
    m = _INFO_HASH_RE.search(html)
    if m:
        return m.group(1).lower()
    # Fallback: download the .torrent file and compute the hash ourselves.
    try:
        r = session.get(
            f"{BASE}/dl.php?t={topic_id}",
            timeout=30,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"rutracker: dl.php {topic_id} error: {e}")
        return None
    return torrent_info_hash(r.content)


def main() -> int:
    query = env("QUERY")
    user = env("RUTRACKER_USERNAME")
    pwd = env("RUTRACKER_PASSWORD")
    if not query:
        log("rutracker: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0
    if not user or not pwd:
        log("rutracker: no credentials, skipping (set RUTRACKER_USERNAME / RUTRACKER_PASSWORD in repo secrets)")
        write_results(TRACKER_SLUG, [])
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    if not login(session, user, pwd):
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"rutracker: searching {query!r}")
    try:
        r = session.get(
            f"{BASE}/tracker.php",
            params={"nm": query},
            timeout=25,
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"rutracker: search error: {e}")
        write_results(TRACKER_SLUG, [])
        return 0

    rows = parse_search(r.text)
    log(f"rutracker: parsed {len(rows)} row(s)")

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
                "url": f"{BASE}/viewtopic.php?t={row['topic_id']}",
                "info_hash": info_hash,
            }
        )

    log(f"rutracker: {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
