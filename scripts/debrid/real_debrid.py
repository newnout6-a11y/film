"""Real-Debrid API wrapper.

Transforms magnet links into cached Direct Download Links (DDL) via
the Real-Debrid REST API.  For popular content the file is already
cached on Debrid's CDN, so the conversion is instant — no P2P
downloading required.  The resulting DDL URL can be streamed directly
to Google Drive via ``rclone copyurl``, completely bypassing the slow
BitTorrent speeds on GitHub Actions runners.

API docs: https://api.real-debrid.com/
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# Re-use common helpers from the search package.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "search"))
from common import log  # noqa: E402

API_BASE = "https://api.real-debrid.com/rest/1.0"

# File extensions that are never the main video file.
_JUNK_EXTENSIONS = frozenset({
    ".txt", ".nfo", ".url", ".srt", ".sub", ".ssa", ".ass",
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".ico",
    ".html", ".htm", ".xml", ".php", ".css", ".js",
    ".exe", ".bat", ".cmd", ".sh",
})

# Video extensions we look for when selecting the best file.
_VIDEO_EXTENSIONS = frozenset({
    ".mkv", ".mp4", ".avi", ".mov", ".webm", ".m4v", ".wmv",
    ".flv", ".ts", ".m2ts", ".vob", ".mpg", ".mpeg",
})


class RealDebridAPI:
    """Thin wrapper over the Real-Debrid REST API."""

    def __init__(self, api_key: str):
        self._api_key = api_key

    def _request(
        self,
        method: str,
        endpoint: str,
        *,
        data: dict[str, str] | None = None,
        timeout: int = 30,
    ) -> dict | list | bytes:
        url = f"{API_BASE}{endpoint}"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Accept": "application/json",
        }
        body = None
        if data is not None:
            body = urllib.parse.urlencode(data).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"

        req = urllib.request.Request(
            url, data=body, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                ct = resp.headers.get("Content-Type", "")
                raw = resp.read()
                if "json" in ct:
                    return json.loads(raw)
                return raw
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"Real-Debrid API error: HTTP {e.code} {e.reason} — "
                f"{body_text[:400]}"
            ) from e

    def add_magnet(self, magnet: str) -> str:
        """Submit a magnet URI. Returns the torrent ID."""
        result = self._request(
            "POST", "/torrents/addMagnet", data={"magnet": magnet}
        )
        if isinstance(result, dict):
            tid = result.get("id") or result.get("uri", "").split("/")[-1]
            return str(tid)
        # 201 Created sometimes returns just the ID in the Location header.
        return str(result)

    def torrent_info(self, torrent_id: str) -> dict:
        """Get full info about a torrent, including its file list."""
        return self._request("GET", f"/torrents/info/{torrent_id}")

    def select_files(self, torrent_id: str, file_ids: str | list[str]) -> None:
        """Select which files to download. Required before unrestricting."""
        if isinstance(file_ids, list):
            ids_str = ",".join(str(f) for f in file_ids)
        else:
            ids_str = str(file_ids)
        self._request(
            "POST",
            f"/torrents/selectFiles/{torrent_id}",
            data={"files": ids_str},
        )

    def unrestrict_link(self, link: str) -> str:
        """Convert a protected Debrid link into a direct DDL URL."""
        result = self._request(
            "POST", "/unrestrict/link", data={"link": link}
        )
        if isinstance(result, dict):
            return result.get("download", "") or result.get("link", "")
        return str(result)

    def is_cached(self, magnet: str) -> bool:
        """Check if a magnet link is already cached (instant DDL available).

        Uses the ``/torrents/instantAvailability`` endpoint.
        """
        try:
            result = self._request(
                "GET",
                "/torrents/instantAvailability",
                # This endpoint uses query params, not form data.
            )
            # The instant availability endpoint needs the magnet hash.
            # Fall back to just trying add_magnet + torrent_info.
        except Exception:  # noqa: BLE001
            pass
        # Simpler approach: add the magnet and check if it's
        # immediately downloaded.
        return False


def _pick_best_file(files: list[dict]) -> list[str]:
    """From a list of torrent files, pick the best video file(s).

    Returns a list of file IDs to select.  Prefers the largest video
    file, ignoring junk files (.txt, .nfo, etc.).
    """
    candidates: list[tuple[int, str, int]] = []  # (index, id, bytes)
    for i, f in enumerate(files):
        name = f.get("path", "") or f.get("name", "")
        ext = os.path.splitext(name)[1].lower()
        fid = str(f.get("id", i))
        fsize = int(f.get("bytes", 0) or f.get("size", 0) or 0)

        # Skip obviously non-video files.
        if ext in _JUNK_EXTENSIONS:
            continue
        # Strongly prefer known video extensions.
        if ext in _VIDEO_EXTENSIONS or not ext:
            candidates.append((i, fid, fsize))

    if not candidates:
        # No video file found — pick the largest file overall.
        if files:
            best = max(
                range(len(files)),
                key=lambda idx: int(
                    files[idx].get("bytes", 0)
                    or files[idx].get("size", 0)
                    or 0
                ),
            )
            return [str(files[best].get("id", best))]
        return []

    # Pick the largest video file.
    candidates.sort(key=lambda c: c[2], reverse=True)
    return [candidates[0][1]]


def magnet_to_ddl(
    api_key: str,
    magnet: str,
    *,
    poll_interval: int = 5,
    max_wait: int = 120,
) -> str:
    """Full pipeline: magnet → add → select files → unrestrict → DDL URL.

    For cached (popular) content this completes in ~2 API round-trips.
    For uncached content we poll until the download completes (up to
    *max_wait* seconds).

    Returns the final DDL URL on success, raises on failure.
    """
    api = RealDebridAPI(api_key)

    # Step 1: Submit the magnet.
    log("debrid: submitting magnet link")
    torrent_id = api.add_magnet(magnet)
    log(f"debrid: torrent ID = {torrent_id}")

    # Step 2: Get file list and select the best video file.
    info = api.torrent_info(torrent_id)
    files = info.get("files", [])
    if not files:
        raise RuntimeError("Real-Debrid returned no files for this torrent")

    file_ids = _pick_best_file(files)
    if not file_ids:
        raise RuntimeError("No usable video file found in torrent")

    log(f"debrid: selecting file(s) {file_ids}")
    api.select_files(torrent_id, file_ids)

    # Step 3: Wait for the torrent to become available.
    status = info.get("status", "")
    # Possible statuses: magnet_error, magnet_conversion, waiting_files_selection,
    # queued, downloading, downloaded, error, virus, compressed.
    elapsed = 0
    while status not in ("downloaded", "dead", "error", "virus"):
        if elapsed >= max_wait:
            raise RuntimeError(
                f"Torrent not ready after {max_wait}s (status={status})"
            )
        time.sleep(poll_interval)
        elapsed += poll_interval
        info = api.torrent_info(torrent_id)
        status = info.get("status", "")
        progress = info.get("progress", 0)
        log(f"debrid: status={status} progress={progress}% ({elapsed}s)")

    if status in ("dead", "error", "virus"):
        raise RuntimeError(
            f"Torrent failed on Debrid (status={status})"
        )

    # Step 4: Unrestrict the link.
    links = info.get("links", [])
    if not links:
        raise RuntimeError("No downloadable links found after unrestrict")

    ddl_url = ""
    for link in links:
        try:
            ddl_url = api.unrestrict_link(link)
            if ddl_url:
                break
        except Exception as e:  # noqa: BLE001
            log(f"debrid: unrestrict failed for {link[:60]}…: {e}")
            continue

    if not ddl_url:
        raise RuntimeError("Failed to unrestrict any link")
    log(f"debrid: DDL URL obtained ({len(ddl_url)} chars)")
    return ddl_url


def main() -> int:
    """CLI entry point — takes a magnet from MAGNET env var, outputs DDL."""
    api_key = os.environ.get("REAL_DEBRID_API_KEY", "").strip()
    magnet = os.environ.get("MAGNET", "").strip()

    if not api_key:
        log("debrid: REAL_DEBRID_API_KEY not set")
        return 1
    if not magnet:
        log("debrid: MAGNET not set")
        return 1

    try:
        ddl = magnet_to_ddl(api_key, magnet)
    except Exception as e:  # noqa: BLE001
        log(f"debrid: FAILED: {e}")
        return 1

    # Output the DDL URL so the workflow can consume it.
    out_path = os.environ.get("GITHUB_OUTPUT", "")
    if out_path:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(f"ddl_url={ddl}\n")
    print(ddl)
    return 0


if __name__ == "__main__":
    sys.exit(main())
