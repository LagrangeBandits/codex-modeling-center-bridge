export function platformAndArchitecture(name) {
  const value = String(name ?? "").trim();
  const lower = value.toLowerCase();
  const baseName = lower.endsWith(".blockmap") ? lower.slice(0, -".blockmap".length) : lower;
  const platform = baseName.endsWith(".exe") ? "windows" : "macos";
  const architecture = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|\.)/i.test(value) ? "arm64" : "x64";
  const type = lower.endsWith(".blockmap") ? "blockmap" : lower.endsWith(".zip") ? "update-archive" : "installer";
  return { platform, architecture, type };
}
