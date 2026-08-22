import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const sourceRoot = path.resolve(
  process.env.MODELING_PLATFORM_CONTRACTS_SOURCE ||
    path.join(repositoryRoot, "..", "modeling-platform-contracts"),
);
const sourceCommit = "b50bc727e8722759a2e5cd8ad91854ab746c7d3c";
const sourceBranch = "codex/contracts-sdk-v1";
const vendorRoot = path.join(
  repositoryRoot,
  "src",
  "vendor",
  "modeling-platform-contracts",
  "b50bc72",
);
const snapshotFiles = ["src/contracts.mjs", "src/sdk.mjs", "src/index.mjs"];

async function git(args) {
  const { stdout } = await execFileAsync("git", ["-C", sourceRoot, ...args], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

const actualCommit = await git(["rev-parse", "HEAD"]);
if (actualCommit !== sourceCommit) {
  throw new Error(
    `共享层版本不匹配：需要 ${sourceCommit}，实际为 ${actualCommit}（${sourceRoot}）`,
  );
}

await fs.mkdir(vendorRoot, { recursive: true });
for (const relativeFile of snapshotFiles) {
  const sourceFile = path.join(sourceRoot, relativeFile);
  const targetFile = path.join(vendorRoot, path.basename(relativeFile));
  await fs.copyFile(sourceFile, targetFile);
}

await fs.writeFile(
  path.join(vendorRoot, "SOURCE.md"),
  `# Modeling platform contracts snapshot\n\n` +
    `- Source project: modeling-platform-contracts\n` +
    `- Source branch: ${sourceBranch}\n` +
    `- Source commit: ${sourceCommit}\n` +
    `- Snapshot files: ${snapshotFiles.join(", ")}\n` +
    `- Runtime dependency: none; these files are bundled with the Bridge.\n` +
    `- Update: set MODELING_PLATFORM_CONTRACTS_SOURCE to a checked-out source repository at the expected commit, then run node scripts/sync-modeling-platform-contracts.mjs.\n`,
  "utf8",
);

console.log(`已同步共享层 ${sourceCommit} 到 ${path.relative(repositoryRoot, vendorRoot)}`);
