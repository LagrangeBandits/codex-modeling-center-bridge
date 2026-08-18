import fs from "node:fs/promises";
import path from "node:path";
import { appDataDirectory, defaultModelingEnvironment, DEFAULT_CAD_PACKAGE, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, DEFAULT_UV_VERSION, isSupportedNodeVersion } from "./constants.mjs";
import { resolveCommand, runtimeEnvironment } from "./desktop-runtime.mjs";
import { commandVersion, execFileText, runCommand } from "./process.mjs";

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 11;

function uvExecutableName() {
  return process.platform === "win32" ? "uv.exe" : "uv";
}

function uvRuntimeDirectory() {
  return path.join(appDataDirectory(), "runtime", "uv");
}

function uvPythonDirectory() {
  return path.join(appDataDirectory(), "runtime", "python");
}

function uvPythonBinDirectory() {
  return path.join(appDataDirectory(), "runtime", "python-bin");
}

function pythonCandidates() {
  if (process.platform === "win32") {
    return [
      { file: "py", args: ["-3.11"] },
      { file: "py", args: ["-3"] },
      { file: "python", args: [] },
      { file: "python3", args: [] },
    ];
  }
  return [
    { file: "python3.11", args: [] },
    { file: "python3", args: [] },
    { file: "python", args: [] },
  ];
}

function venvPython(environmentDirectory) {
  return process.platform === "win32"
    ? path.join(environmentDirectory, "Scripts", "python.exe")
    : path.join(environmentDirectory, "bin", "python");
}

async function runnable(spec, args = ["--version"]) {
  try {
    const result = await execFileText(spec.file, [...spec.args, ...args], { timeout: 20_000, env: runtimeEnvironment() });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    if (!isSupportedPythonVersion(version)) return null;
    return { ...spec, version };
  } catch {
    return null;
  }
}

