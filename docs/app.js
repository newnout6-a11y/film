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
}

// ---------- libsodium (lazy-loaded for in-app secret uploads) ----------
const SODIUM_CDN_URL =
  "https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/browsers-sumo/sodium.js";
let _sodiumLoading = null;
function loadSodium() {
  if (window.sodium && window.sodium.ready) {
    return window.sodium.ready.then(() => window.sodium);
  }
  if (_sodiumLoading) return _sodiumLoading;
  _sodiumLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SODIUM_CDN_URL;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      if (!window.sodium) {
        return reject(new Error("libsodium не загрузился."));
      }
      window.sodium.ready.then(() => resolve(window.sodium));
    };
    s.onerror = () =>
      reject(
        new Error(
          "Не удалось загрузить libsodium с CDN. Проверь интернет или расширения браузера."
        )
      );
    document.head.appendChild(s);
  });
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
  return gh.putActionsSecret(name, encrypted, pk.key_id);
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

async function getDriveAccessToken() {
  if (
    _driveAccessToken &&
    _driveAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return _driveAccessToken.token;
  }
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
  const header = utf8ToBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
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
  $("#settings-dialog").classList.add("flex");
}

function closeSettings() {
  $("#settings-dialog").classList.add("hidden");
  $("#settings-dialog").classList.remove("flex");
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
      const dispatchedAt = Date.now();
      await gh.dispatchWorkflow({ ref, inputs });
      toast("Запущено — раннер качает…", "success");
      $("#url").value = "";
      // GitHub sometimes takes a beat to register the run.
      setTimeout(() => refreshRuns(true), 1500);
      // Open the live progress modal so the user sees actual stage transitions.
      openProgressDialog("Закидываем на Drive");
      trackDispatchedRun(cfg.workflow, dispatchedAt, "Закидывание").catch(
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

  jsonField.addEventListener("input", updateServiceAccountEmail);

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
    } catch (err) {
      setDriveStatus(`Не удалось прочитать файл: ${err.message || err}`, "error");
    }
  });

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
        await uploadGitHubSecret("GDRIVE_SERVICE_ACCOUNT", saInfo.json);
        uploaded.push("GDRIVE_SERVICE_ACCOUNT");
      }
      if (folderId) {
        await uploadGitHubSecret("GDRIVE_FOLDER_ID", folderId);
        uploaded.push("GDRIVE_FOLDER_ID");
      }
      const tail = saInfo
        ? ` Не забудь расшарить папку Drive на ${saInfo.email}.`
        : "";
      setDriveStatus(`Секреты обновлены: ${uploaded.join(", ")}.${tail}`, "success");
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
        await uploadGitHubSecret(pair.name, pair.value);
        uploaded.push(pair.name);
      }
      setTrackersStatus(
        `Секреты обновлены: ${uploaded.join(", ")}.`,
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
// can render real-time progress just by polling /jobs.
const SEARCH_STAGES = [
  { name: "RuTracker", match: /rutracker/i },
  { name: "Pirate Bay", match: /pirate\s*bay|apibay/i },
  { name: "Kinozal", match: /kinozal/i },
  { name: "NNM-Club", match: /nnm/i },
  { name: "Свод результатов", match: /aggregate|свод/i },
  { name: "Загрузка артефакта", match: /artifact|upload/i },
];

const STAGE_ICONS = {
  pending: "○",
  in_progress: "◐",
  success: "●",
  failure: "×",
  skipped: "·",
  cancelled: "·",
  neutral: "●",
};

function setSearchError(text) {
  const el = $("#search-error");
  if (el) el.textContent = text || "";
}

function renderSearchStages(steps) {
  const wrap = $("#search-progress");
  const list = $("#search-stages");
  if (!wrap || !list) return;
  wrap.classList.remove("hidden");
  list.innerHTML = "";
  for (const stage of SEARCH_STAGES) {
    const step = steps.find((s) => stage.match.test(s.name || ""));
    let key = "pending";
    if (step) {
      if (step.status === "completed") {
        key = step.conclusion || "success";
      } else if (step.status === "in_progress" || step.status === "queued") {
        key = "in_progress";
      }
    }
    const li = document.createElement("li");
    li.className = "flex items-center gap-2 text-sm";
    const icon = document.createElement("span");
    icon.className =
      key === "in_progress"
        ? "text-accent-300 animate-pulse"
        : key === "failure" || key === "cancelled" || key === "timed_out"
        ? "text-rose-300"
        : key === "success" || key === "neutral"
        ? "text-emerald-300"
        : key === "skipped"
        ? "text-slate-500"
        : "text-slate-500";
    icon.textContent = STAGE_ICONS[key] || "○";
    const label = document.createElement("span");
    label.className =
      key === "pending" ? "text-slate-400" : "text-slate-100";
    label.textContent = stage.name;
    const sub = document.createElement("span");
    sub.className = "ml-auto text-xs text-slate-500";
    sub.textContent =
      key === "in_progress"
        ? "идёт"
        : key === "success"
        ? "готово"
        : key === "failure"
        ? "ошибка"
        : key === "skipped"
        ? "пропущен (нет логина)"
        : key === "cancelled"
        ? "отменён"
        : "ждёт";
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
    trackDispatchedRun(cfg.workflow, dispatchedAt, "Закидывание").catch(
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

      // Locate the run we just dispatched.
      const run = await waitForRun(gh, dispatchedAt);
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

      const items = await downloadResults(gh, run.id);
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

async function waitForRun(gh, dispatchedAt) {
  const deadline = Date.now() + 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const data = await gh.listRunsForWorkflow(SEARCH_WORKFLOW, {
        event: "workflow_dispatch",
      });
      const runs = data.workflow_runs || [];
      // Pick the most recent run created at-or-after dispatch time.
      const run = runs.find(
        (r) => new Date(r.created_at).getTime() >= dispatchedAt - 5000
      );
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
  return Array.isArray(parsed) ? parsed : parsed.items || [];
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
// intentionally loose so a workflow rename doesn't immediately break the UI.
const DISPATCH_STAGES = [
  { name: "Проверка инпутов", match: /validate|inputs/i },
  { name: "Установка инструментов", match: /install|setup tools|deps/i },
  { name: "Настройка rclone", match: /rclone|configure/i },
  { name: "Скачивание", match: /download|yt-?dlp|aria2/i },
  { name: "Загрузка на Drive", match: /upload|copy|drive/i },
  { name: "Очистка", match: /cleanup|clean/i },
];

function renderProgressStages(steps) {
  const list = $("#progress-stages");
  if (!list) return;
  list.innerHTML = "";
  for (const stage of DISPATCH_STAGES) {
    const step = (steps || []).find((s) => stage.match.test(s.name || ""));
    let key = "pending";
    if (step) {
      if (step.status === "completed") key = step.conclusion || "success";
      else if (step.status === "in_progress" || step.status === "queued")
        key = "in_progress";
    }
    const li = document.createElement("li");
    li.className = "flex items-center gap-2 text-sm";
    const icon = document.createElement("span");
    icon.className =
      key === "in_progress"
        ? "text-accent-300 animate-pulse"
        : key === "failure" || key === "cancelled" || key === "timed_out"
        ? "text-rose-300"
        : key === "success" || key === "neutral"
        ? "text-emerald-300"
        : key === "skipped"
        ? "text-slate-500"
        : "text-slate-500";
    icon.textContent = STAGE_ICONS[key] || "○";
    const label = document.createElement("span");
    label.className =
      key === "pending" ? "text-slate-400" : "text-slate-100";
    label.textContent = stage.name;
    const sub = document.createElement("span");
    sub.className = "ml-auto text-xs text-slate-500";
    sub.textContent =
      key === "in_progress"
        ? "идёт"
        : key === "success"
        ? "готово"
        : key === "failure"
        ? "ошибка"
        : key === "skipped"
        ? "пропущен"
        : key === "cancelled"
        ? "отменён"
        : "ждёт";
    li.appendChild(icon);
    li.appendChild(label);
    li.appendChild(sub);
    list.appendChild(li);
  }
}

let _progressActive = false;

function openProgressDialog(title) {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  $("#progress-title").textContent = title || "Запуск раннера…";
  $("#progress-subtitle").textContent =
    "Ждём, пока GitHub зарегистрирует запуск…";
  $("#progress-link").classList.add("hidden");
  renderProgressStages([]);
  dlg.classList.remove("hidden");
  dlg.classList.add("flex");
  _progressActive = true;
}

function closeProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  dlg.classList.add("hidden");
  dlg.classList.remove("flex");
  _progressActive = false;
}

function bindProgressDialog() {
  const dlg = $("#progress-dialog");
  if (!dlg) return;
  $("#progress-close").addEventListener("click", closeProgressDialog);
  $("#progress-hide").addEventListener("click", closeProgressDialog);
  dlg.addEventListener("click", (e) => {
    if (e.target.id === "progress-dialog") closeProgressDialog();
  });
}

// Polls the workflow run we just dispatched and re-renders the modal.
async function trackDispatchedRun(workflowFile, dispatchedAt, baseTitle) {
  try {
    const gh = new GitHubSearchClient(cfg);
    let run = null;
    const findDeadline = Date.now() + 60_000;
    while (Date.now() < findDeadline && _progressActive) {
      try {
        const data = await gh.listRunsForWorkflow(workflowFile, {
          event: "workflow_dispatch",
        });
        run = (data.workflow_runs || []).find(
          (r) => new Date(r.created_at).getTime() >= dispatchedAt - 5000
        );
      } catch (err) {
        console.warn("trackDispatchedRun list:", err);
      }
      if (run) break;
      await sleep(2000);
    }
    if (!_progressActive) return;
    if (!run) {
      $("#progress-subtitle").textContent =
        "Запуск не появился в API за минуту. Проверь Actions вручную.";
      return;
    }

    $("#progress-title").textContent = baseTitle
      ? `${baseTitle} · #${run.run_number}`
      : `Запуск #${run.run_number}`;
    const link = $("#progress-link");
    link.href = run.html_url;
    link.classList.remove("hidden");

    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && _progressActive) {
      let data;
      try {
        data = await gh.getRunJobs(run.id);
      } catch (err) {
        console.warn("trackDispatchedRun jobs:", err);
        await sleep(3000);
        continue;
      }
      const jobs = data.jobs || [];
      const job = jobs[0];
      if (job) {
        renderProgressStages(job.steps || []);
        $("#progress-subtitle").textContent =
          job.status === "completed"
            ? `Готово: ${job.conclusion || "—"}`
            : job.status === "in_progress"
            ? "Идёт…"
            : "В очереди — ждём раннер.";
      }
      const allDone =
        jobs.length > 0 && jobs.every((j) => j.status === "completed");
      if (allDone) return;
      await sleep(3000);
    }
  } catch (err) {
    console.warn("trackDispatchedRun:", err);
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
    } catch (err) {
      toast(`Не удалось вставить из буфера: ${err.message || err}`, "error");
    }
  });
}

// ---------- bootstrap ----------
document.addEventListener("DOMContentLoaded", () => {
  bindSettings();
  bindForm();
  bindInstall();
  bindPaste();
  bindDriveUpload();
  bindTrackersUpload();
  bindSearch();
  bindUrlHint();
  bindQualityToggle();
  bindAccountSync();
  bindProgressDialog();
  $("#refresh-btn").addEventListener("click", () => refreshRuns(true));

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

  // If launched via the shortcut "?action=beam", focus URL field.
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.get("action") === "beam") {
      $("#url").focus();
    }
  } catch {
    /* noop */
  }

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
