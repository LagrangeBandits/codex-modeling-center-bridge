import os from "node:os";
import path from "node:path";

export const APP_NAME = "Codex Modeling Center Bridge";
export const CONFIG_VERSION = 1;
export const DEFAULT_AGENT = "codex";
export const SUPPORTED_AGENTS = new Set(["codex"]);
export const DEFAULT_NODE_VERSION = "24";
export const DEFAULT_CAD_PACKAGE = "cadquery>=2.4,<3";
export const DEFAULT_PYTHON_VERSION = "3.11";
export const DEFAULT_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_WORKSPACE_NAME = "CodexModelingWorkspace";

export function isSupportedNodeVersion(value) {
  const match = String(value ?? "").match(/(?:v)?(\d+)(?:\.\d+)?(?:\.\d+)?/);
  return Boolean(match && Number(match[1]) >= Number(DEFAULT_NODE_VERSION));
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