async function executableVersion(file) {
  try {
    const result = await execFileText(file, ["--version"], { timeout: 20_000, env: runtimeEnvironment() });
    return { file, args: [], version: (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || "可用" };
  } catch {
    return null;
  }
}

function parsePythonVersion(value) {
  const match = String(value ?? "").match(/(?:Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0),
    value: `${match[1]}.${match[2]}.${match[3] || 0}`,
  };
}

export function isSupportedPythonVersion(value) {
  const version = parsePythonVersion(value);
  return Boolean(version && version.major === MIN_PYTHON_MAJOR && version.minor >= MIN_PYTHON_MINOR);
}

export async function findPython() {
  for (const candidate of pythonCandidates()) {
    const found = await runnable(candidate);
    if (found) return found;
  }
  return null;
}

async function inspectPython(python, { allowUnsupported = false } = {}) {
  if (!python) return null;
  let result;
  try {
    result = await runCommand(python.file, [...python.args, "-c", "import sys; print(sys.executable); print(sys.version.split()[0])"], { env: runtimeEnvironment() });
  } catch {
    return null;
  }
  if (result.code !== 0) return null;
  const [executable, version] = result.stdout.trim().split(/\r?\n/);
  const supported = isSupportedPythonVersion(version);
  if (!supported && !allowUnsupported) return null;
  return { ...python, executable, version, supported };
}

async function checkCadQuery(python) {
  if (!python) return { installed: false, version: null };
  const result = await runCommand(python, ["-c", "import cadquery; print(getattr(cadquery, '__version__', 'installed'))"], { env: runtimeEnvironment() });
  return {
    installed: result.code === 0,
    version: result.code === 0 ? result.stdout.trim() : null,
    error: result.code === 0 ? null : (result.stderr.trim().split(/\r?\n/).pop() || "未安装"),
  };
}

async function checkCodex() {
  const found = await resolveCommand("codex");
  return { installed: Boolean(found), version: found?.version || null, binary: found?.binary || null };
}

async function checkClaude() {
  const found = await resolveCommand("claude");
  return { installed: Boolean(found), version: found?.version || null, binary: found?.binary || null };
}

async function findUv() {
  const candidates = [
    uvExecutableName(),
    path.join(uvRuntimeDirectory(), uvExecutableName()),
  ];
  for (const candidate of candidates) {
    const found = await executableVersion(candidate);
    if (found) return found;
  }
  return null;
}

async function checkUv() {
  const found = await findUv();
  return { installed: Boolean(found), version: found?.version || null };
}

export async function inspectEnvironment(config = {}, options = {}) {
  const environmentDirectory = config.modelingEnvironment || defaultModelingEnvironment();
  const environmentPythonPath = venvPython(environmentDirectory);
  const environmentPython = await inspectPython({ file: environmentPythonPath, args: [] });
  const systemPython = await inspectPython(await findPython());
  const activePython = environmentPython || systemPython;
  const nodeRuntime = options.nodeRuntime || null;
  const node = options.requireExternalNode ? nodeRuntime?.version || null : process.version;
  return {
    node,
    nodeSupported: options.requireExternalNode ? Boolean(nodeRuntime) : isSupportedNodeVersion(process.version),
    nodeRuntime: nodeRuntime?.binary || null,
    nodeRequirement: `${DEFAULT_NODE_VERSION}+`,
    platform: process.platform,
    environmentDirectory,
    modelingPython: activePython,
    systemPython,
    cadquery: await checkCadQuery(activePython),
    codex: await checkCodex(),
    claude: await checkClaude(),
    uv: await checkUv(),
    chatgptApiKeyDetected: Boolean(process.env.OPENAI_API_KEY),
  };
}

async function installPythonRuntimeIfPossible() {
  const existing = await findPython();
  if (existing) return existing;

  let uvError = null;
  try {
    const uv = await installUvRuntimeIfPossible();
    const uvPython = await installPythonWithUv(uv);
    if (uvPython) return uvPython;
  } catch (error) {
    uvError = error instanceof Error ? error.message : String(error);
  }

  if (process.platform === "darwin") {
    const brew = await commandVersion("brew", ["--version"], { env: runtimeEnvironment() });
    if (brew) {
      const result = await runCommand("brew", ["install", "python@3.11"], { env: runtimeEnvironment() });
      if (result.code === 0) {
        const discovered = await findPython();
        if (discovered) return discovered;
        try {
          const prefix = await execFileText("brew", ["--prefix", "python@3.11"], { timeout: 15_000 });
          const brewPython = await runnable({
            file: path.join(prefix.stdout.trim(), "bin", "python3.11"),
            args: [],
          });
          if (brewPython) return brewPython;
        } catch {
          // The error below contains the actionable recovery path.
        }
      }
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "Homebrew 安装 Python 失败。");
      }
      throw new Error("Homebrew 已安装 Python 3.11，但当前终端仍找不到它；请重开终端后重试。");
    }
  }

  if (process.platform === "win32") {
    const winget = await commandVersion("winget.exe", ["--version"], { env: runtimeEnvironment() });
    if (winget) {
      const result = await runCommand("winget.exe", [
        "install", "--id", "Python.Python.3.11", "--exact", "--scope", "user",
        "--accept-source-agreements", "--accept-package-agreements",
      ], { env: runtimeEnvironment() });
      if (result.code === 0) return findPython();
      throw new Error(result.stderr.trim() || "WinGet 安装 Python 失败。");
    }
  }

  throw new Error(
    `未发现 Python 3.11+，且无法通过用户目录运行时自动准备。${uvError ? ` uv: ${uvError}` : ""} 请检查网络后重试，或在 macOS 安装 Homebrew、Windows 安装并启用 WinGet。`,
  );
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function installUvRuntimeIfPossible() {
  const existing = await findUv();
  if (existing) return existing;

  const runtimeDirectory = uvRuntimeDirectory();
  const installerPath = path.join(appDataDirectory(), "runtime", process.platform === "win32" ? "uv-install.ps1" : "uv-install.sh");
  await fs.mkdir(runtimeDirectory, { recursive: true });

  if (process.platform === "win32") {
    const shell = process.env.SystemRoot ? "powershell.exe" : "pwsh";
    const download = await runCommand(shell, [
      "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop'; " +
      `Invoke-WebRequest -UseBasicParsing -MaximumRedirection 5 -Uri ${quotePowerShell(`https://astral.sh/uv/${DEFAULT_UV_VERSION}/install.ps1`)} -OutFile ${quotePowerShell(installerPath)}`,
    ], { env: runtimeEnvironment() });
    if (download.code !== 0) throw new Error(download.stderr.trim() || "下载 uv 安装程序失败。");
    try {
      const installed = await runCommand(shell, [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installerPath,
      ], {
        env: {
          ...runtimeEnvironment(),
          UV_UNMANAGED_INSTALL: runtimeDirectory,
          UV_NO_MODIFY_PATH: "1",
        },
      });
      if (installed.code !== 0) throw new Error(installed.stderr.trim() || "安装 uv 失败。");
    } finally {
      await fs.rm(installerPath, { force: true });
    }
  } else {
    const download = await runCommand("curl", [
      "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--silent", "--show-error",
      "--output", installerPath, `https://astral.sh/uv/${DEFAULT_UV_VERSION}/install.sh`,
    ], { env: runtimeEnvironment() });
    if (download.code !== 0) throw new Error(download.stderr.trim() || "下载 uv 安装程序失败。");
    try {
      const installed = await runCommand("sh", [installerPath], {
        env: {
          ...runtimeEnvironment(),
          UV_UNMANAGED_INSTALL: runtimeDirectory,
          UV_NO_MODIFY_PATH: "1",
        },
      });
      if (installed.code !== 0) throw new Error(installed.stderr.trim() || "安装 uv 失败。");
    } finally {
      await fs.rm(installerPath, { force: true });
    }
  }

  const installed = await findUv();
  if (!installed) throw new Error("uv 安装后仍未找到可执行文件。");
  return installed;
}

