import fs from "node:fs/promises";
import path from "node:path";
import { defaultModelingEnvironment, DEFAULT_CAD_PACKAGE, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION, isSupportedNodeVersion } from "./constants.mjs";
import { commandVersion, execFileText, runCommand } from "./process.mjs";

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 11;

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
    const result = await execFileText(spec.file, [...spec.args, ...args], { timeout: 20_000 });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    if (!isSupportedPythonVersion(version)) return null;
    return { ...spec, version };
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
    result = await runCommand(python.file, [...python.args, "-c", "import sys; print(sys.executable); print(sys.version.split()[0])"]);
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
  const result = await runCommand(python, ["-c", "import cadquery; print(getattr(cadquery, '__version__', 'installed'))"]);
  return {
    installed: result.code === 0,
    version: result.code === 0 ? result.stdout.trim() : null,
    error: result.code === 0 ? null : (result.stderr.trim().split(/\r?\n/).pop() || "未安装"),
  };
}

async function checkCodex() {
  const version = await commandVersion(process.platform === "win32" ? "codex.cmd" : "codex");
  return { installed: Boolean(version), version };
}

async function checkUv() {
  const version = await commandVersion(process.platform === "win32" ? "uv.exe" : "uv");
  return { installed: Boolean(version), version };
}

export async function inspectEnvironment(config = {}) {
  const environmentDirectory = config.modelingEnvironment || defaultModelingEnvironment();
  const environmentPythonPath = venvPython(environmentDirectory);
  const environmentPython = await inspectPython({ file: environmentPythonPath, args: [] });
  const systemPython = await inspectPython(await findPython());
  const activePython = environmentPython || systemPython;
  return {
    node: process.version,
    nodeSupported: isSupportedNodeVersion(process.version),
    nodeRequirement: `${DEFAULT_NODE_VERSION}+`,
    platform: process.platform,
    environmentDirectory,
    modelingPython: activePython,
    systemPython,
    cadquery: await checkCadQuery(activePython),
    codex: await checkCodex(),
    uv: await checkUv(),
    chatgptApiKeyDetected: Boolean(process.env.OPENAI_API_KEY),
  };
}

async function installPythonRuntimeIfPossible() {
  const existing = await findPython();
  if (existing) return existing;

  if (process.platform === "darwin") {
    const brew = await commandVersion("brew");
    if (brew) {
      const result = await runCommand("brew", ["install", "python@3.11"]);
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
    const winget = await commandVersion("winget.exe");
    if (winget) {
      const result = await runCommand("winget.exe", [
        "install", "--id", "Python.Python.3.11", "--exact", "--scope", "user",
        "--accept-source-agreements", "--accept-package-agreements",
      ]);
      if (result.code === 0) return findPython();
      throw new Error(result.stderr.trim() || "WinGet 安装 Python 失败。");
    }
  }

  throw new Error(
    "未发现 Python 3.11+。请先安装 Python 3.11 或更高版本，或在 macOS 安装 Homebrew、Windows 安装并启用 WinGet 后再次运行 bootstrap。",
  );
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
  const runtime = await installPythonRuntimeIfPossible();
  const pythonPath = venvPython(environmentDirectory);
  const existingEnvironment = await inspectPython({ file: pythonPath, args: [] }, { allowUnsupported: true });
  if (existingEnvironment && !existingEnvironment.supported) {
    throw new Error(`已有建模虚拟环境使用 Python ${existingEnvironment.version}，需要 Python ${DEFAULT_PYTHON_VERSION}+；为避免覆盖现有环境，请先指定新的 modelingEnvironment 路径。`);
  }
  if (!existingEnvironment) {
    await createVirtualEnvironment(runtime, environmentDirectory);
  }
  await installCadQuery({ file: pythonPath, args: [] });
  const check = await checkCadQuery({ file: pythonPath, args: [] });
  if (!check.installed) throw new Error(check.error || "CadQuery 安装后验证失败。");
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
    `Python: ${report.modelingPython ? `${yes} ${report.modelingPython.executable} (${report.modelingPython.version})` : `${no} 未发现 Python ${DEFAULT_PYTHON_VERSION}+`}`,
    `CadQuery: ${report.cadquery.installed ? `${yes} ${report.cadquery.version}` : `${no} 未安装`}`,
    `uv: ${report.uv.installed ? `${yes} ${report.uv.version}` : `${no} 未发现（可选）`}`,
    `本机 API Key: ${report.chatgptApiKeyDetected ? "检测到 OPENAI_API_KEY；这可能改用 API 额度" : "未检测到，Codex 将使用本机登录状态"}`,
    `建模环境: ${report.environmentDirectory}`,
  ];
  if (report.cadquery.error) lines.push(`CadQuery 错误: ${report.cadquery.error}`);
  return lines.join("\n");
}
