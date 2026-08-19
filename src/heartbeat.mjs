import os from "node:os";
import { normalizeAgent, platformId } from "./constants.mjs";

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cpuSnapshot() {
  const cpus = os.cpus();
  if (!Array.isArray(cpus) || !cpus.length) return null;
  return cpus.reduce((total, cpu) => {
    const times = cpu?.times || {};
    total.user += Number(times.user) || 0;
    total.nice += Number(times.nice) || 0;
    total.sys += Number(times.sys) || 0;
    total.idle += Number(times.idle) || 0;
    total.irq += Number(times.irq) || 0;
    return total;
  }, { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 });
}

export function cpuPercent(previous, current = cpuSnapshot()) {
  if (!previous || !current) return null;
  const previousTotal = Object.values(previous).reduce((sum, value) => sum + value, 0);
  const currentTotal = Object.values(current).reduce((sum, value) => sum + value, 0);
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = current.idle - previous.idle;
  if (!Number.isFinite(totalDelta) || totalDelta <= 0 || !Number.isFinite(idleDelta)) return null;
  const percentage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number.isFinite(percentage) ? Math.max(0, Math.min(100, Number(percentage.toFixed(2)))) : null;
}

export function collectSystemMetrics(previousCpuSnapshot = null) {
  const currentCpuSnapshot = cpuSnapshot();
  const memoryTotalBytes = positiveInteger(os.totalmem());
  const freeBytes = positiveInteger(os.freemem());
  const memoryUsedBytes = memoryTotalBytes !== null && freeBytes !== null
    ? Math.max(0, memoryTotalBytes - Math.min(memoryTotalBytes, freeBytes))
    : null;
  const load = process.platform === "win32" ? null : os.loadavg()?.[0];
  return {
    cpuSnapshot: currentCpuSnapshot,
    cpuPercent: cpuPercent(previousCpuSnapshot, currentCpuSnapshot),
    memoryUsedBytes,
    memoryTotalBytes,
    load1m: Number.isFinite(load) && load >= 0 ? Number(load.toFixed(3)) : null,
  };
}

export function defaultCapabilities(agent) {
  const selectedAgent = normalizeAgent(agent);
  return [
    "task:direct",
    "task:plan",
    selectedAgent === "claude" ? "agent:claude-code" : "agent:codex",
  ];
}

export function heartbeatPayload({
  runnerId,
  agent,
  provider,
  model,
  softwareVersion,
  activeTasks = 0,
  capacity = 1,
  metrics = {},
  capabilities = defaultCapabilities(agent),
  platform = platformId(),
}) {
  const normalizedAgent = normalizeAgent(agent);
  const safeCapabilities = Array.isArray(capabilities)
    ? capabilities.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim().slice(0, 80)).slice(0, 32)
    : defaultCapabilities(normalizedAgent);
  return {
    runnerId: typeof runnerId === "string" && runnerId.trim() ? runnerId.trim().slice(0, 160) : null,
    platform: typeof platform === "string" && platform.trim() ? platform.trim().slice(0, 40) : "unknown",
    agent: normalizedAgent === "claude" ? "claude-code" : "codex",
    provider: typeof provider === "string" && provider.trim() ? provider.trim().slice(0, 80) : "unknown",
    model: typeof model === "string" && model.trim() ? model.trim().slice(0, 160) : null,
    softwareVersion: typeof softwareVersion === "string" && softwareVersion.trim() ? softwareVersion.trim().slice(0, 40) : "unknown",
    activeTasks: Number.isSafeInteger(activeTasks) && activeTasks >= 0 ? activeTasks : null,
    capacity: Number.isSafeInteger(capacity) && capacity >= 1 ? capacity : null,
    cpuPercent: Number.isFinite(metrics.cpuPercent) ? metrics.cpuPercent : null,
    memoryUsedBytes: positiveInteger(metrics.memoryUsedBytes),
    memoryTotalBytes: positiveInteger(metrics.memoryTotalBytes),
    load1m: Number.isFinite(metrics.load1m) && metrics.load1m >= 0 ? metrics.load1m : null,
    capabilities: safeCapabilities,
  };
}

export { cpuSnapshot };
