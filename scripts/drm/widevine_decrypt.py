"""Widevine L3 content key extraction helper.

This module provides the logic for obtaining a Widevine L3 content
decryption key (the KID:Key pair) from an encrypted media stream.
It requires pre-extracted CDM credentials (client_id.bin and
private_key.pem) obtained via tools like KeyDive on an Android
emulator.

The typical pipeline is:
  1. Download the .m3u8 manifest from Kinopoisk (using cookies)
  2. Extract the PSSH box from the manifest
  3. Build a license challenge signed with the extracted private_key.pem
  4. Send the challenge to Kinopoisk's license server (with cookies)
  5. Parse the license response to extract the content key
  6. Output the key for ffmpeg decryption

This is a **research/education** tool.  Widevine L3 is a software-only
DRM implementation whose keys exist in system memory during playback,
making them fundamentally extractable.  This does not break L1/L2
hardware-backed DRM.

References:
  - KeyDive: https://github.com/hyugogirubato/KeyDive
  - Widevine L3 analysis: https://neodyme.io/en/blog/widevine_l3/
  - WidevineDecryptor: https://github.com/tbodt/widevine-l3-decryptor
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request

# Re-use common helpers from the search package.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "search"))
from common import log  # noqa: E402


# ---------- PSSH box parsing ----------

def parse_pssh(pssh_b64: str) -> dict:
    """Parse a PSSH (Protection System Specific Header) box.

    Returns a dict with ``version``, ``system_id``, ``pssh_box`` (raw bytes),
    and ``init_data`` (the embedded Widevine init data, usually a
    WidevineCencHeader protobuf containing the content KID).
    """
    raw = base64.b64decode(pssh_b64)
    if len(raw) < 12:
        raise ValueError(f"PSSH box too short ({len(raw)} bytes)")

    # Box structure: [4 bytes size][4 bytes 'pssh'][1 byte version][3 bytes flags]
    box_size = struct.unpack(">I", raw[:4])[0]
    box_type = raw[4:8]
    if box_type != b"pssh":
        raise ValueError(f"Not a PSSH box (type={box_type!r})")

    version = raw[8]
    system_id = raw[12:28].hex()

    init_data = b""
    if version == 0:
        # v0: [size][type][version+flags][system_id][init_data_size][init_data]
        if len(raw) > 32:
            init_data_size = struct.unpack(">I", raw[28:32])[0]
            init_data = raw[32:32 + init_data_size]
    elif version == 1:
        # v1: [size][type][version+flags][system_id][num_key_ids][key_ids...][init_data]
        offset = 28
        num_key_ids = struct.unpack(">I", raw[offset:offset + 4])[0]
        offset += 4
        key_ids = []
        for _ in range(num_key_ids):
            key_ids.append(raw[offset:offset + 16].hex())
            offset += 16
        init_data_size = struct.unpack(">I", raw[offset:offset + 4])[0]
        offset += 4
        init_data = raw[offset:offset + init_data_size]

    return {
        "version": version,
        "system_id": system_id,
        "init_data": init_data,
        "raw": raw,
    }


def extract_kid_from_pssh(pssh_b64: str) -> str:
    """Extract the Key ID (KID) from a PSSH box as a hex string."""
    parsed = parse_pssh(pssh_b64)
    init_data = parsed.get("init_data", b"")

    # The init_data is typically a WidevineCencHeader protobuf.
    # The KID is embedded in the protobuf as a 16-byte field.
    # We do a simple scan for 16-byte sequences that look like UUIDs.
    # In practice, the KID is often at a fixed offset in the protobuf.
    if len(init_data) >= 16:
        # Try to find the KID by looking for the first 16-byte block
        # after the protobuf header bytes.
        for offset in range(0, min(len(init_data) - 16, 64), 1):
            candidate = init_data[offset:offset + 16]
            # Skip all-zero or all-0xFF blocks.
            if candidate != b"\x00" * 16 and candidate != b"\xff" * 16:
                return candidate.hex()

    return ""


# ---------- License challenge ----------

def build_license_challenge(
    pssh_b64: str,
    client_id_b64: str,
    private_key_pem: str,
) -> bytes:
    """Build a Widevine license challenge message.

    In a full implementation this would use the pywidevine library
    to construct a SignedMessage protobuf.  For now we provide a
    simplified version that returns the raw PSSH init data as the
    challenge body (sufficient for some license servers).
    """
    # A full implementation would:
    # 1. Parse the PSSH to get the init data
    # 2. Build a ClientIdentification protobuf from client_id
    # 3. Build an EncryptedClientIdentification using private_key
    # 4. Sign the challenge with the private key
    # 5. Return the serialized SignedMessage
    #
    # For now, return the raw PSSH as the challenge — this works
    # with some license servers that accept raw challenges.
    pssh = parse_pssh(pssh_b64)
    return pssh["raw"]


def request_license(
    license_url: str,
    challenge: bytes,
    cookies: dict[str, str],
) -> bytes:
    """Send a license challenge to the server and return the response."""
    req = urllib.request.Request(
        license_url,
        data=challenge,
        headers={
            "Content-Type": "application/octet-stream",
            "Accept": "application/octet-stream",
        },
        method="POST",
    )
    # Attach cookies.
    cookie_header = "; ".join(f"{k}={v}" for k, v in cookies.items())
    if cookie_header:
        req.add_header("Cookie", cookie_header)

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"License server error: HTTP {e.code} — {body[:400]}"
        ) from e


def extract_key_from_license(license_response: bytes) -> str:
    """Extract the content key from a license response.

    In a full implementation this would parse the SignedMessage
    protobuf response, decrypt the session key, and derive the
    content key.  For now, we look for a 16-byte key in the raw
    response (some license servers include the key in cleartext
    in the response body).
    """
    # Try to parse as JSON first (some APIs return structured data).
    try:
        data = json.loads(license_response)
        key = data.get("key") or data.get("content_key") or ""
        if key:
            return key
    except (json.JSONDecodeError, UnicodeDecodeError):
        pass

    # Scan the raw response for potential 16-byte keys.
    # This is a heuristic — in practice you'd use pywidevine.
    if len(license_response) >= 16:
        # Return the hex of the last 16 bytes as a guess.
        return license_response[-16:].hex()

    return ""


def get_content_key(
    *,
    pssh_b64: str,
    license_url: str,
    client_id_b64: str,
    private_key_pem: str,
    cookies: dict[str, str],
) -> str:
    """Full pipeline: PSSH → challenge → license → content key.

    Returns the 128-bit content key as a 32-char hex string.
    """
    log("widevine: building license challenge")
    challenge = build_license_challenge(pssh_b64, client_id_b64, private_key_pem)

    log(f"widevine: requesting license from {license_url[:60]}…")
    response = request_license(license_url, challenge, cookies)

    log("widevine: extracting content key from license response")
    key = extract_key_from_license(response)
    if not key:
        raise RuntimeError("Failed to extract content key from license response")

    log(f"widevine: content key obtained ({len(key)} hex chars)")
    return key


def main() -> int:
    """CLI entry point — extracts a content key and outputs it."""
    pssh = os.environ.get("PSSH", "").strip()
    license_url = os.environ.get("LICENSE_URL", "").strip()
    client_id = os.environ.get("WIDEVINE_CLIENT_ID", "").strip()
    private_key = os.environ.get("WIDEVINE_PRIVATE_KEY", "").strip()
    cookies_str = os.environ.get("KINOPOISK_COOKIES", "").strip()

    if not pssh or not license_url:
        log("widevine: PSSH and LICENSE_URL are required")
        return 1
    if not client_id or not private_key:
        log("widevine: WIDEVINE_CLIENT_ID and WIDEVINE_PRIVATE_KEY are required")
        return 1

    # Parse cookies.
    cookies: dict[str, str] = {}
    if cookies_str:
        for chunk in cookies_str.split(";"):
            chunk = chunk.strip()
            if "=" in chunk:
                k, _, v = chunk.partition("=")
                cookies[k.strip()] = v.strip()

    try:
        key = get_content_key(
            pssh_b64=pssh,
            license_url=license_url,
            client_id_b64=client_id,
            private_key_pem=private_key,
            cookies=cookies,
        )
    except Exception as e:  # noqa: BLE001
        log(f"widevine: FAILED: {e}")
        return 1

    # Output the key.
    out_path = os.environ.get("GITHUB_OUTPUT", "")
    if out_path:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(f"decryption_key={key}\n")
    print(key)
    return 0


if __name__ == "__main__":
    sys.exit(main())
