"use strict";

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORE_KEY = "film-beamer.cfg.v1";

const defaultCfg = {
  repo: "",
  // Empty branch = autodetect via GitHub API (default_branch).
  branch: "",
  workflow: "download-to-drive.yml",
  token: "",
  // ---- Account-mode credentials (cross-device sync via Google Drive) ----
  // The service-account JSON doubles as the "account key": same JSON is used
  // both for uploading GDRIVE_* secrets and for reading/writing the cfg blob
  // on Drive. Per-device, never synced — paste once on each new device.
  driveSaJson: "",
  driveFolderId: "",
  // Whether to auto-push the cfg blob to Drive on every "Сохранить" click.
  accountAutoPush: false,
  // Tracker creds. Mirror what gets uploaded to GitHub Secrets so we can sync
  // them across devices and re-upload to Secrets on each new machine without
  // the user re-typing them.
  trackers: {
    rutracker: { user: "", pass: "" },
    kinozal: { user: "", pass: "" },
    nnm: { user: "", pass: "" },
  },
};

// Cached result of branch autodetect, keyed by repo. Stores the *resolved*
// branch we'd actually dispatch against (after the stale-default fallback).
const defaultBranchCache = new Map();

// Branches we'll fall back to when the repo's default_branch looks like a
// short-lived feature branch — in priority order. The first one that actually
// exists on the remote wins.
const FALLBACK_BRANCHES = ["base", "main", "master"];

// Pattern for "this looks like a feature branch, not a long-lived trunk".
// We use this both for migrating saved overrides and for ignoring a stale
// default_branch returned by the GitHub API.
const STALE_BRANCH_RE = /^(devin|gh-pages|feature|temp)\//i;

// One-time migration: drop saved Devin/auto-generated feature branches that
// users picked up from earlier sessions when GitHub Pages was hosted off them.
// Those branches usually carry an outdated workflow file and cause 422 errors
// on workflow_dispatch ("Unexpected inputs provided"). Empty == autodetect.
function migrateCfg(cfg) {
  if (!cfg || typeof cfg.branch !== "string") return cfg;
  if (STALE_BRANCH_RE.test(cfg.branch)) {
    cfg.branch = "";
  }
  return cfg;
}

function loadCfg() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...defaultCfg };
    const parsed = JSON.parse(raw);
    const merged = { ...defaultCfg, ...parsed };
    const migrated = migrateCfg(merged);
    // Persist the migration so it only happens once.
    if (migrated.branch !== (parsed.branch || "")) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
      } catch {
        /* noop */
      }
    }
    return migrated;
  } catch {
    return { ...defaultCfg };
  }
}

function saveCfg(cfg) {
  localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
}

function clearCfg() {
  localStorage.removeItem(STORE_KEY);
}

function inferRepoFromUrl() {
  // If hosted on GitHub Pages: https://<owner>.github.io/<repo>/
  // Try to derive owner/repo from the URL.
  try {
    const u = new URL(window.location.href);
    const m = u.hostname.match(/^([^.]+)\.github\.io$/);
    if (m) {
      const owner = m[1];
      const parts = u.pathname.split("/").filter(Boolean);
      const repo = parts[0];
      if (owner && repo) return `${owner}/${repo}`;
    }
  } catch {
    /* noop */
  }
  return "";
}

function toast(message, kind = "info", timeoutMs = 4000) {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  $("#toasts").appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity 200ms";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, timeoutMs);
}

function timeAgo(isoString) {
  if (!isoString) return "";
  const then = new Date(isoString).getTime();
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч назад`;
  const d = Math.floor(h / 24);
  return `${d} дн назад`;
}

// Render an `updated_at` from GitHub's secret read-back into a short
// "12 с назад · 18:42:01" form so it's obvious the GET hit live API.
function formatSecretTs(secret) {
  if (!secret || !secret.updated_at) return "только что";
  const ts = new Date(secret.updated_at);
  const ago = timeAgo(secret.updated_at);
  const hh = String(ts.getHours()).padStart(2, "0");
  const mm = String(ts.getMinutes()).padStart(2, "0");
  const ss = String(ts.getSeconds()).padStart(2, "0");
  return `${ago} · ${hh}:${mm}:${ss}`;
}

// ---------- status localisation ----------
const STATUS_LABELS = {
  queued: "в очереди",
  in_progress: "идёт",
  completed: "готово",
  pending: "ждёт",
  waiting: "ожидает",
  requested: "запрошен",
  success: "успех",
  failure: "ошибка",
  cancelled: "отменён",
  skipped: "пропущен",
  timed_out: "таймаут",
  action_required: "нужно действие",
  neutral: "нейтрально",
  stale: "устарел",
  startup_failure: "ошибка старта",
};

// ---------- GitHub API ----------
class GitHubClient {
  constructor(cfg) {
    this.cfg = cfg;
  }

  get headers() {
    const h = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.cfg.token) h.Authorization = `Bearer ${this.cfg.token}`;
    return h;
  }

  async _fetch(path, opts = {}) {
    const url = path.startsWith("http")
      ? path
      : `https://api.github.com${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: { ...this.headers, ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body && body.message ? `: ${body.message}` : "";
      } catch {
        /* ignore */
      }
      throw new Error(`GitHub ${res.status}${detail}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async dispatchWorkflow({ ref, inputs }) {
    const path = `/repos/${this.cfg.repo}/actions/workflows/${encodeURIComponent(
      this.cfg.workflow
    )}/dispatches`;
    return this._fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs }),
    });
  }

  async listRuns(perPage = 10) {
    const path = `/repos/${this.cfg.repo}/actions/workflows/${encodeURIComponent(
      this.cfg.workflow
    )}/runs?per_page=${perPage}`;
    return this._fetch(path);
  }

  async getRepoDefaultBranch() {
    const data = await this._fetch(`/repos/${this.cfg.repo}`);
    return data && data.default_branch ? data.default_branch : null;
  }

  // Returns true if `branch` exists on the remote, false otherwise.
  async branchExists(branch) {
    if (!branch) return false;
    try {
      await this._fetch(
        `/repos/${this.cfg.repo}/branches/${encodeURIComponent(branch)}`
      );
      return true;
    } catch (err) {
      // Treat any error (404, 403, network) as "not usable" — the caller
      // will move on to the next candidate.
      return false;
    }
  }

  async getActionsPublicKey() {
    return this._fetch(`/repos/${this.cfg.repo}/actions/secrets/public-key`);
  }

  async putActionsSecret(name, encryptedValue, keyId) {
    return this._fetch(
      `/repos/${this.cfg.repo}/actions/secrets/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: keyId,
        }),
      }
    );
  }

  // Read-back so we can confirm a PUT actually landed: returns
  // { name, created_at, updated_at } or null on 404.
  async getActionsSecret(name) {
    try {
      return await this._fetch(
        `/repos/${this.cfg.repo}/actions/secrets/${encodeURIComponent(name)}`
      );
    } catch (err) {
      if (/\b404\b/.test(err.message || "")) return null;
      throw err;
    }
  }
}

// ---------- libsodium (lazy-loaded for in-app secret uploads) ----------
// Two-step load: first the libsodium-sumo binary (sets window.libsodium),
// then the wrappers (read window.libsodium, set window.sodium).
// We try local copies in ./vendor first (works in any region, blocks no
// CDN), and fall back to public CDNs if the static host has them missing.
const SODIUM_BINARY_SOURCES = [
  "./vendor/libsodium-sumo.min.js",
  "https://cdn.jsdelivr.net/npm/libsodium-sumo@0.7.13/dist/modules-sumo/libsodium-sumo.min.js",
  "https://unpkg.com/libsodium-sumo@0.7.13/dist/modules-sumo/libsodium-sumo.min.js",
];
const SODIUM_WRAPPERS_SOURCES = [
  "./vendor/libsodium-wrappers.min.js",
  "https://cdn.jsdelivr.net/npm/libsodium-wrappers-sumo@0.7.13/dist/modules-sumo/libsodium-wrappers.min.js",
  "https://unpkg.com/libsodium-wrappers-sumo@0.7.13/dist/modules-sumo/libsodium-wrappers.min.js",
];

function _loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    if (/^https?:/i.test(src)) s.crossOrigin = "anonymous";
    s.onload = () => resolve(src);
    s.onerror = () => reject(new Error(`failed: ${src}`));
    document.head.appendChild(s);
  });
}

async function _loadFromAny(sources, label) {
  const errors = [];
  for (const src of sources) {
    try {
      await _loadScriptOnce(src);
      return src;
    } catch (err) {
      errors.push(`${src} → ${err.message || err}`);
      console.warn(`[sodium] ${label} load failed at`, src, err);
    }
  }
  throw new Error(
    `Не удалось загрузить ${label}. Все источники недоступны:\n` +
      errors.join("\n") +
      "\nПроверь интернет, расширения браузера (uBlock/AdGuard) или сетевой фильтр."
  );
}

let _sodiumLoading = null;
function loadSodium() {
  if (window.sodium && window.sodium.ready) {
    return window.sodium.ready.then(() => window.sodium);
  }
  if (_sodiumLoading) return _sodiumLoading;
  _sodiumLoading = (async () => {
    if (!window.libsodium) {
      await _loadFromAny(SODIUM_BINARY_SOURCES, "libsodium-sumo");
    }
    if (!window.sodium) {
      await _loadFromAny(SODIUM_WRAPPERS_SOURCES, "libsodium-wrappers");
    }
    if (!window.sodium || !window.sodium.ready) {
      throw new Error("libsodium-wrappers загружен, но window.sodium не появился.");
    }
    await window.sodium.ready;
    return window.sodium;
  })();
  return _sodiumLoading;
}

async function ghEncryptSecret(plaintext, publicKeyB64) {
  const sodium = await loadSodium();
  const msg = sodium.from_string(plaintext);
  const key = sodium.from_base64(
    publicKeyB64,
    sodium.base64_variants.ORIGINAL
  );
  const enc = sodium.crypto_box_seal(msg, key);
  return sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);
}

async function uploadGitHubSecret(name, value) {
  const gh = new GitHubClient(cfg);
  const pk = await gh.getActionsPublicKey();
  if (!pk || !pk.key || !pk.key_id) {
    throw new Error("Репо не вернул публичный ключ для секретов.");
  }
  const encrypted = await ghEncryptSecret(value, pk.key);
  await gh.putActionsSecret(name, encrypted, pk.key_id);
  // Read it back so callers can prove to the user that the secret really
  // landed (PUT returns 201/204 with no body — without a follow-up GET there
  // is no way to distinguish "succeeded" from "no-op silently").
  const verified = await gh.getActionsSecret(name);
  if (!verified) {
    throw new Error(
      `GitHub принял PUT, но GET /actions/secrets/${name} вернул 404 — секрет не записался. Проверь права PAT (нужно «Secrets: Read and Write»).`
    );
  }
  return verified;
}

// ---------- Account sync via Google Drive ----------
//
// We keep a JSON blob (`film-beamer-config.json`) inside the user's existing
// Drive folder (the same one that GDRIVE_FOLDER_ID points at). The
// service-account JSON the user pastes in Settings is the "account key": it
// authenticates JWT-flow OAuth (RS256, signed in the browser via Web Crypto)
// and gives the browser direct REST access to Drive. Per-device, the user
// pastes SA + Folder once; everything else (repo, branch, PAT, trackers)
// pulls down from the blob.

const SYNC_FILENAME = "film-beamer-config.json";
const SYNC_SCOPES = "https://www.googleapis.com/auth/drive.file";

let _driveAccessToken = null; // { token, expiresAt }

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return buf;
}

function arrayBufferToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function utf8ToBase64Url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// In-flight de-duplication: while a JWT exchange is running, parallel
// callers (validateDriveAccess, backupCfgToDrive, checkDrive,
// findDriveCfgFile) get the same Promise. Otherwise three buttons clicked
// in quick succession produce three identical OAuth requests and Google
// starts replying with 429.
let _driveAccessTokenInflight = null;
async function getDriveAccessToken() {
  if (
    _driveAccessToken &&
    _driveAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return _driveAccessToken.token;
  }
  if (_driveAccessTokenInflight) return _driveAccessTokenInflight;
  _driveAccessTokenInflight = (async () => {
    if (!cfg.driveSaJson) {
      throw new Error(
        "Сначала вставь Google service-account JSON в раздел «Загрузить ключ Google Drive»."
      );
    }
    let sa;
    try {
      sa = JSON.parse(cfg.driveSaJson);
    } catch (err) {
      throw new Error(`Service-account JSON битый: ${err.message}`);
    }
    if (!sa.client_email || !sa.private_key) {
      throw new Error("В JSON нет client_email/private_key.");
    }

    const now = Math.floor(Date.now() / 1000);
    const header = utf8ToBase64Url(
      JSON.stringify({ alg: "RS256", typ: "JWT" })
    );
    const payload = utf8ToBase64Url(
      JSON.stringify({
        iss: sa.client_email,
        scope: SYNC_SCOPES,
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      })
    );
    const signingInput = `${header}.${payload}`;

    const keyBuf = pemToArrayBuffer(sa.private_key);
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyBuf,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      new TextEncoder().encode(signingInput)
    );
    const jwt = `${signingInput}.${arrayBufferToBase64Url(sigBuf)}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google OAuth ${res.status}: ${text}`);
    }
    const data = await res.json();
    _driveAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
    return data.access_token;
  })();
  try {
    return await _driveAccessTokenInflight;
  } finally {
    _driveAccessTokenInflight = null;
  }
}

async function findDriveCfgFile(token, folderId) {
  const q = `name='${SYNC_FILENAME}' and '${folderId}' in parents and trashed=false`;
  const url =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q,
      fields: "files(id,name,modifiedTime)",
      pageSize: "10",
    }).toString();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive list ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0] : null;
}

async function uploadDriveCfg(token, folderId, content, fileId) {
  // Multipart upload: metadata + content in one request.
  const meta = fileId
    ? { name: SYNC_FILENAME }
    : { name: SYNC_FILENAME, parents: [folderId] };
  const boundary = "-------film-beamer-" + Math.random().toString(16).slice(2);
  const body =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(meta) +
    `\r\n--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    content +
    `\r\n--${boundary}--`;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart";
  const res = await fetch(url, {
    method: fileId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive upload ${res.status}: ${text}`);
  }
  return res.json();
}

async function downloadDriveCfg(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive download ${res.status}: ${text}`);
  }
  return res.text();
}

// Build the JSON blob that lives on Drive. We deliberately leave out the
// per-device bootstrap creds (driveSaJson, driveFolderId, accountAutoPush)
// so the user always types those by hand on a new device — that's the
// "log in" step.
function syncBlobFromCfg() {
  return JSON.stringify(
    {
      version: 1,
      saved_at: new Date().toISOString(),
      cfg: {
        repo: cfg.repo || "",
        branch: cfg.branch || "",
        workflow: cfg.workflow || "",
        token: cfg.token || "",
      },
      trackers: cfg.trackers || {},
    },
    null,
    2
  );
}

function applySyncBlob(blob) {
  let parsed;
  try {
    parsed = JSON.parse(blob);
  } catch (err) {
    throw new Error(`Файл sync некорректный: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.cfg) {
    throw new Error("В файле sync нет поля cfg.");
  }
  cfg.repo = parsed.cfg.repo || cfg.repo;
  cfg.branch = parsed.cfg.branch || "";
  cfg.workflow = parsed.cfg.workflow || cfg.workflow;
  cfg.token = parsed.cfg.token || cfg.token;
  if (parsed.trackers && typeof parsed.trackers === "object") {
    cfg.trackers = { ...(cfg.trackers || {}), ...parsed.trackers };
  }
  saveCfg(cfg);
}

async function backupCfgToDrive() {
  if (!cfg.driveFolderId) {
    throw new Error(
      "Не указан Folder ID — заполни в разделе «Загрузить ключ Google Drive»."
    );
  }
  const token = await getDriveAccessToken();
  const existing = await findDriveCfgFile(token, cfg.driveFolderId);
  await uploadDriveCfg(
    token,
    cfg.driveFolderId,
    syncBlobFromCfg(),
    existing ? existing.id : null
  );
}

async function restoreCfgFromDrive() {
  if (!cfg.driveFolderId) {
    throw new Error(
      "Не указан Folder ID — заполни в разделе «Загрузить ключ Google Drive»."
    );
  }
  const token = await getDriveAccessToken();
  const existing = await findDriveCfgFile(token, cfg.driveFolderId);
  if (!existing) {
    throw new Error(
      `На Drive в этой папке нет файла ${SYNC_FILENAME}. ` +
        "Сначала с другого устройства нажми «Сохранить в Drive»."
    );
  }
  const content = await downloadDriveCfg(token, existing.id);
  applySyncBlob(content);
}

// Resolve the branch we should dispatch workflow_dispatch against.
//
// We prefer GET /repos/{owner}/{repo}.default_branch, but if that returns a
// short-lived Devin/feature pattern (`devin/*`, `gh-pages/*`, `feature/*`,
// `temp/*`), we treat it as stale: those branches usually carry an outdated
// workflow file and produce 422 "Unexpected inputs provided" errors when the
// frontend has already moved on. In that case we probe a small list of
// canonical branches (`base`, `main`, `master`) and use the first one that
// actually exists on the remote. Result is cached per repo for the page.
async function fetchDefaultBranch() {
  if (!cfg.repo) return null;
  if (defaultBranchCache.has(cfg.repo)) {
    return defaultBranchCache.get(cfg.repo);
  }
  const gh = new GitHubClient(cfg);
  let branch = null;
  try {
    branch = await gh.getRepoDefaultBranch();
  } catch {
    branch = null;
  }
  if (branch && STALE_BRANCH_RE.test(branch)) {
    for (const candidate of FALLBACK_BRANCHES) {
      if (await gh.branchExists(candidate)) {
        branch = candidate;
        break;
      }
    }
  }
  if (branch) defaultBranchCache.set(cfg.repo, branch);
  return branch;
}

// Returns the branch to dispatch against. If the user explicitly set one in
// Settings, use it; otherwise look up the repo's default_branch via the API
// and cache it for the lifetime of the page. Always refreshes the hint so the
// user sees both the override and the actual default branch.
async function resolveBranch() {
  const def = await fetchDefaultBranch();
  updateBranchHint(def);
  if (cfg.branch) return cfg.branch;
  return def;
}

function updateBranchHint(defaultBranch) {
  const hint = $("#cfg-branch-hint");
  if (!hint) return;
  if (cfg.branch) {
    if (defaultBranch && defaultBranch !== cfg.branch) {
      hint.textContent = `Вручную: ${cfg.branch} (дефолт репо: ${defaultBranch}). Очисти поле, чтобы использовать дефолт.`;
      hint.className = "text-xs mt-1 text-amber-400";
    } else {
      hint.textContent = `Вручную: ${cfg.branch}`;
      hint.className = "text-xs mt-1 text-slate-500";
    }
  } else {
    hint.textContent = defaultBranch
      ? `Автоопределена: ${defaultBranch}`
      : "";
    hint.className = "text-xs mt-1 text-slate-500";
  }
}

// ---------- UI state ----------
let cfg = loadCfg();
let pollTimer = null;

function ensureRepoLink() {
  const a = $("#repo-link");
  if (cfg.repo) {
    a.href = `https://github.com/${cfg.repo}`;
    a.textContent = cfg.repo;
  } else {
    a.href = "https://github.com/";
    a.textContent = "GitHub";
  }
}

function isReady() {
  // Branch is optional — empty means “autodetect via API”.
  return Boolean(cfg.repo && cfg.token && cfg.workflow);
}

function showSetupHint(show) {
  $("#setup-hint").classList.toggle("hidden", !show);
}

function openSettings() {
  $("#cfg-repo").value = cfg.repo || inferRepoFromUrl();
  $("#cfg-branch").value = cfg.branch || "";
  $("#cfg-workflow").value = cfg.workflow || "download-to-drive.yml";
  $("#cfg-token").value = cfg.token || "";

  // Pre-fill account / Drive / tracker fields from cfg so the user always
  // sees their current state when they open the dialog. The Drive section
  // remembers the SA JSON locally because it doubles as the account key.
  const driveJsonEl = $("#drive-json");
  if (driveJsonEl) driveJsonEl.value = cfg.driveSaJson || "";
  const driveFolderEl = $("#drive-folder");
  if (driveFolderEl) driveFolderEl.value = cfg.driveFolderId || "";
  if (typeof updateServiceAccountEmail === "function") updateServiceAccountEmail();
  for (const t of TRACKER_FIELDS || []) {
    const u = $(t.userInput);
    const p = $(t.passInput);
    if (u && !u.value) u.value = cfg.trackers?.[t.id]?.user || "";
    if (p && !p.value) p.value = cfg.trackers?.[t.id]?.pass || "";
  }
  const autoEl = $("#account-autopush");
  if (autoEl) autoEl.checked = Boolean(cfg.accountAutoPush);
  if (typeof updateAccountStatus === "function") updateAccountStatus();

  // Refresh the hint with whatever's already cached, then trigger an async
  // fetch in the background to populate it for the very first open.
  const cached = cfg.repo ? defaultBranchCache.get(cfg.repo) : null;
  updateBranchHint(cached || null);
  if (cfg.repo && !cached) {
    fetchDefaultBranch().then(updateBranchHint).catch(() => {});
  }
  $("#settings-dialog").classList.remove("hidden");
  // Reach out to GitHub for the secrets audit so the user immediately sees
  // «GDRIVE_SERVICE_ACCOUNT — есть, обновлён X мин назад» instead of
  // assuming "empty form = nothing on GitHub". Silent: refresh shows its
  // own status row inside the panel.
  if (typeof SecretsAudit !== "undefined" && SecretsAudit && SecretsAudit.refresh) {
    // Render whatever we have cached first so the panel doesn't flash empty.
    const last = SecretsAudit.lastResult();
    if (last) {
      SecretsAudit.render(last);
      renderDriveExistingState(last);
    }
    SecretsAudit.refresh({ silent: true, force: false })
      .then((res) => {
        if (res) renderDriveExistingState(res);
      })
      .catch(() => {});
  }
}

// When the user opens Settings on a hard-reloaded device, the Drive form is
// empty (we never persist the SA JSON to the Drive sync blob — it IS the
// account key). Without this nudge, they re-paste the JSON every time even
// though it's already on GitHub. Surface that state explicitly so they can
// stop second-guessing themselves.
function renderDriveExistingState(audit) {
  if (!audit || !audit.ready || !Array.isArray(audit.rows)) {
    applyDriveUploadButtonState();
    return;
  }
  const jsonField = $("#drive-json");
  const folderField = $("#drive-folder");
  if (!jsonField || !folderField) return;
  applyDriveUploadButtonState();
  // Only show the hint when both fields are blank — once the user starts
  // typing, get out of the way.
  if (jsonField.value.trim() || folderField.value.trim()) return;
  const sa = audit.rows.find((r) => r.name === "GDRIVE_SERVICE_ACCOUNT");
  const folder = audit.rows.find((r) => r.name === "GDRIVE_FOLDER_ID");
  if (!sa || !folder || !sa.exists || !folder.exists) return;
  const ago = sa.updatedAt ? timeAgo(sa.updatedAt) : "";
  setDriveStatus(
    ago
      ? `На GitHub · обновлено ${ago}. Заново загружать не нужно — поля можно оставить пустыми.`
      : "На GitHub · значения скрыты GitHub'ом. Заново загружать не нужно.",
    "success"
  );
}

// Lock the «Загрузить в GitHub Secrets» button when both Drive secrets
// already live in GitHub and the form is empty — pressing it in that
// state would either fail with «Заполни хотя бы одно поле» or, worse,
// silently re-write the existing secret with placeholder content. Once
// the user starts typing, the button comes back relabelled
// «Перезаписать на GitHub» so the overwrite is intentional.
function applyDriveUploadButtonState() {
  const btn = $("#drive-upload");
  const jsonField = $("#drive-json");
  const folderField = $("#drive-folder");
  if (!btn || !jsonField || !folderField) return;
  const defaultLabel =
    btn.dataset.defaultLabel || "Загрузить в GitHub Secrets";
  const hasInput = !!(
    jsonField.value.trim() || folderField.value.trim()
  );
  let saExists = false;
  let folderExists = false;
  try {
    const audit =
      typeof SecretsAudit !== "undefined" && SecretsAudit
        ? SecretsAudit.lastResult()
        : null;
    if (audit && audit.ready && Array.isArray(audit.rows)) {
      saExists = !!audit.rows.find(
        (r) => r.name === "GDRIVE_SERVICE_ACCOUNT" && r.exists
      );
      folderExists = !!audit.rows.find(
        (r) => r.name === "GDRIVE_FOLDER_ID" && r.exists
      );
    }
  } catch {
    /* ignore — fall through to default state */
  }
  const bothOnGitHub = saExists && folderExists;
  if (bothOnGitHub && !hasInput) {
    btn.disabled = true;
    btn.textContent = "Уже на GitHub";
    btn.title =
      "Секреты уже лежат в GitHub. Чтобы перезаписать — введи новые значения в поля выше.";
    return;
  }
  btn.disabled = false;
  btn.title = "";
  btn.textContent =
    bothOnGitHub && hasInput ? "Перезаписать на GitHub" : defaultLabel;
}

function closeSettings() {
  $("#settings-dialog").classList.add("hidden");
}

