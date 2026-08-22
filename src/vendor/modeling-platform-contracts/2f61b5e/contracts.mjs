const CONTROL_ROLES = new Set(["user", "assistant", "system"]);
const EXECUTION_MODES = new Set(["direct", "plan"]);
const CONTROL_ACTIONS = new Set(["none", "pause", "resume", "cancel"]);
const QUOTA_STATES = new Set(["ok", "insufficient", "rate_limited", "auth_required", "unknown"]);
const USAGE_MODES = new Set(["cumulative", "delta"]);
const CHECKPOINT_STAGES = new Set(["before_turn", "tool_boundary", "turn_boundary", "before_upload", "agent_error"]);
const MODEL_PREFERENCE_MAX = 240;
const MAX_MESSAGE_LENGTH = 8_000;
const MAX_MESSAGES = 32;
const MAX_CURSOR_LENGTH = 256;
const MAX_ATTEMPT_ID_LENGTH = 160;
const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
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

function cleanText(value, limit = MAX_MESSAGE_LENGTH) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, limit);
  return text || null;
}

function cleanCursor(value) {
  return cleanText(value, MAX_CURSOR_LENGTH);
}

function cleanAttemptId(value) {
  return cleanText(value, MAX_ATTEMPT_ID_LENGTH);
}

function safeModel(value) {
  const model = cleanText(value, MODEL_PREFERENCE_MAX);
  if (!model) return null;
  if (/(?:bearer\s+|sk-[a-z0-9_-]+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])/i.test(model)) return null;
  return model;
}

function roleOf(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  return CONTROL_ROLES.has(role) ? role : fallback;
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

function emptyUsage() {
  return Object.fromEntries(USAGE_KEYS.map((key) => [key, null]));
}

export function normalizeSite(value) {
  if (!value) throw new Error("缺少站点地址");
  const site = String(value).trim().replace(/\/+$/, "");
  const url = new URL(site);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("站点地址必须是 http 或 https URL");
  return site;
}

export function normalizeAgent(value, fallback = "codex") {
  const raw = String(value || fallback).trim().toLowerCase();
  const agent = ["claude-code", "cc"].includes(raw) ? "claude" : raw;
  return AGENT_ID_PATTERN.test(agent) && !["any", "auto"].includes(agent) ? agent : String(fallback).trim().toLowerCase();
}

export function wireAgent(value) {
  const agent = normalizeAgent(value);
  return agent === "claude" ? "claude-code" : agent;
}

export function normalizeTaskAgent(value) {
  const agent = String(value ?? "any").trim().toLowerCase();
  if (["", "any", "auto", "automatic"].includes(agent)) return "any";
  if (!AGENT_ID_PATTERN.test(agent)) return "any";
  return wireAgent(agent);
}

export function normalizeExecutionMode(value, fallback = "direct") {
  const mode = String(value || fallback).trim().toLowerCase();
  return EXECUTION_MODES.has(mode) ? mode : fallback;
}

export function normalizeTaskPriority(value) {
  if (value === null || value === undefined || value === "") return 0;
  const priority = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(priority)) return 0;
  return Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(priority)));
}

export function normalizeModelPreference(value) {
  if (value === null || value === undefined || value === "") return "auto";
  if (typeof value === "string") {
    const text = safeModel(value);
    if (!text) return "auto";
    if (text.startsWith("{") && text.endsWith("}")) {
      try {
        return normalizeModelPreference(JSON.parse(text));
      } catch {
        return text;
      }
    }
    return text;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "auto";
  const provider = safeModel(value.provider);
  const model = safeModel(value.model ?? value.name);
  const reasoningEffort = safeModel(value.reasoningEffort ?? value.reasoning);
  const baseUrl = safeModel(value.baseUrl ?? value.base_url);
  if (!provider && !model && !reasoningEffort && !baseUrl) return "auto";
  return { provider, model, reasoningEffort, baseUrl };
}

export function normalizeTask(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ...source,
    id: cleanText(source.id, 160),
    prompt: cleanText(source.prompt ?? source.request, 16_000) || "请根据网站任务生成建模结果。",
    agent: normalizeTaskAgent(source.agent),
    executionMode: normalizeExecutionMode(source.executionMode ?? source.execution_mode),
    priority: normalizeTaskPriority(source.priority),
    modelPreference: normalizeModelPreference(
      source.modelPreference ?? source.model_preference ?? source.modelPreferences ?? source.model,
    ),
    attemptId: cleanAttemptId(source.attemptId ?? source.attempt_id ?? source.attempt),
    checkpoint: normalizeCheckpoint(source.checkpoint ?? source.resumeCheckpoint),
  };
}

