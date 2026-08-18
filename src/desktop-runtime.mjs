import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appDataDirectory, isSupportedNodeVersion } from "./constants.mjs";
import { execFileText } from "./process.mjs";

function nodeExecutableName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

async function addIfExisting(candidates, value) {
  if (!value) return;
  try {
    const stats = await fs.stat(value);
    if (stats.isFile()) candidates.push(value);
  } catch {
    // A missing optional runtime is expected on a new device.
  }
}

async function userRuntimeCandidates() {
  const runtimeRoot = path.join(appDataDirectory(), "runtime");
  const candidates = [];
  try {
    const entries = await fs.readdir(runtimeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("node-v")) continue;
      const binary = process.platform === "win32"
        ? path.join(runtimeRoot, entry.name, nodeExecutableName())
        : path.join(runtimeRoot, entry.name, "bin", nodeExecutableName());
      await addIfExisting(candidates, binary);
    }
  } catch {
    // The runtime directory is created by the installer when needed.
  }
  return candidates;
}

async function usableNode(binary) {
  try {
    const result = await execFileText(binary, ["--version"], { timeout: 15_000 });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    return isSupportedNodeVersion(version) ? { binary, version } : null;
  } catch {
    return null;
  }
}

export async function resolveBridgeNode() {
  const candidates = [];
  await addIfExisting(candidates, process.env.BRIDGE_NODE_BIN);
  candidates.push(...await userRuntimeCandidates());
  candidates.push(nodeExecutableName());
  for (const candidate of candidates) {
    const found = await usableNode(candidate);
    if (found) return found;
  }
  throw new Error("未找到 Node.js 24+ 运行时。请先运行安装脚本准备用户目录运行时。");
}

export function platformRuntimeHint() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexModelingCenter", "runtime");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "CodexModelingCenter", "runtime");
  return path.join(appDataDirectory(), "runtime");
}
