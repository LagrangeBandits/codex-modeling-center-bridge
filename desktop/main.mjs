import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { agentLabel, normalizeAgent } from "../src/constants.mjs";
import { bootstrapModelingEnvironment, inspectEnvironment } from "../src/modeling-env.mjs";
import { normalizeSite, pairSite } from "../src/site-client.mjs";
import { loadConfig } from "../src/state.mjs";
import { prepareNodeRuntime, resolveBridgeNode, runtimeEnvironment } from "../src/desktop-runtime.mjs";
import { shouldHideToTray, trayRunnerLabel } from "../src/desktop-window-policy.mjs";
import { createInitialUpdateState, createUpdateController, UPDATE_STATUS } from "../src/update-manager.mjs";

const { autoUpdater } = electronUpdater;

const DESKTOP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let tray = null;
let isQuitting = false;
let runnerProcess = null;
let runnerState = { running: false, pid: null, agent: null, output: [] };
let environmentPreparation = null;
let updateController = null;
let startupUpdateTimer = null;
let updatePromptPromise = null;
let promptedUpdateVersion = null;
let promptedDownloadedVersion = null;

const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAoElEQVR4nO3Vyw2AMAwD0O7ACTEaMzMTLJA6ThwVgVIpJ6T6kf7G6BEY27HfTL0WXA7JBpdArImu+6RKRijhMkIN9iAyAKFm32iA13qvKwhNIRCAWRYPDgGzI2RNwK53aENGznVk5zegAQ34PmDZRTRDLLuKPcCSx8hCWJMhgNcZGM4AohX6e3YpMsF0eAVCDkeITKXCKyBycBZSHvzr8QDxueTt/Mfp2AAAAABJRU5ErkJggg==";

function bridgeRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "app.asar.unpacked");
  return path.resolve(DESKTOP_DIRECTORY, "..");
}

function publicConfig(config) {
  return {
    site: config.site || "",
    name: config.name || "",
    platform: config.platform || "",
    agent: config.agent || "codex",
    workspace: config.workspace || "",
    modelingEnvironment: config.modelingEnvironment || "",
    paired: Boolean(config.site && config.runnerId),
  };
}

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sendRunnerEvent(type, payload = {}) {
  const event = { type, ...payload };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("runner:event", event);
}

function sendEnvironmentEvent(type, payload = {}) {
  const event = { type, ...payload };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("environment:event", event);
}

function rememberOutput(stream, chunk) {
  const lines = String(chunk).split(/\r?\n/).map((line) => redact(line)).filter(Boolean);
  runnerState.output = [...runnerState.output, ...lines].slice(-80);
  for (const line of lines) sendRunnerEvent("output", { stream, line });
}

function runnerStatus() {
  return { ...runnerState, output: [...runnerState.output] };
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Bridge", click: showMainWindow },
    {
      label: "检查更新",
      click: () => {
        showMainWindow();
        void updateController?.check();
      },
    },
    { type: "separator" },
    { label: "Bridge 正在后台运行", enabled: false },
    { label: trayRunnerLabel(runnerState), enabled: false },
    { type: "separator" },
    { label: "退出 Bridge", click: () => { void quitBridge(); } },
  ]));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  tray = new Tray(icon);
  tray.setToolTip("Modeling Center Bridge · 后台运行");
  tray.on("click", showMainWindow);
  tray.on("double-click", showMainWindow);
  refreshTrayMenu();
}

async function quitBridge() {
  if (runnerProcess) {
    const result = await dialog.showMessageBox({
      type: "warning",
      buttons: ["取消", "退出 Bridge"],
      defaultId: 0,
      cancelId: 0,
      title: "退出 Bridge",
      message: "Runner 正在运行",
      detail: "退出 Bridge 会停止本机 Runner；正在执行的任务可能需要重新提交。",
    });
    if (result.response !== 1) return;
  }
  isQuitting = true;
  tray?.destroy();
  tray = null;
  app.quit();
}

function updateStatus() {
  return updateController?.getState() || createInitialUpdateState({
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
  });
}

