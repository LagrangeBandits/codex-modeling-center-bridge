import {
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  cancellationState,
  normalizeControlPayload,
  normalizeTaskMessage,
  normalizeTaskMessages,
  normalizeTaskPriority,
} from "./vendor/modeling-platform-contracts/2f61b5e/contracts.mjs";

function cleanText(value, limit = MAX_MESSAGE_LENGTH) {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, limit);
  return text || null;
}

export function taskMessagesFromTask(task) {
  if (!task || typeof task !== "object") return [];
  return normalizeTaskMessages([
    ...(Array.isArray(task.messages) ? task.messages : task.messages ? [task.messages] : []),
    ...(Array.isArray(task.webMessages) ? task.webMessages : task.webMessages ? [task.webMessages] : []),
    ...(Array.isArray(task.continuationMessages) ? task.continuationMessages : task.continuationMessages ? [task.continuationMessages] : []),
    ...(task.message ? [task.message] : []),
  ]);
}

export function taskPromptWithMessages(prompt, messages) {
  const base = cleanText(String(prompt ?? ""), 16_000) || "请根据网站任务生成建模结果。";
  const normalized = normalizeTaskMessages(messages);
  if (!normalized.length) return base;
  const additions = normalized.map((message) => `- ${message.role}: ${message.content}`).join("\n");
  return `${base}\n\n## 网站补充消息\n${additions}`;
}

export class TaskCancelledError extends Error {
  constructor(reason = "网站请求取消了这项任务。") {
    super(cleanText(reason, 1_000) || "网站请求取消了这项任务。");
    this.name = "TaskCancelledError";
    this.code = "TASK_CANCELLED";
  }
}

export class TaskPausedError extends Error {
  constructor(reason = "任务已安全暂停，等待网站恢复。", options = {}) {
    super(cleanText(reason, 1_000) || "任务已安全暂停，等待网站恢复。");
    this.name = "TaskPausedError";
    this.code = "TASK_PAUSED";
    this.checkpoint = options.checkpoint || null;
    this.checkpointSent = options.checkpointSent === true;
    this.retryAfter = options.retryAfter ?? null;
    this.quotaState = options.quotaState || "unknown";
  }
}

export function pauseDirective(value) {
  const source = normalizeControlPayload(value);
  const quotaState = source.quotaState || "unknown";
  const requested = source.pauseRequested === true
    || source.action === "pause"
    || ["insufficient", "rate_limited", "auth_required"].includes(quotaState);
  return {
    requested,
    action: source.action || "none",
    quotaState,
    reason: source.pauseReason || (quotaState === "insufficient" ? "网站余额不足。" : null),
    retryAfter: source.retryAfter ?? null,
    checkpoint: source.checkpoint || null,
    attemptId: source.attemptId || null,
  };
}

export function isQuotaError(error) {
  const text = String(error?.message || error || "").toLowerCase();
  const status = Number(error?.status);
  return [402, 429].includes(status)
    || /(insufficient[_ -]?balance|insufficient[_ -]?quota|quota|rate[ -]?limit|credit|余额不足|额度不足|用量上限|限流)/i.test(text);
}

export {
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  cancellationState,
  normalizeControlPayload,
  normalizeTaskMessage,
  normalizeTaskMessages,
  normalizeTaskPriority,
};
