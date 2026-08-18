import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { agentLabel, normalizeAgent } from "../src/constants.mjs";
import { inspectEnvironment } from "../src/modeling-env.mjs";
import { pairSite } from "../src/site-client.mjs";
import { loadConfig } from "../src/state.mjs";
import { resolveBridgeNode } from "../src/desktop-runtime.mjs";

const DESKTOP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let runnerProcess = null;
let runnerState = { running: false, pid: null, agent: null, output: [] };

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

function rememberOutput(stream, chunk) {
  const lines = String(chunk).split(/\r?\n/).map((line) => redact(line)).filter(Boolean);
  runnerState.output = [...runnerState.output, ...lines].slice(-80);
  for (const line of lines) sendRunnerEvent("output", { stream, line });
}

function runnerStatus() {
  return { ...runnerState, output: [...runnerState.output] };
}

async function status() {
  const config = await loadConfig();
  const report = await inspectEnvironment(config);
  try {
    const runtime = await resolveBridgeNode();
    report.node = runtime.version;
    report.nodeSupported = true;
    report.nodeRuntime = runtime.binary;
  } catch {
    // Keep the Electron runtime report so the UI can explain that Node 24 is missing.
  }
  return { config: publicConfig(config), report, runner: runnerStatus() };
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
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  runnerProcess = child;
  runnerState = { running: true, pid: child.pid || null, agent: selectedAgent, output: [] };
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
  mainWindow.on("closed", () => { mainWindow = null; });
}

ipcMain.handle("app:status", () => status());
ipcMain.handle("app:pair", (_event, input) => pair(input));
ipcMain.handle("runner:start", (_event, input) => startRunner(input));
ipcMain.handle("runner:stop", () => stopRunner());
ipcMain.handle("runner:status", () => runnerStatus());

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (runnerProcess) runnerProcess.kill();
});
