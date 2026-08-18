import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream as createFileReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDataDirectory, DEFAULT_NODE_RELEASE, isSupportedNodeVersion } from "./constants.mjs";
import { execFileText, runCommand } from "./process.mjs";

function nodeExecutableName() {
  return process.platform === "win32" ? "node.exe" : "node";
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function homePath(...parts) {
  return path.join(os.homedir(), ...parts);
}

export function commandPathEntries() {
  const current = String(process.env.PATH || "").split(path.delimiter);
  const extra = process.platform === "win32"
    ? [
        process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "nodejs") : null,
        process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "nodejs") : null,
        process.env.ProgramW6432 ? path.join(process.env.ProgramW6432, "nodejs") : null,
        homePath(".volta", "bin"),
        homePath(".fnm"),
        homePath("scoop", "shims"),
      ]
    : [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/Applications/ChatGPT.app/Contents/Resources",
        homePath("Applications", "ChatGPT.app", "Contents", "Resources"),
        homePath(".local", "bin"),
        homePath(".npm-global", "bin"),
        homePath(".volta", "bin"),
        homePath(".asdf", "shims"),
        homePath(".nvm", "current", "bin"),
        homePath(".fnm"),
      ];
  return unique([...extra, ...current]);
}

export function runtimeEnvironment(extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: commandPathEntries().join(path.delimiter),
  };
}

function commandNames(command) {
  if (process.platform !== "win32") return [command];
  return [`${command}.cmd`, `${command}.exe`, command];
}

export function commandCandidates(command) {
  const names = commandNames(command);
  return unique(names.flatMap((name) => [name, ...commandPathEntries().map((entry) => path.join(entry, name))]));
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
    const result = await execFileText(binary, ["--version"], { timeout: 15_000, env: runtimeEnvironment() });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    return isSupportedNodeVersion(version) ? { binary, version } : null;
  } catch {
    return null;
  }
}

export async function resolveCommand(command) {
  for (const candidate of commandCandidates(command)) {
    try {
      const result = await execFileText(candidate, ["--version"], { timeout: 15_000, env: runtimeEnvironment() });
      const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || "可用";
      return { binary: candidate, version };
    } catch {
      // Continue through the known user and package-manager locations.
    }
  }
  return null;
}

export async function resolveBridgeNode() {
  const candidates = [];
  await addIfExisting(candidates, process.env.BRIDGE_NODE_BIN);
  candidates.push(...await userRuntimeCandidates());
  candidates.push(...commandCandidates("node"));
  for (const candidate of candidates) {
    const found = await usableNode(candidate);
    if (found) return found;
  }
  throw new Error("未找到 Node.js 24+ 运行时。请先运行安装脚本准备用户目录运行时。");
}

function powershellCommand() {
  return process.env.SystemRoot ? "powershell.exe" : "pwsh";
}

function nodeReleaseSpec() {
  if (process.platform === "darwin") {
    const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
    if (!architecture) throw new Error(`暂不支持此 macOS 架构：${process.arch}`);
    return {
      archiveName: `node-v${DEFAULT_NODE_RELEASE}-darwin-${architecture}.tar.gz`,
      runtimeDirectory: `node-v${DEFAULT_NODE_RELEASE}-darwin-${architecture}`,
      sha256: architecture === "arm64"
        ? "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
        : "d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316",
      url: `https://nodejs.org/dist/v${DEFAULT_NODE_RELEASE}/node-v${DEFAULT_NODE_RELEASE}-darwin-${architecture}.tar.gz`,
      archiveType: "tar.gz",
    };
  }
  if (process.platform === "win32") {
    const architecture = process.arch === "arm64" ? "arm64" : "x64";
    return {
      archiveName: `node-v${DEFAULT_NODE_RELEASE}-win-${architecture}.zip`,
      runtimeDirectory: `node-v${DEFAULT_NODE_RELEASE}-win-${architecture}`,
      sha256: architecture === "arm64"
        ? "8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f"
        : "57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73",
      url: `https://nodejs.org/dist/v${DEFAULT_NODE_RELEASE}/node-v${DEFAULT_NODE_RELEASE}-win-${architecture}.zip`,
      archiveType: "zip",
    };
  }
  throw new Error("一键准备运行时目前支持 macOS 和 Windows。");
}

