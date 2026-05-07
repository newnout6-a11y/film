"use strict";

// ---------- tiny helpers ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const STORE_KEY = "film-beamer.cfg.v1";

const defaultCfg = {
  repo: "",
  branch: "main",
  workflow: "download-to-drive.yml",
  token: "",
};

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
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

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
  return Boolean(cfg.repo && cfg.token && cfg.workflow && cfg.branch);
}

function showSetupHint(show) {
  $("#setup-hint").classList.toggle("hidden", !show);
}

function openSettings() {
  $("#cfg-repo").value = cfg.repo || inferRepoFromUrl();
  $("#cfg-branch").value = cfg.branch || "main";
  $("#cfg-workflow").value = cfg.workflow || "download-to-drive.yml";
  $("#cfg-token").value = cfg.token || "";
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
    toast("Settings cleared.", "success");
    closeSettings();
  });
  $("#settings-save").addEventListener("click", () => {
    const next = {
      repo: $("#cfg-repo").value.trim(),
      branch: $("#cfg-branch").value.trim() || "main",
      workflow: $("#cfg-workflow").value.trim() || "download-to-drive.yml",
      token: $("#cfg-token").value.trim(),
    };
    if (!/^[\w.-]+\/[\w.-]+$/.test(next.repo)) {
      toast("Repo must be in the form owner/repo.", "error");
      return;
    }
    if (next.token && !/^(github_pat_|gh[opsu]_)[A-Za-z0-9_]+$/.test(next.token)) {
      toast(
        "Warning: token does not look like a GitHub PAT. Saving anyway.",
        "error",
        2500
      );
    }
    cfg = next;
    saveCfg(cfg);
    ensureRepoLink();
    showSetupHint(!isReady());
    toast("Saved.", "success");
    closeSettings();
    refreshRuns(true);
  });
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

    const inputs = {
      url: $("#url").value.trim(),
      filename: $("#filename").value.trim(),
      subfolder: $("#subfolder").value.trim(),
      mode: $("#mode").value,
      ytdlp_format: $("#ytdlp_format").value.trim() || "bv*+ba/b",
      max_size_mb: String(parseInt($("#max_size_mb").value, 10) || 0),
    };

    if (!/^https?:\/\//i.test(inputs.url)) {
      errEl.textContent = "URL must start with http:// or https://";
      return;
    }

    const btn = $("#beam-btn");
    btn.disabled = true;
    const lbl = $("#beam-btn-label");
    const oldLabel = lbl.textContent;
    lbl.textContent = "Beaming…";

    try {
      const gh = new GitHubClient(cfg);
      await gh.dispatchWorkflow({ ref: cfg.branch, inputs });
      toast("Beam started — runner is downloading…", "success");
      $("#url").value = "";
      // GitHub sometimes takes a beat to register the run.
      setTimeout(() => refreshRuns(true), 1500);
    } catch (err) {
      console.error(err);
      errEl.textContent = err.message || String(err);
      toast(`Failed: ${err.message || err}`, "error");
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
  return s ? s.replace(/_/g, " ") : "unknown";
}

function renderRuns(runs) {
  const wrap = $("#runs");
  wrap.innerHTML = "";
  if (!runs || runs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "px-4 py-6 text-center text-sm text-slate-500";
    empty.textContent = "No runs yet.";
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
    title.textContent = run.display_title || run.name || `Run #${run.run_number}`;
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
      toast(`Could not load runs: ${err.message || err}`, "error");
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
    toast("Installed. Look for it on your home screen.", "success");
  });
  btn.addEventListener("click", async () => {
    if (!deferredInstall) {
      toast(
        "Use your browser menu → Add to Home Screen.",
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

// ---------- Paste-from-clipboard helper ----------
function bindPaste() {
  const btn = $("#paste-btn");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("Clipboard API unavailable.");
      }
      const text = await navigator.clipboard.readText();
      if (!text) return;
      $("#url").value = text.trim();
      $("#url").focus();
    } catch (err) {
      toast(`Could not read clipboard: ${err.message || err}`, "error");
    }
  });
}

// ---------- bootstrap ----------
document.addEventListener("DOMContentLoaded", () => {
  bindSettings();
  bindForm();
  bindInstall();
  bindPaste();
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
