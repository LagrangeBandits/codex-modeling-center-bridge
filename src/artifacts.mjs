import fs from "node:fs/promises";
import path from "node:path";

const CAD_EXTENSIONS = new Set([".step", ".stp", ".stl", ".obj", ".iges", ".igs", ".dxf", ".3mf"]);
const SUPPORT_EXTENSIONS = new Set([".py", ".json", ".md", ".txt", ".csv"]);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export function uploadable(file, relative) {
  const extension = path.extname(file).toLowerCase();
  if (relative.startsWith("artifacts/")) return CAD_EXTENSIONS.has(extension) || SUPPORT_EXTENSIONS.has(extension);
  return CAD_EXTENSIONS.has(extension);
}

export async function collectArtifacts(taskDirectory) {
  const artifactDirectory = path.join(taskDirectory, "artifacts");
  await fs.mkdir(artifactDirectory, { recursive: true });
  const files = await walk(taskDirectory);
  return files.filter((file) => {
    const relative = path.relative(taskDirectory, file).split(path.sep).join("/");
    return uploadable(path.basename(file), relative);
  });
}

export function hasCadArtifact(files) {
  return files.some((file) => CAD_EXTENSIONS.has(path.extname(file).toLowerCase()));
}
