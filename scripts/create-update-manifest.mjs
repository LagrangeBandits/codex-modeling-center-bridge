import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { platformAndArchitecture } from "./update-manifest-utils.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const packageJson = JSON.parse(await fs.readFile(path.join(ROOT_DIRECTORY, "package.json"), "utf8"));

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function normalizeVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function yamlValue(content, key) {
  const match = content.match(new RegExp(`^${key}:\\s*[\\\"']?([^\\\"'\\r\\n]+)`, "m"));
  return match?.[1]?.trim() || null;
}

async function digest(file, algorithm, encoding) {
  const hash = crypto.createHash(algorithm);
  hash.update(await fs.readFile(file));
  return hash.digest(encoding);
}

const assetsDirectory = path.resolve(ROOT_DIRECTORY, argument("--assets", "release-assets"));
const version = normalizeVersion(argument("--version", packageJson.version));
const repository = argument("--repository", "LagrangeBandits/codex-modeling-center-bridge");
const releaseTag = `v${version || ""}`;
const releaseUrl = argument("--release-url", `https://github.com/${repository}/releases/tag/${releaseTag}`);
const minSupportedVersion = normalizeVersion(argument("--min-supported-version", "0.1.0"));

if (!version) fail("无法从 package.json 或参数取得有效版本。");
if (!minSupportedVersion) fail("最低支持版本无效。");
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail("GitHub 仓库格式无效。");

const entries = await fs.readdir(assetsDirectory, { withFileTypes: true }).catch(() => null);
if (!entries) fail(`找不到构建资产目录：${assetsDirectory}`);

const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const releaseFiles = files.filter((name) => /\.(?:dmg|zip|exe|blockmap)$/i.test(name));
const installers = releaseFiles.filter((name) => /\.(?:dmg|zip|exe)$/i.test(name));
if (!installers.some((name) => name.endsWith(".dmg"))) fail("构建资产缺少 macOS DMG。");
if (!installers.some((name) => name.endsWith(".exe"))) fail("构建资产缺少 Windows EXE。");
if (!installers.some((name) => name.endsWith(".zip"))) fail("构建资产缺少 macOS 更新 ZIP。");

for (const manifestName of ["latest.yml", "latest-mac.yml"]) {
  const manifestPath = path.join(assetsDirectory, manifestName);
  const content = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (!content) fail(`缺少 electron-builder 生成的 ${manifestName}。`);
  if (normalizeVersion(yamlValue(content, "version")) !== version) fail(`${manifestName} 版本与 package.json 不一致。`);
  const referencedFile = yamlValue(content, "path");
  if (!referencedFile || !files.includes(referencedFile)) fail(`${manifestName} 引用的构建资产不存在：${referencedFile || "未提供"}。`);
}

const assets = [];
for (const name of releaseFiles) {
  const filePath = path.join(assetsDirectory, name);
  const stat = await fs.stat(filePath);
  const { platform, architecture, type } = platformAndArchitecture(name);
  assets.push({
    name,
    type,
    platform,
    architecture,
    url: `https://github.com/${repository}/releases/download/${releaseTag}/${encodeURIComponent(name)}`,
    size: stat.size,
    sha256: await digest(filePath, "sha256", "hex"),
    sha512: await digest(filePath, "sha512", "base64"),
  });
}

const manifest = {
  schemaVersion: 1,
  product: packageJson.productName || packageJson.name,
  appId: packageJson.build?.appId || null,
  channel: "stable",
  version,
  releaseTag,
  releaseUrl,
  releaseNotesUrl: releaseUrl,
  publishedAt: new Date().toISOString(),
  minSupportedVersion,
  requiresRestart: true,
  protocol: { min: 1, max: 1 },
  assets,
};

const outputPath = path.join(assetsDirectory, "update-manifest.json");
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
JSON.parse(serialized);
await fs.writeFile(outputPath, serialized, "utf8");
console.log(`update-manifest.json 已生成：${assets.length} 个构建资产，版本 v${version}`);
