import { execFile, spawn } from "node:child_process";

function mergedEnvironment(options = {}) {
  return { ...process.env, ...(options.env ?? {}) };
}

export function runCommand(file, args = [], options = {}) {
  const command = typeof file === "string" ? file : file.file;
  const commandArgs = typeof file === "string" ? args : [...(file.args ?? []), ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      env: mergedEnvironment(options),
      windowsHide: true,
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
    if (options.input) {
      child.stdin.end(options.input);
    }
  });
}

export async function execFileText(file, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: mergedEnvironment(options),
      windowsHide: true,
      maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
      timeout: options.timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(stderr?.trim() || stdout?.trim() || error.message);
        failure.code = error.code;
        failure.cause = error;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function commandVersion(file, args = ["--version"]) {
  try {
    const result = await execFileText(file, args, { timeout: 15_000 });
    return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] || "可用";
  } catch {
    return null;
  }
}

export async function commandExists(file) {
  try {
    await execFileText(file, ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