export function normalizeTaskMessage(value, fallbackRole = "user") {
  if (typeof value === "string") {
    const content = cleanText(value);
    return content ? { id: null, role: roleOf(fallbackRole), content } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const content = cleanText(value.content ?? value.message ?? value.text);
  if (!content) return null;
  return {
    id: cleanCursor(value.id ?? value.messageId ?? value.message_id),
    role: roleOf(value.role ?? value.senderRole ?? fallbackRole, fallbackRole),
    content,
  };
}

export function normalizeTaskMessages(value, fallbackRole = "user") {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const messages = [];
  const seen = new Set();
  for (const item of values) {
    const message = normalizeTaskMessage(item, fallbackRole);
    if (!message) continue;
    const key = message.id ? `id:${message.id}` : `${message.role}:${message.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(message);
    if (messages.length >= MAX_MESSAGES) break;
  }
  return messages;
}

export function cancellationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { requested: false, reason: null };
  const truthy = (candidate) => candidate === true || ["1", "true", "yes", "cancel", "cancelled", "canceled"].includes(String(candidate || "").trim().toLowerCase());
  const status = String(value.status ?? value.state ?? "").trim().toLowerCase();
  const timestamp = value.cancelRequestedAt ?? value.cancel_requested_at;
  const hasTimestamp = timestamp !== null && timestamp !== undefined && String(timestamp).trim() && String(timestamp).toLowerCase() !== "null";
  return {
    requested: [value.cancelRequested, value.cancelled, value.canceled, value.shouldCancel].some(truthy)
      || Boolean(hasTimestamp)
      || ["cancelled", "canceled", "cancelling", "cancel_requested"].includes(status),
    reason: cleanText(value.cancelReason ?? value.cancellationReason ?? value.reason, 1_000),
  };
}

function booleanValue(value) {
  if (value === true) return true;
  if (value === false) return false;
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase())
    ? true
    : ["0", "false", "no", "off"].includes(String(value ?? "").trim().toLowerCase())
      ? false
      : null;
}

export function normalizeQuotaState(value) {
  const state = String(value ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
  return QUOTA_STATES.has(state) ? state : "unknown";
}

export function normalizeControlAction(value) {
  const action = String(value ?? "").trim().toLowerCase().replace(/[ -]+/g, "_");
  return CONTROL_ACTIONS.has(action) ? action : "none";
}

export function normalizeCheckpoint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stage = String(value.stage ?? value.checkpointStage ?? "").trim().toLowerCase();
  const checkpointId = cleanAttemptId(value.checkpointId ?? value.checkpoint_id ?? value.id);
  if (!checkpointId && !stage) return null;
  return {
    checkpointId,
    checkpointVersion: cleanText(value.checkpointVersion ?? value.version, 40),
    stage: CHECKPOINT_STAGES.has(stage) ? stage : "turn_boundary",
    attemptId: cleanAttemptId(value.attemptId ?? value.attempt_id),
    resumeSupported: booleanValue(value.resumeSupported ?? value.resume_supported),
    resumeFrom: cleanAttemptId(value.resumeFrom ?? value.resume_from ?? value.resumeToken ?? value.resume_token),
    reasonCode: cleanText(value.reasonCode ?? value.reason_code ?? value.reason, 120),
    createdAt: cleanText(value.createdAt ?? value.created_at, 80),
  };
}

export function normalizeUsageMetadata(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const mode = String(source.usageMode ?? source.usage_mode ?? "").trim().toLowerCase();
  const usageComplete = booleanValue(source.usageComplete ?? source.usage_complete);
  return {
    attemptId: cleanAttemptId(source.attemptId ?? source.attempt_id),
    sequence: tokenNumber(source.sequence),
    usageMode: USAGE_MODES.has(mode) ? mode : null,
    usageSource: cleanText(source.usageSource ?? source.usage_source, 120),
    usageComplete,
    observedAt: cleanText(source.observedAt ?? source.observed_at, 80),
  };
}

export function normalizeControlPayload(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const cancellation = cancellationState(source);
  const control = {
    cursor: cleanCursor(source.cursor ?? source.nextCursor ?? source.next_cursor),
    cancelRequested: cancellation.requested,
    cancelReason: cancellation.reason,
    messages: normalizeTaskMessages(source.messages ?? source.webMessages ?? source.items),
  };
  const action = normalizeControlAction(source.action ?? source.controlAction ?? source.control_action);
  const quota = source.quotaState ?? source.quota_state ?? source.billingState ?? source.billing_state;
  const pause = booleanValue(source.pauseRequested ?? source.pause_requested);
  const retryAfter = source.retryAfter ?? source.retry_after;
  const checkpoint = normalizeCheckpoint(source.checkpoint ?? source.checkpointRequest ?? source.checkpoint_request);
  const attemptId = cleanAttemptId(source.attemptId ?? source.attempt_id ?? source.attempt);
  if (action !== "none") control.action = action;
  if (quota !== undefined) control.quotaState = normalizeQuotaState(quota);
  if (pause !== null) control.pauseRequested = pause;
  if (source.pauseReason !== undefined || source.pause_reason !== undefined || source.reasonCode !== undefined || source.reason_code !== undefined) {
    control.pauseReason = cleanText(source.pauseReason ?? source.pause_reason ?? source.reasonCode ?? source.reason_code, 240);
  }
  if (retryAfter !== undefined && retryAfter !== null) control.retryAfter = cleanText(retryAfter, 80) || tokenNumber(retryAfter);
  if (checkpoint) control.checkpoint = checkpoint;
  if (attemptId) control.attemptId = attemptId;
  if (source.resumeRequested !== undefined || source.resume_requested !== undefined) {
    control.resumeRequested = booleanValue(source.resumeRequested ?? source.resume_requested);
  }
  return control;
}

export function normalizeUsage(raw) {
  const usage = emptyUsage();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { usage, complete: false, reason: "终结响应没有 usage 对象。" };
  const inputDetails = raw.input_tokens_details || raw.prompt_tokens_details || {};
  const outputDetails = raw.output_tokens_details || raw.completion_tokens_details || {};
  usage.inputTokens = firstTokenNumber(raw.input_tokens, raw.prompt_tokens, raw.input, raw.inputTokens);
  usage.outputTokens = firstTokenNumber(raw.output_tokens, raw.completion_tokens, raw.output, raw.outputTokens);
  usage.totalTokens = firstTokenNumber(raw.total_tokens, raw.total, raw.total_token_count, raw.totalTokens);
  usage.cachedInputTokens = firstTokenNumber(raw.cached_input_tokens, raw.cachedInputTokens, raw.cache_read_input_tokens, raw.cacheReadInputTokens, inputDetails.cached_tokens);
  usage.cacheWriteInputTokens = firstTokenNumber(raw.cache_write_input_tokens, raw.cacheWriteInputTokens);
  usage.cacheCreationInputTokens = firstTokenNumber(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens);
  usage.cacheReadInputTokens = firstTokenNumber(raw.cache_read_input_tokens, raw.cacheReadInputTokens);
  usage.reasoningOutputTokens = firstTokenNumber(raw.reasoning_output_tokens, raw.reasoning_tokens, raw.reasoningOutputTokens, outputDetails.reasoning_tokens);
  if (usage.totalTokens === null && usage.inputTokens !== null && usage.outputTokens !== null) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  const known = USAGE_KEYS.some((key) => usage[key] !== null);
  const complete = usage.inputTokens !== null && usage.outputTokens !== null && usage.totalTokens !== null;
  return { usage, complete, reason: known && complete ? null : known ? "终结响应缺少完整的 input/output/total 用量。" : "usage 对象没有可识别的 token 数值字段。" };
}

export function usagePayload(value) {
  if (value === null) return null;
  const payload = emptyUsage();
  if (!value || typeof value !== "object" || Array.isArray(value)) return payload;
  for (const key of USAGE_KEYS) payload[key] = tokenNumber(value[key]);
  return payload;
}

export function normalizeTelemetry(value) {
  if (value === null) return { provider: null, model: null, usage: null };
  const source = value && typeof value === "object" ? value : {};
  const telemetry = {
    provider: safeModel(source.provider) || "unknown",
    model: safeModel(source.model),
    usage: usagePayload(source.usage),
  };
  const metadata = normalizeUsageMetadata(source);
  if (metadata.attemptId) telemetry.attemptId = metadata.attemptId;
  if (metadata.sequence !== null) telemetry.sequence = metadata.sequence;
  if (metadata.usageMode) telemetry.usageMode = metadata.usageMode;
  if (metadata.usageSource) telemetry.usageSource = metadata.usageSource;
  if (metadata.usageComplete !== null) telemetry.usageComplete = metadata.usageComplete;
  if (metadata.observedAt) telemetry.observedAt = metadata.observedAt;
  return telemetry;
}

export { CHECKPOINT_STAGES, CONTROL_ACTIONS, MAX_ATTEMPT_ID_LENGTH, MAX_MESSAGE_LENGTH, MAX_MESSAGES, QUOTA_STATES, USAGE_KEYS, USAGE_MODES };
