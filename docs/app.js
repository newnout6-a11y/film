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
};

// Cached result of GET /repos/{owner}/{repo}.default_branch, keyed by repo.
const defaultBranchCache = new Map();

function loadCfg() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...defaultCfg };
    const parsed = JSON.parse(raw);
    return { ...defaultCfg, ...parsed };
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

// Returns the branch to dispatch against. If the user explicitly set one in
// Settings, use it; otherwise look up the repo's default_branch via the API
// and cache it for the lifetime of the page.
async function resolveBranch() {
  if (cfg.branch) return cfg.branch;
  if (!cfg.repo) return null;
  if (defaultBranchCache.has(cfg.repo)) {
    return defaultBranchCache.get(cfg.repo);
  }
  const gh = new GitHubClient(cfg);
  const branch = await gh.getRepoDefaultBranch();
  if (branch) {
    defaultBranchCache.set(cfg.repo, branch);
    updateBranchHint(branch);
  }
  return branch;
}

function updateBranchHint(branch) {
  const hint = $("#cfg-branch-hint");
  if (!hint) return;
  hint.textContent = branch
    ? `Автоопределена: ${branch}`
    : "";
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
  // Show the cached autodetected branch (if known) under the field.
  const cached = cfg.repo ? defaultBranchCache.get(cfg.repo) : null;
  updateBranchHint(cached || "");
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
    const next = {
      repo: $("#cfg-repo").value.trim(),
      // Empty branch is allowed — it means “autodetect via API”.
      branch: $("#cfg-branch").value.trim(),
      workflow: $("#cfg-workflow").value.trim() || "download-to-drive.yml",
      token: $("#cfg-token").value.trim(),
    };
    if (!/^[\w.-]+\/[\w.-]+$/.test(next.repo)) {
      toast("Репозиторий должен быть в формате owner/repo.", "error");
      return;
    }
    if (next.token && !/^(github_pat_|gh[opsu]_)[A-Za-z0-9_]+$/.test(next.token)) {
      toast(
        "Внимание: токен не похож на GitHub PAT. Сохраняю всё равно.",
        "error",
        2500
      );
    }
    cfg = next;
    saveCfg(cfg);
    ensureRepoLink();
    showSetupHint(!isReady());
    toast("Сохранено.", "success");
    closeSettings();
    refreshRuns(true);
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

    try {
      const gh = new GitHubClient(cfg);
      const ref = await resolveBranch();
      if (!ref) {
        throw new Error(
          "Не получилось определить ветку репо — укажи её вручную в Настройках."
        );
      }
      await gh.dispatchWorkflow({ ref, inputs });
      toast("Запущено — раннер качает…", "success");
      $("#url").value = "";
      // GitHub sometimes takes a beat to register the run.
      setTimeout(() => refreshRuns(true), 1500);
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      toast(`Ошибка: ${err.message || err}`, "error");
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
  bindUrlHint();
  bindQualityToggle();
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
