import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
let packageVersion = "unknown";
try {
  packageVersion = require("../package.json").version || packageVersion;
} catch {
  // Source snapshots without package.json still have a safe version value.
}

export const APP_NAME = "Codex Modeling Center Bridge";
export const BRIDGE_VERSION = packageVersion === "unknown" || packageVersion.startsWith("v")
  ? packageVersion
  : `v${packageVersion}`;
export const CONFIG_VERSION = 1;
export const DEFAULT_AGENT = "codex";
export const SUPPORTED_AGENTS = new Set(["codex", "claude"]);
export const DEFAULT_EXECUTION_MODE = "direct";
export const SUPPORTED_EXECUTION_MODES = new Set(["direct", "plan"]);
export const AGENT_LABELS = {
  codex: "Codex",
  claude: "Claude Code",
};
export const DEFAULT_NODE_VERSION = "24";
export const DEFAULT_NODE_RELEASE = "24.19.0";
export const DEFAULT_UV_VERSION = "0.12.0";
export const DEFAULT_CAD_PACKAGE = "cadquery>=2.4,<3";
export const DEFAULT_PYTHON_VERSION = "3.11";
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_WORKSPACE_NAME = "CodexModelingWorkspace";

export function isSupportedNodeVersion(value) {
  const match = String(value ?? "").match(/(?:v)?(\d+)(?:\.\d+)?(?:\.\d+)?/);
  return Boolean(match && Number(match[1]) >= Number(DEFAULT_NODE_VERSION));
}

export function normalizeAgent(value, fallback = DEFAULT_AGENT) {
  const raw = String(value || fallback).trim().toLowerCase();
  const agent = raw === "claude-code" ? "claude" : raw;
  if (!SUPPORTED_AGENTS.has(agent)) {
    throw new Error(`不支持的本地 Agent：${value}。可选值为 codex 或 claude。`);
  }
  return agent;
}

export function resolveTaskAgent(value, fallback = DEFAULT_AGENT) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "any" || normalized === "auto" || normalized === "automatic") {
    return normalizeAgent(fallback);
  }
  return normalizeAgent(normalized);
}

export function normalizeExecutionMode(value, fallback = DEFAULT_EXECUTION_MODE) {
  const mode = String(value || fallback).trim().toLowerCase();
  if (!SUPPORTED_EXECUTION_MODES.has(mode)) {
    throw new Error(`不支持的任务执行模式：${value}。可选值为 direct 或 plan。`);
  }
  return mode;
}

export function agentLabel(value) {
  return AGENT_LABELS[normalizeAgent(value)] || String(value);
}

export function platformId() {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  if (process.platform === "linux") return "linux";
  return "unknown";
}

export function platformLabel(value = platformId()) {
  if (value === "macos") return "macOS";
  if (value === "windows") return "Windows";
  if (value === "linux") return "Linux";
  return "本地系统";
}

export function appDataDirectory() {
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexModelingCenter");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CodexModelingCenter");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "codex-modeling-center");
}

export function defaultWorkspace() {
  return path.join(appDataDirectory(), DEFAULT_WORKSPACE_NAME);
}

export function defaultModelingEnvironment() {
  return path.join(appDataDirectory(), "modeling-python");
}

export function isSafeTaskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

export function defaultTaskDirectory(workspace, taskId) {
  return path.join(workspace, "tasks", taskId);
}
