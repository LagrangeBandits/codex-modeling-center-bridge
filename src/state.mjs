import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appDataDirectory, CONFIG_VERSION, DEFAULT_AGENT, defaultModelingEnvironment, defaultWorkspace, normalizeAgent, platformId } from "./constants.mjs";
import { execFileText } from "./process.mjs";

const CONFIG_PATH = path.join(appDataDirectory(), "config.json");
const SECRET_PATH = path.join(appDataDirectory(), "secrets.json");
const KEYCHAIN_SERVICE = "codex-modeling-center-bridge";

async function ensureDataDirectory() {
  await fs.mkdir(appDataDirectory(), { recursive: true, mode: 0o700 });
}

async function readJson(filename, fallback) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filename, value) {
  await ensureDataDirectory();
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, filename);
  if (process.platform !== "win32") await fs.chmod(filename, 0o600);
}

export async function loadConfig() {
  const config = await readJson(CONFIG_PATH, {});
  return {
    configVersion: CONFIG_VERSION,
    ...config,
    workspace: config.workspace || defaultWorkspace(),
    modelingEnvironment: config.modelingEnvironment || defaultModelingEnvironment(),
    platform: config.platform || platformId(),
    agent: normalizeAgent(config.agent || DEFAULT_AGENT),
  };
}

export async function saveConfig(patch) {
  const current = await loadConfig();
  const next = { ...current, ...patch, configVersion: CONFIG_VERSION };
  await writeJson(CONFIG_PATH, next);
  return next;
}

function macAccount() {
  return `${os.userInfo().username}:site-bridge`;
}

async function setMacSecret(name, value) {
  await execFileText("security", [
    "add-generic-password",
    "-a", macAccount(),
    "-s", `${KEYCHAIN_SERVICE}:${name}`,
    "-w", value,
    "-U",
  ], { timeout: 20_000 });
}

async function getMacSecret(name) {
  const result = await execFileText("security", [
    "find-generic-password",
    "-a", macAccount(),
    "-s", `${KEYCHAIN_SERVICE}:${name}`,
    "-w",
  ], { timeout: 20_000 });
  return result.stdout.trim();
}

async function deleteMacSecret(name) {
  try {
    await execFileText("security", [
      "delete-generic-password",
      "-a", macAccount(),
      "-s", `${KEYCHAIN_SERVICE}:${name}`,
    ], { timeout: 20_000 });
  } catch {
    // Missing keychain entries are already in the desired state.
  }
}

function powershellCommand() {
  return process.env.SystemRoot ? "powershell.exe" : "pwsh";
}

async function protectWindows(value) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes = [Text.Encoding]::UTF8.GetBytes($env:CODEX_BRIDGE_SECRET)",
    "$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($protected)",
  ].join("; ");
  const result = await execFileText(powershellCommand(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 20_000,
    env: { CODEX_BRIDGE_SECRET: value },
  });
  return result.stdout.trim();
}

async function unprotectWindows(value) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes = [Convert]::FromBase64String($env:CODEX_BRIDGE_SECRET)",
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Text.Encoding]::UTF8.GetString($plain)",
  ].join("; ");
  const result = await execFileText(powershellCommand(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    timeout: 20_000,
    env: { CODEX_BRIDGE_SECRET: value },
  });
  return result.stdout.trim();
}

async function setFallbackSecret(name, value) {
  const secrets = await readJson(SECRET_PATH, {});
  secrets[name] = value;
  await writeJson(SECRET_PATH, secrets);
}

async function getFallbackSecret(name) {
  const secrets = await readJson(SECRET_PATH, {});
  return typeof secrets[name] === "string" ? secrets[name] : null;
}

async function deleteFallbackSecret(name) {
  const secrets = await readJson(SECRET_PATH, {});
  delete secrets[name];
  await writeJson(SECRET_PATH, secrets);
}

export async function saveSecret(name, value) {
  if (!value) throw new Error(`不能保存空的密钥：${name}`);
  if (process.platform === "darwin") {
    await setMacSecret(name, value);
    return { backend: "macOS Keychain" };
  }
  if (process.platform === "win32") {
    const encrypted = await protectWindows(value);
    const secrets = await readJson(SECRET_PATH, {});
    secrets[name] = { backend: "Windows DPAPI", value: encrypted };
    await writeJson(SECRET_PATH, secrets);
    return { backend: "Windows DPAPI" };
  }
  await setFallbackSecret(name, value);
  return { backend: "0600 user file" };
}

export async function loadSecret(name) {
  if (process.platform === "darwin") {
    try {
      return await getMacSecret(name);
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    const secrets = await readJson(SECRET_PATH, {});
    const entry = secrets[name];
    if (!entry?.value) return null;
    try {
      return await unprotectWindows(entry.value);
    } catch {
      return null;
    }
  }
  return getFallbackSecret(name);
}

export async function deleteSecret(name) {
  if (process.platform === "darwin") return deleteMacSecret(name);
  return deleteFallbackSecret(name);
}

export function configPath() {
  return CONFIG_PATH;
}

export function dataDirectory() {
  return appDataDirectory();
}
