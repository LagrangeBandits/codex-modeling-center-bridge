import {
  USAGE_KEYS,
  normalizeUsage as normalizeContractUsage,
  usagePayload as normalizeUsagePayload,
} from "./vendor/modeling-platform-contracts/2f61b5e/contracts.mjs";

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, null]));
}

function terminalEventForAgent(agent, event) {
  if (agent === "codex") return event?.type === "turn.completed";
  if (agent === "claude" || agent === "claude-code") return event?.type === "result";
  return Boolean(usageObjectFromEvent(event));
}

function usageObjectFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.usage && typeof event.usage === "object") return event.usage;
  if (event.stats && typeof event.stats === "object") {
    if (event.stats.tokens && typeof event.stats.tokens === "object") return event.stats.tokens;
    return event.stats;
  }
  if (event.result && typeof event.result === "object") {
    if (event.result.usage && typeof event.result.usage === "object") return event.result.usage;
    if (event.result.stats && typeof event.result.stats === "object") return event.result.stats;
  }
  if (event.metrics && typeof event.metrics === "object") return event.metrics;
  return null;
}

function usageModeFromEvent(event) {
  const mode = String(event?.usageMode ?? event?.usage_mode ?? event?.usage?.mode ?? "").trim().toLowerCase();
  return mode === "delta" ? "delta" : "cumulative";
}

function usageSourceFromEvent(agent, event) {
  const source = event?.usageSource ?? event?.usage_source ?? event?.source;
  if (typeof source === "string" && source.trim()) return source.trim().slice(0, 120);
  return `${String(agent || "agent").trim().toLowerCase() || "agent"}:event`;
}

function observedAtFromEvent(event) {
  const value = event?.observedAt ?? event?.observed_at ?? event?.timestamp ?? event?.created_at ?? event?.createdAt;
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  return new Date().toISOString();
}

function usageCompleteForEvent(agent, event, normalized) {
  const explicit = event?.usageComplete ?? event?.usage_complete;
  if (explicit === true) return true;
  if (!normalized.complete) return false;
  if (agent === "codex" || agent === "claude" || agent === "claude-code") return terminalEventForAgent(agent, event);
  return ["result", "complete", "completed", "turn.completed", "task.completed"].includes(String(event?.type || "").toLowerCase());
}

/**
 * Convert the provider-specific usage object into the bridge protocol shape.
 * The result deliberately contains only aggregate token counts and nulls.
 */
export function normalizeUsage(raw) {
  return normalizeContractUsage(raw);
}

export function extractUsageFromEvent(agent, event) {
  const raw = usageObjectFromEvent(event);
  if (!raw) return null;
  const normalized = normalizeUsage(raw);
  return {
    ...normalized,
    usageMode: usageModeFromEvent(event),
    usageSource: usageSourceFromEvent(agent, event),
    usageComplete: usageCompleteForEvent(agent, event, normalized),
    observedAt: observedAtFromEvent(event),
  };
}

export function extractAgentUsage(agent, events) {
  const event = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .find((candidate) => terminalEventForAgent(agent, candidate));
  if (!event) {
    return {
      usage: emptyUsage(),
      reason: `${agent} 本地响应没有可识别的终结用量事件。`,
    };
  }
  return normalizeUsage(usageObjectFromEvent(event));
}

function modelName(value) {
  if (typeof value !== "string") return null;
  const model = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
  if (!model || /(?:bearer\s+|sk-[a-z0-9_-]+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])/i.test(model)) return null;
  return model;
}

export function providerForAgent(agent) {
  // Agent identity is not provider identity. A Codex-compatible endpoint may
  // be OpenAI, DeepSeek, Qwen/DashScope, or another provider; Claude Code may
  // also be configured against a compatible endpoint. Resolve the provider
  // from the real event/config evidence instead of guessing from the agent.
  return "unknown";
}

