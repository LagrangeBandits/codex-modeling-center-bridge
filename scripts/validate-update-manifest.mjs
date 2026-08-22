import fs from "node:fs/promises";
import path from "node:path";

const filename = path.resolve(process.argv[2] || "release-assets/update-manifest.json");
let manifest;
try {
  manifest = JSON.parse(await fs.readFile(filename, "utf8"));
} catch (error) {
  console.error(`无法读取 update-manifest.json：${error.message}`);
  process.exit(1);
}

const requiredFeatures = new Set([
  "cli-capabilities",
  "usage-sequences",
  "pause-checkpoint-resume",
  "heartbeat-capabilities",
  "legacy-protocol-fallback",
]);
if (manifest.schemaVersion !== 2) throw new Error("update-manifest schemaVersion 必须为 2。");
if (!manifest.version || !manifest.releaseTag || !manifest.releaseUrl) throw new Error("update-manifest 缺少版本或 Release 信息。");
if (process.env.GITHUB_ACTIONS === "true" && !/^[a-f0-9]{40}$/i.test(String(manifest.sourceCommit || ""))) throw new Error("CI 发布清单缺少可追溯 sourceCommit。");
if (manifest.requiresRestart !== true) throw new Error("update-manifest 必须声明 requiresRestart=true。");
if (manifest.protocol?.min !== 1 || manifest.protocol?.max !== 2) throw new Error("update-manifest protocol 范围不正确。");
for (const feature of requiredFeatures) {
  if (!manifest.protocol.features?.includes(feature)) throw new Error(`update-manifest 缺少 feature：${feature}`);
  if (!manifest.features?.includes(feature)) throw new Error(`update-manifest 顶层缺少 feature：${feature}`);
}
if (!Array.isArray(manifest.assets) || !manifest.assets.length) throw new Error("update-manifest 没有资产。");
if (!manifest.assets.some((asset) => asset.platform === "macos" && asset.architecture === "arm64" && asset.type === "installer")) throw new Error("缺少 macOS arm64 installer 资产。");
if (!manifest.assets.some((asset) => asset.platform === "windows" && asset.architecture === "x64" && asset.type === "installer")) throw new Error("缺少 Windows x64 installer 资产。");
for (const asset of manifest.assets) {
  if (!asset.name || !asset.url || !Number.isSafeInteger(asset.size) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !asset.sha512) {
    throw new Error(`资产元数据不完整：${asset.name || "unknown"}`);
  }
}
console.log(`update-manifest 校验通过：v${manifest.version}，${manifest.assets.length} 个资产，protocol ${manifest.protocol.min}-${manifest.protocol.max}`);