async function installPythonWithUv(uv) {
  if (!uv) return null;
  const pythonDirectory = uvPythonDirectory();
  const pythonBinDirectory = uvPythonBinDirectory();
  await fs.mkdir(pythonDirectory, { recursive: true });
  await fs.mkdir(pythonBinDirectory, { recursive: true });
  const env = {
    ...runtimeEnvironment(),
    UV_PYTHON_INSTALL_DIR: pythonDirectory,
    UV_PYTHON_BIN_DIR: pythonBinDirectory,
  };
  const install = await runCommand(uv, ["python", "install", DEFAULT_PYTHON_VERSION], { env });
  if (install.code !== 0) throw new Error(install.stderr.trim() || "uv 安装 Python 3.11 失败。");
  const found = await execFileText(uv.file, ["python", "find", `>=${DEFAULT_PYTHON_VERSION}`], { env, timeout: 20_000 });
  const pythonPath = found.stdout.trim().split(/\r?\n/).pop();
  if (!pythonPath) throw new Error("uv 已安装 Python，但没有返回可执行路径。");
  const runtime = await runnable({ file: pythonPath, args: [] });
  if (!runtime) throw new Error("uv 返回的 Python 版本不满足 3.11+。");
  return runtime;
}

async function createVirtualEnvironment(python, environmentDirectory) {
  await fs.mkdir(path.dirname(environmentDirectory), { recursive: true });
  const result = await runCommand(python.file, [...python.args, "-m", "venv", environmentDirectory]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || "创建 Python 虚拟环境失败。");
}

async function installCadQuery(python) {
  const upgrade = await runCommand(python, ["-m", "pip", "install", "--upgrade", "pip"]);
  if (upgrade.code !== 0) throw new Error(upgrade.stderr.trim() || "升级 pip 失败。");
  const install = await runCommand(python, ["-m", "pip", "install", DEFAULT_CAD_PACKAGE]);
  if (install.code !== 0) throw new Error(install.stderr.trim() || "安装 CadQuery 失败。");
}

export async function bootstrapModelingEnvironment(config = {}, options = {}) {
  if (!options.yes) throw new Error("bootstrap 会在本机安装 Python/CadQuery 依赖，请确认后加 --yes 执行。");
  const environmentDirectory = config.modelingEnvironment || defaultModelingEnvironment();
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  onProgress("正在检查 Python 和 CadQuery 环境…");
  const runtime = await installPythonRuntimeIfPossible();
  const pythonPath = venvPython(environmentDirectory);
  const existingEnvironment = await inspectPython({ file: pythonPath, args: [] }, { allowUnsupported: true });
  if (existingEnvironment && !existingEnvironment.supported) {
    throw new Error(`已有建模虚拟环境使用 Python ${existingEnvironment.version}，需要 Python ${DEFAULT_PYTHON_VERSION}+；为避免覆盖现有环境，请先指定新的 modelingEnvironment 路径。`);
  }
  if (!existingEnvironment) {
    onProgress("正在创建用户目录 Python 虚拟环境…");
    await createVirtualEnvironment(runtime, environmentDirectory);
  }
  onProgress("正在安装或修复 CadQuery…");
  await installCadQuery({ file: pythonPath, args: [] });
  const check = await checkCadQuery({ file: pythonPath, args: [] });
  if (!check.installed) throw new Error(check.error || "CadQuery 安装后验证失败。");
  onProgress(`CadQuery ${check.version || "已安装"} 已就绪`);
  return {
    environmentDirectory,
    python: pythonPath,
    cadquery: check.version,
    pythonTarget: DEFAULT_PYTHON_VERSION,
  };
}

export function environmentPythonPath(config = {}) {
  return venvPython(config.modelingEnvironment || defaultModelingEnvironment());
}

export function formatDoctor(report) {
  const yes = "✓";
  const no = "—";
  const lines = [
    `平台: ${report.platform}`,
    `Node: ${report.nodeSupported ? `${yes} ${report.node}` : `${no} ${report.node}（需要 ${report.nodeRequirement || `${DEFAULT_NODE_VERSION}+`}）`}`,
    `Codex CLI: ${report.codex.installed ? `${yes} ${report.codex.version}` : `${no} 未发现`}`,
    `Claude Code: ${report.claude.installed ? `${yes} ${report.claude.version}` : `${no} 未发现（可选）`}`,
    `Python: ${report.modelingPython ? `${yes} ${report.modelingPython.executable} (${report.modelingPython.version})` : `${no} 未发现 Python ${DEFAULT_PYTHON_VERSION}+`}`,
    `CadQuery: ${report.cadquery.installed ? `${yes} ${report.cadquery.version}` : `${no} 未安装`}`,
    `uv: ${report.uv.installed ? `${yes} ${report.uv.version}` : `${no} 未发现（可选）`}`,
    `本机 API Key: ${report.chatgptApiKeyDetected ? "检测到 OPENAI_API_KEY；这可能改用 API 额度" : "未检测到，Codex 将使用本机登录状态"}`,
    `建模环境: ${report.environmentDirectory}`,
  ];
  if (report.cadquery.error) lines.push(`CadQuery 错误: ${report.cadquery.error}`);
  return lines.join("\n");
}
