import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeCheckpoint } from "./vendor/modeling-platform-contracts/2f61b5e/contracts.mjs";
import { usagePayload } from "./usage.mjs";

function safeText(value, limit = 160) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
  return text || null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function writeLocalCheckpoint(taskDirectory, input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const checkpoint = normalizeCheckpoint(source.checkpoint) || {};
  const checkpointId = checkpoint.checkpointId || safeText(source.checkpointId, 160) || `cp-${randomUUID()}`;
  const payload = {
    schemaVersion: 1,
    checkpointId,
    checkpointVersion: checkpoint.checkpointVersion || "1",
    taskId: safeText(source.taskId, 160),
    attemptId: safeText(source.attemptId, 160),
    agent: safeText(source.agent, 80),
    provider: safeText(source.provider, 80) || "unknown",
    model: safeText(source.model, 160),
    stage: checkpoint.stage || safeText(source.stage, 40) || "turn_boundary",
    sessionRef: safeText(source.sessionRef, 240),
    resumeSupported: source.resumeSupported === true,
    eventCount: safeCount(source.eventCount),
    reasonCode: safeText(source.reasonCode, 120),
    usage: usagePayload(source.usage),
    createdAt: new Date().toISOString(),
  };
  const filename = path.join(taskDirectory, "checkpoint.json");
  await fs.mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filename);
  return payload;
}

export async function loadLocalCheckpoint(taskDirectory) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(taskDirectory, "checkpoint.json"), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return null;
  }
}
