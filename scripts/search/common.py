"""Shared helpers for tracker search scripts.

Each tracker module reads QUERY from env, optionally reads its credentials,
fetches and parses results, and writes ``results/<tracker>.json``. The
``aggregate`` step then merges them into a single ``results.json`` artifact.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import urllib.parse
from typing import Any

# Public BitTorrent trackers we attach to every magnet link so that DHT-only
# results bootstrap quickly on the runner.
PUBLIC_TRACKERS: tuple[str, ...] = (
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.demonii.com:1337/announce",
    "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce",
    "udp://tracker.torrent.eu.org:451/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
)

RESULTS_DIR = "results"


def log(msg: str) -> None:
    """Print to stderr — keeps stdout clean for any potential JSON output."""
    print(msg, file=sys.stderr, flush=True)


def write_results(tracker_slug: str, items: list[dict[str, Any]]) -> None:
    os.makedirs(RESULTS_DIR, exist_ok=True)
    path = os.path.join(RESULTS_DIR, f"{tracker_slug}.json")
    # Atomic write: aggregate.py reads every <slug>.json in this directory.
    # If a tracker crashed mid-dump previously, aggregate could pick up a
    # truncated file and json.load would raise, dropping the whole tracker.
    # Write to a sibling .tmp first and rename — POSIX rename is atomic on
    # the same filesystem.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    log(f"{tracker_slug}: wrote {len(items)} item(s) to {path}")


def to_magnet(info_hash: str, title: str | None = None) -> str | None:
    """Build a magnet URI from a 40-char hex info_hash."""
    if not info_hash:
        return None
    h = info_hash.strip().lower()
    if len(h) != 40 or not all(c in "0123456789abcdef" for c in h):
        return None
    parts = [f"xt=urn:btih:{h}"]
    if title:
        parts.append("dn=" + urllib.parse.quote_plus(title))
    for tr in PUBLIC_TRACKERS:
        parts.append("tr=" + urllib.parse.quote_plus(tr))
    return "magnet:?" + "&".join(parts)


# ---------- bencode (minimal, just enough to read .torrent files) ----------


def _bdecode(data: bytes, idx: int = 0):
    c = data[idx]
    if c == ord("i"):
        end = data.index(b"e", idx)
        return int(data[idx + 1 : end]), end + 1
    if ord("0") <= c <= ord("9"):
        colon = data.index(b":", idx)
        length = int(data[idx:colon])
        return data[colon + 1 : colon + 1 + length], colon + 1 + length
    if c == ord("l"):
        idx += 1
        out: list = []
        while data[idx] != ord("e"):
            v, idx = _bdecode(data, idx)
            out.append(v)
        return out, idx + 1
    if c == ord("d"):
        idx += 1
        out_d: dict = {}
        while data[idx] != ord("e"):
            k, idx = _bdecode(data, idx)
            v, idx = _bdecode(data, idx)
            out_d[k] = v
        return out_d, idx + 1
    raise ValueError(f"bencode: unexpected byte {c!r} at {idx}")


def _bencode(v) -> bytes:
    if isinstance(v, int):
        return f"i{v}e".encode()
    if isinstance(v, bytes):
        return f"{len(v)}:".encode() + v
    if isinstance(v, list):
        return b"l" + b"".join(_bencode(x) for x in v) + b"e"
    if isinstance(v, dict):
        items = sorted(v.items(), key=lambda kv: kv[0])
        return b"d" + b"".join(_bencode(k) + _bencode(val) for k, val in items) + b"e"
    raise TypeError(f"bencode: cannot encode {type(v).__name__}")


def torrent_info_hash(torrent_bytes: bytes) -> str | None:
    """SHA-1 of the bencoded info dict from a .torrent file."""
    try:
        obj, _ = _bdecode(torrent_bytes)
        if not isinstance(obj, dict) or b"info" not in obj:
            return None
        return hashlib.sha1(_bencode(obj[b"info"])).hexdigest()
    except Exception as e:  # noqa: BLE001
        log(f"torrent_info_hash: parse failed ({e})")
        return None


# ---------- size parsing ----------

_SIZE_UNITS = {
    "b": 1,
    "kb": 1024,
    "mb": 1024**2,
    "gb": 1024**3,
    "tb": 1024**4,
    "к": 1024,
    "м": 1024**2,
    "г": 1024**3,
    "т": 1024**4,
    "кб": 1024,
    "мб": 1024**2,
    "гб": 1024**3,
    "тб": 1024**4,
}


def parse_size(text: str) -> int:
    """Parse strings like '1.5 GB', '700 MB', '1,2 ГБ' into bytes."""
    if not text:
        return 0
    s = text.strip().lower().replace("\xa0", " ").replace(",", ".")
    s = s.replace("\u00a0", " ")
    # Pull out the numeric prefix and the unit suffix.
    num = []
    i = 0
    while i < len(s) and (s[i].isdigit() or s[i] == "."):
        num.append(s[i])
        i += 1
    try:
        value = float("".join(num)) if num else 0.0
    except ValueError:
        value = 0.0
    unit = s[i:].strip()
    mult = _SIZE_UNITS.get(unit) or _SIZE_UNITS.get(unit.split()[0] if unit else "", 1)
    return int(value * mult)


def parse_int(text: str) -> int:
    if not text:
        return 0
    digits = "".join(c for c in text if c.isdigit())
    return int(digits) if digits else 0


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


# ---------- Netscape cookie jar parser ----------
#
# All three authenticated trackers (RuTracker, Kinozal, NNM-Club) accept the
# *same* set of session cookies that you'd export from a logged-in browser
# session via "cookies.txt" extensions. This is invaluable when:
#  * the user has 2FA / Captcha enabled and login.php POST stops working;
#  * the password contains characters that mangle through windows-1251;
#  * GitHub Actions IP gets challenged but the browser session still works.
#
# We accept either the standard Netscape "cookies.txt" format (what
# yt-dlp / curl / wget use) or a `name=value; name2=value2` cookie header
# string. Empty / comment-only / malformed input returns an empty dict so
# callers can short-circuit safely.

def parse_netscape_cookies(text: str) -> dict[str, str]:
    """Parse Netscape cookies.txt content (or a `name=value;` header).

    Returns a dict of name->value. Domain/path/expiry are dropped — the
    caller pins the cookies to the tracker domain themselves. Skips
    HttpOnly-prefixed comments and blank lines.
    """
    if not text:
        return {}
    out: dict[str, str] = {}
    raw = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    # Cookie header form: a; b=2; c=3
    if "\t" not in raw and "=" in raw and ";" in raw and "\n" not in raw:
        for chunk in raw.split(";"):
            chunk = chunk.strip()
            if not chunk or "=" not in chunk:
                continue
            k, _, v = chunk.partition("=")
            k = k.strip()
            if k:
                out[k] = v.strip()
        return out
    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        # cookies.txt comments — `# Netscape HTTP Cookie File` etc. The
        # `#HttpOnly_` prefix is a non-standard extension chrome/curl
        # emit; strip it so the cookie still applies.
        if line.startswith("#HttpOnly_"):
            line = line[len("#HttpOnly_") :]
        elif line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            # `name\tvalue` two-column shorthand — treat as cookie pair.
            if len(parts) == 2 and parts[0]:
                out[parts[0].strip()] = parts[1].strip()
            continue
        # Standard Netscape: domain  flag  path  secure  expiry  name  value
        name = parts[5].strip()
        value = parts[6].strip() if len(parts) > 6 else ""
        if name:
            out[name] = value
    return out


def cookies_from_env(name: str) -> dict[str, str]:
    """Convenience wrapper: read env(name) as a Netscape cookie blob."""
    return parse_netscape_cookies(env(name))
