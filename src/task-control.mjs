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

export {
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES,
  cancellationState,
  normalizeControlPayload,
  normalizeTaskMessage,
  normalizeTaskMessages,
  normalizeTaskPriority,
};