async function status() {
  const config = await loadConfig();
  let nodeRuntime = null;
  let nodeRuntimeError = null;
  try {
    nodeRuntime = await resolveBridgeNode();
  } catch (error) {
    nodeRuntimeError = redact(error.message);
  }
  const report = await inspectEnvironment(config, { nodeRuntime, requireExternalNode: true });
  report.nodeRuntimeError = nodeRuntimeError;
  return { config: publicConfig(config), report, runner: runnerStatus() };
}

async function prepareEnvironment() {
  if (environmentPreparation) return environmentPreparation;
  environmentPreparation = (async () => {
    const onProgress = (message) => sendEnvironmentEvent("progress", { message });
    onProgress("正在准备本机建模环境…");
    const node = await prepareNodeRuntime({ onProgress });
    const config = await loadConfig();
    const modeling = await bootstrapModelingEnvironment(config, { yes: true, onProgress });
    const nextStatus = await status();
    sendEnvironmentEvent("complete", { status: nextStatus });
    return { node, modeling, status: nextStatus };
  })().catch((error) => {
    sendEnvironmentEvent("error", { message: redact(error.message || String(error)) });
    throw error;
  }).finally(() => {
    environmentPreparation = null;
  });
  return environmentPreparation;
}

async function startRunner(input = {}) {
  if (runnerProcess) return runnerStatus();
  const config = await loadConfig();
  const selectedAgent = normalizeAgent(input.agent || config.agent);
  if (!config.site || !config.runnerId) throw new Error("请先完成网站配对。");
  const runtime = await resolveBridgeNode();
  const cliPath = path.join(bridgeRoot(), "src", "cli.mjs");
  try {
    await fs.access(cliPath);
  } catch {
    throw new Error("找不到本地 Runner 文件，请重新安装桌面程序。");
  }

  const child = spawn(runtime.binary, [cliPath, "start", "--agent", selectedAgent], {
    cwd: bridgeRoot(),
    env: runtimeEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runnerProcess = child;
  runnerState = { running: true, pid: child.pid || null, agent: selectedAgent, output: [] };
  refreshTrayMenu();
  sendRunnerEvent("started", { pid: child.pid || null, agent: selectedAgent, agentLabel: agentLabel(selectedAgent), node: runtime.version });
  child.stdout.on("data", (chunk) => rememberOutput("stdout", chunk));
  child.stderr.on("data", (chunk) => rememberOutput("stderr", chunk));
  child.on("error", (error) => {
    rememberOutput("stderr", `Runner 启动失败：${error.message}`);
    sendRunnerEvent("error", { message: redact(error.message) });
  });
  child.on("close", (code, signal) => {
    runnerProcess = null;
    runnerState = { ...runnerState, running: false, pid: null };
    refreshTrayMenu();
    sendRunnerEvent("stopped", { code, signal });
  });
  return runnerStatus();
}

async function stopRunner() {
  if (runnerProcess) runnerProcess.kill();
  return runnerStatus();
}

async function pair(input = {}) {
  const selectedAgent = normalizeAgent(input.agent);
  const response = await pairSite({
    site: input.site,
    code: input.code,
    siteAuth: input.siteAuth,
    name: input.name,
    agent: selectedAgent,
    workspace: input.workspace,
  });
  return {
    response: {
      name: response.name || input.name || "",
      platform: response.platform || "",
      agent: normalizeAgent(response.agent || selectedAgent),
    },
    status: await status(),
  };
}

async function openSite() {
  const config = await loadConfig();
  if (!config.site) throw new Error("请先连接至云端建模系统。");
  const site = normalizeSite(config.site);
  await shell.openExternal(site);
  return { site };
}

async function openUpdateNotes() {
  const url = updateStatus().update?.releaseNotesUrl;
  if (!url || !url.startsWith("https://github.com/LagrangeBandits/codex-modeling-center-bridge/releases/tag/")) {
    throw new Error("当前没有可查看的 Release notes。");
  }
  await shell.openExternal(url);
  return { opened: true };
}

function updateDialogParent() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

async function promptForUpdate(state) {
  if (!app.isPackaged || !state?.update?.version) return;
  if (updatePromptPromise) return updatePromptPromise;

  if (state.status === UPDATE_STATUS.AVAILABLE) {
    const version = state.update.version;
    if (promptedUpdateVersion === version) return;
    promptedUpdateVersion = version;
    updatePromptPromise = (async () => {
      showMainWindow();
      const result = await dialog.showMessageBox(updateDialogParent(), {
        type: "info",
        title: "发现 Bridge 更新",
        message: `发现新版本 v${version}`,
        detail: state.update.releaseNotes
          ? `${state.update.releaseNotes}\n\n下载和安装前会保留当前版本；Runner 正在运行时不会自动安装。`
          : "下载和安装前会保留当前版本；Runner 正在运行时不会自动安装。",
        buttons: ["稍后提醒", "查看更新说明", "下载更新"],
        defaultId: 2,
        cancelId: 0,
      });
      if (result.response === 1) {
        await openUpdateNotes();
      } else if (result.response === 2) {
        await updateController?.download();
      }
    })().catch((error) => {
      console.warn(`更新弹窗：${redact(error.message || String(error))}`);
    }).finally(() => {
      updatePromptPromise = null;
    });
    return updatePromptPromise;
  }

  if (state.status === UPDATE_STATUS.DOWNLOADED) {
    const version = state.update.version;
    if (promptedDownloadedVersion === version) return;
    promptedDownloadedVersion = version;
    updatePromptPromise = (async () => {
      showMainWindow();
      const runnerRunning = runnerStatus().running;
      const result = await dialog.showMessageBox(updateDialogParent(), {
        type: runnerRunning ? "warning" : "info",
        title: "Bridge 更新已下载",
        message: `v${version} 已下载完成`,
        detail: runnerRunning
          ? "请先停止 Runner，再在软件更新区域点击“重启并安装”。"
          : "确认后 Bridge 将退出并重启，安装新版本。",
        buttons: runnerRunning ? ["知道了"] : ["稍后安装", "重启并安装"],
        defaultId: runnerRunning ? 0 : 1,
        cancelId: 0,
      });
      if (!runnerRunning && result.response === 1) {
        await updateController?.install();
      }
    })().catch((error) => {
      console.warn(`更新安装弹窗：${redact(error.message || String(error))}`);
    }).finally(() => {
      updatePromptPromise = null;
    });
    return updatePromptPromise;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 620,
    title: "云建模中心",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(DESKTOP_DIRECTORY, "preload.cjs"),
    },
  });
  mainWindow.loadFile(path.join(DESKTOP_DIRECTORY, "index.html"));
  mainWindow.on("close", (event) => {
    if (!shouldHideToTray(isQuitting)) return;
    event.preventDefault();
    mainWindow.hide();
    refreshTrayMenu();
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("app:status", () => status());
ipcMain.handle("app:pair", (_event, input) => pair(input));
ipcMain.handle("environment:prepare", () => prepareEnvironment());
ipcMain.handle("site:open", () => openSite());
ipcMain.handle("runner:start", (_event, input) => startRunner(input));
ipcMain.handle("runner:stop", () => stopRunner());
ipcMain.handle("runner:status", () => runnerStatus());
ipcMain.handle("update:status", () => updateStatus());
ipcMain.handle("update:check", () => updateController?.check() || updateStatus());
ipcMain.handle("update:download", () => updateController?.download() || updateStatus());
ipcMain.handle("update:install", () => updateController?.install() || updateStatus());
ipcMain.handle("update:notes", () => openUpdateNotes());

app.whenReady().then(() => {
  updateController = createUpdateController({
    updater: autoUpdater,
    isPackaged: app.isPackaged,
    currentVersion: app.getVersion(),
    getRunnerStatus: runnerStatus,
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:event", state);
      void promptForUpdate(state);
    },
    log: (message) => console.warn(`更新：${message}`),
  });
  updateController.initialize();
  createWindow();
  createTray();
  if (app.isPackaged) {
    startupUpdateTimer = setTimeout(() => {
      startupUpdateTimer = null;
      void updateController?.check();
    }, 5_000);
    startupUpdateTimer.unref?.();
  }
  app.on("activate", () => {
    showMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (startupUpdateTimer) clearTimeout(startupUpdateTimer);
  tray?.destroy();
  tray = null;
  if (runnerProcess) runnerProcess.kill();
});
