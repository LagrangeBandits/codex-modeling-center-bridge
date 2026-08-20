import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[2] || "dist");
const matches = [];

async function walk(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && entry.name === "app-update.yml") matches.push(target);
  }
}

await walk(root);
if (!matches.length) {
  console.error(`未找到 electron-builder 生成的 app-update.yml：${root}`);
  process.exit(1);
}

for (const file of matches) {
  const content = await fs.readFile(file, "utf8");
  if (!/provider:\s*github\b/.test(content) || !/owner:\s*LagrangeBandits\b/.test(content) || !/repo:\s*codex-modeling-center-bridge\b/.test(content)) {
    console.error(`app-update.yml 内容不是公开 GitHub provider：${file}`);
    process.exit(1);
  }
}

console.log(`app-update.yml 校验通过：${matches.length} 个`);
