import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Codex } from "@openai/codex-sdk";
import { runtimeEnvironment } from "./desktop-runtime.mjs";
import { environmentPythonPath } from "./modeling-env.mjs";
import { extractAgentUsage, extractUsageFromEvent, formatUsage } from "./usage.mjs";

const ROOT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FALLBACK_GUIDANCE = `# 私有 CAD 建模规则

优先使用 Python + CadQuery / OpenCascade 的参数化 B-rep 建模方法，统一使用 mm，并明确坐标系、轴向和左右手性。默认交付 STEP，同时保留可复现脚本和验证报告。生成后检查实体有效性、solids 数量、包围盒和关键尺寸。所有最终文件必须放入当前任务目录的 artifacts/。`;

export async function loadGuidance() {
  try {
    return await fs.readFile(path.join(ROOT_DIRECTORY, "templates", "AGENTS.md"), "utf8");
  } catch {
    return FALLBACK_GUIDANCE;
  }
}

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sanitize(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function eventItem(event) {
  return event?.item && typeof event.item === "object" ? event.item : null;
}

function markdownFromEvents({ prompt, threadId, events, finalResponse }) {
  const lines = [
    "# Codex 本地任务摘要",
    "",
    `- 本地线程：\`${threadId || "未返回"}\``,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 用户需求",
    "",
    redact(prompt),
    "",
    "## Codex 回合摘要",
    "",
  ];

  for (const event of events) {
    const item = eventItem(event);
    if (event.type === "turn.completed") {
      const usage = extractUsageFromEvent("codex", event);
      if (usage) lines.push(`- 用量记录：${formatUsage(usage.usage)}`);
      continue;
    }
    if (!item) continue;
    if (item.type === "agent_message") {
      lines.push("### Agent 消息", "", redact(item.text), "");
    } else if (item.type === "command_execution") {
      lines.push("### 本地命令", "", `\`${redact(item.command)}\``, "");
      if (item.aggregated_output) {
        lines.push("```text", redact(item.aggregated_output).slice(0, 4_000), "```", "");
      }
    } else if (item.type === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes.map((change) => `${change.kind}: ${change.path}`).join(", ") : "";
      lines.push(`- 文件变更：${redact(changes)}`);
    } else if (item.type === "error") {
      lines.push(`- Agent 错误：${redact(item.message)}`);
    }
  }

  if (finalResponse && !lines.includes(redact(finalResponse))) {
    lines.push("## 最终摘要", "", redact(finalResponse), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

function sdkThreadOptions(taskDirectory, config) {
  const options = {
    workingDirectory: taskDirectory,
    skipGitRepoCheck: true,
    sandboxMode: config.executionMode === "plan" ? "read-only" : "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: false,
  };
  if (config.model) options.model = config.model;
  if (config.reasoningEffort) options.modelReasoningEffort = config.reasoningEffort;
  return options;
}

function safeHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeProviderKey(value) {
  const provider = String(value || "").trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(provider) && provider.toLowerCase() !== "unknown" ? provider : null;
}

function sdkOptions(config) {
  const options = { env: sdkEnvironment(config) };
  const baseUrl = safeHttpUrl(config.baseUrl);
  if (baseUrl) options.baseUrl = baseUrl;
  const provider = safeProviderKey(config.modelProvider || config.model_provider || config.provider);
  if (provider) options.config = { model_provider: provider };
  return options;
}

function sdkEnvironment(config) {
  const environment = runtimeEnvironment();
  const pythonPath = environmentPythonPath(config);
  const pythonDirectory = path.dirname(pythonPath);
  environment.PATH = `${pythonDirectory}${path.delimiter}${environment.PATH || ""}`;
  return environment;
}

export async function runCodexTurn({ taskDirectory, prompt, config, previousThreadId, onEvent, signal }) {
  const codex = new Codex(sdkOptions(config));
  const options = sdkThreadOptions(taskDirectory, config);
  const thread = previousThreadId
    ? codex.resumeThread(previousThreadId, options)
    : codex.startThread(options);
  const events = [];
  const stream = await thread.runStreamed(prompt, { signal });

  for await (const event of stream.events) {
    events.push(event);
    if (onEvent) await onEvent(event, thread);
  }

  const finalResponse = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .pop() || "";
  const threadId = thread.id || previousThreadId || null;
  const usageResult = extractAgentUsage("codex", events);
  if (usageResult.reason) console.warn(`Codex 用量未知：${usageResult.reason}`);
  await fs.mkdir(path.join(taskDirectory, "artifacts"), { recursive: true });
  const sanitizedEvents = events.map((event) => sanitize(event));
  await fs.writeFile(path.join(taskDirectory, "events.jsonl"), `${sanitizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await fs.writeFile(path.join(taskDirectory, "artifacts", "conversation.md"), markdownFromEvents({ prompt, threadId, events, finalResponse }), "utf8");
  await fs.writeFile(path.join(taskDirectory, "session.json"), `${JSON.stringify({ agent: "codex", threadId, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { threadId, finalResponse, events, usage: usageResult.usage };
}

export async function prepareTaskDirectory(taskDirectory, task) {
  await fs.mkdir(path.join(taskDirectory, "artifacts"), { recursive: true });
  const guidance = await loadGuidance();
  await fs.writeFile(path.join(taskDirectory, "REQUEST.md"), `# CAD 建模任务\n\n${task.prompt}\n`, "utf8");
  await fs.writeFile(path.join(taskDirectory, "AGENTS.md"), guidance, "utf8");
}

export async function loadSession(taskDirectory) {
  try {
    const session = JSON.parse(await fs.readFile(path.join(taskDirectory, "session.json"), "utf8"));
    if (session.agent === "claude") return typeof session.sessionId === "string" ? session : null;
    return typeof session.threadId === "string" ? { agent: "codex", ...session } : null;
  } catch {
    return null;
  }
}

export function redactForLog(value) {
  return redact(value);
}