function bindSettings() {
  $("#settings-btn").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#settings-dialog").addEventListener("click", (e) => {
    if (e.target.id === "settings-dialog") closeSettings();
  });
  $("#setup-hint-link").addEventListener("click", openSettings);
  $("#settings-clear").addEventListener("click", () => {
    clearCfg();
    cfg = loadCfg();
    ensureRepoLink();
    showSetupHint(true);
    toast("Настройки очищены.", "success");
    closeSettings();
  });
  $("#settings-save").addEventListener("click", () => {
    const repo = $("#cfg-repo").value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      toast("Репозиторий должен быть в формате owner/repo.", "error");
      return;
    }
    const token = $("#cfg-token").value.trim();
    if (token && !/^(github_pat_|gh[opsu]_)[A-Za-z0-9_]+$/.test(token)) {
      toast(
        "Внимание: токен не похож на GitHub PAT. Сохраняю всё равно.",
        "error",
        2500
      );
    }
    // Preserve existing fields we don't expose in the main form (Drive creds,
    // tracker creds, autopush). Those are managed by their own sections / by
    // applySyncBlob — but we still want them in cfg.
    cfg = {
      ...cfg,
      repo,
      branch: $("#cfg-branch").value.trim(),
      workflow: $("#cfg-workflow").value.trim() || "download-to-drive.yml",
      token,
      accountAutoPush: $("#account-autopush")?.checked || false,
    };
    saveCfg(cfg);
    ensureRepoLink();
    showSetupHint(!isReady());
    toast("Сохранено.", "success");
    closeSettings();
    refreshRuns(true);
    // If the user opted in, push the cfg blob up to Drive in the background.
    if (cfg.accountAutoPush && cfg.driveSaJson && cfg.driveFolderId) {
      backupCfgToDrive()
        .then(() => toast("Синхронизировано с Drive.", "success", 2000))
        .catch((err) =>
          toast(`Drive sync не сработал: ${err.message || err}`, "error")
        );
    }
  });
}

// Recognises common URL shapes so we can give the user inline feedback and so
// the workflow knows whether to pick yt-dlp, aria2-direct or aria2-bittorrent.
function classifyUrl(raw) {
  const url = (raw || "").trim();
  if (!url) return { kind: "empty" };
  if (/^magnet:\?/i.test(url)) return { kind: "magnet" };
  if (/\.torrent(\?|$)/i.test(url)) return { kind: "torrent" };
  if (!/^https?:\/\//i.test(url)) return { kind: "invalid" };
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { kind: "invalid" };
  }
  if (/(^|\.)kinopoisk\.ru$/.test(host)) return { kind: "kinopoisk", host };
  if (
    /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|tiktok\.com|twitter\.com|x\.com|twitch\.tv|dailymotion\.com|rutube\.ru|vk\.com|bilibili\.com|facebook\.com|instagram\.com|ok\.ru|coub\.com)$/.test(
      host
    )
  ) {
    return { kind: "video", host };
  }
  if (/\.(mp4|mkv|webm|avi|mov|m4v|mp3|m4a|flac|wav|ogg|opus|zip|rar|7z|iso|pdf|epub|cbr|cbz)(\?|$)/i.test(url)) {
    return { kind: "direct", host };
  }
  return { kind: "unknown", host };
}

const URL_HINTS = {
  empty: { text: "", cls: "text-slate-400" },
  invalid: {
    text: "Ссылка должна начинаться с http(s):// или magnet:?",
    cls: "text-rose-300",
  },
  kinopoisk: {
    text:
      "Кинопоиск — это страница описания, видео там нет. Скопируй magnet с RuTracker или ссылку с Rutube/YouTube.",
    cls: "text-rose-300",
  },
  magnet: {
    text: "Магнет-ссылка — пойдёт через aria2c (BitTorrent).",
    cls: "text-emerald-300",
  },
  torrent: {
    text: ".torrent файл — пойдёт через aria2c (BitTorrent).",
    cls: "text-emerald-300",
  },
  video: {
    text: "Похоже на видео-сайт — пойдёт через yt-dlp.",
    cls: "text-emerald-300",
  },
  direct: {
    text: "Прямая ссылка на файл — пойдёт через aria2c.",
    cls: "text-emerald-300",
  },
  unknown: {
    text: "Попробую yt-dlp как универсальный извлекатель. Если не выйдет — посмотри лог раннера.",
    cls: "text-slate-400",
  },
};

function bindUrlHint() {
  const hint = $("#url-hint");
  const input = $("#url");
  if (!hint || !input) return;
  const update = () => {
    const cls = classifyUrl(input.value).kind;
    const meta = URL_HINTS[cls] || URL_HINTS.unknown;
    hint.textContent = meta.text;
    hint.className = `text-xs ${meta.cls}`;
  };
  input.addEventListener("input", update);
  input.addEventListener("paste", () => setTimeout(update, 0));
  update();
}

function bindQualityToggle() {
  const select = $("#quality");
  const wrap = $("#ytdlp-format-wrap");
  if (!select || !wrap) return;
  const sync = () => {
    wrap.classList.toggle("hidden", select.value !== "custom");
    wrap.classList.toggle("block", select.value === "custom");
  };
  select.addEventListener("change", sync);
  sync();
}

// Convert a raw GitHubClient error from workflow_dispatch into a human
// message. Most generic errors pass through unchanged; we special-case the
// 422 "Unexpected inputs provided" surface because it points at a very
// specific real-world problem (the workflow file on the dispatched branch is
// older than the form), and the GitHub error string alone doesn't make that
// obvious to the user.
function explainDispatchError(err, ref) {
  const raw = (err && err.message) || String(err || "");
  if (
    /\b422\b/.test(raw) &&
    /Unexpected inputs provided/i.test(raw)
  ) {
    const branchPart = ref ? ` (\`${ref}\`)` : "";
    return (
      `Workflow на ветке${branchPart} устарел и не знает новых полей формы. ` +
      "Замёрж base в эту ветку (или поменяй default branch репо на base в Settings → Branches), " +
      "затем нажми «Закинуть» ещё раз. Полная ошибка: " +
      raw
    );
  }
  return raw;
}

function bindForm() {
  $("#beam-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errEl = $("#form-error");
    errEl.textContent = "";

    if (!isReady()) {
      showSetupHint(true);
      openSettings();
      return;
    }

    const rawUrl = $("#url").value.trim();
    const quality = $("#quality").value || "auto";
    const customFormat = $("#ytdlp_format").value.trim();
    const inputs = {
      url: rawUrl,
      filename: $("#filename").value.trim(),
      subfolder: $("#subfolder").value.trim(),
      quality,
      ytdlp_format: quality === "custom" ? customFormat || "bv*+ba/b" : "",
    };

    const cls = classifyUrl(rawUrl).kind;
    if (cls === "empty" || cls === "invalid") {
      errEl.textContent =
        "Ссылка должна начинаться с http(s):// или magnet:?";
      return;
    }
    if (cls === "kinopoisk") {
      errEl.textContent =
        "Кинопоиск не хостит видео. Скопируй magnet с RuTracker или ссылку с Rutube/YouTube.";
      return;
    }

    const btn = $("#beam-btn");
    btn.disabled = true;
    const lbl = $("#beam-btn-label");
    const oldLabel = lbl.textContent;
    lbl.textContent = "Отправляем…";

    let ref = null;
    try {
      const gh = new GitHubClient(cfg);
      ref = await resolveBranch();
      if (!ref) {
        throw new Error(
          "Не получилось определить ветку репо — укажи её вручную в Настройках."
        );
      }
      // Snapshot existing run ids so trackDispatchedRun can find the new
      // one by id (clock-skew-proof).
      const knownRunIds = await snapshotRunIds(gh, cfg.workflow);
      const dispatchedAt = Date.now();
      await gh.dispatchWorkflow({ ref, inputs });
      toast("Запущено — раннер качает…", "success");
      $("#url").value = "";
      // GitHub sometimes takes a beat to register the run.
      setTimeout(() => refreshRuns(true), 1500);
      // Open the live progress modal so the user sees actual stage transitions.
      openProgressDialog("Закидываем на Drive");
      trackDispatchedRun(cfg.workflow, dispatchedAt, "Закидывание", knownRunIds).catch(
        () => {}
      );
    } catch (err) {
      console.error(err);
      const msg = explainDispatchError(err, ref);
      errEl.textContent = msg;
      toast(`Ошибка: ${msg}`, "error");
    } finally {
      btn.disabled = false;
      lbl.textContent = oldLabel;
    }
  });
}

function statusKey(run) {
  // Prefer conclusion when completed; otherwise status.
  if (run.status === "completed" && run.conclusion) return run.conclusion;
  return run.status;
}

function statusLabel(run) {
  const s = statusKey(run);
  if (!s) return "неизвестно";
  return STATUS_LABELS[s] || s.replace(/_/g, " ");
}

function renderRuns(runs) {
  const wrap = $("#runs");
  wrap.innerHTML = "";
  if (!runs || runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "px-4 py-6 text-center text-sm text-slate-500";
    empty.textContent = "Пока ничего не было.";
    wrap.appendChild(empty);
    return;
  }
  for (const run of runs) {
    const row = document.createElement("a");
    row.href = run.html_url;
    row.target = "_blank";
    row.rel = "noreferrer noopener";
    row.className = "run-row";

    const dot = document.createElement("span");
    dot.className = `dot ${statusKey(run)}`;
    row.appendChild(dot);

    const label = document.createElement("div");
    label.className = "min-w-0";
    const title = document.createElement("div");
    title.className = "truncate text-sm font-medium text-slate-100";
    title.textContent = run.display_title || run.name || `Запуск #${run.run_number}`;
    const sub = document.createElement("div");
    sub.className = "truncate text-xs text-slate-500";
    sub.textContent = `#${run.run_number} · ${run.event} · ${
      run.head_branch
    } · ${timeAgo(run.created_at)}`;
    label.appendChild(title);
    label.appendChild(sub);
    row.appendChild(label);

    const stat = document.createElement("div");
    stat.className =
      "rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-slate-300";
    stat.textContent = statusLabel(run);
    row.appendChild(stat);

    const arrow = document.createElement("div");
    arrow.className = "arrow-cell text-slate-500";
    arrow.textContent = "↗";
    row.appendChild(arrow);

    wrap.appendChild(row);
  }
}

async function refreshRuns(immediate = false) {
  if (!isReady()) {
    renderRuns([]);
    return;
  }
  try {
    const gh = new GitHubClient(cfg);
    const data = await gh.listRuns(10);
    renderRuns(data.workflow_runs || []);
  } catch (err) {
    console.warn("refreshRuns failed:", err);
    if (immediate) {
      toast(`Не удалось загрузить запуски: ${err.message || err}`, "error");
    }
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshRuns, 7000);
}

// ---------- PWA install prompt ----------
let deferredInstall = null;
function bindInstall() {
  const btn = $("#install-btn");
  if (!btn) return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    btn.hidden = false;
  });
  window.addEventListener("appinstalled", () => {
    deferredInstall = null;
    btn.hidden = true;
    toast("Установлено. Ищи на главном экране.", "success");
  });
  btn.addEventListener("click", async () => {
    if (!deferredInstall) {
      toast(
        "Открой меню браузера → «Добавить на главный экран».",
        "info",
        5000
      );
      return;
    }
    deferredInstall.prompt();
    try {
      await deferredInstall.userChoice;
    } catch {
      /* noop */
    }
    deferredInstall = null;
    btn.hidden = true;
  });
}

// ---------- Drive secret uploader ----------
function extractFolderId(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  const match = trimmed.match(/folders\/([A-Za-z0-9_-]+)/);
  const id = match ? match[1] : trimmed;
  return /^[A-Za-z0-9_-]{10,}$/.test(id) ? id : null;
}

function parseServiceAccountJson(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`JSON невалиден: ${e.message}`);
  }
  if (parsed.type !== "service_account" || !parsed.client_email) {
    throw new Error(
      "Это не похоже на service-account JSON (нет type=service_account / client_email)."
    );
  }
  return { json: trimmed, email: parsed.client_email };
}

function setDriveStatus(text, kind = "info") {
  const el = $("#drive-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove(
    "hidden",
    "text-slate-400",
    "text-emerald-300",
    "text-rose-300"
  );
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  const cls =
    kind === "success"
      ? "text-emerald-300"
      : kind === "error"
      ? "text-rose-300"
      : "text-slate-400";
  el.classList.add(cls);
  // The status sits below the upload button. On mobile the dialog can be
  // taller than the viewport, so scroll the message into view so the user
  // actually sees the success/error message instead of guessing.
  try {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    /* older browsers */
  }
}

function updateServiceAccountEmail() {
  const box = $("#drive-sa-email");
  const valEl = $("#drive-sa-email-value");
  const raw = $("#drive-json").value;
  if (!raw.trim()) {
    box.classList.add("hidden");
    return;
  }
  try {
    const { email } = parseServiceAccountJson(raw);
    valEl.textContent = email;
    box.classList.remove("hidden");
  } catch {
    box.classList.add("hidden");
  }
}

