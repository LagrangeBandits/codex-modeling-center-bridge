const RELEASE_ROOT = "https://github.com/LagrangeBandits/codex-modeling-center-bridge/releases/tag/";
const SECRET_PATTERN = /(?:bearer\s+[A-Za-z0-9._~+/=-]+|(?:ghp_|github_pat_|sk-)[a-z0-9._-]+|(?:token|runnerToken|siteAuth|siteBypassToken|authorization|cookie|secret|password|api[_-]?key|pairingCode|配对码)\s*[:=]\s*[^\s,;]+)/gi;
const URL_PATTERN = /https?:\/\/[^\s)]+/gi;

export const UPDATE_STATUS = Object.freeze({
  DISABLED: "disabled",
  IDLE: "idle",
  CHECKING: "checking",
  NOT_AVAILABLE: "not-available",
  AVAILABLE: "available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  INSTALLING: "installing",
  ERROR: "error",
});

const STATUS_VALUES = new Set(Object.values(UPDATE_STATUS));

function cleanText(value, limit = 4_000, stripUrls = false) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(SECRET_PATTERN, "[REDACTED]")
    .replace(stripUrls ? URL_PATTERN : /$^/g, "[链接已省略]")
    .trim()
    .slice(0, limit);
  return text || null;
}

function parseVersion(value) {
  const raw = String(value ?? "").trim().replace(/^v/i, "");
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    main: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

export function normalizeVersion(value) {
  const parsed = parseVersion(value);
  if (!parsed) return null;
  const main = parsed.main.join(".");
  return parsed.prerelease.length ? `${main}-${parsed.prerelease.join(".")}` : main;
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(left[index]) - Number(right[index]);
      if (difference) return difference > 0 ? 1 : -1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.main.length; index += 1) {
    if (left.main[index] !== right.main[index]) return left.main[index] > right.main[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

function releaseUrl(version) {
  const normalized = normalizeVersion(version);
  return normalized ? `${RELEASE_ROOT}v${normalized}` : null;
}

function notesText(value) {
  if (Array.isArray(value)) {
    return cleanText(value.map((entry) => {
      if (typeof entry === "string") return entry;
      return entry?.note || entry?.text || entry?.body || "";
    }).filter(Boolean).join("\n\n"), 4_000, true);
  }
  if (value && typeof value === "object") return notesText(value.note || value.text || value.body || "");
  return cleanText(value, 4_000, true);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function safeAssetName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().split(/[\\/]/).pop();
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name.slice(0, 240) : null;
}

export function normalizeUpdateInfo(info, currentVersion = "unknown") {
  const source = info && typeof info === "object" ? info : {};
  const version = normalizeVersion(source.version);
  const normalizedCurrent = normalizeVersion(currentVersion);
  return {
    version,
    currentVersion: normalizedCurrent || "unknown",
    isNewer: Boolean(version && normalizedCurrent && isNewerVersion(version, normalizedCurrent)),
    releaseName: cleanText(source.releaseName, 240, true),
    releaseNotes: notesText(source.releaseNotes),
    releaseDate: safeDate(source.releaseDate),
    releaseNotesUrl: releaseUrl(version),
    assetName: safeAssetName(source.path),
    features: Array.isArray(source.features)
      ? source.features.filter((feature) => typeof feature === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(feature)).slice(0, 32)
      : [],
  };
}

export function normalizeDownloadProgress(progress) {
  const source = progress && typeof progress === "object" ? progress : {};
  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  };
  const percentValue = Number(source.percent);
  return {
    percent: Number.isFinite(percentValue) ? Math.max(0, Math.min(100, Math.round(percentValue * 10) / 10)) : 0,
    transferred: number(source.transferred),
    total: number(source.total),
    bytesPerSecond: number(source.bytesPerSecond),
  };
}

export function sanitizeUpdateError(error) {
  const raw = error?.message ?? error?.description ?? error ?? "更新失败。";
  const message = cleanText(String(raw), 1_000, true);
  return message || "更新失败。";
}

function stateUpdate(value, currentVersion) {
  if (!value || typeof value !== "object") return null;
  const normalized = normalizeUpdateInfo(value, currentVersion);
  if (!normalized.version) return null;
  return normalized;
}

export function normalizeUpdateState(value = {}) {
  const currentVersion = normalizeVersion(value.currentVersion) || "unknown";
  const status = STATUS_VALUES.has(value.status) ? value.status : UPDATE_STATUS.IDLE;
  const update = stateUpdate(value.update, currentVersion);
  return {
    status,
    currentVersion,
    update,
    progress: value.progress ? normalizeDownloadProgress(value.progress) : null,
    error: value.error ? sanitizeUpdateError(value.error) : null,
  };
}

export function createInitialUpdateState({ currentVersion = "unknown", isPackaged = false } = {}) {
  return normalizeUpdateState({
    status: isPackaged ? UPDATE_STATUS.IDLE : UPDATE_STATUS.DISABLED,
    currentVersion,
  });
}

export function createUpdateController({
  updater = null,
  isPackaged = false,
  currentVersion = "unknown",
  getRunnerStatus = () => ({ running: false }),
  onState = () => {},
  log = () => {},
} = {}) {
  let state = createInitialUpdateState({ currentVersion, isPackaged });
  let bound = false;
  let checkPromise = null;
  let downloadPromise = null;

  const snapshot = () => normalizeUpdateState(state);
  const publish = (patch) => {
    state = normalizeUpdateState({ ...state, ...patch });
    onState(snapshot());
    return snapshot();
  };
  const safeLog = (message) => {
    try { log(sanitizeUpdateError(message)); } catch { /* logging must not affect updates */ }
  };
  const setError = (error) => {
    const message = sanitizeUpdateError(error);
    safeLog(message);
    return publish({ status: UPDATE_STATUS.ERROR, error: message });
  };
  const applyInfo = (info, status = UPDATE_STATUS.AVAILABLE) => {
    const update = normalizeUpdateInfo(info, currentVersion);
    if (!update.version || !update.isNewer) {
      return publish({ status: UPDATE_STATUS.NOT_AVAILABLE, update: null, progress: null, error: null });
    }
    return publish({ status, update, progress: status === UPDATE_STATUS.AVAILABLE ? null : state.progress, error: null });
  };

  function bind() {
    if (bound || !isPackaged || !updater || typeof updater.on !== "function") return;
    bound = true;
    updater.autoDownload = false;
    if ("autoInstallOnAppQuit" in updater) updater.autoInstallOnAppQuit = false;
    if ("autoInstallEvent" in updater) updater.autoInstallEvent = "manual";
    if ("allowPrerelease" in updater) updater.allowPrerelease = false;
    if ("allowDowngrade" in updater) updater.allowDowngrade = false;
    if ("logger" in updater) {
      updater.logger = {
        info: (...args) => safeLog(args.join(" ")),
        warn: (...args) => safeLog(args.join(" ")),
        error: (...args) => safeLog(args.join(" ")),
        debug: (...args) => safeLog(args.join(" ")),
      };
    }
    updater.on("checking-for-update", () => publish({ status: UPDATE_STATUS.CHECKING, error: null }));
    updater.on("update-available", (info) => applyInfo(info));
    updater.on("update-not-available", (info) => {
      const update = normalizeUpdateInfo(info, currentVersion);
      publish({ status: UPDATE_STATUS.NOT_AVAILABLE, update: update.version ? update : null, progress: null, error: null });
    });
    updater.on("download-progress", (progress) => publish({ status: UPDATE_STATUS.DOWNLOADING, progress, error: null }));
    updater.on("update-downloaded", (event) => {
      const info = event?.info || event;
      const update = normalizeUpdateInfo(info, currentVersion);
      publish({
        status: UPDATE_STATUS.DOWNLOADED,
        update: update.version ? update : state.update,
        progress: { percent: 100, transferred: state.progress?.total, total: state.progress?.total, bytesPerSecond: 0 },
        error: null,
      });
    });
    updater.on("update-cancelled", (info) => {
      const update = normalizeUpdateInfo(info, currentVersion);
      publish({ status: UPDATE_STATUS.AVAILABLE, update: update.version ? update : state.update, error: "更新下载已取消。" });
    });
    updater.on("error", (error) => setError(error));
  }

  async function check() {
    if (!isPackaged) return snapshot();
    bind();
    if (!updater || typeof updater.checkForUpdates !== "function") return setError("当前版本不支持自动更新。");
    if (checkPromise) return checkPromise;
    publish({ status: UPDATE_STATUS.CHECKING, error: null });
    checkPromise = Promise.resolve()
      .then(() => updater.checkForUpdates())
      .then((result) => {
        const info = result?.updateInfo;
        if (info) return applyInfo(info);
        return publish({ status: UPDATE_STATUS.NOT_AVAILABLE, update: null, progress: null, error: null });
      })
      .catch((error) => setError(error))
      .finally(() => { checkPromise = null; });
    return checkPromise;
  }

  async function download() {
    if (!isPackaged) return snapshot();
    bind();
    if (state.status !== UPDATE_STATUS.AVAILABLE || !state.update?.isNewer) {
      return setError("请先检查到可用更新。");
    }
    if (!updater || typeof updater.downloadUpdate !== "function") return setError("当前版本不支持下载更新。");
    if (downloadPromise) return downloadPromise;
    publish({ status: UPDATE_STATUS.DOWNLOADING, progress: { percent: 0 }, error: null });
    downloadPromise = Promise.resolve()
      .then(() => updater.downloadUpdate())
      .then(() => snapshot())
      .catch((error) => setError(error))
      .finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  function install() {
    if (!isPackaged) return snapshot();
    if (state.status !== UPDATE_STATUS.DOWNLOADED) return setError("更新尚未下载完成。");
    if (getRunnerStatus()?.running) {
      return publish({ error: "Runner 正在运行。请先停止 Runner，再确认重启并安装。" });
    }
    if (!updater || typeof updater.quitAndInstall !== "function") return setError("当前版本不支持安装更新。");
    publish({ status: UPDATE_STATUS.INSTALLING, error: null });
    try {
      updater.quitAndInstall(false, true);
    } catch (error) {
      return setError(error);
    }
    return snapshot();
  }

  function initialize() {
    bind();
    return snapshot();
  }

  return {
    initialize,
    getState: snapshot,
    check,
    download,
    install,
  };
}