function nodeRuntimeRoot() {
  return path.join(appDataDirectory(), "runtime");
}

async function fileSha256(filename) {
  const hash = createHash("sha256");
  const stream = createFileReadStream(filename);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function downloadNodeArchive(spec, archivePath) {
  if (process.platform === "win32") {
    const shell = powershellCommand();
    const result = await runCommand(shell, [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; " +
        `Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri ${quotePowerShell(spec.url)} -OutFile ${quotePowerShell(archivePath)}`,
    ], { env: runtimeEnvironment() });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "下载 Node.js 运行时失败。");
    return;
  }
  const result = await runCommand("curl", [
    "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--silent", "--show-error",
    "--output", archivePath, spec.url,
  ], { env: runtimeEnvironment() });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "下载 Node.js 运行时失败。");
}

async function extractNodeArchive(spec, archivePath, runtimeRoot) {
  if (spec.archiveType === "zip") {
    const result = await runCommand(powershellCommand(), [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; " +
        `Expand-Archive -LiteralPath ${quotePowerShell(archivePath)} -DestinationPath ${quotePowerShell(runtimeRoot)} -Force`,
    ], { env: runtimeEnvironment() });
    if (result.code !== 0) throw new Error(result.stderr.trim() || "解压 Node.js 运行时失败。");
    return;
  }
  const result = await runCommand("tar", ["-xzf", archivePath, "-C", runtimeRoot], { env: runtimeEnvironment() });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "解压 Node.js 运行时失败。");
}

let nodePreparation = null;

async function prepareNodeRuntimeInternal(onProgress = () => {}) {
  try {
    const existing = await resolveBridgeNode();
    onProgress(`已发现 Node.js ${existing.version}`);
    return existing;
  } catch {
    // Continue with the user-scoped runtime download.
  }

  const spec = nodeReleaseSpec();
  const runtimeRoot = nodeRuntimeRoot();
  const archivePath = path.join(runtimeRoot, spec.archiveName);
  const binary = process.platform === "win32"
    ? path.join(runtimeRoot, spec.runtimeDirectory, nodeExecutableName())
    : path.join(runtimeRoot, spec.runtimeDirectory, "bin", nodeExecutableName());
  await fs.mkdir(runtimeRoot, { recursive: true });
  onProgress(`正在准备 Node.js ${DEFAULT_NODE_RELEASE}…`);
  if (!await fs.stat(archivePath).then(() => true).catch(() => false)) {
    await downloadNodeArchive(spec, archivePath);
  }
  onProgress("正在校验 Node.js 安装包…");
  const actualSha256 = await fileSha256(archivePath);
  if (actualSha256 !== spec.sha256) {
    await fs.rm(archivePath, { force: true });
    throw new Error(`Node.js 下载校验失败：期望 ${spec.sha256}，实际 ${actualSha256}`);
  }
  const usableArchive = await fs.stat(binary).then(() => true).catch(() => false);
  if (!usableArchive) {
    onProgress("正在解压并准备用户目录运行时…");
    await extractNodeArchive(spec, archivePath, runtimeRoot);
  }
  const prepared = await resolveBridgeNode();
  onProgress(`Node.js ${prepared.version} 已就绪`);
  return prepared;
}

export function prepareNodeRuntime({ onProgress } = {}) {
  if (!nodePreparation) {
    nodePreparation = prepareNodeRuntimeInternal(onProgress).finally(() => { nodePreparation = null; });
  }
  return nodePreparation;
}

export function platformRuntimeHint() {
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexModelingCenter", "runtime");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "CodexModelingCenter", "runtime");
  return path.join(appDataDirectory(), "runtime");
}