function bindDriveUpload() {
  const btn = $("#drive-upload");
  if (!btn) return;
  const jsonField = $("#drive-json");
  const folderField = $("#drive-folder");
  const fileInput = $("#drive-json-file");
  const filePicker = $("#drive-json-pick");

  jsonField.addEventListener("input", () => {
    updateServiceAccountEmail();
    applyDriveUploadButtonState();
  });
  folderField.addEventListener("input", applyDriveUploadButtonState);

  filePicker.addEventListener("click", (e) => {
    e.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      jsonField.value = await file.text();
      updateServiceAccountEmail();
      applyDriveUploadButtonState();
    } catch (err) {
      setDriveStatus(`Не удалось прочитать файл: ${err.message || err}`, "error");
    }
  });

  applyDriveUploadButtonState();

  btn.addEventListener("click", async () => {
    setDriveStatus("");
    if (!cfg.repo) {
      setDriveStatus("Сначала укажи репозиторий в Настройках выше.", "error");
      return;
    }
    if (!cfg.token) {
      setDriveStatus(
        "Сначала введи GitHub-токен выше и нажми «Сохранить».",
        "error"
      );
      return;
    }

    const folderRaw = folderField.value.trim();
    const jsonRaw = jsonField.value.trim();
    if (!folderRaw && !jsonRaw) {
      setDriveStatus(
        "Заполни хотя бы одно поле — JSON или ID папки.",
        "error"
      );
      return;
    }

    let folderId = null;
    if (folderRaw) {
      folderId = extractFolderId(folderRaw);
      if (!folderId) {
        setDriveStatus(
          "Не похоже на ID папки Drive. Вставь URL вида https://drive.google.com/drive/folders/... или сам ID.",
          "error"
        );
        return;
      }
    }

    let saInfo = null;
    if (jsonRaw) {
      try {
        saInfo = parseServiceAccountJson(jsonRaw);
      } catch (err) {
        setDriveStatus(err.message || String(err), "error");
        return;
      }
    }

    btn.disabled = true;
    setDriveStatus("Шифрую в браузере и отправляю…");
    try {
      const uploaded = [];
      if (saInfo) {
        const v = await uploadGitHubSecret(
          "GDRIVE_SERVICE_ACCOUNT",
          saInfo.json
        );
        uploaded.push(`GDRIVE_SERVICE_ACCOUNT (обновлён ${formatSecretTs(v)})`);
      }
      if (folderId) {
        const v = await uploadGitHubSecret("GDRIVE_FOLDER_ID", folderId);
        uploaded.push(`GDRIVE_FOLDER_ID (обновлён ${formatSecretTs(v)})`);
      }
      const tail = saInfo
        ? ` Не забудь расшарить папку Drive на ${saInfo.email}.`
        : "";
      setDriveStatus(
        `Записано в GitHub Secrets и подтверждено GET-ом: ${uploaded.join(
          "; "
        )}.${tail}`,
        "success"
      );
      toast("Секреты Drive загружены в GitHub.", "success");
      // Persist locally so account-sync can use the SA+folder as the
      // "account key" across page reloads. We keep the JSON in localStorage
      // but never push it to the Drive sync blob (it IS the key).
      cfg = {
        ...cfg,
        driveSaJson: saInfo ? saInfo.json : cfg.driveSaJson,
        driveFolderId: folderId || cfg.driveFolderId,
      };
      saveCfg(cfg);
      if (typeof updateAccountStatus === "function") updateAccountStatus();
      jsonField.value = "";
      updateServiceAccountEmail();
    } catch (err) {
      const msg = err.message || String(err);
      const hint = /\b403\b/.test(msg)
        ? " У токена должно быть право «Secrets: Read and Write». Перевыпусти PAT с этим разрешением."
        : "";
      setDriveStatus(`Ошибка: ${msg}${hint}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Drive OAuth refresh-token uploader ----------
// Service Accounts have **no** Drive quota of their own. Personal
// @gmail.com accounts can't create Shared Drives (Workspace-only feature),
// so the only way for those users to actually receive uploads is to
// authenticate Drive **as themselves** — i.e. an OAuth refresh token.
//
// The simplest pipeline is:
//   1. user runs `rclone authorize "drive"` on any machine,
//   2. pastes the resulting JSON below,
//   3. we sealed-box-encrypt it and PUT it as `GDRIVE_OAUTH_TOKEN`
//      via the same code path that handles `GDRIVE_SERVICE_ACCOUNT`.
//
// The workflow prefers OAuth over SA when both secrets exist.
function setDriveOAuthStatus(text, kind = "info") {
  const el = $("#drive-oauth-status");
  if (!el) return;
  el.textContent = text || "";
  el.className =
    "text-xs " +
    (text ? "" : "hidden ") +
    (kind === "success"
      ? "text-emerald-300"
      : kind === "error"
      ? "text-rose-300"
      : "text-slate-400");
  if (text) {
    try {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    } catch {
      /* older browsers */
    }
  }
}

function parseDriveOAuthTokenJson(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "Не удалось распарсить JSON. Скопируй вывод `rclone authorize \"drive\"` целиком, включая обе фигурные скобки."
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OAuth-токен должен быть JSON-объектом, а не массивом.");
  }
  if (typeof parsed.refresh_token !== "string" || !parsed.refresh_token) {
    throw new Error(
      "В JSON нет поля `refresh_token`. Перевыпусти токен через `rclone authorize \"drive\"` — там он обязательно есть."
    );
  }
  // Re-serialise to drop pretty-printing whitespace and unrelated fields
  // the user may have pasted by accident. rclone's own format only uses
  // these four keys.
  const clean = {
    access_token: typeof parsed.access_token === "string" ? parsed.access_token : "",
    token_type: typeof parsed.token_type === "string" ? parsed.token_type : "Bearer",
    refresh_token: parsed.refresh_token,
    expiry: typeof parsed.expiry === "string" ? parsed.expiry : "",
  };
  return JSON.stringify(clean);
}

function bindDriveOAuthUpload() {
  const btn = $("#drive-oauth-upload");
  const tokenField = $("#drive-oauth-token");
  const folderField = $("#drive-folder");
  if (!btn || !tokenField || !folderField) return;

  // Reset the status line whenever the inputs change so a stale
  // success/error message can't be confused with the new value.
  const reset = () => {
    if ($("#drive-oauth-status")?.textContent) setDriveOAuthStatus("");
  };
  tokenField.addEventListener("input", reset);
  folderField.addEventListener("input", reset);

  btn.addEventListener("click", async () => {
    setDriveOAuthStatus("");
    if (!cfg.repo) {
      setDriveOAuthStatus(
        "Сначала укажи репозиторий в Настройках выше.",
        "error"
      );
      return;
    }
    if (!cfg.token) {
      setDriveOAuthStatus(
        "Сначала введи GitHub-токен выше и нажми «Сохранить».",
        "error"
      );
      return;
    }

    const tokenRaw = tokenField.value.trim();
    if (!tokenRaw) {
      setDriveOAuthStatus(
        "Вставь JSON, который выдал `rclone authorize \"drive\"`.",
        "error"
      );
      return;
    }

    let cleanJson;
    try {
      cleanJson = parseDriveOAuthTokenJson(tokenRaw);
    } catch (err) {
      setDriveOAuthStatus(err.message || String(err), "error");
      return;
    }

    const folderRaw = folderField.value.trim();
    let folderId = null;
    if (folderRaw) {
      folderId = extractFolderId(folderRaw);
      if (!folderId) {
        setDriveOAuthStatus(
          "Не похоже на ID папки Drive. Вставь URL вида https://drive.google.com/drive/folders/... или сам ID.",
          "error"
        );
        return;
      }
    }

    btn.disabled = true;
    setDriveOAuthStatus("Шифрую в браузере и отправляю…");
    try {
      const uploaded = [];
      const v = await uploadGitHubSecret("GDRIVE_OAUTH_TOKEN", cleanJson);
      uploaded.push(`GDRIVE_OAUTH_TOKEN (обновлён ${formatSecretTs(v)})`);
      if (folderId) {
        const fv = await uploadGitHubSecret("GDRIVE_FOLDER_ID", folderId);
        uploaded.push(`GDRIVE_FOLDER_ID (обновлён ${formatSecretTs(fv)})`);
      }
      setDriveOAuthStatus(
        `Записано в GitHub Secrets и подтверждено GET-ом: ${uploaded.join(
          "; "
        )}. Воркфлоу теперь будет писать в Drive от твоего имени.`,
        "success"
      );
      toast("OAuth-токен Drive загружен в GitHub.", "success");
      tokenField.value = "";
      // Refresh the audit panel so the new GDRIVE_OAUTH_TOKEN row appears
      // without a manual page reload.
      try {
        if (typeof SecretsAudit !== "undefined" && SecretsAudit) {
          SecretsAudit.refresh();
        }
      } catch {
        /* SecretsAudit not loaded — fine */
      }
    } catch (err) {
      const msg = err.message || String(err);
      const hint = /\b403\b/.test(msg)
        ? " У токена должно быть право «Secrets: Read and Write». Перевыпусти PAT с этим разрешением."
        : "";
      setDriveOAuthStatus(`Ошибка: ${msg}${hint}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- YouTube cookies uploader ----------
// YouTube hardened bot detection in 2025 — cloud IPs (incl. GitHub Actions
// runners) get the "Sign in to confirm you're not a bot" wall on most
// videos. Letting users upload their cookies.txt as YT_COOKIES is the only
// reliable workaround. We never persist this in localStorage / Drive sync.
function setYtCookiesStatus(text, kind = "info") {
  const el = $("#yt-cookies-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove(
    "hidden",
    "text-slate-400",
    "text-emerald-300",
    "text-rose-300"
  );
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  const cls =
    kind === "success"
      ? "text-emerald-300"
      : kind === "error"
      ? "text-rose-300"
      : "text-slate-400";
  el.classList.add(cls);
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function looksLikeNetscapeCookies(raw) {
  if (!raw) return false;
  const s = raw.trim();
  if (!s) return false;
  // Netscape cookie file: comments + tab-separated lines with 7 fields.
  // We allow leading blank/comment lines.
  const nonComment = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (!nonComment.length) return false;
  // First non-comment line must split into >=6 tab-separated fields.
  return nonComment[0].split("\t").length >= 6;
}

function bindYtCookiesUpload() {
  const btn = $("#yt-cookies-upload");
  if (!btn) return;
  const clearBtn = $("#yt-cookies-clear");
  const field = $("#yt-cookies");
  const fileInput = $("#yt-cookies-file");
  const filePicker = $("#yt-cookies-pick");

  filePicker.addEventListener("click", (e) => {
    e.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      field.value = await file.text();
    } catch (err) {
      setYtCookiesStatus(
        `Не удалось прочитать файл: ${err.message || err}`,
        "error"
      );
    }
  });

  btn.addEventListener("click", async () => {
    setYtCookiesStatus("");
    if (!cfg.repo) {
      setYtCookiesStatus("Сначала укажи репозиторий в Настройках выше.", "error");
      return;
    }
    if (!cfg.token) {
      setYtCookiesStatus(
        "Сначала введи GitHub-токен выше и нажми «Сохранить».",
        "error"
      );
      return;
    }
    const raw = field.value;
    if (!raw || !raw.trim()) {
      setYtCookiesStatus("Поле пустое — вставь содержимое cookies.txt.", "error");
      return;
    }
    if (!looksLikeNetscapeCookies(raw)) {
      setYtCookiesStatus(
        "Это не похоже на cookies.txt в Netscape-формате. Экспортируй через расширение «Get cookies.txt LOCALLY» или «cookies.txt» (Firefox).",
        "error"
      );
      return;
    }

    btn.disabled = true;
    setYtCookiesStatus("Шифрую в браузере и отправляю…");
    try {
      const v = await uploadGitHubSecret("YT_COOKIES", raw);
      setYtCookiesStatus(
        `Записано в GitHub Secrets и подтверждено GET-ом: YT_COOKIES (обновлён ${formatSecretTs(
          v
        )}). На следующем запуске yt-dlp возьмёт куки из секрета.`,
        "success"
      );
      toast("Куки YouTube загружены в GitHub.", "success");
      // Wipe from the textarea so it doesn't sit in the DOM.
      field.value = "";
    } catch (err) {
      const msg = err.message || String(err);
      const hint = /\b403\b/.test(msg)
        ? " У токена должно быть право «Secrets: Read and Write»."
        : "";
      setYtCookiesStatus(`Ошибка: ${msg}${hint}`, "error");
    } finally {
      btn.disabled = false;
    }
  });

  clearBtn.addEventListener("click", async () => {
    setYtCookiesStatus("");
    if (!cfg.repo || !cfg.token) {
      setYtCookiesStatus(
        "Сначала укажи репо и GitHub-токен в Настройках выше.",
        "error"
      );
      return;
    }
    if (!confirm("Удалить секрет YT_COOKIES из GitHub? yt-dlp снова станет ходить без авторизации.")) {
      return;
    }
    clearBtn.disabled = true;
    setYtCookiesStatus("Удаляю…");
    try {
      const [owner, repo] = cfg.repo.split("/");
      const url = `https://api.github.com/repos/${owner}/${repo}/actions/secrets/YT_COOKIES`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status === 204) {
        setYtCookiesStatus("Секрет YT_COOKIES удалён из GitHub.", "success");
        toast("Секрет YT_COOKIES удалён.", "success");
      } else if (res.status === 404) {
        setYtCookiesStatus("Секрет YT_COOKIES уже не существует.", "info");
      } else {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
    } catch (err) {
      setYtCookiesStatus(`Ошибка: ${err.message || err}`, "error");
    } finally {
      clearBtn.disabled = false;
    }
  });
}

// ---------- Cookie Wizard ----------
// Parse a Netscape cookies.txt file, detect which "buckets" of known
// services it covers (YouTube/Google for yt-dlp, RuTracker, Kinozal,
// NNM-Club), and let the user push each bucket as a separate GitHub
// Secret. The whole point: when a user already has a single big
// cookies.txt exported from their browser, they shouldn't have to
// hand-edit it down to per-site files — we do that here.
//
// Why per-site? yt-dlp expects a Netscape file; trackers (RuTracker etc.)
// also accept Netscape cookies. Mixing all sites into one secret leaks
// extra cookies into runners that don't need them. Splitting also keeps
// each secret well under GitHub's 48 KiB limit.
const COOKIE_BUCKETS = [
  {
    id: "youtube",
    label: "YouTube",
    secretName: "YT_COOKIES",
    // yt-dlp uses cookies from .youtube.com plus Google account cookies
    // from .google.com / accounts.google.com (HSID, SSID, APISID,
    // SAPISID, __Secure-...). We grab both — yt-dlp ignores any extras.
    domains: [
      /(^|\.)youtube\.com$/i,
      /(^|\.)youtu\.be$/i,
      /(^|\.)google\.com$/i,
      /(^|\.)googleapis\.com$/i,
      /(^|\.)googlevideo\.com$/i,
      /(^|\.)ytimg\.com$/i,
    ],
    description:
      "Куки .youtube.com + аккаунт Google (HSID, SAPISID, …) — нужны yt-dlp, чтобы YouTube не возвращал «Sign in to confirm you're not a bot».",
  },
  {
    id: "rutracker",
    label: "RuTracker",
    secretName: "RUTRACKER_COOKIES",
    domains: [/(^|\.)rutracker\.org$/i, /(^|\.)rutracker\.net$/i],
    description:
      "Куки rutracker.org — альтернатива логину/паролю. Если они истекают, переключайся на пару RUTRACKER_USERNAME/RUTRACKER_PASSWORD ниже.",
  },
  {
    id: "kinozal",
    label: "Kinozal",
    secretName: "KINOZAL_COOKIES",
    domains: [/(^|\.)kinozal\.tv$/i, /(^|\.)kinozal\.guru$/i],
    description:
      "Куки kinozal.tv — для авторизованного доступа к раздачам.",
  },
  {
    id: "nnm",
    label: "NNM-Club",
    secretName: "NNM_COOKIES",
    domains: [/(^|\.)nnm-club\.me$/i, /(^|\.)nnmclub\.to$/i],
    description: "Куки nnm-club.me — для доступа к закрытым разделам.",
  },
];

// Parse one cookies.txt body (Netscape format) into a list of cookie
// objects. We deliberately accept files with `# HttpOnly_…` prefixes
// (yt-dlp's exporter style) and tolerate \r\n line endings.
//
// Returns { cookies: [...], errors: [{line, raw, reason}], totalLines }.
function parseNetscapeCookies(raw) {
  const out = { cookies: [], errors: [], totalLines: 0 };
  if (!raw || typeof raw !== "string") return out;
  const lines = raw.split(/\r?\n/);
  out.totalLines = lines.length;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line || !line.trim()) continue;
    // yt-dlp / Get-cookies.txt-LOCALLY prefix HttpOnly cookies with
    // `#HttpOnly_` — strip the marker and keep the cookie.
    let httpOnly = false;
    if (/^#\s*HttpOnly_/i.test(line)) {
      line = line.replace(/^#\s*HttpOnly_/i, "");
      httpOnly = true;
    } else if (line.startsWith("#")) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length < 6) {
      out.errors.push({ line: i + 1, raw: line, reason: "<6 полей" });
      continue;
    }
    // Netscape spec: domain, includeSubdomains, path, secure, expires,
    // name, value. yt-dlp accepts a missing value (treats as empty).
    const [domainRaw, flag, path, secure, expires, name, ...rest] = parts;
    const value = rest.join("\t");
    out.cookies.push({
      lineNo: i + 1,
      raw: line,
      domain: domainRaw,
      includeSubdomains: /^TRUE$/i.test(flag),
      path: path || "/",
      secure: /^TRUE$/i.test(secure),
      expires: Number(expires) || 0,
      name: name || "",
      value: value || "",
      httpOnly,
    });
  }
  return out;
}

// Build a clean Netscape cookies.txt body for one bucket of cookies.
// Includes a header so yt-dlp / curl / aria2c recognize the format.
function formatNetscapeCookies(cookies) {
  const header =
    "# Netscape HTTP Cookie File\n" +
    "# This file is generated by Film Beamer's cookie wizard.\n" +
    "# Do not edit by hand.\n\n";
  const body = cookies
    .map((c) => {
      const prefix = c.httpOnly ? "#HttpOnly_" : "";
      return [
        prefix + c.domain,
        c.includeSubdomains ? "TRUE" : "FALSE",
        c.path || "/",
        c.secure ? "TRUE" : "FALSE",
        String(c.expires || 0),
        c.name || "",
        c.value || "",
      ].join("\t");
    })
    .join("\n");
  return header + body + "\n";
}

// Group parsed cookies by bucket. A cookie that doesn't match any known
// bucket is dropped (we don't want to upload random ad-tech cookies as
// secrets). Returns an array shaped for UI rendering.
function bucketizeCookies(cookies) {
  return COOKIE_BUCKETS.map((bucket) => {
    const matched = cookies.filter((c) =>
      bucket.domains.some((re) => re.test(c.domain))
    );
    const domains = Array.from(new Set(matched.map((c) => c.domain))).sort();
    const sampleNames = Array.from(new Set(matched.map((c) => c.name)))
      .filter(Boolean)
      .slice(0, 8);
    return {
      ...bucket,
      cookies: matched,
      domains,
      sampleNames,
      count: matched.length,
    };
  });
}

function setCookieWizardStatus(text, kind = "info") {
  const el = $("#cookie-wizard-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove(
    "hidden",
    "text-slate-400",
    "text-emerald-300",
    "text-rose-300"
  );
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  const cls =
    kind === "success"
      ? "text-emerald-300"
      : kind === "error"
      ? "text-rose-300"
      : "text-slate-400";
  el.classList.add(cls);
}

function renderCookieWizardBuckets(buckets) {
  const list = $("#cookie-wizard-buckets");
  if (!list) return;
  list.innerHTML = "";
  if (!buckets.length) return;
  for (const bucket of buckets) {
    const card = document.createElement("div");
    card.className =
      "rounded-xl border border-white/10 bg-ink-900 p-3 text-xs space-y-2";
    const head = document.createElement("div");
    head.className = "flex items-center justify-between gap-2";
    const title = document.createElement("div");
    title.className = "flex items-center gap-2";
    const dot = document.createElement("span");
    dot.className =
      "inline-block h-2 w-2 rounded-full " +
      (bucket.count > 0 ? "bg-emerald-400" : "bg-slate-500");
    const name = document.createElement("span");
    name.className = "text-sm font-medium text-slate-100";
    name.textContent = bucket.label;
    const secret = document.createElement("code");
    secret.className =
      "rounded bg-ink-900 px-1 text-[10px] text-slate-400";
    secret.textContent = bucket.secretName;
    title.appendChild(dot);
    title.appendChild(name);
    title.appendChild(secret);
    const count = document.createElement("span");
    count.className = "text-[11px] text-slate-400";
    count.textContent = bucket.count
      ? `${bucket.count} cookie · ${bucket.domains.length} домен(ов)`
      : "не найдено";
    head.appendChild(title);
    head.appendChild(count);
    card.appendChild(head);

    const desc = document.createElement("p");
    desc.className = "text-[11px] text-slate-500 leading-snug";
    desc.textContent = bucket.description;
    card.appendChild(desc);

    if (bucket.count > 0) {
      const sample = document.createElement("p");
      sample.className = "text-[11px] text-slate-500 break-words";
      sample.innerHTML =
        "<span class='text-slate-400'>Имена:</span> " +
        bucket.sampleNames
          .map(
            (n) =>
              `<code class='rounded bg-ink-900 px-1 text-[10px] text-slate-400'>${n}</code>`
          )
          .join(" ");
      card.appendChild(sample);
    }

    const row = document.createElement("div");
    row.className = "flex flex-wrap items-center gap-2 pt-1";
    const upload = document.createElement("button");
    upload.type = "button";
    upload.className =
      "rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm shadow-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-50";
    upload.textContent = bucket.count
      ? `Загрузить как ${bucket.secretName}`
      : "Нет данных";
    upload.disabled = !bucket.count;
    upload.dataset.bucketId = bucket.id;
    upload.addEventListener("click", () => uploadCookieBucket(bucket, upload));
    row.appendChild(upload);

    const status = document.createElement("span");
    status.className = "text-[11px] text-slate-400";
    status.dataset.bucketStatus = bucket.id;
    row.appendChild(status);
    card.appendChild(row);

    list.appendChild(card);
  }
}

async function uploadCookieBucket(bucket, btn) {
  const status = document.querySelector(
    `[data-bucket-status="${bucket.id}"]`
  );
  const setStatus = (txt, kind = "info") => {
    if (!status) return;
    status.textContent = txt || "";
    status.classList.remove(
      "text-slate-400",
      "text-emerald-300",
      "text-rose-300"
    );
    status.classList.add(
      kind === "success"
        ? "text-emerald-300"
        : kind === "error"
        ? "text-rose-300"
        : "text-slate-400"
    );
  };
  if (!cfg.repo) {
    setStatus("Сначала укажи репо в Настройках выше.", "error");
    return;
  }
  if (!cfg.token) {
    setStatus("Сначала введи и сохрани GitHub-токен.", "error");
    return;
  }
  if (!bucket.count) {
    setStatus("Нечего загружать.", "error");
    return;
  }
  btn.disabled = true;
  setStatus("Шифрую и отправляю…");
  try {
    const body = formatNetscapeCookies(bucket.cookies);
    const v = await uploadGitHubSecret(bucket.secretName, body);
    setStatus(
      `Готово · обновлён ${formatSecretTs(v)}`,
      "success"
    );
    toast(`${bucket.secretName} загружен в GitHub.`, "success");
  } catch (err) {
    const msg = err.message || String(err);
    const hint = /\b403\b/.test(msg)
      ? " У токена должно быть «Secrets: Read and Write»."
      : "";
    setStatus(`Ошибка: ${msg}${hint}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function uploadAllCookieBuckets(buckets, btn) {
  if (!cfg.repo) {
    setCookieWizardStatus("Сначала укажи репо в Настройках выше.", "error");
    return;
  }
  if (!cfg.token) {
    setCookieWizardStatus(
      "Сначала введи и сохрани GitHub-токен выше.",
      "error"
    );
    return;
  }
  const nonEmpty = buckets.filter((b) => b.count > 0);
  if (!nonEmpty.length) {
    setCookieWizardStatus(
      "В файле не нашлось куков ни одного из известных сайтов.",
      "error"
    );
    return;
  }
  btn.disabled = true;
  setCookieWizardStatus(
    `Загружаю ${nonEmpty.length} секрет(а)…`,
    "info"
  );
  let ok = 0;
  let fail = 0;
  const errors = [];
  for (const bucket of nonEmpty) {
    const status = document.querySelector(
      `[data-bucket-status="${bucket.id}"]`
    );
    if (status) {
      status.textContent = "загрузка…";
      status.classList.remove("text-emerald-300", "text-rose-300");
      status.classList.add("text-slate-400");
    }
    try {
      const body = formatNetscapeCookies(bucket.cookies);
      const v = await uploadGitHubSecret(bucket.secretName, body);
      ok++;
      if (status) {
        status.textContent = `OK · ${formatSecretTs(v)}`;
        status.classList.remove("text-slate-400", "text-rose-300");
        status.classList.add("text-emerald-300");
      }
    } catch (err) {
      fail++;
      const msg = err.message || String(err);
      errors.push(`${bucket.secretName}: ${msg}`);
      if (status) {
        status.textContent = `ошибка: ${msg}`;
        status.classList.remove("text-slate-400", "text-emerald-300");
        status.classList.add("text-rose-300");
      }
    }
  }
  btn.disabled = false;
  if (fail === 0) {
    setCookieWizardStatus(
      `Готово: ${ok} секрет(ов) обновлены.`,
      "success"
    );
    toast(`Куки загружены: ${ok} секрет(ов).`, "success");
  } else {
    setCookieWizardStatus(
      `Часть не получилась (${fail}). Ошибки: ${errors.join("; ")}`,
      "error"
    );
  }
}

function bindCookieWizard() {
  const fileBtn = $("#cookie-wizard-pick");
  const fileInput = $("#cookie-wizard-file");
  const dropZone = $("#cookie-wizard-drop");
  const uploadAllBtn = $("#cookie-wizard-upload-all");
  if (!fileInput || !dropZone || !fileBtn || !uploadAllBtn) return;

  let lastBuckets = [];

  const handleText = (raw) => {
    setCookieWizardStatus("");
    if (!raw || !raw.trim()) {
      setCookieWizardStatus("Файл пустой.", "error");
      renderCookieWizardBuckets([]);
      lastBuckets = [];
      return;
    }
    if (!looksLikeNetscapeCookies(raw)) {
      setCookieWizardStatus(
        "Это не похоже на Netscape cookies.txt. Экспортируй через расширение «Get cookies.txt LOCALLY» или «cookies.txt» (Firefox).",
        "error"
      );
      renderCookieWizardBuckets([]);
      lastBuckets = [];
      return;
    }
    const parsed = parseNetscapeCookies(raw);
    const buckets = bucketizeCookies(parsed.cookies);
    lastBuckets = buckets;
    renderCookieWizardBuckets(buckets);
    const total = buckets.reduce((a, b) => a + b.count, 0);
    const known = buckets.filter((b) => b.count > 0).length;
    if (!total) {
      setCookieWizardStatus(
        `Распарсил ${parsed.cookies.length} cookie из ${parsed.totalLines} строк, но среди них нет ни одного из известных сайтов (YouTube/RuTracker/Kinozal/NNM).`,
        "error"
      );
    } else {
      setCookieWizardStatus(
        `Готово: ${parsed.cookies.length} cookie из ${parsed.totalLines} строк, для ${known} сайт(ов) (всего ${total} cookie). Жми «Загрузить как …» по каждому, или «Загрузить все» — внизу.`,
        "success"
      );
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    setCookieWizardStatus(`Читаю ${file.name}…`, "info");
    try {
      const raw = await file.text();
      handleText(raw);
    } catch (err) {
      setCookieWizardStatus(
        `Не получилось прочитать файл: ${err.message || err}`,
        "error"
      );
    }
  };

  fileBtn.addEventListener("click", (e) => {
    e.preventDefault();
    fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
  });

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("ring-2", "ring-accent-500");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("ring-2", "ring-accent-500");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("ring-2", "ring-accent-500");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  uploadAllBtn.addEventListener("click", () => {
    if (!lastBuckets.length) {
      setCookieWizardStatus(
        "Сначала загрузи cookies.txt (кнопкой или drag-and-drop).",
        "error"
      );
      return;
    }
    uploadAllCookieBuckets(lastBuckets, uploadAllBtn);
  });
}

// ---------- Tracker creds uploader ----------
const TRACKER_FIELDS = [
  {
    id: "rutracker",
    label: "RuTracker",
    userInput: "#trk-rutracker-user",
    passInput: "#trk-rutracker-pass",
    userSecret: "RUTRACKER_USERNAME",
    passSecret: "RUTRACKER_PASSWORD",
  },
  {
    id: "kinozal",
    label: "Kinozal",
    userInput: "#trk-kinozal-user",
    passInput: "#trk-kinozal-pass",
    userSecret: "KINOZAL_USERNAME",
    passSecret: "KINOZAL_PASSWORD",
  },
  {
    id: "nnm",
    label: "NNM-Club",
    userInput: "#trk-nnm-user",
    passInput: "#trk-nnm-pass",
    userSecret: "NNM_USERNAME",
    passSecret: "NNM_PASSWORD",
  },
];

function setTrackersStatus(text, kind = "info") {
  const el = $("#trackers-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove(
    "hidden",
    "text-slate-400",
    "text-emerald-300",
    "text-rose-300"
  );
  if (!text) {
    el.classList.add("hidden");
    return;
  }
  const cls =
    kind === "success"
      ? "text-emerald-300"
      : kind === "error"
      ? "text-rose-300"
      : "text-slate-400";
  el.classList.add(cls);
}

function bindTrackersUpload() {
  const btn = $("#trackers-upload");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    setTrackersStatus("");
    if (!cfg.repo) {
      setTrackersStatus("Сначала укажи репозиторий в Настройках выше.", "error");
      return;
    }
    if (!cfg.token) {
      setTrackersStatus(
        "Сначала введи GitHub-токен выше и нажми «Сохранить».",
        "error"
      );
      return;
    }

    const pairs = [];
    const errors = [];
    for (const t of TRACKER_FIELDS) {
      const u = $(t.userInput).value.trim();
      const p = $(t.passInput).value;
      if (!u && !p) continue;
      if (!u || !p) {
        errors.push(t.label);
        continue;
      }
      pairs.push({ name: t.userSecret, value: u, label: t.label });
      pairs.push({ name: t.passSecret, value: p, label: t.label });
    }

    if (errors.length) {
      setTrackersStatus(
        `Заполни и логин, и пароль: ${errors.join(", ")}.`,
        "error"
      );
      return;
    }
    if (!pairs.length) {
      setTrackersStatus(
        "Нечего загружать — заполни хотя бы один трекер.",
        "error"
      );
      return;
    }

    btn.disabled = true;
    setTrackersStatus("Шифрую в браузере и отправляю…");
    try {
      const uploaded = [];
      for (const pair of pairs) {
        const v = await uploadGitHubSecret(pair.name, pair.value);
        uploaded.push(`${pair.name} (${formatSecretTs(v)})`);
      }
      setTrackersStatus(
        `Записано в GitHub Secrets и подтверждено GET-ом: ${uploaded.join(
          "; "
        )}.`,
        "success"
      );
      toast("Секреты трекеров загружены в GitHub.", "success");
      // Mirror tracker creds into cfg so they sync to Drive and can be
      // re-uploaded to GitHub Secrets on a fresh device without re-typing.
      const trackers = { ...(cfg.trackers || {}) };
      for (const t of TRACKER_FIELDS) {
        const u = $(t.userInput).value.trim();
        const p = $(t.passInput).value;
        if (u && p) trackers[t.id] = { user: u, pass: p };
      }
      cfg = { ...cfg, trackers };
      saveCfg(cfg);
      if (cfg.accountAutoPush && cfg.driveSaJson && cfg.driveFolderId) {
        backupCfgToDrive().catch(() => {});
      }
      for (const t of TRACKER_FIELDS) {
        $(t.passInput).value = "";
      }
    } catch (err) {
      const msg = err.message || String(err);
      const hint = /\b403\b/.test(msg)
        ? " У токена должно быть право «Secrets: Read and Write»."
        : "";
      setTrackersStatus(`Ошибка: ${msg}${hint}`, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------- Tracker search ----------
const SEARCH_WORKFLOW = "search.yml";
const SEARCH_RESULTS_ARTIFACT = "search-results";
const JSZIP_CDN_URL =
  "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
let _jszipLoading = null;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (_jszipLoading) return _jszipLoading;
  _jszipLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JSZIP_CDN_URL;
    s.crossOrigin = "anonymous";
    s.onload = () =>
      window.JSZip
        ? resolve(window.JSZip)
        : reject(new Error("JSZip не загрузился."));
    s.onerror = () =>
      reject(
        new Error(
          "Не удалось загрузить JSZip с CDN. Проверь интернет / расширения."
        )
      );
    document.head.appendChild(s);
  });
  return _jszipLoading;
}

// Stage names mirror the step names in .github/workflows/search.yml so the UI
// can render real-time progress just by polling /jobs. Each entry's `slug`
// also matches the slug each tracker writes into results.json so we can swap
// the workflow-step view for the real per-tracker status once the artifact
// is downloaded.
const SEARCH_STAGES = [
  { slug: "rutracker", name: "RuTracker", match: /rutracker/i },
  // Match the workflow's "Search Rutor" step name. Keep this entry above
  // the "RuTracker" check would not work because the regex anchors fall
  // through, but Rutor's regex is more specific (\brutor\b) so order
  // doesn't matter. We keep it next to RuTracker for diagnostic clarity.
  { slug: "rutor", name: "Rutor", match: /\brutor\b/i },
  { slug: "apibay", name: "Pirate Bay", match: /pirate\s*bay|apibay/i },
  { slug: "kinozal", name: "Kinozal", match: /kinozal/i },
  { slug: "nnm", name: "NNM-Club", match: /nnm/i },
  { slug: "aggregate", name: "Свод результатов", match: /aggregate|свод/i },
  { slug: "upload", name: "Загрузка артефакта", match: /artifact|upload/i },
];

const STAGE_ICONS = {
  pending: "○",
  in_progress: "◐",
  success: "●",
  failure: "×",
  skipped: "·",
  cancelled: "·",
  neutral: "●",
  empty: "·",
  blocked: "×",
  ok: "●",
  failed: "×",
};

function setSearchError(text) {
  const el = $("#search-error");
  if (el) el.textContent = text || "";
}

// Map a tracker-status slug from results.json onto the visual key the row
// renderer understands. Trackers report their actual outcome (ok / empty /
// blocked / skipped / failed); the workflow only exposes step.conclusion
// which is `success` even when the script gave up — that's exactly the bug
// we are fixing.
function _statusToKey(status) {
  switch (status) {
    case "ok":
      return "success";
    case "empty":
      return "empty";
    case "skipped":
      return "skipped";
    case "blocked":
      return "blocked";
    case "failed":
      return "failure";
    default:
      return "pending";
  }
}

function _stageVisualClass(key) {
  if (key === "in_progress") return "text-accent-300 animate-pulse";
  if (key === "failure" || key === "blocked" || key === "cancelled" || key === "timed_out")
    return "text-rose-300";
  if (key === "success" || key === "neutral" || key === "ok")
    return "text-emerald-300";
  if (key === "empty") return "text-amber-300";
  if (key === "skipped") return "text-slate-500";
  return "text-slate-500";
}

function _stageVisualLabel(key, count, reason) {
  if (key === "in_progress") return "идёт";
  if (key === "success" || key === "ok")
    return count ? `готово · ${count}` : "готово";
  if (key === "empty") return "ничего не нашлось";
  if (key === "blocked") return reason || "трекер заблокировал";
  if (key === "failure" || key === "failed")
    return reason || "ошибка";
  if (key === "skipped")
    return reason || "пропущен (нет логина)";
  if (key === "cancelled") return "отменён";
  return "ждёт";
}

function renderSearchStages(steps, opts) {
  // `opts.stages` is the per-tracker status payload from results.json once
  // we have it. While the workflow is still running we fall back to the
  // step list (steps[]) — that's the only signal available mid-run.
  const wrap = $("#search-progress");
  const list = $("#search-stages");
  if (!wrap || !list) return;
  wrap.classList.remove("hidden");
  list.innerHTML = "";
  const stagesByslug = new Map();
  if (opts && Array.isArray(opts.stages)) {
    for (const s of opts.stages) {
      if (s && s.slug) stagesByslug.set(s.slug, s);
    }
  }
  for (const stage of SEARCH_STAGES) {
    let key = "pending";
    let count = 0;
    let reason = "";
    const fromResults = stagesByslug.get(stage.slug);
    if (fromResults) {
      key = _statusToKey(fromResults.status);
      count = Number(fromResults.count) || 0;
      reason = fromResults.reason || "";
    } else {
      const step = steps.find((s) => stage.match.test(s.name || ""));
      if (step) {
        if (step.status === "completed") {
          key = step.conclusion || "success";
        } else if (step.status === "in_progress" || step.status === "queued") {
          key = "in_progress";
        }
      }
    }
    const li = document.createElement("li");
    li.className = "flex items-center gap-2 text-sm";
    const icon = document.createElement("span");
    icon.className = _stageVisualClass(key);
    icon.textContent = STAGE_ICONS[key] || "○";
    const label = document.createElement("span");
    label.className =
      key === "pending" ? "text-slate-400" : "text-slate-100";
    label.textContent = stage.name;
    const sub = document.createElement("span");
    sub.className = "ml-auto truncate text-xs text-slate-500";
    sub.textContent = _stageVisualLabel(key, count, reason);
    if (reason) li.title = reason;
    li.appendChild(icon);
    li.appendChild(label);
    li.appendChild(sub);
    list.appendChild(li);
  }
}

function formatBytes(n) {
  if (!n || n <= 0) return "—";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

function renderSearchResults(items) {
  const wrap = $("#search-results");
  const list = $("#search-results-list");
  const count = $("#search-results-count");
  if (!wrap || !list) return;
  wrap.classList.remove("hidden");
  list.innerHTML = "";
  count.textContent = items.length ? `${items.length} шт.` : "";
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className =
      "rounded-xl border border-white/10 bg-ink-900/40 p-3 text-sm text-slate-400";
    empty.textContent =
      "Ничего не нашлось. Попробуй другой запрос или добавь логин трекера в Настройках.";
    list.appendChild(empty);
    return;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.className =
      "group flex items-start gap-3 rounded-xl border border-white/10 bg-ink-900/60 p-3 hover:border-accent-400/40";

    const meta = document.createElement("div");
    meta.className = "min-w-0 grow";
    const title = document.createElement("div");
    title.className = "truncate text-sm font-medium text-slate-100";
    title.textContent = item.title || "(без названия)";
    const sub = document.createElement("div");
    sub.className = "mt-0.5 truncate text-xs text-slate-500";
    const seedersText =
      typeof item.seeders === "number" ? `🌱 ${item.seeders}` : "🌱 ?";
    const sizeText = item.size ? formatBytes(item.size) : "—";
    sub.textContent = `${item.tracker} · ${sizeText} · ${seedersText}`;
    meta.appendChild(title);
    meta.appendChild(sub);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "shrink-0 rounded-lg bg-gradient-to-r from-accent-500 to-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white shadow-lg shadow-accent-500/30 disabled:cursor-not-allowed disabled:opacity-60";
    btn.textContent = "Закинуть";
    btn.addEventListener("click", () => beamMagnet(item, btn));

    li.appendChild(meta);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function beamMagnet(item, btn) {
  if (!item || !item.magnet) {
    toast("У этого результата нет магнет-ссылки.", "error");
    return;
  }
  $("#url").value = item.magnet;
  $("#filename").value = item.title || "";
  setSearchError("");
  if (!isReady()) {
    showSetupHint(true);
    openSettings();
    return;
  }
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = "Закидываем…";
  try {
    const gh = new GitHubClient(cfg);
    const ref = await resolveBranch();
    if (!ref) {
      throw new Error("Не получилось определить ветку репо.");
    }
    // Snapshot existing run ids so trackDispatchedRun can find the new
    // one by id (clock-skew-proof).
    const knownRunIds = await snapshotRunIds(gh, cfg.workflow);
    const dispatchedAt = Date.now();
    await gh.dispatchWorkflow({
      ref,
      inputs: {
        url: item.magnet,
        filename: item.title || "",
        subfolder: "",
        quality: "auto",
        ytdlp_format: "",
      },
    });
    toast("Запущено — раннер качает торрент…", "success");
    setTimeout(() => refreshRuns(true), 1500);
    openProgressDialog(`Закидываем: ${item.title || "торрент"}`);
    trackDispatchedRun(cfg.workflow, dispatchedAt, "Закидывание", knownRunIds).catch(
      () => {}
    );
  } catch (err) {
    console.error(err);
    toast(`Ошибка: ${err.message || err}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

class GitHubSearchClient extends GitHubClient {
  async getWorkflow(workflowFile) {
    return this._fetch(
      `/repos/${this.cfg.repo}/actions/workflows/${encodeURIComponent(
        workflowFile
      )}`
    );
  }

  async listRunsForWorkflow(workflowFile, params = {}) {
    const qs = new URLSearchParams({ per_page: "10", ...params }).toString();
    return this._fetch(
      `/repos/${this.cfg.repo}/actions/workflows/${encodeURIComponent(
        workflowFile
      )}/runs?${qs}`
    );
  }

  async getRunJobs(runId) {
    return this._fetch(
      `/repos/${this.cfg.repo}/actions/runs/${runId}/jobs?per_page=20`
    );
  }

  async listRunArtifacts(runId) {
    return this._fetch(
      `/repos/${this.cfg.repo}/actions/runs/${runId}/artifacts`
    );
  }

  async fetchArtifactZip(artifact) {
    // Returns a 302 redirect to a signed Azure URL. Browser fetch follows it.
    const res = await fetch(
      `https://api.github.com/repos/${this.cfg.repo}/actions/artifacts/${artifact.id}/zip`,
      { headers: this.headers, redirect: "follow" }
    );
    if (!res.ok) {
      throw new Error(
        `Не удалось скачать артефакт: GitHub ${res.status}.`
      );
    }
    return res.arrayBuffer();
  }
}

function bindSearch() {
  const btn = $("#search-btn");
  const input = $("#search-query");
  if (!btn || !input) return;

  const runSearch = async () => {
    setSearchError("");
    const query = input.value.trim();
    if (query.length < 2) {
      setSearchError("Введи хотя бы 2 символа для поиска.");
      return;
    }
    if (!isReady()) {
      showSetupHint(true);
      openSettings();
      return;
    }

    $("#search-results").classList.add("hidden");
    $("#search-results-list").innerHTML = "";

    btn.disabled = true;
    const lbl = $("#search-btn-label");
    const oldLabel = lbl.textContent;
    lbl.textContent = "Запускаем…";

    let dispatchedAt = null;
    try {
      const gh = new GitHubSearchClient(cfg);

      try {
        await gh.getWorkflow(SEARCH_WORKFLOW);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/\b404\b/.test(msg)) {
          throw new Error(
            `В репо нет workflow ${SEARCH_WORKFLOW}. Смержь PR с поиском и попробуй снова.`
          );
        }
        throw err;
      }

      const ref = await resolveBranch();
      if (!ref) throw new Error("Не получилось определить ветку репо.");

      // Snapshot recent run IDs *before* dispatch so we can detect the new
      // run by id. Comparing created_at against Date.now() is unreliable on
      // mobiles with skewed clocks — the device timestamp can land ahead of
      // the GitHub server timestamp by minutes, and no run ever satisfies
      // the predicate.
      const knownRunIds = await snapshotRunIds(gh, SEARCH_WORKFLOW);

      dispatchedAt = Date.now();
      // Dispatch search.yml with the query input.
      await gh._fetch(
        `/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(
          SEARCH_WORKFLOW
        )}/dispatches`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref, inputs: { query } }),
        }
      );
      toast("Поиск запущен — слежу за этапами…", "info");

      renderSearchStages([]);

      // Locate the run we just dispatched (by id, not by timestamp).
      const run = await waitForRun(gh, knownRunIds);
      if (!run) throw new Error("Не нашёл наш запуск среди недавних.");

      // Poll job steps until the run is completed.
      const jobs = await pollRunUntilDone(gh, run.id);
      const job = jobs && jobs[0];
      const conclusion = job ? job.conclusion : null;
      if (conclusion && conclusion !== "success" && conclusion !== "neutral") {
        throw new Error(
          `Workflow завершился со статусом «${conclusion}». Посмотри лог в GitHub.`
        );
      }

      const { items, stages } = await downloadResults(gh, run.id);
      // Re-render the stage list with the per-tracker truth (`stages`)
      // instead of leaving the workflow's "all green" status visible.
      renderSearchStages(job ? job.steps || [] : [], { stages });
      renderSearchResults(items);
      if (!items.length) {
        toast("Ничего не нашлось.", "info");
      } else {
        toast(`Готово: ${items.length} результатов.`, "success");
      }
    } catch (err) {
      console.error(err);
      setSearchError(err.message || String(err));
      toast(`Ошибка поиска: ${err.message || err}`, "error");
    } finally {
      btn.disabled = false;
      lbl.textContent = oldLabel;
    }
  };

  btn.addEventListener("click", runSearch);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
}