export function modelFromEvent(event) {
  const directCandidates = [
    event?.model,
    event?.model_name,
    event?.model_id,
    event?.modelName,
    event?.data?.model,
    event?.data?.model_name,
    event?.message?.model,
    event?.message?.model_name,
    event?.item?.model,
    event?.response?.model,
    event?.output?.model,
    event?.result && typeof event.result === "object" ? event.result.model : null,
  ];
  for (const candidate of directCandidates) {
    const direct = modelName(candidate);
    if (direct) return direct;
  }

  // Claude Code may expose modelUsage keyed by model name. Only infer a
  // model when the response names exactly one model; never guess on a mix.
  const modelUsage = event?.modelUsage;
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    const names = Object.keys(modelUsage).map(modelName).filter(Boolean);
    if (names.length === 1) return names[0];
  }
  return null;
}

export function modelFromEvents(events, configuredModel = null) {
  const eventModel = [...(Array.isArray(events) ? events : [])]
    .reverse()
    .map(modelFromEvent)
    .find(Boolean);
  return eventModel || modelName(configuredModel);
}

export function agentTelemetry(agent, events, configuredModel, usage) {
  return {
    provider: providerForAgent(agent),
    model: modelFromEvents(events, configuredModel),
    usage: usagePayload(usage),
  };
}

function addUsage(base, delta) {
  const result = { ...base };
  for (const key of USAGE_KEYS) {
    const value = Number.isSafeInteger(delta?.[key]) && delta[key] >= 0 ? delta[key] : null;
    if (value === null) continue;
    result[key] = (Number.isSafeInteger(result[key]) ? result[key] : 0) + value;
  }
  if (result.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

function replaceKnownUsage(base, next) {
  const result = { ...base };
  for (const key of USAGE_KEYS) {
    if (Number.isSafeInteger(next?.[key]) && next[key] >= 0) result[key] = next[key];
  }
  if (result.totalTokens === null && result.inputTokens !== null && result.outputTokens !== null) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return result;
}

/**
 * Accumulates provider usage without retaining or uploading raw provider events.
 * Providers may emit cumulative snapshots or explicit deltas; each emitted
 * envelope gets a monotonic task-local sequence for idempotent server writes.
 */
export function createUsageAccumulator({ attemptId = null, usageSource = "agent:event" } = {}) {
  let sequence = 0;
  let aggregate = emptyUsage();
  let lastEnvelope = null;

  function update(agent, event) {
    const envelope = extractUsageFromEvent(agent, event);
    if (!envelope) return null;
    aggregate = envelope.usageMode === "delta"
      ? addUsage(aggregate, envelope.usage)
      : replaceKnownUsage(aggregate, envelope.usage);
    sequence += 1;
    lastEnvelope = {
      attemptId: typeof attemptId === "string" && attemptId.trim() ? attemptId.trim().slice(0, 160) : null,
      sequence,
      usageMode: envelope.usageMode,
      usageSource: envelope.usageSource || usageSource,
      usageComplete: envelope.usageComplete,
      observedAt: envelope.observedAt,
      usage: usagePayload(aggregate),
    };
    return { ...lastEnvelope };
  }

  function snapshot() {
    return lastEnvelope ? { ...lastEnvelope, usage: usagePayload(lastEnvelope.usage) } : null;
  }

  return {
    update,
    snapshot,
    get sequence() { return sequence; },
    get usage() { return usagePayload(aggregate); },
  };
}

/**
 * Whitelist the protocol payload so raw provider objects can never cross the
 * site boundary, even if a caller accidentally passes an event-like object.
 */
export function usagePayload(value) {
  return normalizeUsagePayload(value);
}

export function formatUsage(usage) {
  const value = (key) => usage?.[key] ?? "未知";
  const optional = [
    ["缓存输入", "cachedInputTokens"],
    ["写入缓存", "cacheWriteInputTokens"],
    ["创建缓存", "cacheCreationInputTokens"],
    ["读取缓存", "cacheReadInputTokens"],
    ["推理输出", "reasoningOutputTokens"],
  ]
    .filter(([, key]) => usage?.[key] !== null && usage?.[key] !== undefined)
    .map(([label, key]) => `${label} ${usage[key]}`);
  return [
    `输入 ${value("inputTokens")}`,
    `输出 ${value("outputTokens")}`,
    `总计 ${value("totalTokens")}`,
    ...optional,
  ].join("，");
}

export { USAGE_KEYS };
