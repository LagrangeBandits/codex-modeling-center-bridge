const MAX_MESSAGE_LENGTH = 8_000;
const MAX_MESSAGES = 32;
const MAX_CURSOR_LENGTH = 256;

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

function roleOf(value, fallback = "user") {
  const role = String(value || fallback).trim().toLowerCase();
  return new Set(["user", "assistant", "system"]).has(role) ? role : fallback;
}

export function normalizeTaskPriority(value) {
  if (value === null || value === undefined || value === "") return 0;
  const priority = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(priority)) return 0;
  return Math.max(-1_000_000, Math.min(1_000_000, Math.trunc(priority)));
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

function truthyCancellation(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return new Set(["1", "true", "yes", "cancel", "cancelled", "canceled"]).has(value.trim().toLowerCase());
}

export function cancellationState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { requested: false, reason: null };
  }
  const status = String(value.status ?? value.state ?? "").trim().toLowerCase();
  const cancelRequestedAt = value.cancelRequestedAt ?? value.cancel_requested_at;
  const hasCancellationTimestamp = cancelRequestedAt !== null
    && cancelRequestedAt !== undefined
    && String(cancelRequestedAt).trim() !== ""
    && String(cancelRequestedAt).trim().toLowerCase() !== "null";
  const requested = [
    value.cancelRequested,
    value.cancelled,
    value.canceled,
    value.shouldCancel,
  ].some(truthyCancellation) || hasCancellationTimestamp || new Set(["cancelled", "canceled", "cancelling", "cancel_requested"]).has(status);
  return {
    requested,
    reason: cleanText(value.cancelReason ?? value.cancellationReason ?? value.reason, 1_000),
  };
}

export function normalizeControlPayload(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const cancellation = cancellationState(source);
  return {
    cursor: cleanCursor(source.cursor ?? source.nextCursor ?? source.next_cursor),
    cancelRequested: cancellation.requested,
    cancelReason: cancellation.reason,
    messages: normalizeTaskMessages(source.messages ?? source.webMessages ?? source.items),
  };
}

export class TaskCancelledError extends Error {
  constructor(reason = "网站请求取消了这项任务。") {
    super(cleanText(reason, 1_000) || "网站请求取消了这项任务。");
    this.name = "TaskCancelledError";
    this.code = "TASK_CANCELLED";
  }
}

export { MAX_MESSAGE_LENGTH, MAX_MESSAGES };