// Snapshots the IDs of recent workflow_dispatch runs for `workflowFile`.
// Used to detect a freshly-dispatched run by id (robust against device
// clock skew that breaks created_at-based matching).
async function snapshotRunIds(gh, workflowFile) {
  const known = new Set();
  try {
    const data = await gh.listRunsForWorkflow(workflowFile, {
      event: "workflow_dispatch",
      per_page: "20",
    });
    for (const r of data.workflow_runs || []) known.add(r.id);
  } catch (err) {
    console.warn("snapshotRunIds:", err);
  }
  return known;
}

async function waitForRun(gh, knownRunIds) {
  const deadline = Date.now() + 90 * 1000;
  while (Date.now() < deadline) {
    try {
      const data = await gh.listRunsForWorkflow(SEARCH_WORKFLOW, {
        event: "workflow_dispatch",
      });
      const runs = data.workflow_runs || [];
      // /runs returns newest first — pick the first id we did not see in
      // the pre-dispatch snapshot.
      const run = runs.find((r) => !knownRunIds.has(r.id));
      if (run) return run;
    } catch (err) {
      console.warn("waitForRun:", err);
    }
    await sleep(2000);
  }
  return null;
}

async function pollRunUntilDone(gh, runId) {
  // Returns the final list of jobs once the run is completed.
  const deadline = Date.now() + 8 * 60 * 1000; // 8 min cap.
  let lastJobs = [];
  while (Date.now() < deadline) {
    let data;
    try {
      data = await gh.getRunJobs(runId);
    } catch (err) {
      console.warn("getRunJobs:", err);
      await sleep(3000);
      continue;
    }
    lastJobs = data.jobs || [];
    const job = lastJobs[0];
    if (job) renderSearchStages(job.steps || []);
    const allDone =
      lastJobs.length > 0 &&
      lastJobs.every((j) => j.status === "completed");
    if (allDone) return lastJobs;
    await sleep(3000);
  }
  return lastJobs;
}

async function downloadResults(gh, runId) {
  // Wait for artifact to appear (sometimes lags a bit after run completion).
  const deadline = Date.now() + 60 * 1000;
  let artifact = null;
  while (Date.now() < deadline) {
    const data = await gh.listRunArtifacts(runId);
    artifact = (data.artifacts || []).find(
      (a) => a.name === SEARCH_RESULTS_ARTIFACT
    );
    if (artifact) break;
    await sleep(2000);
  }
  if (!artifact) {
    throw new Error(
      "Артефакт с результатами не появился. Открой запуск в GitHub и посмотри лог."
    );
  }

  let buf;
  try {
    buf = await gh.fetchArtifactZip(artifact);
  } catch (err) {
    throw new Error(
      `Браузер не смог скачать артефакт (${
        err.message || err
      }). Открой запуск в GitHub и скачай results.json вручную.`
    );
  }

  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file("results.json");
  if (!entry) {
    throw new Error("В артефакте нет файла results.json.");
  }
  const text = await entry.async("string");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`results.json не парсится: ${err.message || err}`);
  }
  if (Array.isArray(parsed)) {
    // Old (schema 1) artifact: just an items array.
    return { items: parsed, stages: [] };
  }
  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    stages: Array.isArray(parsed.stages) ? parsed.stages : [],
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Account-sync UI ----------
function updateAccountStatus() {
  const el = $("#account-status");
  if (!el) return;
  if (!cfg.driveSaJson || !cfg.driveFolderId) {
    el.textContent =
      "Заполни service-account JSON и Folder ID ниже — это и есть «логин» аккаунта.";
    el.className = "mt-3 text-xs text-amber-300";
    return;
  }
  el.textContent = "Drive подключён. «Сохранить в Drive» отправит настройки в файл film-beamer-config.json.";
  el.className = "mt-3 text-xs text-emerald-300";
}

function bindAccountSync() {
  const pull = $("#account-pull");
  const push = $("#account-push");
  if (!pull || !push) return;

  pull.addEventListener("click", async () => {
    if (!cfg.driveSaJson || !cfg.driveFolderId) {
      toast(
        "Сначала заполни service-account JSON и Folder ID ниже.",
        "error"
      );
      return;
    }
    pull.disabled = true;
    const old = pull.textContent;
    pull.textContent = "Качаю…";
    try {
      await restoreCfgFromDrive();
      // Re-render dialog from the freshly loaded cfg.
      $("#cfg-repo").value = cfg.repo || "";
      $("#cfg-branch").value = cfg.branch || "";
      $("#cfg-workflow").value = cfg.workflow || "download-to-drive.yml";
      $("#cfg-token").value = cfg.token || "";
      for (const t of TRACKER_FIELDS) {
        const u = $(t.userInput);
        const p = $(t.passInput);
        if (u) u.value = cfg.trackers?.[t.id]?.user || "";
        if (p) p.value = cfg.trackers?.[t.id]?.pass || "";
      }
      ensureRepoLink();
      showSetupHint(!isReady());
      toast("Подгружено из Drive.", "success");
    } catch (err) {
      toast(`Не удалось: ${err.message || err}`, "error", 5000);
    } finally {
      pull.disabled = false;
      pull.textContent = old;
    }
  });

  push.addEventListener("click", async () => {
    if (!cfg.driveSaJson || !cfg.driveFolderId) {
      toast(
        "Сначала заполни service-account JSON и Folder ID ниже.",
        "error"
      );
      return;
    }
    push.disabled = true;
    const old = push.textContent;
    push.textContent = "Сохраняю…";
    try {
      await backupCfgToDrive();
      toast("Сохранено в Drive.", "success");
    } catch (err) {
      toast(`Не удалось: ${err.message || err}`, "error", 5000);
    } finally {
      push.disabled = false;
      push.textContent = old;
    }
  });
}

// On startup, if we already have SA + folder configured, transparently pull
// the latest cfg from Drive and apply it. This is what makes the "log in
// from another device" flow seamless: paste the same SA + folder once and
// everything else materialises.
async function bootstrapAccountSync() {
  if (!cfg.driveSaJson || !cfg.driveFolderId) return;
  try {
    const token = await getDriveAccessToken();
    const existing = await findDriveCfgFile(token, cfg.driveFolderId);
    if (!existing) return;
    const content = await downloadDriveCfg(token, existing.id);
    applySyncBlob(content);
    ensureRepoLink();
    showSetupHint(!isReady());
    refreshRuns(true);
  } catch (err) {
    console.warn("bootstrapAccountSync:", err);
  }
}

// ---------- Run progress modal ----------
//
// Mirrors the step names in .github/workflows/download-to-drive.yml so the
// UI can render "where are we" without parsing logs. The matchers are
// intentionally loose so a workflow rename doesn't immediately break the UI,
// but each stage knows the *exact* step name(s) it usually corresponds to so
// the matchers don't accidentally collapse "Install tools" into "Configure
// rclone" (that was the bug behind tracker rows getting stuck on "ждёт"
// forever — the matchers were so loose multiple stages bound to the same
// step and then "Loading…" never advanced past the first match).
const DISPATCH_STAGES = [
  {
    id: "validate",
    name: "Проверка инпутов",
    match: /validate inputs|detect downloader|check secrets/i,
  },
  {
    id: "install",
    name: "Установка инструментов",
    match: /^install tools|install tools$|setup tools|install deps/i,
  },
  {
    id: "rclone",
    name: "Настройка rclone",
    match: /configure rclone|rclone (config|setup)/i,
  },
  {
    id: "workspace",
    name: "Подготовка рабочей папки",
    match: /prepare workspace|workspace/i,
  },
  {
    id: "download",
    name: "Скачивание",
    match: /download with (aria2|yt-?dlp)|^download |downloading|yt-?dlp$/i,
  },
  {
    id: "upload",
    name: "Загрузка на Drive",
    match: /upload to (google )?drive|rclone copy|^upload$/i,
  },
  {
    id: "cleanup",
    name: "Очистка",
    match: /^cleanup$|^clean$|tear ?down/i,
  },
];

// "Setup-y" GitHub-injected steps we don't want to count as either a real
// stage or as "unmatched": they're noise for the user but they DO appear in
// /jobs and used to confuse the matchers.
const DISPATCH_NOISE_STEPS = [
  /^set up job$/i,
  /^complete job$/i,
  /^post /i,
];

function isNoiseStep(step) {
  if (!step || !step.name) return false;
  return DISPATCH_NOISE_STEPS.some((re) => re.test(step.name));
}

// Map of stage.id → matching `step` object. Useful for diagnostics and to
// answer "what's the very current step's full name?".
function indexStepsByStage(steps) {
  const out = {};
  if (!Array.isArray(steps)) return out;
  for (const stage of DISPATCH_STAGES) {
    out[stage.id] = steps.find(
      (s) => !isNoiseStep(s) && stage.match.test(s.name || "")
    );
  }
  return out;
}

// Classify the *overall* run from its job/steps so the UI can show the
// right pill at the top: "В очереди", "Идёт: <step>", "Готово", "Ошибка".
function summariseRun(run, job) {
  if (!run) return { kind: "queued", text: "Ждём GitHub…" };
  if (run.status === "queued") return { kind: "queued", text: "В очереди" };
  if (run.status === "completed") {
    if (run.conclusion === "success" || run.conclusion === "neutral") {
      return { kind: "success", text: "Готово" };
    }
    if (run.conclusion === "skipped") {
      return { kind: "skipped", text: "Пропущен" };
    }
    return {
      kind: "failure",
      text:
        run.conclusion === "failure"
          ? "Раннер упал"
          : `Завершён: ${run.conclusion || "—"}`,
    };
  }
  if (job && job.status === "in_progress") {
    const cur = (job.steps || []).find(
      (s) => s.status === "in_progress" && !isNoiseStep(s)
    );
    if (cur) return { kind: "running", text: `Идёт: ${cur.name}` };
    return { kind: "running", text: "Идёт…" };
  }
  return { kind: "running", text: STATUS_LABELS[run.status] || run.status };
}

// Format a step's elapsed/total time as "12с", "1м 04с", "3м", "—".
function formatStepDuration(step, now) {
  if (!step) return "";
  const startStr = step.started_at;
  if (!startStr) return "";
  const start = new Date(startStr).getTime();
  if (!Number.isFinite(start)) return "";
  const endStr = step.completed_at || null;
  const end = endStr ? new Date(endStr).getTime() : (now || Date.now());
  if (!Number.isFinite(end) || end < start) return "";
  const ms = Math.max(0, end - start);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}м ${String(rem).padStart(2, "0")}с` : `${m}м`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}

function renderProgressStages(steps, opts) {
  const list = $("#progress-stages");
  if (!list) return;
  const now = (opts && opts.now) || Date.now();
  list.innerHTML = "";
  let currentStepName = null;
  for (const stage of DISPATCH_STAGES) {
    const step = (Array.isArray(steps) ? steps : []).find(
      (s) => !isNoiseStep(s) && stage.match.test(s.name || "")
    );
    let key = "pending";
    if (step) {
      if (step.status === "completed") key = step.conclusion || "success";
      else if (step.status === "in_progress" || step.status === "queued")
        key = "in_progress";
    }
    if (key === "in_progress" && step) currentStepName = step.name;

    const li = document.createElement("li");
    li.className = `stage-row ${key}`;
    li.dataset.stageId = stage.id;

    const icon = document.createElement("span");
    icon.className = "stage-icon";
    if (key === "failure" || key === "cancelled" || key === "timed_out") {
      icon.classList.add("text-rose-300");
    } else if (key === "success" || key === "neutral") {
      icon.classList.add("text-emerald-300");
    } else if (key === "in_progress") {
      icon.classList.add("text-accent-300");
    } else {
      icon.classList.add("text-slate-500");
    }
    icon.textContent = STAGE_ICONS[key] || "○";

    const detail = document.createElement("div");
    detail.className = "stage-detail";
    const name = document.createElement("span");
    name.className = "stage-name";
    name.textContent = stage.name;
    detail.appendChild(name);
    if (step && step.name && step.name.trim().toLowerCase() !== stage.name.trim().toLowerCase()) {
      const sub = document.createElement("span");
      sub.className = "stage-sub";
      sub.textContent = step.name;
      detail.appendChild(sub);
    }

    const tail = document.createElement("span");
    tail.className = "stage-tail";
    if (key === "in_progress") {
      const dur = step ? formatStepDuration(step, now) : "";
      tail.textContent = dur ? `идёт · ${dur}` : "идёт";
    } else if (key === "success") {
      tail.textContent = step ? `готово · ${formatStepDuration(step, now)}` : "готово";
    } else if (key === "failure") {
      tail.textContent = "ошибка";
    } else if (key === "skipped") {
      tail.textContent = "пропущен";
    } else if (key === "cancelled") {
      tail.textContent = "отменён";
    } else if (key === "timed_out") {
      tail.textContent = "таймаут";
    } else if (key === "neutral") {
      tail.textContent = "нейтрально";
    } else {
      tail.textContent = "ждёт";
    }

    li.appendChild(icon);
    li.appendChild(detail);
    li.appendChild(tail);
    list.appendChild(li);
  }
  return { currentStepName };
}

let _progressActive = false;
// The currently tracked run, if any. We store this so the polling loop can
// recover state on reload (via sessionStorage) and so the diagnostics panel
// can show "sees the same run as the live progress dialog".
let _trackedRun = null;
let _progressStartedAt = 0;
// Cancellation token for the in-flight tracker loop. Each call to
// trackDispatchedRun bumps this so a stale loop from a previous dispatch
// doesn't keep updating the dialog over a fresh dispatch.
let _trackEpoch = 0;

function openProgressDialog(title) {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  hideRestorePill();
  $("#progress-title").textContent = title || "Запуск раннера…";
  $("#progress-subtitle").textContent =
    "Ждём, пока GitHub зарегистрирует запуск…";
  const link = $("#progress-link");
  if (link) link.classList.add("hidden");
  const meta = $("#progress-meta");
  if (meta) meta.classList.add("hidden");
  const elapsed = $("#progress-elapsed");
  if (elapsed) elapsed.textContent = "—";
  const cur = $("#progress-current-step");
  if (cur) cur.textContent = "—";
  const log = $("#progress-log");
  if (log) log.textContent = "";
  const logWrap = $("#progress-log-wrap");
  if (logWrap) logWrap.removeAttribute("open");
  renderProgressStages([]);
  dlg.classList.remove("hidden");
  _progressActive = true;
  _progressStartedAt = Date.now();
  startProgressMetaTicker();
}

// «Свернуть» on the dialog used to call closeProgressDialog() outright,
// which also stopped the meta ticker and zeroed _progressActive — the run
// vanished from the user's view with no way to bring it back. Now we have
// two states: the modal can be `hidden` while `_progressActive` is still
// true, in which case a fixed restore pill at the bottom-right keeps the
// run reachable until it actually completes.
function showRestorePill() {
  const pill = $("#progress-restore");
  if (pill) pill.classList.add("visible");
}
function hideRestorePill() {
  const pill = $("#progress-restore");
  if (pill) pill.classList.remove("visible");
}

function hideProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  dlg.classList.add("hidden");
  // Keep _progressActive + the meta ticker running so the elapsed clock
  // doesn't reset when the user re-opens the panel.
  if (_progressActive) showRestorePill();
}

function reopenProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  dlg.classList.remove("hidden");
  hideRestorePill();
}

function closeProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  dlg.classList.add("hidden");
  hideRestorePill();
  _progressActive = false;
  stopProgressMetaTicker();
}

function bindProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  const closeBtn = $("#progress-close");
  if (closeBtn) closeBtn.addEventListener("click", closeProgressDialog);
  const hideBtn = $("#progress-hide");
  // Minimise = hide the modal but keep the run reachable via the pill.
  if (hideBtn) hideBtn.addEventListener("click", hideProgressDialog);
  dlg.addEventListener("click", (e) => {
    // Backdrop tap is treated as «свернуть», not «закрыть» — the user is
    // probably trying to look at the page while the runner spins.
    if (e.target.id === "progress-dialog") hideProgressDialog();
  });
  const pill = $("#progress-restore");
  if (pill) pill.addEventListener("click", reopenProgressDialog);
}

// Drives the "Длительность" / "Текущий шаг" mini-card in the dialog so
// users see a clock that ticks even when GitHub's API is slow to respond.
let _progressTickerId = null;
let _progressLastSubtitle = "";
let _progressLastCurrentStep = "";
function startProgressMetaTicker() {
  stopProgressMetaTicker();
  _progressTickerId = setInterval(() => {
    if (!_progressActive) {
      stopProgressMetaTicker();
      return;
    }
    const meta = $("#progress-meta");
    const el = $("#progress-elapsed");
    if (!meta || !el) return;
    if (_progressStartedAt) {
      meta.classList.remove("hidden");
      const ms = Date.now() - _progressStartedAt;
      const s = Math.floor(ms / 1000);
      const m = Math.floor(s / 60);
      const rest = s % 60;
      el.textContent = m
        ? `${m}м ${String(rest).padStart(2, "0")}с`
        : `${rest}с`;
    }
  }, 1000);
}
function stopProgressMetaTicker() {
  if (_progressTickerId) {
    clearInterval(_progressTickerId);
    _progressTickerId = null;
  }
}

// Updates the "Текущий шаг" line. Called from trackDispatchedRun once we know
// the current step from /jobs.
function setProgressCurrentStep(name) {
  const meta = $("#progress-meta");
  const cur = $("#progress-current-step");
  if (!meta || !cur) return;
  if (name) {
    meta.classList.remove("hidden");
    cur.textContent = name;
    _progressLastCurrentStep = name;
  } else {
    cur.textContent = _progressLastCurrentStep || "—";
  }
}

function setProgressSubtitle(text) {
  const sub = $("#progress-subtitle");
  if (!sub) return;
  sub.textContent = text || "";
  _progressLastSubtitle = text || "";
}

// Polls the workflow run we just dispatched and re-renders the modal. This
// is the function that powers the "Закидываем на Drive" live progress and
// it is what most users see when something goes wrong, so it gets the
// fanciest error handling: exponential backoff on transient 5xx, hard
// cancel on rate-limits, sessionStorage persistence so a refresh resumes
// tracking, and a tail of the runner log when the job fails.
async function trackDispatchedRun(workflowFile, dispatchedAt, baseTitle, knownRunIds) {
  const epoch = ++_trackEpoch;
  const isStillCurrent = () => epoch === _trackEpoch && _progressActive;
  ActiveRunStore.markPending({ workflowFile, dispatchedAt, baseTitle });
  let backoffMs = 1500;
  try {
    const gh = new GitHubSearchClient(cfg);
    let run = null;
    const findDeadline = Date.now() + 90_000;
    // Prefer matching by id (clock-skew-proof). When resumed after a page
    // reload we don't have a snapshot, so fall back to the timestamp check.
    const matchByNewId = knownRunIds instanceof Set;
    while (Date.now() < findDeadline && isStillCurrent()) {
      try {
        const data = await gh.listRunsForWorkflow(workflowFile, {
          event: "workflow_dispatch",
        });
        const runs = data.workflow_runs || [];
        if (matchByNewId) {
          run = runs.find((r) => !knownRunIds.has(r.id));
        } else {
          run = runs.find(
            (r) => new Date(r.created_at).getTime() >= dispatchedAt - 5000
          );
        }
        backoffMs = 1500;
      } catch (err) {
        ErrorLog.push(`Поиск запуска: ${err.message || err}`);
        backoffMs = Math.min(backoffMs * 1.6, 12_000);
      }
      if (run) break;
      await sleep(backoffMs);
    }
    if (!isStillCurrent()) return;
    if (!run) {
      setProgressSubtitle(
        "Запуск не появился в API за полторы минуты. Открой Actions в GitHub и проверь вручную."
      );
      ActiveRunStore.clear();
      return;
    }
    _trackedRun = run;
    ActiveRunStore.attachRun(run);

    const titleEl = $("#progress-title");
    if (titleEl) {
      titleEl.textContent = baseTitle
        ? `${baseTitle} · #${run.run_number}`
        : `Запуск #${run.run_number}`;
    }
    const link = $("#progress-link");
    if (link) {
      link.href = run.html_url;
      link.classList.remove("hidden");
    }

    const deadline = Date.now() + 60 * 60_000;
    let consecutiveFailures = 0;
    backoffMs = 3000;
    while (Date.now() < deadline && isStillCurrent()) {
      let data = null;
      try {
        data = await gh.getRunJobs(run.id);
        consecutiveFailures = 0;
        backoffMs = 3000;
      } catch (err) {
        consecutiveFailures += 1;
        ErrorLog.push(`Опрос задач: ${err.message || err}`);
        // 401/403 means we lost auth — bail out, no point in spamming.
        if (/\b(401|403)\b/.test(String(err.message || ""))) {
          setProgressSubtitle(
            "Токен GitHub отклонён — обнови PAT в Настройках."
          );
          ActiveRunStore.clear();
          return;
        }
        // Exponential backoff for 5xx and network blips.
        backoffMs = Math.min(backoffMs * 1.7, 20_000);
        if (consecutiveFailures >= 6) {
          setProgressSubtitle(
            "GitHub API не отвечает. Попробуй обновить страницу или проверь сеть."
          );
        }
        await sleep(backoffMs);
        continue;
      }
      const jobs = data.jobs || [];
      const job = jobs[0];
      if (job) {
        const renderRes = renderProgressStages(job.steps || []);
        const summary = summariseRun(run, job);
        setProgressSubtitle(summary.text);
        if (renderRes && renderRes.currentStepName) {
          setProgressCurrentStep(renderRes.currentStepName);
        } else if (job.status === "completed") {
          setProgressCurrentStep(
            job.conclusion === "success" ? "всё готово" : `завершено: ${job.conclusion}`
          );
        }
      } else {
        setProgressSubtitle("GitHub ещё не назначил раннер.");
      }
      const allDone =
        jobs.length > 0 && jobs.every((j) => j.status === "completed");
      if (allDone) {
        // Refresh the latest /runs entry so we have the final conclusion.
        try {
          const fresh = await gh.listRunsForWorkflow(workflowFile, {
            event: "workflow_dispatch",
          });
          const updated = (fresh.workflow_runs || []).find(
            (r) => r.id === run.id
          );
          if (updated) run = updated;
        } catch {
          /* ignore — we already have a usable summary */
        }
        const final = summariseRun(run, job);
        setProgressSubtitle(final.text);
        // If the job failed, fetch the tail of the failing step's log so the
        // user has actionable context without leaving the page.
        if (job && job.conclusion && job.conclusion !== "success") {
          await populateProgressLog(gh, run, job);
        }
        ActiveRunStore.clear();
        return;
      }
      await sleep(backoffMs);
    }
    if (isStillCurrent()) {
      setProgressSubtitle(
        "Превышен лимит ожидания (1 час). Дальше слежу через список запусков."
      );
    }
  } catch (err) {
    ErrorLog.push(`Слежение за запуском: ${err.message || err}`);
    setProgressSubtitle(`Ошибка слежения: ${err.message || err}`);
  } finally {
    if (epoch === _trackEpoch && !_progressActive) {
      ActiveRunStore.clear();
    }
  }
}

