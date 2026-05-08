"""Shared helpers for media-API search scripts (Kodik, VideoCDN, etc).

These APIs differ from BitTorrent trackers: they return direct stream
URLs (.m3u8 / .mp4) instead of magnet links.  The output format extends
the tracker schema with ``stream_url`` and ``quality`` fields so
``aggregate.py`` can merge both kinds into a single ``results.json``.
"""

from __future__ import annotations

import re
from typing import Any

# Re-export everything from common so media scripts only need one import.
from common import *  # noqa: F401,F403

# ---------- quality helpers ----------

QUALITY_RANK: dict[str, int] = {
    "2160p": 6,
    "4k": 6,
    "uhd": 5,
    "1080p": 4,
    "720p": 3,
    "480p": 2,
    "360p": 1,
}

_QUALITY_RE = re.compile(
    r"\b(2160p|1080p|720p|480p|360p|4k|uhd)\b", re.IGNORECASE
)


def detect_quality(text: str) -> str:
    """Return the best quality tag found in *text* (e.g. '1080p')."""
    best_rank = 0
    best_tag = ""
    for m in _QUALITY_RE.finditer(text):
        tag = m.group(1).lower()
        rank = QUALITY_RANK.get(tag, 0)
        if rank > best_rank:
            best_rank = rank
            best_tag = tag
    return best_tag


def quality_sort_key(quality: str) -> int:
    """Numeric key for sorting — higher is better."""
    return QUALITY_RANK.get(quality, 0)


# ---------- result normalisation ----------

def make_stream_item(
    *,
    title: str,
    stream_url: str,
    quality: str = "",
    translation: str = "",
    tracker: str,
    url: str = "",
    size: int = 0,
    season: int | None = None,
    episode: int | None = None,
    kinopoisk_id: int | str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build a result dict that ``aggregate.py`` accepts.

    The ``stream_url`` field is what the download workflow will use
    instead of a magnet link.  ``info_hash`` is set to a synthetic
    value derived from the URL so dedup still works.
    """
    item: dict[str, Any] = {
        "title": title,
        "size": size,
        "seeders": 0,
        "leechers": 0,
        "tracker": tracker,
        "magnet": "",
        "stream_url": stream_url,
        "url": url or stream_url,
        "info_hash": _synthetic_hash(stream_url),
        "quality": quality,
        "translation": translation,
    }
    if season is not None:
        item["season"] = season
    if episode is not None:
        item["episode"] = episode
    if kinopoisk_id is not None:
        item["kinopoisk_id"] = int(kinopoisk_id)
    if extra:
        item.update(extra)
    return item


def _synthetic_hash(url: str) -> str:
    """Stable 40-char hex hash from a URL for dedup in aggregate.py."""
    import hashlib

    return hashlib.sha1(url.encode()).hexdigest()
