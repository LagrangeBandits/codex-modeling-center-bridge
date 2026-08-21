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

/**
 * Convert the provider-specific usage object into the bridge protocol shape.
 * The result deliberately contains only aggregate token counts and nulls.
 */
export function normalizeUsage(raw) {
  return normalizeContractUsage(raw);
}

export function extractUsageFromEvent(agent, event) {
  if (!terminalEventForAgent(agent, event)) return null;
  return normalizeUsage(usageObjectFromEvent(event));
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
    event?.modelName,
    event?.message?.model,
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