// Best-effort fetch of the runner log for the failing step so users get a
// hint right in the dialog instead of having to click through to GitHub.
async function populateProgressLog(gh, run, job) {
  const wrap = $("#progress-log-wrap");
  const out = $("#progress-log");
  if (!wrap || !out) return;
  try {
    const url = `https://api.github.com/repos/${cfg.repo}/actions/jobs/${job.id}/logs`;
    const res = await fetch(url, {
      headers: { ...new GitHubClient(cfg).headers },
      redirect: "follow",
    });
    if (!res.ok) {
      out.textContent = `Лог недоступен (HTTP ${res.status}). Открой запуск в GitHub.`;
      wrap.setAttribute("open", "");
      return;
    }
    const text = await res.text();
    // Take the last ~3KB of the log — enough for a panic/stack trace.
    const tail = text.slice(-3500);
    out.textContent = tail || "Лог пустой.";
    wrap.setAttribute("open", "");
  } catch (err) {
    out.textContent = `Не получилось скачать лог: ${err.message || err}`;
    wrap.setAttribute("open", "");
  }
}

// ---------- Paste-from-clipboard helper ----------
function bindPaste() {
  const btn = $("#paste-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("Clipboard API недоступен.");
      }
      const text = await navigator.clipboard.readText();
      if (!text) return;
      $("#url").value = text.trim();
      $("#url").focus();
      // Trigger the URL hint pipeline so the user immediately sees what kind
      // of source the pasted URL is and which downloader will be used.
      $("#url").dispatchEvent(new Event("input"));
    } catch (err) {
      toast(`Не удалось вставить из буфера: ${err.message || err}`, "error");
    }
  });
}

function bindClearUrl() {
  const btn = $("#clear-url-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const url = $("#url");
    if (!url) return;
    url.value = "";
    url.focus();
    url.dispatchEvent(new Event("input"));
  });
}

// ---------- Error log ----------
//
// The diagnostics dialog has an "ошибки за сессию" panel. We feed it from
// here. Every place that catches an error in a polling loop should call
// `ErrorLog.push(message)` so the user has a single place to see what went
// wrong instead of having to open DevTools. We deliberately keep this in
// memory only — the log is per-tab and starts fresh on every reload.
const ErrorLog = (() => {
  const MAX = 50;
  const entries = [];
  const listeners = new Set();
  function notify() {
    for (const cb of listeners) {
      try {
        cb(entries.slice());
      } catch (err) {
        console.warn("ErrorLog listener:", err);
      }
    }
  }
  return {
    push(message) {
      const text = String(message || "").trim();
      if (!text) return;
      entries.unshift({ ts: Date.now(), text });
      if (entries.length > MAX) entries.length = MAX;
      notify();
    },
    clear() {
      entries.length = 0;
      notify();
    },
    list() {
      return entries.slice();
    },
    subscribe(cb) {
      listeners.add(cb);
      cb(entries.slice());
      return () => listeners.delete(cb);
    },
  };
})();

// Hook console.error so unhandled errors from third-party scripts (libsodium
// CDN failures, sodium init mismatches, etc.) end up in the error log too.
// We don't replace `console.error` itself — we just listen via window.error.
window.addEventListener("error", (event) => {
  const m = event && event.error && event.error.message
    ? event.error.message
    : event && event.message
    ? event.message
    : "";
  if (m) ErrorLog.push(`JS: ${m}`);
});
window.addEventListener("unhandledrejection", (event) => {
  const r = event && event.reason;
  const m = r && r.message ? r.message : String(r || "");
  if (m) ErrorLog.push(`Promise: ${m}`);
});

// ---------- Active run persistence (sessionStorage) ----------
//
// The single biggest UX bug after stale-cache: if the user reloaded the page
// while a workflow was running, the live progress dialog vanished and the
// "ждёт" pills in the runs list never updated, because we threw away the
// `_trackedRun` reference on every load. This module pickles the run we're
// tracking so a refresh resumes it (or shows it as "completed" immediately
// if the run finished in the meantime).
const ActiveRunStore = (() => {
  const KEY = "film-beamer.active-run.v1";
  function read() {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return parsed;
    } catch {
      return null;
    }
  }
  function write(value) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(value));
    } catch {
      /* sessionStorage may be disabled in private mode; not fatal */
    }
  }
  function clear() {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* noop */
    }
  }
  return {
    read,
    clear,
    markPending(meta) {
      write({
        ...meta,
        runId: null,
        runUrl: null,
        runNumber: null,
        savedAt: Date.now(),
      });
    },
    attachRun(run) {
      const cur = read() || {};
      write({
        ...cur,
        runId: run.id,
        runUrl: run.html_url,
        runNumber: run.run_number,
        runCreatedAt: run.created_at,
        savedAt: Date.now(),
      });
    },
    rememberCompleted(run) {
      // We don't currently persist completed runs — the runs list does that
      // already. This is a hook for future use (run history page, etc.).
      void run;
    },
  };
})();

// On boot, if sessionStorage says we were tracking a run, resume tracking.
// The function is idempotent: it is safe to call even when nothing was saved.
async function resumeActiveRun() {
  const saved = ActiveRunStore.read();
  if (!saved || !saved.workflowFile || !saved.dispatchedAt) return;
  // If the saved run is older than 2 hours, drop it — too stale to be useful.
  if (Date.now() - (saved.savedAt || 0) > 2 * 60 * 60_000) {
    ActiveRunStore.clear();
    return;
  }
  if (!isReady()) {
    // Settings cleared / token missing — nothing we can do.
    ActiveRunStore.clear();
    return;
  }
  try {
    const baseTitle = saved.baseTitle || "Активный запуск";
    openProgressDialog(`${baseTitle} (восстановлен)`);
    setProgressSubtitle("Восстанавливаем прогресс из предыдущей сессии…");
    trackDispatchedRun(saved.workflowFile, saved.dispatchedAt, baseTitle).catch(
      (err) => ErrorLog.push(`Восстановление: ${err.message || err}`)
    );
  } catch (err) {
    ErrorLog.push(`Восстановление активного запуска: ${err.message || err}`);
    ActiveRunStore.clear();
  }
}

// ---------- Recent URLs ----------
//
// We persist the last N URLs the user dispatched so they can re-beam with one
// click. URLs that look obviously sensitive (bearer tokens, raw credentials)
// are never stored.
const RecentURLs = (() => {
  const KEY = "film-beamer.recent-urls.v1";
  const MAX = 10;
  const SENSITIVE_RE = /(token=|password=|api[_-]?key=|secret=)/i;
  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (it) => it && typeof it.url === "string" && it.url
      );
    } catch {
      return [];
    }
  }
  function write(items) {
    try {
      localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX)));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }
  return {
    list() {
      return read();
    },
    add({ url, filename }) {
      if (!url || typeof url !== "string") return;
      if (SENSITIVE_RE.test(url)) return;
      const items = read().filter((it) => it.url !== url);
      items.unshift({
        url,
        filename: (filename || "").trim(),
        ts: Date.now(),
      });
      write(items);
      RecentURLs.render();
    },
    remove(url) {
      const items = read().filter((it) => it.url !== url);
      write(items);
      RecentURLs.render();
    },
    clear() {
      write([]);
      RecentURLs.render();
    },
    // Wholesale replace — used by SettingsBackup.applySnapshot() so
    // imported recent-URL lists actually land in localStorage instead of
    // being silently dropped.
    replace(items) {
      if (!Array.isArray(items)) return;
      const safe = items.filter(
        (it) => it && typeof it.url === "string" && it.url
      );
      write(safe);
      RecentURLs.render();
    },
    render() {
      const wrap = $("#recent-urls-wrap");
      const list = $("#recent-urls");
      if (!wrap || !list) return;
      const items = read();
      list.innerHTML = "";
      if (!items.length) {
        wrap.classList.add("hidden");
        return;
      }
      wrap.classList.remove("hidden");
      for (const item of items) {
        const li = document.createElement("li");
        const chip = document.createElement("span");
        chip.className = "recent-url-chip";
        chip.title = `${item.url}${
          item.filename ? `\n${item.filename}` : ""
        }`;
        const text = document.createElement("span");
        text.className = "text";
        text.textContent = item.filename
          ? `${item.filename} · ${shortenUrl(item.url)}`
          : shortenUrl(item.url);
        chip.appendChild(text);
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "remove";
        rm.textContent = "✕";
        rm.title = "Удалить из истории";
        rm.addEventListener("click", (e) => {
          e.stopPropagation();
          RecentURLs.remove(item.url);
        });
        chip.addEventListener("click", () => {
          const urlInput = $("#url");
          if (!urlInput) return;
          urlInput.value = item.url;
          urlInput.dispatchEvent(new Event("input"));
          urlInput.focus();
          if (item.filename) {
            const f = $("#filename");
            if (f && !f.value) f.value = item.filename;
          }
        });
        chip.appendChild(rm);
        li.appendChild(chip);
        list.appendChild(li);
      }
    },
  };
})();

// Trim very long URLs to a readable chip label.
function shortenUrl(raw) {
  if (!raw) return "";
  if (/^magnet:\?/i.test(raw)) {
    const m = raw.match(/dn=([^&]+)/);
    if (m) {
      try {
        return `magnet · ${decodeURIComponent(m[1])}`.slice(0, 80);
      } catch {
        return `magnet · ${m[1]}`.slice(0, 80);
      }
    }
    return "magnet · " + raw.slice(8, 28) + "…";
  }
  try {
    const u = new URL(raw);
    let path = u.pathname || "/";
    if (path.length > 36) {
      path = path.slice(0, 18) + "…" + path.slice(-12);
    }
    return `${u.hostname}${path}`;
  } catch {
    return raw.length > 60 ? raw.slice(0, 28) + "…" + raw.slice(-24) : raw;
  }
}

// ---------- Service Worker update flow ----------
//
// Pairs with the new docs/sw.js. When the SW finds a fresh build on the
// network, it installs into "waiting" state. The page then shows an update
// banner; clicking "Обновить" sends SKIP_WAITING and reloads.
const SwUpdater = (() => {
  let waitingWorker = null;
  let reloading = false;
  function showBanner(version) {
    const banner = $("#update-banner");
    if (!banner) return;
    const verEl = $("#update-banner-version");
    if (verEl) {
      verEl.textContent = version
        ? `(${version})`
        : "";
    }
    banner.classList.remove("hidden");
  }
  function hideBanner() {
    const banner = $("#update-banner");
    if (banner) banner.classList.add("hidden");
  }
  async function init() {
    if (!("serviceWorker" in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register("./sw.js");
      // If a waiting worker is already there (we missed the install event),
      // surface it immediately.
      if (reg.waiting) {
        waitingWorker = reg.waiting;
        showBanner();
      }
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            waitingWorker = installing;
            showBanner();
          }
        });
      });
      // Force a check now so deploys land within seconds of the user landing
      // on the page, even if Chrome wouldn't otherwise check for hours.
      reg.update().catch(() => {});
      // Re-check periodically (every 6h) for long-lived tabs.
      setInterval(() => reg.update().catch(() => {}), 6 * 60 * 60_000);
    } catch (err) {
      console.warn("SW register:", err);
      ErrorLog.push(`Service Worker: ${err.message || err}`);
    }
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
    navigator.serviceWorker.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "SW_VERSION") {
        const el = $("#diag-sw-version");
        if (el) el.textContent = data.version || "—";
      } else if (data.type === "CACHE_PURGED") {
        toast("Кеш очищен. Перезагружаю…", "success", 1500);
        setTimeout(() => window.location.reload(), 800);
      }
    });
  }
  function bind() {
    const apply = $("#update-banner-apply");
    const dismiss = $("#update-banner-dismiss");
    if (apply) {
      apply.addEventListener("click", () => {
        if (!waitingWorker) {
          // No waiting worker — just hard reload.
          window.location.reload();
          return;
        }
        try {
          waitingWorker.postMessage({ type: "SKIP_WAITING" });
        } catch {
          window.location.reload();
        }
      });
    }
    if (dismiss) {
      dismiss.addEventListener("click", hideBanner);
    }
  }
  return { init, bind, showBanner, hideBanner };
})();

// ---------- Diagnostics dialog ----------
//
// Surfaces "is this thing actually wired up correctly?" answers in one place
// so the user can self-serve troubleshoot before pinging an admin. Each
// check is best-effort and updates a row asynchronously — opening the
// dialog never blocks on slow checks.
const Diagnostics = (() => {
  const PAGE_VERSION = "v22-secrets-audit";
  let opened = false;

  function setRow(id, text, status) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.classList.remove(
      "diag-status-ok",
      "diag-status-warn",
      "diag-status-bad",
      "diag-status-pending"
    );
    if (status === "ok") el.classList.add("diag-status-ok");
    else if (status === "warn") el.classList.add("diag-status-warn");
    else if (status === "bad") el.classList.add("diag-status-bad");
    else el.classList.add("diag-status-pending");
  }

  async function checkSwVersion() {
    setRow("#diag-sw-version", "запрашиваю…", "pending");
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
      setRow("#diag-sw-version", "не активен", "warn");
      return;
    }
    try {
      navigator.serviceWorker.controller.postMessage({ type: "GET_VERSION" });
    } catch (err) {
      setRow("#diag-sw-version", `ошибка: ${err.message || err}`, "bad");
    }
  }

  async function checkCacheSize() {
    setRow("#diag-cache-size", "считаю…", "pending");
    try {
      if (!("caches" in window)) {
        setRow("#diag-cache-size", "Cache API недоступен", "warn");
        return;
      }
      const keys = await caches.keys();
      let total = 0;
      let count = 0;
      for (const key of keys) {
        if (!key.startsWith("film-beamer-")) continue;
        const cache = await caches.open(key);
        const requests = await cache.keys();
        count += requests.length;
        // We don't have a reliable way to get response size without re-reading
        // every cached blob, which is wasteful — give an entry count instead.
      }
      setRow(
        "#diag-cache-size",
        keys.length
          ? `${count} файлов в ${keys.filter((k) => k.startsWith("film-beamer-")).length} кешах`
          : "пусто",
        keys.length ? "ok" : "warn"
      );
      void total;
    } catch (err) {
      setRow("#diag-cache-size", `ошибка: ${err.message || err}`, "bad");
    }
  }

  async function checkGitHub() {
    setRow("#diag-github", "пробую…", "pending");
    if (!cfg.token) {
      setRow("#diag-github", "PAT не задан", "warn");
      return;
    }
    try {
      const res = await fetch("https://api.github.com/rate_limit", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${cfg.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) {
        setRow(
          "#diag-github",
          `HTTP ${res.status} — токен невалиден или истёк`,
          "bad"
        );
        return;
      }
      const data = await res.json();
      const core = data && data.resources && data.resources.core;
      if (core) {
        setRow(
          "#diag-github",
          `OK · лимит ${core.remaining}/${core.limit}`,
          core.remaining > 100 ? "ok" : "warn"
        );
      } else {
        setRow("#diag-github", "OK", "ok");
      }
    } catch (err) {
      setRow("#diag-github", `сеть: ${err.message || err}`, "bad");
    }
  }

  async function checkDrive() {
    setRow("#diag-drive", "пробую…", "pending");
    if (!cfg.driveSaJson || !cfg.driveFolderId) {
      // Local form is empty — but the user may have already uploaded the
      // secret to GitHub on a previous session, then cleared localStorage
      // (or hard-reloaded). Consult SecretsAudit so this row reads
      // «На GitHub · 16 ч назад» instead of nudging the user to re-paste
      // their service-account JSON for no reason.
      let audit = null;
      try {
        if (typeof SecretsAudit !== "undefined" && SecretsAudit) {
          audit = SecretsAudit.lastResult() || (await SecretsAudit.audit({ force: false }));
        }
      } catch {
        audit = null;
      }
      if (audit && audit.ready && Array.isArray(audit.rows)) {
        const sa = audit.rows.find((r) => r.name === "GDRIVE_SERVICE_ACCOUNT");
        const folder = audit.rows.find((r) => r.name === "GDRIVE_FOLDER_ID");
        if (sa && sa.exists && folder && folder.exists) {
          const ago = sa.updatedAt ? timeAgo(sa.updatedAt) : "";
          setRow(
            "#diag-drive",
            ago
              ? `На GitHub · обновлён ${ago}`
              : "На GitHub · значения скрыты",
            "ok"
          );
          return;
        }
      }
      setRow("#diag-drive", "SA + Folder не задан", "warn");
      return;
    }
    try {
      const token = await getDriveAccessToken();
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
          cfg.driveFolderId
        )}?fields=id,name,driveId,owners`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) {
        const text = await res.text();
        setRow(
          "#diag-drive",
          `HTTP ${res.status}: ${text.slice(0, 80)}`,
          "bad"
        );
        return;
      }
      const data = await res.json();
      setRow(
        "#diag-drive",
        `OK · «${data.name || cfg.driveFolderId}»`,
        "ok"
      );
    } catch (err) {
      setRow("#diag-drive", `${err.message || err}`, "bad");
    }
  }

  async function checkSecrets() {
    setRow("#diag-secrets", "проверяю…", "pending");
    if (!cfg.token || !cfg.repo) {
      setRow("#diag-secrets", "репо/PAT не заданы", "warn");
      return;
    }
    try {
      // Source-of-truth list lives in SecretsAudit; we just summarise its
      // result for the diagnostics row. This keeps the two surfaces in sync.
      const result = await SecretsAudit.audit({ force: true });
      if (!result.ready) {
        setRow("#diag-secrets", result.reason || "не готов", "warn");
        return;
      }
      const missingRequired = result.rows
        .filter((r) => r.required && r.exists === false)
        .map((r) => r.name);
      const present = result.rows.filter((r) => r.exists === true);
      if (missingRequired.length) {
        setRow(
          "#diag-secrets",
          `нет обязательных: ${missingRequired.join(", ")}`,
          "bad"
        );
      } else {
        setRow(
          "#diag-secrets",
          `OK · ${present.length}/${result.rows.length} заданы`,
          "ok"
        );
      }
    } catch (err) {
      setRow("#diag-secrets", `${err.message || err}`, "bad");
    }
  }

  function checkOnline() {
    if (navigator.onLine) {
      setRow("#diag-online", "online", "ok");
    } else {
      setRow("#diag-online", "offline", "bad");
    }
  }

  function setLoadTime() {
    const el = $("#diag-load-time");
    if (!el) return;
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      if (nav) {
        el.textContent = `${Math.round(nav.duration)} мс`;
      } else {
        el.textContent = `${Math.round(performance.now())} мс`;
      }
    } catch {
      el.textContent = "—";
    }
  }

  function renderErrors(entries) {
    const list = $("#diag-errors");
    if (!list) return;
    const counter = $("#diag-errors-count");
    if (counter) counter.textContent = `(${entries.length})`;
    list.innerHTML = "";
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "text-slate-500";
      empty.textContent = "Пока чисто.";
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "diag-error-entry";
      const time = document.createElement("span");
      time.className = "diag-error-time";
      const d = new Date(entry.ts);
      time.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(
        d.getMinutes()
      ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
      li.appendChild(time);
      const text = document.createElement("span");
      text.textContent = entry.text;
      li.appendChild(text);
      list.appendChild(li);
    }
  }

  function buildExportReport() {
    const fmt = (id) => {
      const el = $(id);
      return el ? (el.textContent || "").trim() : "—";
    };
    const lines = [
      "# Film Beamer · отчёт диагностики",
      `Время: ${new Date().toISOString()}`,
      `Версия страницы: ${PAGE_VERSION}`,
      `Версия SW: ${fmt("#diag-sw-version")}`,
      `Время загрузки: ${fmt("#diag-load-time")}`,
      `Кеш: ${fmt("#diag-cache-size")}`,
      `GitHub API: ${fmt("#diag-github")}`,
      `Drive: ${fmt("#diag-drive")}`,
      `Секреты: ${fmt("#diag-secrets")}`,
      `Online: ${fmt("#diag-online")}`,
      `User-Agent: ${navigator.userAgent}`,
      `Repo: ${cfg.repo || "—"}`,
      `Branch: ${cfg.branch || "(default)"}`,
      `Workflow: ${cfg.workflow || "—"}`,
      "",
      "## Последние ошибки",
    ];
    const errors = ErrorLog.list();
    if (!errors.length) {
      lines.push("(нет)");
    } else {
      for (const entry of errors) {
        lines.push(`- ${new Date(entry.ts).toISOString()} · ${entry.text}`);
      }
    }
    return lines.join("\n");
  }

  async function resetSw() {
    if (
      !confirm(
        "Снимаем регистрацию Service Worker и стираем все кеши. Страница перезагрузится. Продолжить?"
      )
    ) {
      return;
    }
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (err) {
      ErrorLog.push(`Сброс SW: ${err.message || err}`);
    }
    window.location.reload();
  }

  function open() {
    const dlg = $("#diag-dialog");
    if (!dlg) return;
    dlg.classList.remove("hidden");
    opened = true;
    // Static-ish info first.
    setRow("#diag-page-version", PAGE_VERSION, "ok");
    setLoadTime();
    checkOnline();
    // Async checks.
    checkSwVersion();
    checkCacheSize();
    checkGitHub();
    checkDrive();
    checkSecrets();
    renderErrors(ErrorLog.list());
  }
  function close() {
    const dlg = $("#diag-dialog");
    if (dlg) dlg.classList.add("hidden");
    opened = false;
  }
  function bind() {
    const btn = $("#diag-btn");
    if (btn) btn.addEventListener("click", open);
    const closeBtn = $("#diag-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    const dlg = $("#diag-dialog");
    if (dlg) {
      dlg.addEventListener("click", (e) => {
        if (e.target.id === "diag-dialog") close();
      });
    }
    const recheck = $("#diag-recheck");
    if (recheck) recheck.addEventListener("click", open);
    const purge = $("#diag-purge");
    if (purge) {
      purge.addEventListener("click", async () => {
        if (
          !confirm(
            "Стираем кеш Service Worker и перезагружаем страницу. Продолжить?"
          )
        ) {
          return;
        }
        if (
          "serviceWorker" in navigator &&
          navigator.serviceWorker.controller
        ) {
          navigator.serviceWorker.controller.postMessage({
            type: "PURGE_CACHE",
          });
        } else {
          // Fallback — drop caches manually.
          try {
            if ("caches" in window) {
              const keys = await caches.keys();
              await Promise.all(
                keys
                  .filter((k) => k.startsWith("film-beamer-"))
                  .map((k) => caches.delete(k))
              );
            }
          } catch (err) {
            ErrorLog.push(`Очистка кеша: ${err.message || err}`);
          }
          window.location.reload();
        }
      });
    }
    const reset = $("#diag-reset-sw");
    if (reset) reset.addEventListener("click", resetSw);
    const exportBtn = $("#diag-export");
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        const text = buildExportReport();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            toast("Отчёт скопирован в буфер.", "success", 1800);
            return;
          }
          throw new Error("Clipboard API недоступен");
        } catch {
          // Fallback — open a textarea so the user can copy manually.
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.top = "10%";
          ta.style.left = "10%";
          ta.style.width = "80%";
          ta.style.height = "60%";
          ta.style.zIndex = "9999";
          document.body.appendChild(ta);
          ta.select();
          try {
            document.execCommand("copy");
            toast("Отчёт скопирован.", "success", 1800);
          } catch {
            toast("Скопируй вручную из открывшегося окна.", "warning", 4000);
          }
          setTimeout(() => ta.remove(), 4000);
        }
      });
    }
    ErrorLog.subscribe((entries) => {
      if (opened) renderErrors(entries);
      // Always update the count badge in the header.
      const counter = $("#diag-errors-count");
      if (counter) counter.textContent = `(${entries.length})`;
    });
    // Online/offline state — reflect into the dialog if it's open.
    window.addEventListener("online", () => {
      if (opened) checkOnline();
    });
    window.addEventListener("offline", () => {
      if (opened) checkOnline();
    });
  }
  return { open, close, bind };
})();

// ---------- Secrets audit ----------
//
// Renders a panel inside the Settings dialog (and feeds the "Секреты репо"
// row in Diagnostics) that says, for every secret the project knows about,
// whether it's present on GitHub and when it was last updated. The actual
// value is never returned by the API — we only get `created_at` /
// `updated_at`. That's enough to answer the user's question:
//
//   «Я уже загружал GDRIVE_SERVICE_ACCOUNT, почему после жёсткой
//   перезагрузки сайт снова просит JSON?»
//
// After clearing localStorage the form fields are empty, but the secret
// is still safely on GitHub — this panel makes that explicit instead of
// silently nudging the user to re-upload.
const SecretsAudit = (() => {
  // Single source of truth: kept in sync with the secret names referenced
  // by the workflows in `.github/workflows/*.yml` and the uploaders in
  // bindDriveUpload / bindYtCookiesUpload / bindTrackersUpload /
  // uploadCookieBucket.
  const KNOWN = [
    {
      name: "GDRIVE_SERVICE_ACCOUNT",
      group: "Google Drive",
      required: true,
      description: "Ключ сервис-аккаунта (JSON) для заливки в Drive.",
    },
    {
      name: "GDRIVE_FOLDER_ID",
      group: "Google Drive",
      required: true,
      description: "ID папки Drive, куда ложить файлы.",
    },
    {
      name: "YT_COOKIES",
      group: "yt-dlp",
      required: false,
      description: "Куки YouTube/age-gate, если ролики требуют логина.",
    },
    {
      name: "RUTRACKER_USERNAME",
      group: "RuTracker",
      required: false,
      description: "Логин для выкачивания магнетов с RuTracker.",
    },
    {
      name: "RUTRACKER_PASSWORD",
      group: "RuTracker",
      required: false,
      description: "Пароль парной к RUTRACKER_USERNAME.",
    },
    {
      name: "RUTRACKER_COOKIES",
      group: "RuTracker",
      required: false,
      description: "Netscape-cookies; полезны, если включён 2FA.",
    },
    {
      name: "KINOZAL_USERNAME",
      group: "Kinozal",
      required: false,
      description: "Логин Kinozal.",
    },
    {
      name: "KINOZAL_PASSWORD",
      group: "Kinozal",
      required: false,
      description: "Пароль Kinozal.",
    },
    {
      name: "KINOZAL_COOKIES",
      group: "Kinozal",
      required: false,
      description: "Netscape-cookies Kinozal (если логина не хватает).",
    },
    {
      name: "NNM_USERNAME",
      group: "NNM-Club",
      required: false,
      description: "Логин NNM-Club.",
    },
    {
      name: "NNM_PASSWORD",
      group: "NNM-Club",
      required: false,
      description: "Пароль NNM-Club.",
    },
    {
      name: "NNM_COOKIES",
      group: "NNM-Club",
      required: false,
      description: "Netscape-cookies NNM-Club.",
    },
  ];

  let _last = null; // Last audit() result, used by Diagnostics.
  let _inflight = null;

  // Probe each secret in parallel. Errors are tagged on a per-row basis
  // (e.g. one 403 doesn't blank the whole list). Use the same in-flight
  // de-duplication trick getDriveAccessToken uses so that
  // openSettings()+Diagnostics.open() back-to-back hit GitHub once.
  function audit({ force = false } = {}) {
    if (_inflight) return _inflight;
    if (!force && _last && Date.now() - _last.ts < 30_000) {
      return Promise.resolve(_last);
    }
    _inflight = (async () => {
      const result = {
        ts: Date.now(),
        ready: false,
        rows: KNOWN.map((k) => ({ ...k, exists: null, updatedAt: null, error: null })),
      };
      if (!cfg.token || !cfg.repo) {
        result.ready = false;
        result.reason = "Не заданы репо и/или PAT.";
        _last = result;
        return result;
      }
      result.ready = true;
      const gh = new GitHubClient(cfg);
      await Promise.all(
        result.rows.map(async (row) => {
          try {
            const sec = await gh.getActionsSecret(row.name);
            if (sec) {
              row.exists = true;
              row.updatedAt = sec.updated_at || sec.created_at || null;
            } else {
              row.exists = false;
            }
          } catch (err) {
            row.error = err.message || String(err);
          }
        })
      );
      _last = result;
      return result;
    })().finally(() => {
      _inflight = null;
    });
    return _inflight;
  }

  function setStatus(text, kind = "info") {
    const el = $("#secrets-audit-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.remove("text-emerald-300", "text-rose-300", "text-slate-500");
    el.classList.add(
      kind === "success"
        ? "text-emerald-300"
        : kind === "error"
        ? "text-rose-300"
        : "text-slate-500"
    );
  }

  function render(result) {
    const list = $("#secrets-audit-list");
    if (!list) return;
    list.innerHTML = "";
    if (!result || !result.ready) {
      const li = document.createElement("li");
      li.className =
        "rounded-lg border border-white/10 bg-ink-900/60 px-3 py-2 text-slate-400";
      li.textContent =
        result && result.reason
          ? result.reason
          : "Сначала укажи репо и PAT выше — иначе GitHub API не пустит.";
      list.appendChild(li);
      return;
    }
    // Group rows by `group` to match the visual layout of the uploader
    // sections below.
    const byGroup = new Map();
    for (const row of result.rows) {
      if (!byGroup.has(row.group)) byGroup.set(row.group, []);
      byGroup.get(row.group).push(row);
    }
    for (const [group, rows] of byGroup.entries()) {
      const header = document.createElement("li");
      header.className =
        "mt-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400";
      header.textContent = group;
      list.appendChild(header);
      for (const row of rows) {
        const li = document.createElement("li");
        li.className =
          "flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-ink-900/60 px-3 py-2";
        const left = document.createElement("div");
        left.className = "min-w-0 flex flex-col";
        const code = document.createElement("code");
        code.className = "font-mono text-[11px] text-slate-200";
        code.textContent = row.name;
        left.appendChild(code);
        const desc = document.createElement("span");
        desc.className = "text-[11px] text-slate-500";
        desc.textContent = row.description;
        left.appendChild(desc);
        li.appendChild(left);
        const right = document.createElement("span");
        right.className = "shrink-0 text-right text-[11px]";
        if (row.error) {
          right.textContent = `ошибка: ${row.error.slice(0, 60)}`;
          right.classList.add("text-rose-300");
        } else if (row.exists === true) {
          const ago = row.updatedAt ? timeAgo(row.updatedAt) : "";
          right.textContent = ago ? `✓ есть · ${ago}` : "✓ есть";
          right.classList.add("text-emerald-300");
        } else if (row.exists === false) {
          right.textContent = row.required ? "✗ нет (обязательный)" : "—";
          right.classList.add(
            row.required ? "text-rose-300" : "text-slate-500"
          );
        } else {
          right.textContent = "…";
          right.classList.add("text-slate-500");
        }
        li.appendChild(right);
        list.appendChild(li);
      }
    }
  }

  async function refresh({ silent = false, force = true } = {}) {
    if (!silent) setStatus("Проверяю…");
    let result;
    try {
      result = await audit({ force });
    } catch (err) {
      setStatus(`Ошибка: ${err.message || err}`, "error");
      return null;
    }
    render(result);
    // Once we know which secrets already exist on GitHub, the Drive
    // uploader can lock its button to prevent accidental duplicate
    // writes (and surface "Перезаписать на GitHub" if the user typed
    // something).
    if (typeof applyDriveUploadButtonState === "function") {
      try {
        applyDriveUploadButtonState();
      } catch {
        /* ignore */
      }
    }
    if (typeof renderDriveExistingState === "function") {
      try {
        renderDriveExistingState(result);
      } catch {
        /* ignore */
      }
    }
    if (!result.ready) {
      setStatus(result.reason || "", "error");
      return result;
    }
    const present = result.rows.filter((r) => r.exists === true).length;
    const missingRequired = result.rows.filter(
      (r) => r.required && r.exists === false
    );
    if (missingRequired.length) {
      setStatus(
        `Не хватает: ${missingRequired.map((r) => r.name).join(", ")}.`,
        "error"
      );
    } else {
      setStatus(`На GitHub: ${present} из ${result.rows.length}.`, "success");
    }
    return result;
  }

  function bind() {
    const btn = $("#secrets-audit-refresh");
    if (btn) btn.addEventListener("click", () => refresh({ force: true }));
  }

  function lastResult() {
    return _last;
  }

  return { KNOWN, audit, render, refresh, bind, lastResult };
})();

