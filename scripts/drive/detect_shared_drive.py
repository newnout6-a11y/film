"""Detect whether ``GDRIVE_FOLDER_ID`` lives in a Shared Drive.

Service Accounts have **zero** personal Drive quota — uploads to a regular
"My Drive" folder fail with ``storageQuotaExceeded`` even when the folder is
shared with the SA, because the SA still tries to write to its own My Drive.
Files only land successfully when the destination is a Shared Drive (or a
folder inside one), because in that case the *Shared Drive* owns the bytes.

This script signs a JWT with the SA's private key, exchanges it for an
access token, and asks the Drive API ``files.get`` for ``driveId``. If
``driveId`` is non-empty, the folder is on a Shared Drive — we surface that
ID so the workflow can add ``team_drive = <id>`` to ``rclone.conf``. When
the folder is just in My Drive, we fail loud and early with a precise hint
that nothing else is going to fix this.

Outputs (to ``$GITHUB_OUTPUT`` if present, else stdout):
- ``team_drive_id``   — non-empty when the folder is on a Shared Drive
- ``is_shared_drive`` — ``true``/``false``
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def _die(msg: str) -> None:
    # Print as a GitHub Actions error annotation so the UI surfaces it
    # instead of burying it in raw stdout.
    sys.stderr.write(f"::error::{msg}\n")
    sys.exit(1)


def _gh_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if out_path:
        with open(out_path, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")
    print(f"{key}={value}")


def _mint_token(sa: dict) -> str:
    # PyJWT[crypto] is installed in the workflow step before us. Importing
    # here keeps this file scriptable for ad-hoc local debugging without
    # crypto installed (the `_die` for missing JWT will fire in that case).
    try:
        import jwt  # type: ignore
    except ImportError:
        _die(
            "PyJWT is required. The workflow step should install it with "
            "`pip install pyjwt[crypto]` before running this script."
        )
    now = int(time.time())
    claims = {
        "iss": sa["client_email"],
        "scope": "https://www.googleapis.com/auth/drive.readonly",
        "aud": "https://oauth2.googleapis.com/token",
        "iat": now,
        "exp": now + 3600,
    }
    assertion = jwt.encode(claims, sa["private_key"], algorithm="RS256")
    body = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }
    ).encode()
    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        _die(
            "Token exchange failed: "
            f"HTTP {e.code} {e.reason} — {body_text[:400]}"
        )
    except Exception as e:  # noqa: BLE001
        _die(f"Token exchange failed: {e!r}")
    token = data.get("access_token")
    if not token:
        _die(f"Token response missing access_token: {data!r}")
    return token


def _get_folder(token: str, folder_id: str) -> dict:
    url = (
        "https://www.googleapis.com/drive/v3/files/"
        f"{urllib.parse.quote(folder_id, safe='')}"
        "?supportsAllDrives=true&fields=driveId,id,name,mimeType,parents"
    )
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace")
        if e.code == 404:
            _die(
                "Папка с ID, указанным в секрете GDRIVE_FOLDER_ID, не "
                "видна сервис-аккаунту. Поделись папкой с email "
                "сервис-аккаунта и сохрани секрет ещё раз."
            )
        _die(
            f"Drive API files.get failed: HTTP {e.code} {e.reason} — "
            f"{body_text[:400]}"
        )
    except Exception as e:  # noqa: BLE001
        _die(f"Drive API files.get failed: {e!r}")


def main() -> int:
    sa_path = os.environ.get("SA_PATH") or ""
    folder_id = os.environ.get("GDRIVE_FOLDER_ID") or ""
    if not sa_path or not os.path.isfile(sa_path):
        _die("SA_PATH is unset or does not point at a readable file.")
    if not folder_id:
        _die("GDRIVE_FOLDER_ID is empty.")
    with open(sa_path, encoding="utf-8") as f:
        sa = json.load(f)
    if "client_email" not in sa or "private_key" not in sa:
        _die(
            "Service account JSON is missing client_email/private_key. "
            "Re-export the key from Google Cloud Console."
        )
    token = _mint_token(sa)
    info = _get_folder(token, folder_id)
    drive_id = info.get("driveId") or ""
    is_shared = bool(drive_id)
    print(
        f"folder name: {info.get('name')!r}, mimeType: {info.get('mimeType')!r}, "
        f"driveId: {drive_id!r}"
    )
    _gh_output("team_drive_id", drive_id)
    _gh_output("is_shared_drive", "true" if is_shared else "false")
    if not is_shared:
        sys.stderr.write(
            "::error title=Drive folder is in My Drive — uploads will 403::"
            "Сервис-аккаунты не имеют собственного места в My Drive. "
            "Создай Shared Drive (Общий диск), добавь сервис-аккаунт как "
            "Content manager, перенеси целевую папку туда и обнови "
            "GDRIVE_FOLDER_ID на ID папки внутри Shared Drive. "
            "Подробности: https://developers.google.com/workspace/drive/api/guides/about-shareddrives\n"
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
