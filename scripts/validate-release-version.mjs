import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");

function normalizeVersion(value) {
  const version = String(value ?? "").trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

const packageJson = JSON.parse(await fs.readFile(path.join(ROOT_DIRECTORY, "package.json"), "utf8"));
const packageVersion = normalizeVersion(packageJson.version);
const requestedTag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
const tagVersion = normalizeVersion(requestedTag);

if (!packageVersion) {
  console.error("package.json 版本号无效。");
  process.exit(1);
}

if (!tagVersion) {
  console.error(`Git tag 无效：${requestedTag || "未提供"}。`);
  process.exit(1);
}

if (packageVersion !== tagVersion) {
  console.error(`版本不一致：package.json=${packageVersion}，tag=${tagVersion}。`);
  process.exit(1);
}

console.log(`版本校验通过：v${packageVersion}`);