// ---------- Settings test buttons ----------
//
// "Проверить токен" / "Проверить Drive" / "Проверить секреты" buttons in the
// Settings dialog. These run the same checks Diagnostics does but inline,
// next to the relevant inputs, so users can verify before saving.
async function validateGitHubAccess() {
  const out = $("#cfg-token-status");
  if (!out) return;
  const token = ($("#cfg-token").value || "").trim();
  const repo = ($("#cfg-repo").value || "").trim();
  if (!token) {
    out.textContent = "Введи PAT и попробуй снова.";
    out.className = "mt-1 text-xs text-amber-300";
    return;
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    out.textContent = "Сначала укажи репо в формате owner/repo.";
    out.className = "mt-1 text-xs text-amber-300";
    return;
  }
  out.textContent = "Проверяю…";
  out.className = "mt-1 text-xs text-slate-400";
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (res.status === 401) {
      out.textContent = "401 — токен битый или истёк. Перевыпусти PAT.";
      out.className = "mt-1 text-xs text-rose-300";
      return;
    }
    if (res.status === 404) {
      out.textContent =
        "404 — репо не найден или у токена нет к нему доступа. Проверь видимость и репозиторные права.";
      out.className = "mt-1 text-xs text-rose-300";
      return;
    }
    if (!res.ok) {
      out.textContent = `HTTP ${res.status}.`;
      out.className = "mt-1 text-xs text-rose-300";
      return;
    }
    const data = await res.json();
    out.textContent = `OK · default ${data.default_branch || "—"} · public=${data.private ? "нет" : "да"}`;
    out.className = "mt-1 text-xs text-emerald-300";
  } catch (err) {
    out.textContent = `Сеть: ${err.message || err}`;
    out.className = "mt-1 text-xs text-rose-300";
  }
}

