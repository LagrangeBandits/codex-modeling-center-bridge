const USAGE_KEYS = Object.freeze([
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "cacheCreationInputTokens",
  "cacheReadInputTokens",
  "reasoningOutputTokens",
]);

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, null]));
}

function tokenNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstTokenNumber(...values) {
  for (const value of values) {
    const number = tokenNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function terminalEventForAgent(agent, event) {
  if (agent === "codex") return event?.type === "turn.completed";
  if (agent === "claude" || agent === "claude-code") return event?.type === "result";
  return Boolean(event?.usage);
}

/**
 * Convert the provider-specific usage object into the bridge protocol shape.
 * The result deliberately contains only aggregate token counts and nulls.
 */
export function normalizeUsage(raw) {
  const usage = emptyUsage();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { usage, reason: "终结响应没有 usage 对象。" };
  }

  const inputDetails = raw.input_tokens_details || raw.prompt_tokens_details || {};
  const outputDetails = raw.output_tokens_details || raw.completion_tokens_details || {};
  usage.inputTokens = firstTokenNumber(raw.input_tokens, raw.prompt_tokens, raw.input, raw.inputTokens);
  usage.outputTokens = firstTokenNumber(raw.output_tokens, raw.completion_tokens, raw.output, raw.outputTokens);
  usage.totalTokens = firstTokenNumber(raw.total_tokens, raw.total, raw.total_token_count, raw.totalTokens);
  usage.cachedInputTokens = firstTokenNumber(
    raw.cached_input_tokens,
    raw.cachedInputTokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
    inputDetails.cached_tokens,
  );
  usage.cacheWriteInputTokens = firstTokenNumber(
    raw.cache_write_input_tokens,
    raw.cacheWriteInputTokens,
  );
  usage.cacheCreationInputTokens = firstTokenNumber(
    raw.cache_creation_input_tokens,
    raw.cacheCreationInputTokens,
  );
  usage.cacheReadInputTokens = firstTokenNumber(
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
  );
  usage.reasoningOutputTokens = firstTokenNumber(
    raw.reasoning_output_tokens,
    raw.reasoning_tokens,
    raw.reasoningOutputTokens,
    outputDetails.reasoning_tokens,
  );

  if (
    usage.totalTokens === null
    && usage.inputTokens !== null
    && usage.outputTokens !== null
    && Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
  ) {
    // This is an exact sum of the provider's reported input/output fields,
    // not an estimate. Provider-specific cache dimensions remain separate.
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }

  const knownCount = USAGE_KEYS.reduce((count, key) => count + (usage[key] === null ? 0 : 1), 0);
  if (knownCount === 0) {
    return { usage, reason: "usage 对象没有可识别的 token 数值字段。" };
  }

  const missingRequired = ["inputTokens", "outputTokens", "totalTokens"].filter((key) => usage[key] === null);
  if (missingRequired.length) {
    return { usage, reason: `终结响应缺少 ${missingRequired.join("、")}，无法完整统计。` };
  }
  return { usage, reason: null };
}

export function extractUsageFromEvent(agent, event) {
  if (!terminalEventForAgent(agent, event)) return null;
  return normalizeUsage(event?.usage);
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
  return normalizeUsage(event.usage);
}

function modelName(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return model ? model.slice(0, 160) : null;
}

export function providerForAgent(agent) {
  return agent === "claude" || agent === "claude-code" ? "anthropic" : "openai";
}

export function modelFromEvent(event) {
  const direct = modelName(event?.model || event?.model_name || event?.modelName || event?.message?.model);
  if (direct) return direct;

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
  if (value === null) return null;
  const payload = emptyUsage();
  if (!value || typeof value !== "object" || Array.isArray(value)) return payload;
  for (const key of USAGE_KEYS) payload[key] = tokenNumber(value[key]);
  return payload;
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
