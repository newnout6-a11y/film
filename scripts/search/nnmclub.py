"""NNM-Club search. Requires NNM_USERNAME / NNM_PASSWORD."""

from __future__ import annotations

import os
import re
import sys
import urllib.parse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (  # noqa: E402
    PUBLIC_TRACKERS,
    cookies_from_env,
    env,
    log,
    parse_int,
    parse_size,
    to_magnet,
    torrent_info_hash,
    write_results,
)

TRACKER_LABEL = "NNM-Club"
TRACKER_SLUG = "nnm"
BASE = "https://nnmclub.to/forum"
TOP_N = 8

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) film-beamer/1.0"


def login(session: requests.Session, username: str, password: str) -> bool:
    payload = {
        "username": username,
        "password": password,
        "redirect": "",
        "login": "Вход",
    }
    try:
        r = session.post(
            f"{BASE}/login.php",
            data=payload,
            timeout=20,
            allow_redirects=True,
        )
    except Exception as e:  # noqa: BLE001
        log(f"nnm: login error: {e}")
        return False
    cookies = session.cookies.get_dict()
    if "phpbb2mysql_data" in cookies or "phpbb2mysql_sid" in cookies:
        log("nnm: login OK")
        return True
    body = r.text or ""
    lowered = body.lower()
    hint = ""
    if "captcha" in lowered or "капча" in lowered:
        hint = " (CAPTCHA — paste NNM_COOKIES instead)"
    elif "неверн" in lowered or "wrong" in lowered or "incorrect" in lowered:
        hint = " (server says credentials are wrong)"
    log(
        f"nnm: login failed — HTTP {r.status_code}, body {len(body)}B"
        f"{hint}; check NNM_USERNAME / NNM_PASSWORD or use NNM_COOKIES"
    )
    return False


def is_logged_in(session: requests.Session) -> bool:
    try:
        r = session.get(f"{BASE}/index.php", timeout=15)
    except Exception as e:  # noqa: BLE001
        log(f"nnm: probe error: {e}")
        return False
    if r.status_code != 200:
        return False
    body = r.text
    # phpBB returns the login form on the index page when not authenticated.
    if "login.php" in body and "logout.php" not in body:
        return False
    return True


def parse_search(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    # NNM-Club uses phpBB themes — the row container changes between
    # `table.forumline`, `table.tablesorter` and a plain `table`. The only
    # reliable invariant is the viewtopic anchor, so widen the row sweep
    # accordingly.
    rows = (
        soup.select("table.forumline tr")
        or soup.select("table.tablesorter tr")
        or soup.select("table.forum tr")
        or soup.select("table tr")
        or soup.select("tr")
    )
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        title_a = row.select_one('a[href*="viewtopic.php?t="]')
        if not title_a:
            continue
        href = title_a.get("href") or ""
        m = re.search(r"viewtopic\.php\?t=(\d+)", href)
        if not m:
            continue
        topic_id = m.group(1)
        if topic_id in seen:
            continue
        seen.add(topic_id)
        title = title_a.get_text(strip=True)
        if not title:
            continue

        # NNM frequently embeds the magnet right in the search results.
        magnet_a = row.select_one('a[href^="magnet:"]')
        info_hash = ""
        if magnet_a:
            href_m = magnet_a.get("href") or ""
            mh = re.search(r"btih:([0-9A-Fa-f]{40})", href_m)
            if mh:
                info_hash = mh.group(1).lower()

        size_text = ""
        seeders = leechers = 0
        cells = row.find_all("td")
        for c in cells:
            txt = c.get_text(" ", strip=True)
            if not txt:
                continue
            if re.search(r"\b(MB|GB|TB|KB|МБ|ГБ|ТБ|КБ)\b", txt, re.IGNORECASE):
                size_text = txt
        if cells:
            # Last few cells: dl-count, seeders, leechers, ...
            seeders = parse_int(cells[-3].get_text(strip=True)) if len(cells) >= 3 else 0
            leechers = parse_int(cells[-2].get_text(strip=True)) if len(cells) >= 2 else 0

        out.append(
            {
                "title": title,
                "topic_id": topic_id,
                "size": parse_size(size_text),
                "seeders": seeders,
                "leechers": leechers,
                "info_hash": info_hash,
            }
        )
    return out


_INFO_HASH_RE = re.compile(r"btih:([0-9A-Fa-f]{40})")


def fetch_info_hash(session: requests.Session, topic_id: str) -> str | None:
    try:
        r = session.get(
            f"{BASE}/viewtopic.php?t={topic_id}",
            timeout=20,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"nnm: viewtopic {topic_id} error: {e}")
        return None
    m = _INFO_HASH_RE.search(r.text)
    if m:
        return m.group(1).lower()
    # Last-ditch: download .torrent and hash it.
    try:
        r = session.get(
            f"{BASE}/download.php",
            params={"id": topic_id},
            timeout=30,
            headers={"User-Agent": USER_AGENT},
        )
        r.raise_for_status()
    except Exception:
        return None
    return torrent_info_hash(r.content)


def main() -> int:
    query = env("QUERY")
    user = env("NNM_USERNAME")
    pwd = env("NNM_PASSWORD")
    cookies = cookies_from_env("NNM_COOKIES")
    if not query:
        log("nnm: empty query, skipping")
        write_results(TRACKER_SLUG, [])
        return 0
    if not (user and pwd) and not cookies:
        log(
            "nnm: no credentials, skipping (set NNM_USERNAME / NNM_PASSWORD "
            "or paste a Netscape NNM_COOKIES blob)"
        )
        write_results(TRACKER_SLUG, [])
        return 0

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    authed = False
    if cookies:
        for k, v in cookies.items():
            session.cookies.set(k, v, domain=".nnmclub.to")
        if is_logged_in(session):
            log(f"nnm: authenticated via NNM_COOKIES ({len(cookies)} cookies)")
            authed = True
        else:
            log("nnm: cookies present but session probe failed; trying login.php")
    if not authed and user and pwd:
        if login(session, user, pwd):
            authed = True
    if not authed:
        log("nnm: not authenticated, skipping")
        write_results(TRACKER_SLUG, [])
        return 0

    log(f"nnm: searching {query!r}")
    try:
        r = session.get(f"{BASE}/tracker.php", params={"nm": query}, timeout=25)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        log(f"nnm: search error: {e}")
        write_results(TRACKER_SLUG, [])
        return 0

    rows = parse_search(r.text)
    log(f"nnm: parsed {len(rows)} row(s)")
    rows.sort(key=lambda x: x["seeders"], reverse=True)
    rows = rows[:TOP_N]

    items: list[dict] = []
    for row in rows:
        info_hash = row["info_hash"] or fetch_info_hash(session, row["topic_id"])
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

    log(f"nnm: {len(items)} usable result(s)")
    write_results(TRACKER_SLUG, items)
    return 0


if __name__ == "__main__":
    sys.exit(main())