async function validateDriveAccess() {
  const out = $("#drive-test-status");
  if (!out) return;
  const jsonRaw = ($("#drive-json").value || "").trim();
  const folderRaw = ($("#drive-folder").value || "").trim();
  if (!jsonRaw && !cfg.driveSaJson) {
    out.textContent = "Сначала вставь service-account JSON.";
    out.className = "mt-1 text-xs text-amber-300";
    return;
  }
  if (!folderRaw && !cfg.driveFolderId) {
    out.textContent = "Сначала вставь Folder ID.";
    out.className = "mt-1 text-xs text-amber-300";
    return;
  }
  out.textContent = "Проверяю доступ к Drive…";
  out.className = "mt-1 text-xs text-slate-400";
  // Build a temporary cfg that uses the values currently in the dialog so the
  // user can validate before saving.
  const prev = { json: cfg.driveSaJson, folder: cfg.driveFolderId };
  if (jsonRaw) cfg.driveSaJson = jsonRaw;
  if (folderRaw) {
    const id = extractFolderId(folderRaw) || folderRaw;
    cfg.driveFolderId = id;
  }
  // Reset cached token so we definitely re-issue a JWT with the new SA.
  _driveAccessToken = null;
  try {
    const token = await getDriveAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        cfg.driveFolderId
      )}?fields=id,name`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      const text = await res.text();
      out.textContent = `HTTP ${res.status}: ${text.slice(0, 80)}`;
      out.className = "mt-1 text-xs text-rose-300";
      return;
    }
    const data = await res.json();
    out.textContent = `OK · вижу папку «${data.name || cfg.driveFolderId}»`;
    out.className = "mt-1 text-xs text-emerald-300";
  } catch (err) {
    out.textContent = `${err.message || err}`;
    out.className = "mt-1 text-xs text-rose-300";
  } finally {
    cfg.driveSaJson = prev.json;
    cfg.driveFolderId = prev.folder;
    _driveAccessToken = null;
  }
}

function bindSettingsValidators() {
  const tokenBtn = $("#cfg-token-test");
  if (tokenBtn) tokenBtn.addEventListener("click", validateGitHubAccess);
  const driveBtn = $("#drive-test");
  if (driveBtn) driveBtn.addEventListener("click", validateDriveAccess);

  // Stale status reset: once the user starts editing the inputs that fed
  // a previous "Проверить …" run, blank the status line so the previous
  // green tick can't be mistaken for confirmation of the new value.
  const tokenStatus = $("#cfg-token-status");
  if (tokenStatus) {
    const reset = () => {
      if (tokenStatus.textContent) {
        tokenStatus.textContent = "";
        tokenStatus.className = "text-xs text-slate-500";
      }
    };
    const tokenInput = $("#cfg-token");
    const repoInput = $("#cfg-repo");
    if (tokenInput) tokenInput.addEventListener("input", reset);
    if (repoInput) repoInput.addEventListener("input", reset);
  }
  const driveStatus = $("#drive-test-status");
  if (driveStatus) {
    const reset = () => {
      if (driveStatus.textContent) {
        driveStatus.textContent = "";
        driveStatus.className = "mt-1 text-xs text-slate-500";
      }
    };
    const driveJson = $("#drive-json");
    const driveFolder = $("#drive-folder");
    if (driveJson) driveJson.addEventListener("input", reset);
    if (driveFolder) driveFolder.addEventListener("input", reset);
  }
}

// ---------- Keyboard shortcuts ----------
//
// Ctrl/Cmd+K  → focus URL input
// Ctrl/Cmd+,  → open Settings
// Ctrl/Cmd+/  → open Diagnostics
// Esc         → close any open dialog
function bindKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // Don't trigger letter-based shortcuts while the user is typing inside
    // an input/textarea — they collide with native browser behaviours
    // (Ctrl+Q in some text fields toggles spellcheck, etc.). Special keys
    // like Esc and Ctrl+K still fire because they are the explicit "jump
    // to URL" / "close dialog" gestures users expect.
    const target = e.target;
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    if (mod && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      const url = $("#url");
      if (url) {
        url.focus();
        url.select();
      }
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      openSettings();
      return;
    }
    if (mod && e.key === "/") {
      e.preventDefault();
      if (typeof HelpDialog !== "undefined" && HelpDialog && HelpDialog.open) {
        HelpDialog.open();
      } else {
        Diagnostics.open();
      }
      return;
    }
    if (mod && !inField && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      Diagnostics.open();
      return;
    }
    if (mod && !inField && (e.key === "h" || e.key === "H")) {
      e.preventDefault();
      if (typeof RunHistory !== "undefined" && RunHistory && RunHistory.open) {
        RunHistory.open();
      }
      return;
    }
    if (mod && !inField && (e.key === "q" || e.key === "Q")) {
      e.preventDefault();
      if (typeof BulkQueue !== "undefined" && BulkQueue && BulkQueue.open) {
        BulkQueue.open();
      }
      return;
    }
    if (mod && !inField && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      if (
        typeof WorkflowPresets !== "undefined" &&
        WorkflowPresets &&
        WorkflowPresets.open
      ) {
        WorkflowPresets.open();
      }
      return;
    }
    if (
      mod &&
      e.shiftKey &&
      !inField &&
      (e.key === "l" || e.key === "L" || e.key === "Л" || e.key === "л")
    ) {
      e.preventDefault();
      const cur = Theme.get();
      const next =
        cur === "dark" ? "light" : cur === "light" ? "auto" : "dark";
      Theme.set(next);
      return;
    }
    if (e.key === "Escape") {
      // Close whichever dialog is open. We don't preventDefault — Esc has
      // its own native behaviour we want to keep where possible.
      const sd = $("#settings-dialog");
      if (sd && !sd.classList.contains("hidden")) {
        closeSettings();
      }
      const pd = $("#progress-dialog");
      if (pd && !pd.classList.contains("hidden")) {
        // Esc on the modal collapses to the restore pill — same as «Свернуть»
        // — so a stray keypress doesn't hide the in-flight run entirely.
        hideProgressDialog();
      }
      const dd = $("#diag-dialog");
      if (dd && !dd.classList.contains("hidden")) {
        Diagnostics.close();
      }
      const hd = $("#history-dialog");
      if (
        hd &&
        !hd.classList.contains("hidden") &&
        typeof RunHistory !== "undefined" &&
        RunHistory.close
      ) {
        RunHistory.close();
      }
      const qd = $("#queue-dialog");
      if (
        qd &&
        !qd.classList.contains("hidden") &&
        typeof BulkQueue !== "undefined" &&
        BulkQueue.close
      ) {
        BulkQueue.close();
      }
      const psd = $("#preset-dialog");
      if (
        psd &&
        !psd.classList.contains("hidden") &&
        typeof WorkflowPresets !== "undefined" &&
        WorkflowPresets.close
      ) {
        WorkflowPresets.close();
      }
      const help = $("#help-dialog");
      if (
        help &&
        !help.classList.contains("hidden") &&
        typeof HelpDialog !== "undefined" &&
        HelpDialog.close
      ) {
        HelpDialog.close();
      }
    }
  });
}

// Wire the new header action buttons (Help / Queue / History) and the
// preset save/manage buttons that sit next to the form. The corresponding
// modules each ship their own bind() that wires their dialog's internal
// behaviour; this function only handles the *triggers* that live outside
// the dialogs.
// Robust click wiring: any thrown exception inside a dialog's open() must
// NOT propagate up to the page (where the user perceives it as "the site
// just crashed") — instead we catch, surface a toast and log the full
// stack so the next session has a clean trace to look at.
function _safeOpenHandler(label, getter) {
  return async (ev) => {
    try {
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      const mod = getter();
      if (!mod || typeof mod.open !== "function") {
        console.error(
          `[fb] ${label}: module not loaded yet (mod=${mod && typeof mod})`
        );
        toast(
          `Не получилось открыть «${label}» — модуль ещё не загрузился. Попробуй обновить страницу (Ctrl+Shift+R).`,
          "error"
        );
        return;
      }
      // open() may be async (BulkQueue/RunHistory render with awaited
      // fetches); awaiting here ensures rejected promises hit the catch
      // below instead of becoming silent unhandled rejections.
      await mod.open();
    } catch (err) {
      console.error(`[fb] ${label}.open() crashed:`, err);
      toast(
        `Ошибка в «${label}»: ${
          (err && err.message) || err
        }. Скриншот консоли (F12 → Console) сильно поможет починить.`,
        "error"
      );
    }
  };
}

function bindHeaderActionButtons() {
  const help = $("#open-help");
  if (help) {
    help.addEventListener(
      "click",
      _safeOpenHandler("Помощь", () =>
        typeof HelpDialog !== "undefined" ? HelpDialog : null
      )
    );
  }
  const queue = $("#open-queue");
  if (queue) {
    queue.addEventListener(
      "click",
      _safeOpenHandler("Очередь", () =>
        typeof BulkQueue !== "undefined" ? BulkQueue : null
      )
    );
  }
  const history = $("#open-history");
  if (history) {
    history.addEventListener(
      "click",
      _safeOpenHandler("История", () =>
        typeof RunHistory !== "undefined" ? RunHistory : null
      )
    );
  }
  const presetSave = $("#preset-save");
  if (presetSave) {
    presetSave.addEventListener("click", (ev) => {
      try {
        if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
        if (
          typeof WorkflowPresets !== "undefined" &&
          WorkflowPresets &&
          WorkflowPresets.saveFromForm
        ) {
          WorkflowPresets.saveFromForm();
        }
      } catch (err) {
        console.error("[fb] preset-save crashed:", err);
        toast(
          `Ошибка при сохранении пресета: ${(err && err.message) || err}`,
          "error"
        );
      }
    });
  }
  const presetManage = $("#preset-manage");
  if (presetManage) {
    presetManage.addEventListener(
      "click",
      _safeOpenHandler("Пресеты", () =>
        typeof WorkflowPresets !== "undefined" ? WorkflowPresets : null
      )
    );
  }
}

// Wire the in-Settings sound on/off checkbox to the Sounds module. Kept
// separate from the rest so it can be lazily created if missing.
function bindSoundToggle() {
  const cb = $("#sound-toggle");
  if (!cb) return;
  cb.checked = Sounds.read();
  cb.addEventListener("change", () => {
    Sounds.set(cb.checked);
    if (cb.checked) {
      Sounds.ding();
      toast("Звуки включены", "info", 1500);
    } else {
      toast("Звуки выключены", "info", 1500);
    }
  });
}

// Wire the three "preview" buttons next to the sound toggle in Settings.
// Even if the global "play sounds" switch is off, these buttons should
// always play the requested sample so the user can hear what each event
// sounds like. We force them through the underlying tone generator with
// `.force` and add a subtle visual pulse so muted devices still get
// feedback.
function bindSoundPreviewButtons() {
  const map = [
    {
      id: "#sound-test-ding",
      play: () => Sounds.ding(true),
      pulseClass: "sound-pulse-ok",
    },
    {
      id: "#sound-test-buzz",
      play: () => Sounds.buzz(true),
      pulseClass: "sound-pulse-err",
    },
    {
      id: "#sound-test-chirp",
      play: () => Sounds.chirp(true),
      pulseClass: "sound-pulse-ok",
    },
  ];
  for (const item of map) {
    const btn = $(item.id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      try {
        item.play();
      } catch (err) {
        console.warn("sound preview failed", err);
      }
      btn.classList.remove("sound-pulse-ok", "sound-pulse-err");
      // Force a reflow so re-adding the class restarts the animation
      void btn.offsetWidth;
      btn.classList.add(item.pulseClass);
      window.setTimeout(() => {
        btn.classList.remove(item.pulseClass);
      }, 900);
    });
  }
}

// ---------- Deep-link prefill ----------
//
// The page accepts these query parameters so other apps (including the PWA
// share target) can pre-fill the form:
//   ?url=...
//   &filename=...
//   &subfolder=...
//   &quality=...
//   &action=beam (auto-submit if isReady())
function applyDeepLinkPrefill() {
  let parsed;
  try {
    parsed = new URL(window.location.href);
  } catch {
    return;
  }
  const params = parsed.searchParams;
  const url = params.get("url");
  if (url) {
    const u = $("#url");
    if (u) {
      u.value = url;
      u.dispatchEvent(new Event("input"));
    }
  }
  const filename = params.get("filename");
  if (filename) {
    const f = $("#filename");
    if (f) f.value = filename;
  }
  const subfolder = params.get("subfolder");
  if (subfolder) {
    const s = $("#subfolder");
    if (s) s.value = subfolder;
  }
  const quality = params.get("quality");
  if (quality) {
    const q = $("#quality");
    if (q) {
      const allowed = ["auto", "1080p", "720p", "480p", "audio", "custom"];
      if (allowed.includes(quality)) {
        q.value = quality;
        q.dispatchEvent(new Event("change"));
      }
    }
  }
  const action = params.get("action");
  if (action === "beam") {
    if (isReady() && url) {
      // Fire after a short delay so all event listeners are bound.
      setTimeout(() => {
        const form = $("#beam-form");
        if (form) {
          form.dispatchEvent(
            new Event("submit", { cancelable: true, bubbles: true })
          );
        }
      }, 200);
    } else {
      const u = $("#url");
      if (u) u.focus();
    }
  }
  // Strip query string so a refresh doesn't re-submit.
  if (url || filename || subfolder || quality || action) {
    try {
      const clean = parsed.origin + parsed.pathname + parsed.hash;
      history.replaceState(null, "", clean);
    } catch {
      /* noop */
    }
  }
}

// Wrap the original beam-form submit to record the URL into RecentURLs after
// a successful dispatch. We do this via a post-bind hook rather than editing
// bindForm directly so the existing flow is untouched.
function bindRecentUrlCapture() {
  const form = $("#beam-form");
  if (!form) return;
  // We capture the inputs *at submit time* (not at dispatch time) so we
  // catch even runs that fail validation after submit started, but we
  // only push to RecentURLs once the form's "Отправляем…" button label has
  // returned to its original state without an error appearing in #form-error.
  const urlInput = $("#url");
  const filenameInput = $("#filename");
  let pending = null;
  form.addEventListener(
    "submit",
    () => {
      pending = {
        url: urlInput ? urlInput.value.trim() : "",
        filename: filenameInput ? filenameInput.value.trim() : "",
      };
      // After ~6s, if no error appeared we treat the dispatch as successful
      // and store the URL.
      setTimeout(() => {
        if (!pending) return;
        const errEl = $("#form-error");
        if (!errEl || !errEl.textContent.trim()) {
          if (pending.url) RecentURLs.add(pending);
        }
        pending = null;
      }, 6000);
    },
    { capture: true }
  );
}

// Refresh button rotation on click — purely cosmetic but signals to the user
// that the click registered.
function bindRefreshButton() {
  const btn = $("#refresh-btn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    btn.classList.add("animate-spin");
    refreshRuns(true).finally(() => {
      setTimeout(() => btn.classList.remove("animate-spin"), 600);
    });
  });
}

// ---------- Theme ----------
//
// Three modes: "auto" follows the OS, "dark" forces the existing palette
// (which is what users had before this module landed), "light" inverts
// surfaces and text. We toggle a class on <html> and let CSS variables in
// style.css do the heavy lifting. The choice is persisted in localStorage,
// independent of the Drive-synced cfg blob, because theme is a per-device
// preference (a phone in the sun wants different settings than a desktop).
const Theme = (() => {
  const KEY = "film-beamer.theme.v1";
  const VALID = new Set(["auto", "dark", "light"]);
  const listeners = new Set();
  let media = null;

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw && VALID.has(raw)) return raw;
    } catch {
      /* localStorage may be disabled */
    }
    return "auto";
  }

  function write(value) {
    try {
      localStorage.setItem(KEY, value);
    } catch {
      /* noop */
    }
  }

  function effective(mode) {
    if (mode === "auto") {
      try {
        return window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
      } catch {
        return "dark";
      }
    }
    return mode;
  }

  function apply(mode) {
    const html = document.documentElement;
    const eff = effective(mode);
    html.classList.toggle("theme-light", eff === "light");
    html.classList.toggle("theme-dark", eff === "dark");
    html.dataset.theme = eff;
    html.dataset.themeChoice = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", eff === "light" ? "#f3f5fa" : "#0b0d14");
    }
    const colorScheme = document.querySelector('meta[name="color-scheme"]');
    if (colorScheme) {
      colorScheme.setAttribute(
        "content",
        eff === "light" ? "light" : "dark"
      );
    }
    for (const cb of listeners) {
      try {
        cb(mode, eff);
      } catch (err) {
        ErrorLog.push(`Theme listener: ${err.message || err}`);
      }
    }
  }

  function set(mode) {
    if (!VALID.has(mode)) return;
    write(mode);
    apply(mode);
    syncButtons(mode);
    toast(
      mode === "auto"
        ? "Тема: авто (следует за системой)"
        : mode === "light"
        ? "Тема: светлая"
        : "Тема: тёмная",
      "info",
      2000
    );
  }

  function syncButtons(mode) {
    const buttons = $$("[data-theme-set]");
    for (const btn of buttons) {
      const target = btn.getAttribute("data-theme-set");
      btn.classList.toggle("theme-btn-active", target === mode);
      btn.setAttribute("aria-pressed", target === mode ? "true" : "false");
    }
    const compact = $("#theme-toggle");
    if (compact) {
      const eff = effective(mode);
      compact.textContent = eff === "light" ? "🌞" : "🌙";
      compact.setAttribute(
        "title",
        mode === "auto"
          ? "Тема: авто"
          : mode === "light"
          ? "Тема: светлая"
          : "Тема: тёмная"
      );
    }
  }

  function bind() {
    apply(read());
    syncButtons(read());
    if (window.matchMedia) {
      try {
        media = window.matchMedia("(prefers-color-scheme: light)");
        const handler = () => {
          if (read() === "auto") apply("auto");
        };
        if (media.addEventListener) media.addEventListener("change", handler);
        else if (media.addListener) media.addListener(handler);
      } catch {
        /* noop */
      }
    }
    for (const btn of $$("[data-theme-set]")) {
      btn.addEventListener("click", () => set(btn.getAttribute("data-theme-set")));
    }
    const compact = $("#theme-toggle");
    if (compact) {
      compact.addEventListener("click", () => {
        const cur = read();
        const next =
          cur === "dark" ? "light" : cur === "light" ? "auto" : "dark";
        set(next);
      });
    }
  }

  return {
    bind,
    set,
    get: read,
    effective: () => effective(read()),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})();

// ---------- Sounds ----------
//
// Tiny WebAudio "ding" / "buzz" cues for run completion. We deliberately
// avoid any audio assets (asset bundling adds CI complexity for one feature)
// and synthesise the tones in browser. Honors a localStorage opt-out.
const Sounds = (() => {
  const KEY = "film-beamer.sound.v1";
  let ctx = null;

  function read() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === "off") return false;
    } catch {
      /* noop */
    }
    return true;
  }

  function set(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      /* noop */
    }
  }

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    } catch {
      return null;
    }
    return ctx;
  }

  function tone({ freq, duration, type = "sine", gain = 0.05, force = false }) {
    if (!force && !read()) return;
    const audio = ensureCtx();
    if (!audio) return;
    try {
      if (audio.state === "suspended") audio.resume().catch(() => {});
      const osc = audio.createOscillator();
      const env = audio.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, audio.currentTime);
      env.gain.linearRampToValueAtTime(gain, audio.currentTime + 0.01);
      env.gain.exponentialRampToValueAtTime(
        0.0001,
        audio.currentTime + duration
      );
      osc.connect(env);
      env.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + duration);
    } catch {
      /* swallow audio errors */
    }
  }

  function ding(force = false) {
    tone({ freq: 880, duration: 0.16, type: "sine", gain: 0.06, force });
    setTimeout(
      () => tone({ freq: 1320, duration: 0.18, type: "sine", gain: 0.04, force }),
      90
    );
  }

  function buzz(force = false) {
    tone({ freq: 220, duration: 0.22, type: "sawtooth", gain: 0.05, force });
    setTimeout(
      () => tone({ freq: 165, duration: 0.28, type: "sawtooth", gain: 0.05, force }),
      130
    );
  }

  function chirp(force = false) {
    tone({ freq: 660, duration: 0.08, type: "triangle", gain: 0.03, force });
  }

  return { read, set, ding, buzz, chirp };
})();

// ---------- Notifications ----------
//
// Best-effort wrapper around the Notification API. Silently no-ops on
// browsers that don't expose it (most iOS Safari versions, etc.). The
// permission prompt is only triggered when the user explicitly opts in,
// never on page load.
const Notifications = (() => {
  const KEY = "film-beamer.notify.v1";

  function supported() {
    return typeof window !== "undefined" && "Notification" in window;
  }

  function status() {
    if (!supported()) return "unsupported";
    return Notification.permission;
  }

  function readPref() {
    try {
      return localStorage.getItem(KEY) === "on";
    } catch {
      return false;
    }
  }

  function writePref(on) {
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {
      /* noop */
    }
  }

  async function request() {
    if (!supported()) {
      toast("Браузер не поддерживает уведомления", "warn");
      return false;
    }
    try {
      const result = await Notification.requestPermission();
      const ok = result === "granted";
      writePref(ok);
      if (ok) {
        toast("Уведомления включены — пинг по завершении", "ok");
      } else {
        toast(
          result === "denied"
            ? "Доступ к уведомлениям запрещён в настройках браузера"
            : "Уведомления не включены",
          "warn"
        );
      }
      return ok;
    } catch (err) {
      ErrorLog.push(`Notifications.request: ${err.message || err}`);
      return false;
    }
  }

  function disable() {
    writePref(false);
    toast("Уведомления выключены", "info", 2000);
  }

  function notify(title, options = {}) {
    if (!readPref()) return null;
    if (status() !== "granted") return null;
    try {
      const note = new Notification(title, {
        icon: "./icon.svg",
        badge: "./icon.svg",
        tag: "film-beamer",
        renotify: true,
        ...options,
      });
      note.onclick = () => {
        try {
          window.focus();
        } catch {
          /* noop */
        }
        note.close();
        if (options.url) {
          try {
            window.open(options.url, "_blank", "noopener,noreferrer");
          } catch {
            /* noop */
          }
        }
      };
      return note;
    } catch (err) {
      ErrorLog.push(`Notifications.notify: ${err.message || err}`);
      return null;
    }
  }

  function vibrate(pattern) {
    if (!navigator.vibrate) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* noop */
    }
  }

  function announceSuccess(meta) {
    const title = "Заброс готов";
    const body = meta && meta.filename
      ? `${meta.filename} в Drive`
      : "Файл загружен на Google Drive";
    notify(title, { body, url: meta && meta.url });
    vibrate([60, 40, 60]);
    Sounds.ding();
  }

  function announceFailure(meta) {
    const title = "Ошибка заброса";
    const body = meta && meta.message
      ? meta.message
      : "Нажми, чтобы открыть лог раннера";
    notify(title, { body, url: meta && meta.url });
    vibrate([200, 100, 200]);
    Sounds.buzz();
  }

  function bind() {
    const enable = $("#notify-enable");
    const disableBtn = $("#notify-disable");
    const status = $("#notify-status");
    const refreshStatus = () => {
      if (!status) return;
      if (!supported()) {
        status.textContent = "не поддерживается";
        status.className = "text-xs text-slate-500";
        return;
      }
      const perm = Notification.permission;
      const enabled = readPref();
      status.textContent = enabled
        ? "включены"
        : perm === "denied"
        ? "запрещены"
        : "выключены";
      status.className = `text-xs ${
        enabled
          ? "text-emerald-300"
          : perm === "denied"
          ? "text-rose-300"
          : "text-slate-400"
      }`;
    };
    refreshStatus();
    if (enable) enable.addEventListener("click", () => request().then(refreshStatus));
    if (disableBtn) disableBtn.addEventListener("click", () => {
      disable();
      refreshStatus();
    });
    // Sound checkbox is owned by bindSoundToggle() — we used to also wire
    // a `change` listener here, which double-fired Sounds.set on every
    // click and stacked two toasts on top of each other. Leaving the
    // wiring in one place keeps the behaviour predictable.
  }

  return {
    supported,
    status,
    readPref,
    writePref,
    request,
    disable,
    notify,
    announceSuccess,
    announceFailure,
    bind,
  };
})();

// ---------- Run history ----------
//
// `RunHistory` is the persistent counterpart to the live runs list. Where
// the runs panel re-renders from `gh.listRuns()` on every poll, this
// localStorage-backed store remembers every run we *initiated* through this
// app — including their inputs (URL, filename, subfolder, quality), so
// re-beam works even if the run scrolled off the GitHub list.
const RunHistory = (() => {
  const KEY = "film-beamer.history.v1";
  const MAX = 200;
  const listeners = new Set();

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry) => entry && typeof entry === "object" && entry.id
      );
    } catch {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
    } catch {
      /* over quota or disabled */
    }
  }

  function notify() {
    const snap = read();
    for (const cb of listeners) {
      try {
        cb(snap);
      } catch (err) {
        ErrorLog.push(`RunHistory listener: ${err.message || err}`);
      }
    }
  }

  function add(entry) {
    if (!entry || !entry.id) return;
    const list = read().filter((e) => e.id !== entry.id);
    list.unshift({
      ...entry,
      addedAt: Date.now(),
    });
    write(list);
    notify();
  }

  function update(id, patch) {
    const list = read();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
    write(list);
    notify();
  }

  function remove(id) {
    const list = read().filter((e) => e.id !== id);
    write(list);
    notify();
  }

  function clear() {
    write([]);
    notify();
  }

  function findByDispatchedAt(ts) {
    const list = read();
    // Pending entries that haven't been linked to a run id yet store dispatchedAt.
    return list.find((e) => !e.runId && e.dispatchedAt === ts);
  }

  function statsFor(list) {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60_000;
    const weekAgo = now - 7 * 24 * 60 * 60_000;
    let total = list.length;
    let success = 0;
    let failure = 0;
    let inProgress = 0;
    let dayCount = 0;
    let weekCount = 0;
    let durSum = 0;
    let durCount = 0;
    for (const entry of list) {
      const conclusion = (entry.conclusion || "").toLowerCase();
      if (conclusion === "success") success++;
      else if (
        conclusion === "failure" ||
        conclusion === "timed_out" ||
        conclusion === "cancelled"
      ) {
        failure++;
      } else if (!conclusion) {
        inProgress++;
      }
      const ts = entry.addedAt || entry.dispatchedAt || 0;
      if (ts >= dayAgo) dayCount++;
      if (ts >= weekAgo) weekCount++;
      if (entry.startedAt && entry.completedAt) {
        durSum += entry.completedAt - entry.startedAt;
        durCount++;
      }
    }
    return {
      total,
      success,
      failure,
      inProgress,
      dayCount,
      weekCount,
      avgDurationMs: durCount ? Math.round(durSum / durCount) : 0,
      successRate: total
        ? Math.round((success / Math.max(1, total - inProgress)) * 100)
        : 0,
    };
  }

  function fmtDuration(ms) {
    if (!ms || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s} с`;
    const m = Math.floor(s / 60);
    const ss = s % 60;
    if (m < 60) return `${m}:${String(ss).padStart(2, "0")}`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  }

  function shortUrl(raw) {
    if (!raw) return "—";
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^www\./, "");
      const path = (u.pathname || "/").slice(0, 30);
      return `${host}${path}${u.pathname.length > 30 ? "…" : ""}`;
    } catch {
      return raw.length > 60 ? `${raw.slice(0, 57)}…` : raw;
    }
  }

  function statusPill(entry) {
    const concl = (entry.conclusion || "").toLowerCase();
    if (concl === "success")
      return { text: "успех", cls: "history-pill-ok" };
    if (concl === "failure")
      return { text: "ошибка", cls: "history-pill-bad" };
    if (concl === "cancelled")
      return { text: "отменён", cls: "history-pill-warn" };
    if (concl === "timed_out")
      return { text: "таймаут", cls: "history-pill-bad" };
    if ((entry.status || "").toLowerCase() === "in_progress")
      return { text: "идёт", cls: "history-pill-info" };
    if ((entry.status || "").toLowerCase() === "queued")
      return { text: "в очереди", cls: "history-pill-info" };
    if (!entry.runId) return { text: "ждёт", cls: "history-pill-pending" };
    return { text: entry.conclusion || "—", cls: "history-pill-pending" };
  }

  function applyFilter(list, query) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return list;
    return list.filter((entry) => {
      const fields = [
        entry.url,
        entry.filename,
        entry.subfolder,
        entry.quality,
        entry.conclusion,
        entry.status,
        entry.runNumber ? `#${entry.runNumber}` : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return fields.includes(q);
    });
  }

  function applyStatusFilter(list, status) {
    if (!status || status === "all") return list;
    return list.filter((entry) => {
      const concl = (entry.conclusion || "").toLowerCase();
      const s = (entry.status || "").toLowerCase();
      if (status === "success") return concl === "success";
      if (status === "failure")
        return (
          concl === "failure" || concl === "timed_out" || concl === "cancelled"
        );
      if (status === "in_progress") return !concl && (s === "in_progress" || s === "queued");
      if (status === "pending") return !entry.runId;
      return true;
    });
  }

  function render() {
    const root = $("#history-list");
    if (!root) return;
    const q = $("#history-search") ? $("#history-search").value : "";
    const status = $("#history-filter") ? $("#history-filter").value : "all";
    const all = read();
    const filtered = applyStatusFilter(applyFilter(all, q), status);
    const empty = $("#history-empty");
    const counter = $("#history-count");
    if (counter) {
      counter.textContent =
        filtered.length === all.length
          ? `${all.length}`
          : `${filtered.length}/${all.length}`;
    }
    if (empty) empty.classList.toggle("hidden", filtered.length > 0);
    root.innerHTML = "";
    if (!filtered.length) {
      renderStats(all);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
      frag.appendChild(renderRow(entry));
    }
    root.appendChild(frag);
    renderStats(all);
  }

  function renderStats(list) {
    const stats = statsFor(list);
    const els = {
      total: $("#stats-total"),
      success: $("#stats-success"),
      failure: $("#stats-failure"),
      day: $("#stats-day"),
      week: $("#stats-week"),
      rate: $("#stats-rate"),
      duration: $("#stats-duration"),
    };
    if (els.total) els.total.textContent = String(stats.total);
    if (els.success) els.success.textContent = String(stats.success);
    if (els.failure) els.failure.textContent = String(stats.failure);
    if (els.day) els.day.textContent = String(stats.dayCount);
    if (els.week) els.week.textContent = String(stats.weekCount);
    if (els.rate)
      els.rate.textContent = stats.total ? `${stats.successRate}%` : "—";
    if (els.duration)
      els.duration.textContent = fmtDuration(stats.avgDurationMs);
  }

  function renderRow(entry) {
    const li = document.createElement("li");
    li.className = "history-row";
    li.dataset.id = entry.id;

    const head = document.createElement("div");
    head.className = "history-row-head";
    const pill = statusPill(entry);
    const badge = document.createElement("span");
    badge.className = `history-pill ${pill.cls}`;
    badge.textContent = pill.text;
    head.appendChild(badge);

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = entry.filename || shortUrl(entry.url);
    head.appendChild(title);

    if (entry.runNumber != null) {
      const num = document.createElement("span");
      num.className = "history-run-num";
      num.textContent = `#${entry.runNumber}`;
      head.appendChild(num);
    }

    const time = document.createElement("span");
    time.className = "history-time";
    time.textContent = timeAgo(
      new Date(entry.addedAt || entry.dispatchedAt || 0).toISOString()
    );
    head.appendChild(time);
    li.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    meta.appendChild(metaPair("URL", shortUrl(entry.url), entry.url));
    if (entry.subfolder) meta.appendChild(metaPair("Папка", entry.subfolder));
    if (entry.quality) meta.appendChild(metaPair("Качество", entry.quality));
    if (entry.startedAt && entry.completedAt) {
      meta.appendChild(
        metaPair(
          "Время",
          fmtDuration(entry.completedAt - entry.startedAt)
        )
      );
    }
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "history-actions";

    if (entry.runUrl) {
      const open = document.createElement("a");
      open.href = entry.runUrl;
      open.target = "_blank";
      open.rel = "noreferrer noopener";
      open.className = "history-btn history-btn-link";
      open.textContent = "Открыть";
      actions.appendChild(open);
    }

    const repeat = document.createElement("button");
    repeat.type = "button";
    repeat.className = "history-btn history-btn-repeat";
    repeat.textContent = "Перезапустить";
    repeat.addEventListener("click", () => repeatEntry(entry));
    actions.appendChild(repeat);

    if (entry.url) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "history-btn";
      copy.textContent = "Копировать URL";
      copy.addEventListener("click", () => copyUrl(entry.url));
      actions.appendChild(copy);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-btn history-btn-remove";
    remove.textContent = "Удалить";
    remove.addEventListener("click", () => {
      RunHistory.remove(entry.id);
      toast("Запись удалена", "info", 2000);
    });
    actions.appendChild(remove);

    li.appendChild(actions);
    return li;
  }

  function metaPair(k, v, hover) {
    const wrap = document.createElement("span");
    wrap.className = "history-meta-pair";
    if (hover) wrap.title = hover;
    const key = document.createElement("span");
    key.className = "history-meta-key";
    key.textContent = `${k}:`;
    wrap.appendChild(key);
    const val = document.createElement("span");
    val.className = "history-meta-val";
    val.textContent = v;
    wrap.appendChild(val);
    return wrap;
  }

  function copyUrl(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("URL скопирован", "ok", 1800),
        () => toast("Не удалось скопировать", "warn", 2400)
      );
      return;
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("URL скопирован", "ok", 1800);
    } catch {
      toast("Не удалось скопировать", "warn", 2400);
    }
  }

  function repeatEntry(entry) {
    const url = $("#url");
    const filename = $("#filename");
    const subfolder = $("#subfolder");
    const quality = $("#quality");
    const ytdlpFormat = $("#ytdlp_format");
    if (url) url.value = entry.url || "";
    if (filename) filename.value = entry.filename || "";
    if (subfolder) subfolder.value = entry.subfolder || "";
    if (quality) {
      quality.value = entry.quality || "auto";
      quality.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (ytdlpFormat) ytdlpFormat.value = entry.ytdlp_format || "";
    if (url) {
      url.dispatchEvent(new Event("input", { bubbles: true }));
      url.focus();
    }
    closeHistoryDialog();
    toast("Поля заполнены — нажми «Закинуть»", "info", 2400);
  }

  function bind() {
    const list = $("#history-list");
    if (!list) return;
    listeners.add((entries) => {
      void entries;
      render();
    });
    const search = $("#history-search");
    if (search) search.addEventListener("input", render);
    const filter = $("#history-filter");
    if (filter) filter.addEventListener("change", render);
    const clearBtn = $("#history-clear");
    if (clearBtn)
      clearBtn.addEventListener("click", () => {
        if (!read().length) return;
        if (
          !confirm(
            "Удалить всю историю запусков? Это локальный список — на GitHub он останется."
          )
        )
          return;
        clear();
        toast("История очищена", "info", 2200);
      });
    const exportBtn = $("#history-export");
    if (exportBtn)
      exportBtn.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(read(), null, 2)], {
          type: "application/json",
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `film-beamer-history-${new Date()
          .toISOString()
          .replace(/[:.]/g, "-")}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        toast("Файл сохранён", "ok", 2200);
      });
    const openBtn = $("#open-history");
    if (openBtn) openBtn.addEventListener("click", openHistoryDialog);
    const closeBtn = $("#history-close");
    if (closeBtn) closeBtn.addEventListener("click", closeHistoryDialog);
    const dialog = $("#history-dialog");
    if (dialog)
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) closeHistoryDialog();
      });
    render();
  }

  function openHistoryDialog() {
    const dlg = $("#history-dialog");
    if (!dlg) return;
    dlg.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    render();
    setTimeout(() => {
      const search = $("#history-search");
      if (search) search.focus();
    }, 30);
  }

  function closeHistoryDialog() {
    const dlg = $("#history-dialog");
    if (!dlg) return;
    dlg.classList.add("hidden");
    document.body.style.overflow = "";
  }

  return {
    add,
    update,
    remove,
    clear,
    read,
    findByDispatchedAt,
    bind,
    render,
    open: openHistoryDialog,
    close: closeHistoryDialog,
  };
})();

// ---------- Workflow presets ----------
//
// A "preset" is a saved combination of form inputs (filename template,
// subfolder, quality, custom yt-dlp format). The user picks a preset name
// from a dropdown and the form snaps to that preset's values. Presets live
// in localStorage and roll up into the Drive sync blob so they follow the
// user across devices.
const WorkflowPresets = (() => {
  const KEY = "film-beamer.presets.v1";
  const listeners = new Set();

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((p) => p && typeof p === "object" && p.name);
    } catch {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* over quota / disabled */
    }
  }

  function notify() {
    for (const cb of listeners) {
      try {
        cb(read());
      } catch (err) {
        ErrorLog.push(`Presets listener: ${err.message || err}`);
      }
    }
  }

  function add(preset) {
    if (!preset || !preset.name) return;
    const list = read().filter((p) => p.name !== preset.name);
    list.push({
      ...preset,
      createdAt: preset.createdAt || Date.now(),
      updatedAt: Date.now(),
    });
    list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    write(list);
    notify();
  }

  function remove(name) {
    write(read().filter((p) => p.name !== name));
    notify();
  }

  // Wholesale replace + notify + render. Used by SettingsBackup.applySnapshot
  // so an imported preset list shows up in the dropdown immediately. Plain
  // write() skips listeners; we want them fired so the manage-list and the
  // <select> in the form both refresh without a page reload.
  function replaceAll(list) {
    if (!Array.isArray(list)) return;
    const safe = list.filter((p) => p && typeof p === "object" && p.name);
    write(safe);
    notify();
  }

  function find(name) {
    return read().find((p) => p.name === name) || null;
  }

  function snapshotForm() {
    return {
      filename: ($("#filename") && $("#filename").value.trim()) || "",
      subfolder: ($("#subfolder") && $("#subfolder").value.trim()) || "",
      quality: ($("#quality") && $("#quality").value) || "auto",
      ytdlp_format:
        ($("#ytdlp_format") && $("#ytdlp_format").value.trim()) || "",
    };
  }

  function applyToForm(preset) {
    if (!preset) return;
    const filename = $("#filename");
    const subfolder = $("#subfolder");
    const quality = $("#quality");
    const ytdlp = $("#ytdlp_format");
    if (filename) filename.value = preset.filename || "";
    if (subfolder) subfolder.value = preset.subfolder || "";
    if (quality) {
      quality.value = preset.quality || "auto";
      quality.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (ytdlp) ytdlp.value = preset.ytdlp_format || "";
  }

  function renderSelect() {
    const select = $("#preset-select");
    if (!select) return;
    const current = select.value;
    select.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— Пресет —";
    select.appendChild(placeholder);
    for (const preset of read()) {
      const opt = document.createElement("option");
      opt.value = preset.name;
      opt.textContent = preset.name;
      select.appendChild(opt);
    }
    if (current) select.value = current;
  }

  function renderList() {
    const root = $("#preset-list");
    if (!root) return;
    const list = read();
    root.innerHTML = "";
    const empty = $("#preset-empty");
    if (empty) empty.classList.toggle("hidden", list.length > 0);
    for (const preset of list) {
      const card = document.createElement("div");
      card.className = "preset-card";

      const head = document.createElement("div");
      head.className = "preset-card-head";
      const title = document.createElement("span");
      title.className = "preset-card-title";
      title.textContent = preset.name;
      head.appendChild(title);
      if (preset.updatedAt) {
        const ts = document.createElement("span");
        ts.className = "preset-card-ts";
        ts.textContent = timeAgo(new Date(preset.updatedAt).toISOString());
        head.appendChild(ts);
      }
      card.appendChild(head);

      const body = document.createElement("div");
      body.className = "preset-card-body";
      body.appendChild(presetField("Файл", preset.filename || "—"));
      body.appendChild(presetField("Папка", preset.subfolder || "—"));
      body.appendChild(presetField("Качество", preset.quality || "auto"));
      if (preset.ytdlp_format) {
        body.appendChild(presetField("yt-dlp", preset.ytdlp_format));
      }
      card.appendChild(body);

      const actions = document.createElement("div");
      actions.className = "preset-card-actions";
      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "preset-btn preset-btn-apply";
      apply.textContent = "Применить";
      apply.addEventListener("click", () => {
        applyToForm(preset);
        toast(`Пресет «${preset.name}» применён`, "ok", 2000);
      });
      actions.appendChild(apply);
      const update = document.createElement("button");
      update.type = "button";
      update.className = "preset-btn";
      update.textContent = "Обновить из формы";
      update.addEventListener("click", () => {
        add({ ...preset, ...snapshotForm() });
        toast(`Пресет «${preset.name}» обновлён`, "ok", 2200);
      });
      actions.appendChild(update);
      const del = document.createElement("button");
      del.type = "button";
      del.className = "preset-btn preset-btn-remove";
      del.textContent = "Удалить";
      del.addEventListener("click", () => {
        if (!confirm(`Удалить пресет «${preset.name}»?`)) return;
        remove(preset.name);
        toast("Пресет удалён", "info", 2000);
      });
      actions.appendChild(del);
      card.appendChild(actions);
      root.appendChild(card);
    }
  }

  function presetField(k, v) {
    const wrap = document.createElement("div");
    wrap.className = "preset-field";
    const key = document.createElement("span");
    key.className = "preset-field-key";
    key.textContent = `${k}:`;
    wrap.appendChild(key);
    const val = document.createElement("span");
    val.className = "preset-field-val";
    val.textContent = v;
    wrap.appendChild(val);
    return wrap;
  }

  function bind() {
    const select = $("#preset-select");
    const saveBtn = $("#preset-save");
    const openBtn = $("#preset-manage");
    const closeBtn = $("#preset-close");
    const dialog = $("#preset-dialog");
    listeners.add(() => {
      renderSelect();
      renderList();
    });
    if (select) {
      select.addEventListener("change", () => {
        const preset = find(select.value);
        if (preset) {
          applyToForm(preset);
          toast(`Пресет «${preset.name}»`, "info", 1800);
        }
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        const name = (
          prompt("Имя пресета (видно только тебе)") || ""
        ).trim();
        if (!name) return;
        add({ name, ...snapshotForm() });
        toast(`Пресет «${name}» сохранён`, "ok", 2400);
      });
    }
    if (openBtn) openBtn.addEventListener("click", openDialog);
    if (closeBtn) closeBtn.addEventListener("click", closeDialog);
    if (dialog)
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) closeDialog();
      });
    renderSelect();
    renderList();
  }

  function openDialog() {
    const dlg = $("#preset-dialog");
    if (!dlg) return;
    dlg.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    renderList();
  }

  function closeDialog() {
    const dlg = $("#preset-dialog");
    if (!dlg) return;
    dlg.classList.add("hidden");
    document.body.style.overflow = "";
  }

  return {
    read,
    write,
    add,
    remove,
    find,
    bind,
    open: openDialog,
    close: closeDialog,
  };
})();

// ---------- Bulk queue ----------
//
// Lets the user paste 50 URLs at once and dispatches them sequentially with
// a configurable concurrency limit (default 1, max 3 — anything higher
// chokes the runner Drive uploads). The queue persists across reloads so a
// page refresh doesn't lose 30 in-flight items.
const BulkQueue = (() => {
  const KEY = "film-beamer.queue.v1";
  const STATUS = {
    PENDING: "pending",
    DISPATCHING: "dispatching",
    RUNNING: "running",
    DONE: "done",
    FAILED: "failed",
    SKIPPED: "skipped",
    CANCELLED: "cancelled",
  };
  const listeners = new Set();
  let running = false;
  let concurrency = 1;
  let abortRequested = false;

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => e && e.url);
    } catch {
      return [];
    }
  }

  function write(list) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* noop */
    }
  }

  function notify() {
    const snap = read();
    for (const cb of listeners) {
      try {
        cb(snap);
      } catch (err) {
        ErrorLog.push(`BulkQueue listener: ${err.message || err}`);
      }
    }
  }

  function add(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const list = read();
    const seen = new Set(list.map((e) => e.url));
    let added = 0;
    for (const item of items) {
      const url = (item && item.url) || "";
      if (!url || seen.has(url)) continue;
      seen.add(url);
      list.push({
        id: `q${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        url,
        filename: item.filename || "",
        subfolder: item.subfolder || "",
        quality: item.quality || "auto",
        ytdlp_format: item.ytdlp_format || "",
        status: STATUS.PENDING,
        attempts: 0,
        addedAt: Date.now(),
        updatedAt: Date.now(),
        error: "",
      });
      added++;
    }
    write(list);
    notify();
    return added;
  }

  function update(id, patch) {
    const list = read();
    const idx = list.findIndex((e) => e.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], ...patch, updatedAt: Date.now() };
    write(list);
    notify();
  }

  function remove(id) {
    write(read().filter((e) => e.id !== id));
    notify();
  }

  function clearDone() {
    const list = read().filter(
      (e) => e.status !== STATUS.DONE && e.status !== STATUS.SKIPPED
    );
    write(list);
    notify();
  }

  function clearAll() {
    write([]);
    notify();
  }

  function abort() {
    abortRequested = true;
    toast("Очередь остановится после текущего элемента", "info", 2400);
  }

  function status() {
    return {
      running,
      abortRequested,
      concurrency,
      total: read().length,
      pending: read().filter((e) => e.status === STATUS.PENDING).length,
      done: read().filter(
        (e) => e.status === STATUS.DONE || e.status === STATUS.SKIPPED
      ).length,
      failed: read().filter((e) => e.status === STATUS.FAILED).length,
    };
  }

  function setConcurrency(n) {
    const v = Math.max(1, Math.min(3, parseInt(n, 10) || 1));
    concurrency = v;
    return v;
  }

  function parsePastedList(text) {
    if (!text) return [];
    const lines = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const line of lines) {
      // Each line may be just a URL, or "URL | filename | subfolder | quality"
      const parts = line.split(/\s*[|\t]\s*/);
      const item = { url: parts[0] || "" };
      if (parts[1]) item.filename = parts[1];
      if (parts[2]) item.subfolder = parts[2];
      if (parts[3]) item.quality = parts[3];
      const cls = classifyUrl(item.url).kind;
      if (cls === "empty" || cls === "invalid" || cls === "kinopoisk") continue;
      out.push(item);
    }
    return out;
  }

  async function dispatchOne(entry, gh, ref) {
    update(entry.id, {
      status: STATUS.DISPATCHING,
      attempts: (entry.attempts || 0) + 1,
      error: "",
    });
    const inputs = {
      url: entry.url,
      filename: entry.filename || "",
      subfolder: entry.subfolder || "",
      quality: entry.quality || "auto",
      ytdlp_format: entry.ytdlp_format || "",
    };
    try {
      await gh.dispatchWorkflow({ ref, inputs });
      update(entry.id, {
        status: STATUS.RUNNING,
        dispatchedAt: new Date().toISOString(),
      });
      try {
        RunHistory.add({
          id: `bulk-${entry.id}`,
          dispatchedAt: new Date().toISOString(),
          ...inputs,
          source: "bulk",
        });
      } catch {
        /* RunHistory may not be loaded yet on edge cases */
      }
      return { ok: true };
    } catch (err) {
      const msg = explainDispatchError(err, ref);
      ErrorLog.push(`Очередь: ${msg}`);
      update(entry.id, {
        status: STATUS.FAILED,
        error: msg.slice(0, 240),
      });
      return { ok: false, error: msg };
    }
  }

  async function start() {
    if (running) return;
    if (!isReady()) {
      toast("Сначала задай репо и токен в Настройках", "warn", 3200);
      return;
    }
    running = true;
    abortRequested = false;
    notify();
    toast("Очередь запущена", "info", 1800);
    const gh = new GitHubClient(cfg);
    let ref;
    try {
      ref = await resolveBranch();
    } catch (err) {
      ErrorLog.push(`Очередь: не удалось определить ветку — ${err.message || err}`);
      running = false;
      notify();
      return;
    }
    try {
      while (!abortRequested) {
        const list = read();
        const next = list.find((e) => e.status === STATUS.PENDING);
        if (!next) break;
        const result = await dispatchOne(next, gh, ref);
        if (result.ok) {
          update(next.id, { status: STATUS.DONE });
        }
        // Rate-limit pacing: 4s between dispatches when concurrency = 1.
        await new Promise((r) => setTimeout(r, 4000 / concurrency));
      }
    } finally {
      running = false;
      abortRequested = false;
      notify();
      toast("Очередь завершена", "ok", 2400);
    }
  }

  function render() {
    const root = $("#queue-list");
    if (!root) return;
    const list = read();
    const empty = $("#queue-empty");
    if (empty) empty.classList.toggle("hidden", list.length > 0);
    const counter = $("#queue-counter");
    const s = status();
    if (counter) {
      counter.textContent = list.length
        ? `${s.done}/${list.length} · ошибок ${s.failed}`
        : "пусто";
    }
    root.innerHTML = "";
    for (const entry of list) {
      root.appendChild(renderRow(entry));
    }
    const startBtn = $("#queue-start");
    const abortBtn = $("#queue-abort");
    if (startBtn) {
      startBtn.disabled = running || !s.pending;
      startBtn.textContent = running
        ? "Идёт…"
        : s.pending
        ? `Запустить (${s.pending})`
        : "Нет ожидающих";
    }
    if (abortBtn) abortBtn.disabled = !running;
  }

  function renderRow(entry) {
    const row = document.createElement("li");
    row.className = `queue-row queue-status-${entry.status}`;
    row.dataset.id = entry.id;

    const head = document.createElement("div");
    head.className = "queue-row-head";
    const pill = document.createElement("span");
    pill.className = `queue-pill queue-pill-${entry.status}`;
    pill.textContent = labelForStatus(entry.status);
    head.appendChild(pill);
    const url = document.createElement("span");
    url.className = "queue-url";
    url.textContent = shortenUrl(entry.url);
    url.title = entry.url;
    head.appendChild(url);
    if (entry.attempts > 1) {
      const att = document.createElement("span");
      att.className = "queue-att";
      att.textContent = `попытка ${entry.attempts}`;
      head.appendChild(att);
    }
    row.appendChild(head);

    if (entry.filename || entry.subfolder || entry.quality !== "auto") {
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      if (entry.filename) meta.appendChild(metaPair("файл", entry.filename));
      if (entry.subfolder) meta.appendChild(metaPair("папка", entry.subfolder));
      if (entry.quality && entry.quality !== "auto")
        meta.appendChild(metaPair("качество", entry.quality));
      row.appendChild(meta);
    }

    if (entry.error) {
      const err = document.createElement("div");
      err.className = "queue-error";
      err.textContent = entry.error;
      row.appendChild(err);
    }

    const actions = document.createElement("div");
    actions.className = "queue-actions";
    if (entry.status === STATUS.FAILED) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "queue-btn";
      retry.textContent = "Повторить";
      retry.addEventListener("click", () =>
        update(entry.id, { status: STATUS.PENDING, error: "" })
      );
      actions.appendChild(retry);
    }
    if (
      entry.status === STATUS.PENDING ||
      entry.status === STATUS.FAILED
    ) {
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "queue-btn";
      skip.textContent = "Пропустить";
      skip.addEventListener("click", () =>
        update(entry.id, { status: STATUS.SKIPPED })
      );
      actions.appendChild(skip);
    }
    const drop = document.createElement("button");
    drop.type = "button";
    drop.className = "queue-btn queue-btn-remove";
    drop.textContent = "Удалить";
    drop.addEventListener("click", () => remove(entry.id));
    actions.appendChild(drop);
    row.appendChild(actions);
    return row;
  }

  function metaPair(k, v) {
    const wrap = document.createElement("span");
    wrap.className = "queue-meta-pair";
    const key = document.createElement("span");
    key.className = "queue-meta-key";
    key.textContent = `${k}:`;
    wrap.appendChild(key);
    const val = document.createElement("span");
    val.className = "queue-meta-val";
    val.textContent = v;
    wrap.appendChild(val);
    return wrap;
  }

  function shortenUrl(raw) {
    if (!raw) return "—";
    if (raw.length > 80) return `${raw.slice(0, 77)}…`;
    return raw;
  }

  function labelForStatus(s) {
    switch (s) {
      case STATUS.PENDING:
        return "ожидает";
      case STATUS.DISPATCHING:
        return "отправка…";
      case STATUS.RUNNING:
        return "запущен";
      case STATUS.DONE:
        return "готово";
      case STATUS.FAILED:
        return "ошибка";
      case STATUS.SKIPPED:
        return "пропущен";
      case STATUS.CANCELLED:
        return "отменён";
      default:
        return s;
    }
  }

  function bind() {
    listeners.add(() => render());
    const open = $("#open-queue");
    const close = $("#queue-close");
    const dialog = $("#queue-dialog");
    if (open) open.addEventListener("click", () => openDialog());
    if (close) close.addEventListener("click", () => closeDialog());
    if (dialog)
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) closeDialog();
      });

    const importBtn = $("#queue-import");
    if (importBtn)
      importBtn.addEventListener("click", () => {
        const ta = $("#queue-input");
        if (!ta) return;
        const items = parsePastedList(ta.value);
        if (!items.length) {
          toast("Не нашёл валидных URL", "warn", 2400);
          return;
        }
        const added = add(items);
        ta.value = "";
        toast(`Добавлено в очередь: ${added}`, "ok", 2400);
      });
    const startBtn = $("#queue-start");
    if (startBtn)
      startBtn.addEventListener("click", () => {
        start().catch((err) =>
          ErrorLog.push(`Очередь: ${err.message || err}`)
        );
      });
    const abortBtn = $("#queue-abort");
    if (abortBtn) abortBtn.addEventListener("click", () => abort());
    const clearDoneBtn = $("#queue-clear-done");
    if (clearDoneBtn)
      clearDoneBtn.addEventListener("click", () => {
        clearDone();
        toast("Готовые удалены", "info", 1800);
      });
    const clearAllBtn = $("#queue-clear-all");
    if (clearAllBtn)
      clearAllBtn.addEventListener("click", () => {
        if (!read().length) return;
        if (!confirm("Очистить очередь полностью?")) return;
        clearAll();
        toast("Очередь очищена", "info", 1800);
      });
    const concSel = $("#queue-concurrency");
    if (concSel) {
      concSel.value = String(concurrency);
      concSel.addEventListener("change", () => {
        const v = setConcurrency(concSel.value);
        toast(`Параллельных дозвонов: ${v}`, "info", 1800);
      });
    }
    render();
  }

  function openDialog() {
    const dlg = $("#queue-dialog");
    if (!dlg) return;
    dlg.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    render();
    setTimeout(() => {
      const ta = $("#queue-input");
      if (ta) ta.focus();
    }, 30);
  }

  function closeDialog() {
    const dlg = $("#queue-dialog");
    if (!dlg) return;
    dlg.classList.add("hidden");
    document.body.style.overflow = "";
  }

  return {
    read,
    add,
    remove,
    clearDone,
    clearAll,
    start,
    abort,
    status,
    bind,
    open: openDialog,
    close: closeDialog,
  };
})();

// ---------- Help dialog ----------
//
// Reference dialog with keyboard shortcuts, common gotchas and links to the
// upstream tools (yt-dlp, aria2c) so the user can grep their own answers.
const HelpDialog = (() => {
  function open() {
    const dlg = $("#help-dialog");
    if (!dlg) return;
    dlg.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  }

  function close() {
    const dlg = $("#help-dialog");
    if (!dlg) return;
    dlg.classList.add("hidden");
    document.body.style.overflow = "";
  }

  function bind() {
    const openBtn = $("#open-help");
    const closeBtn = $("#help-close");
    const dialog = $("#help-dialog");
    if (openBtn) openBtn.addEventListener("click", open);
    if (closeBtn) closeBtn.addEventListener("click", close);
    if (dialog)
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) close();
      });
  }

  return { open, close, bind };
})();

// ---------- Settings export / import ----------
//
// JSON dump of cfg (without secret-account keys redacted) so the user can
// copy their setup between machines without having to re-paste 30 things in
// Settings. Drive sync covers 90% of this need; this is a manual escape
// hatch for "I want to email this to a friend" or "I'm switching browsers".
const SettingsBackup = (() => {
  const REDACTED = ["token"];
  const PRIVATE = ["driveSaJson"];

  function snapshot(opts = {}) {
    const out = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (opts.includeSecrets || (!REDACTED.includes(k) && !PRIVATE.includes(k))) {
        out[k] = v;
      }
    }
    return {
      _kind: "film-beamer-settings",
      _version: 1,
      _exportedAt: new Date().toISOString(),
      cfg: out,
      presets: WorkflowPresets.read(),
      recentUrls: typeof RecentURLs !== "undefined" ? RecentURLs.list() : [],
      theme: Theme.get(),
    };
  }

  function exportToFile(opts = {}) {
    const blob = new Blob([JSON.stringify(snapshot(opts), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `film-beamer-settings-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("Настройки сохранены в файл", "success", 2400);
  }

  function exportToClipboard(opts = {}) {
    const text = JSON.stringify(snapshot(opts), null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast("Настройки скопированы в буфер", "success", 2400),
        () => toast("Не получилось копировать", "info", 2400)
      );
    } else {
      toast("Clipboard API недоступен", "info");
    }
  }

  function applySnapshot(snap) {
    if (!snap || snap._kind !== "film-beamer-settings") {
      throw new Error("Это не дамп Film Beamer");
    }
    if (snap.cfg && typeof snap.cfg === "object") {
      for (const [k, v] of Object.entries(snap.cfg)) {
        if (k in cfg && !REDACTED.includes(k)) {
          cfg[k] = v;
        }
      }
      saveCfg(cfg);
    }
    // Presets are persisted+rendered via the module's public API so the
    // dropdown and manage-list refresh immediately, no page reload needed.
    if (Array.isArray(snap.presets)) {
      WorkflowPresets.replaceAll(snap.presets);
    }
    // Recent URLs round-trip through replace() instead of being dropped.
    if (Array.isArray(snap.recentUrls) && typeof RecentURLs !== "undefined") {
      RecentURLs.replace(snap.recentUrls);
    }
    if (snap.theme) Theme.set(snap.theme);
    toast("Настройки применены — перезагрузи страницу", "success", 4500);
  }

  async function importFromFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      applySnapshot(JSON.parse(text));
    } catch (err) {
      ErrorLog.push(`Импорт настроек: ${err.message || err}`);
      toast(`Ошибка: ${err.message || err}`, "error", 4500);
    }
  }

  function bind() {
    const exportBtn = $("#cfg-export");
    const exportClipBtn = $("#cfg-export-clipboard");
    const importBtn = $("#cfg-import");
    const fileInput = $("#cfg-import-file");
    if (exportBtn) exportBtn.addEventListener("click", () => exportToFile());
    if (exportClipBtn)
      exportClipBtn.addEventListener("click", () => exportToClipboard());
    if (importBtn && fileInput) {
      importBtn.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) importFromFile(f);
        fileInput.value = "";
      });
    }
  }

  return {
    snapshot,
    exportToFile,
    exportToClipboard,
    importFromFile,
    applySnapshot,
    bind,
  };
})();

// ---------- Extended URL classifier ----------
//
// On top of `classifyUrl`, this exposes structured metadata about a URL:
// detected category, suggested filename, recommended quality preset, and a
// human-readable hint. Used by the URL hint label and BulkQueue parser.
const URLClassifierExt = (() => {
  const VIDEO_HOSTS = new Set([
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
    "vimeo.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "twitch.tv",
    "dailymotion.com",
    "rutube.ru",
    "vk.com",
    "bilibili.com",
    "facebook.com",
    "instagram.com",
    "ok.ru",
    "coub.com",
    "9gag.com",
    "reddit.com",
    "imgur.com",
  ]);

  const TRACKER_HOSTS = new Set([
    "rutracker.org",
    "rutracker.net",
    "kinozal.tv",
    "kinozal.guru",
    "nnmclub.to",
    "nnm-club.me",
    "1337x.to",
    "1337x.tw",
    "thepiratebay.org",
    "thepiratebay10.org",
  ]);

  function hostOf(raw) {
    try {
      return new URL(raw).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  function category(raw) {
    const url = (raw || "").trim();
    if (!url) return "empty";
    if (/^magnet:\?/i.test(url)) return "magnet";
    if (/\.torrent(\?|$)/i.test(url)) return "torrent";
    if (!/^https?:\/\//i.test(url)) return "invalid";
    const host = hostOf(url);
    for (const h of TRACKER_HOSTS) {
      if (host === h || host.endsWith("." + h)) return "tracker-page";
    }
    for (const h of VIDEO_HOSTS) {
      if (host === h || host.endsWith("." + h)) return "video";
    }
    if (host.endsWith("kinopoisk.ru")) return "kinopoisk";
    if (
      /\.(mp4|mkv|webm|avi|mov|m4v|mp3|m4a|flac|wav|ogg|opus|zip|rar|7z|iso|pdf|epub|cbr|cbz)(\?|$)/i.test(
        url
      )
    ) {
      return "direct";
    }
    return "unknown";
  }

  function suggestedFilename(raw) {
    if (!raw) return "";
    try {
      const u = new URL(raw);
      const seg = u.pathname.split("/").filter(Boolean).pop() || "";
      if (!seg) return "";
      // Strip extension if it's an unhelpful one (.html, .php, etc.)
      return seg.replace(/\.(html?|php|aspx?)$/i, "");
    } catch {
      return "";
    }
  }

  function suggestedQuality(raw) {
    const cat = category(raw);
    if (cat === "magnet" || cat === "torrent" || cat === "direct") return "auto";
    if (cat !== "video") return "auto";
    const host = hostOf(raw);
    // YouTube benefits from 1080p as a default; others stay on auto.
    if (host.includes("youtube") || host.includes("youtu.be")) return "1080p";
    return "auto";
  }

  function describeCategory(cat) {
    switch (cat) {
      case "video":
        return "Видео-сайт — yt-dlp.";
      case "magnet":
        return "Magnet — aria2c (BitTorrent).";
      case "torrent":
        return ".torrent — aria2c (BitTorrent).";
      case "direct":
        return "Прямая ссылка на файл — aria2c.";
      case "tracker-page":
        return "Страница раздачи. Скопируй с неё magnet или .torrent.";
      case "kinopoisk":
        return "Кинопоиск не хостит видео.";
      case "invalid":
        return "Ссылка должна начинаться с http(s):// или magnet:?";
      case "empty":
        return "";
      case "unknown":
      default:
        return "Попробую yt-dlp как универсальный извлекатель.";
    }
  }

  function metadata(raw) {
    const cat = category(raw);
    return {
      category: cat,
      host: hostOf(raw),
      filename: suggestedFilename(raw),
      quality: suggestedQuality(raw),
      hint: describeCategory(cat),
    };
  }

  return { category, metadata, suggestedFilename, suggestedQuality };
})();

// ---------- Auto-fill suggestions ----------
//
// When the URL field changes and the filename is empty, propose a value the
// user can accept with one Tab keypress. Doesn't fight a user who has typed
// something — only fills empty fields.
function bindAutoFillSuggestions() {
  const url = $("#url");
  const filename = $("#filename");
  const quality = $("#quality");
  if (!url || !filename) return;
  let lastUserFilename = "";
  filename.addEventListener("input", () => {
    lastUserFilename = filename.value;
  });
  url.addEventListener("input", () => {
    const meta = URLClassifierExt.metadata(url.value.trim());
    // Only autofill when the field is empty *and* the user hasn't typed
    // anything custom there yet.
    if (!filename.value || filename.value === lastUserFilename) {
      const suggested = meta.filename;
      if (suggested && suggested !== filename.value) {
        filename.placeholder = `авто: ${suggested}`;
      } else {
        filename.placeholder = "авто (имя сохраним из источника)";
      }
    }
    if (
      quality &&
      meta.quality &&
      meta.quality !== "auto" &&
      quality.value === "auto"
    ) {
      // Just hint via title; never override silently.
      quality.title = `Подсказка: ${meta.quality} для ${meta.host}`;
    }
  });
}

// ---------- bootstrap ----------
document.addEventListener("DOMContentLoaded", () => {
  // Apply the user's saved theme as early as possible, before the rest of
  // the UI binds, so the page doesn't briefly flash dark→light when light
  // mode is selected.
  Theme.bind();

  // Bring up the Service Worker update channel as early as we can so a
  // freshly deployed version can prompt the user even if other init steps
  // throw.
  SwUpdater.bind();
  SwUpdater.init().catch((err) => {
    ErrorLog.push(`SW init: ${err.message || err}`);
  });

  bindSettings();
  bindForm();
  bindInstall();
  bindPaste();
  bindClearUrl();
  bindDriveUpload();
  bindDriveOAuthUpload();
  bindYtCookiesUpload();
  bindCookieWizard();
  bindTrackersUpload();
  bindSearch();
  bindUrlHint();
  bindQualityToggle();
  bindAccountSync();
  bindProgressDialog();
  bindRefreshButton();
  bindKeyboardShortcuts();
  bindRecentUrlCapture();
  bindSettingsValidators();
  bindAutoFillSuggestions();
  bindSoundToggle();
  bindSoundPreviewButtons();
  Diagnostics.bind();
  Notifications.bind();
  RunHistory.bind();
  WorkflowPresets.bind();
  BulkQueue.bind();
  HelpDialog.bind();
  SettingsBackup.bind();
  SecretsAudit.bind();
  bindHeaderActionButtons();
  RecentURLs.render();

  // Pre-fill repo from URL if not configured yet.
  if (!cfg.repo) {
    const guessed = inferRepoFromUrl();
    if (guessed) cfg.repo = guessed;
  }

  ensureRepoLink();
  showSetupHint(!isReady());
  refreshRuns();
  startPolling();
  // Try pulling the latest cfg from Drive once on boot. Silent on failure
  // (e.g. SA not yet configured, network issue).
  bootstrapAccountSync();
  // Apply ?url=... and friends, then resume tracking a previously dispatched
  // run if there was one. resumeActiveRun() needs both repo + token in cfg
  // — isReady() guards against the post-clearCfg() case where the listing
  // call would otherwise hit GitHub with an empty Authorization header and
  // log a noisy 401 in ErrorLog for no benefit.
  applyDeepLinkPrefill();
  if (isReady()) resumeActiveRun();

  // Pause polling when tab is hidden to save quota.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    } else {
      refreshRuns();
      startPolling();
    }
  });
});
