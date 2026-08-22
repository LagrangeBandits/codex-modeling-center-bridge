import fs from "node:fs/promises";
import path from "node:path";
import { AGENT_ID_PATTERN, agentLabel, normalizeAgent } from "./constants.mjs";
import { resolveCommand, runtimeEnvironment } from "./desktop-runtime.mjs";
import { spawnCommand } from "./process.mjs";
import { extractAgentUsage, extractUsageFromEvent, formatUsage } from "./usage.mjs";

const MAX_OUTPUT = 12_000;
const MAX_EVENT_TEXT = 8_000;
const CAPABILITY_STATES = new Set(["supported", "unsupported", "unknown"]);
const DEFAULT_CAPABILITIES = Object.freeze({
  direct: "supported",
  plan: "unknown",
  streaming: "unknown",
  usage: "unknown",
  providerModel: "unknown",
  cancel: "supported",
  resume: "unsupported",
});

/**
 * Built-in profiles cover CLIs that expose a non-interactive/headless mode.
 * Commands are passed as separate values. Windows npm shims are the only
 * exception: Node requires a shell to execute trusted .cmd/.bat entrypoints.
 * Unknown tools can be added with config.cliAgents.
 */
export const BUILTIN_CLI_AGENTS = Object.freeze([
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    adapter: "codex",
    capabilities: { direct: "supported", plan: "supported", streaming: "supported", usage: "supported", providerModel: "supported", cancel: "supported", resume: "supported" },
  },
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    adapter: "claude",
    capabilities: { direct: "supported", plan: "supported", streaming: "supported", usage: "supported", providerModel: "supported", cancel: "supported", resume: "supported" },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    directArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--approval-mode", "yolo"],
    outputFormat: "jsonl",
    supportsPlan: false,
    modelArgs: ["--model", "{model}"],
    provider: "google",
    capabilities: { direct: "supported", plan: "unsupported", streaming: "supported", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unsupported" },
  },
  {
    id: "qwen",
    label: "Qwen Code",
    command: "qwen",
    directArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--approval-mode", "yolo"],
    planArgs: ["-p", "{prompt}", "--output-format", "stream-json", "--approval-mode", "plan"],
    outputFormat: "jsonl",
    modelArgs: ["--model", "{model}"],
    provider: "qwen",
    capabilities: { direct: "supported", plan: "supported", streaming: "supported", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unknown" },
  },
  {
    id: "trae",
    label: "Trae Agent CLI",
    command: "trae-cli",
    directArgs: ["run", "{prompt}", "--working-dir", "{cwd}"],
    outputFormat: "text",
    modelArgs: ["--model", "{model}"],
    providerArgs: ["--provider", "{provider}"],
    capabilities: { direct: "supported", plan: "unsupported", streaming: "unknown", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unsupported" },
  },
  {
    id: "opencode",
    label: "OpenCode",
    commands: ["opencode2", "opencode"],
    directArgs: ["run", "{prompt}", "--format", "json"],
    outputFormat: "json",
    modelArgs: ["--model", "{model}"],
    capabilities: { direct: "supported", plan: "unsupported", streaming: "unknown", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unknown" },
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    command: "copilot",
    directArgs: ["-p", "{prompt}", "--output-format", "json", "--allow-all-tools"],
    planArgs: ["-p", "{prompt}", "--output-format", "json", "--plan"],
    outputFormat: "json",
    requiresAutoApproval: true,
    capabilities: { direct: "supported", plan: "supported", streaming: "unknown", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unsupported" },
  },
  {
    id: "aider",
    label: "Aider",
    command: "aider",
    directArgs: ["--message", "{prompt}", "--yes-always", "--no-auto-commits"],
    outputFormat: "text",
    capabilities: { direct: "supported", plan: "unsupported", streaming: "unknown", usage: "unknown", providerModel: "unknown", cancel: "supported", resume: "unsupported" },
  },
]);

function cleanString(value, limit = 160) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
  return text || null;
}
function cleanArray(value, fallback = []) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value.map((item) => item.slice(0, 2_000))
    : fallback;
}

function capabilityState(value, fallback = "unknown") {
  if (value === true) return "supported";
  if (value === false) return "unsupported";
  const state = String(value ?? "").trim().toLowerCase();
  return CAPABILITY_STATES.has(state) ? state : fallback;
}

function normalizeCapabilities(source) {
  const value = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  return Object.fromEntries(Object.entries(DEFAULT_CAPABILITIES).map(([key, fallback]) => [key, capabilityState(value[key], fallback)]));
}

function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|ghp|github_pat)-[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function sanitize(value) {
  if (typeof value === "string") return redact(value).slice(0, MAX_EVENT_TEXT);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function normalizeProfile(source, sourceType = "custom") {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const rawId = String(source.id || "").trim().toLowerCase();
  if (!AGENT_ID_PATTERN.test(rawId) || ["any", "auto"].includes(rawId)) return null;
  const id = normalizeAgent(rawId);
  const commandList = cleanArray(source.commands, source.command ? [String(source.command)] : []);
  const command = cleanString(commandList[0], 240);
  if (!commandList.length || !command) return null;
  const profile = {
    id,
    label: cleanString(source.label, 80) || agentLabel(id),
    commands: commandList.map((item) => item.trim()).filter(Boolean).slice(0, 8),
    adapter: source.adapter === "codex" || source.adapter === "claude" ? source.adapter : "cli",
    source: sourceType,
    versionArgs: cleanArray(source.versionArgs, ["--version"]).slice(0, 16),
    directArgs: cleanArray(source.directArgs, source.args ? cleanArray(source.args) : ["{prompt}"]).slice(0, 64),
    planArgs: Array.isArray(source.planArgs) ? cleanArray(source.planArgs).slice(0, 64) : null,
    resumeArgs: Array.isArray(source.resumeArgs) ? cleanArray(source.resumeArgs).slice(0, 32) : null,
    outputFormat: ["text", "json", "jsonl"].includes(source.outputFormat) ? source.outputFormat : "text",
    modelArgs: cleanArray(source.modelArgs),
    providerArgs: cleanArray(source.providerArgs),
    provider: cleanString(source.provider, 80),
    supportsPlan: Array.isArray(source.planArgs) && source.planArgs.length > 0,
    requiresAutoApproval: Boolean(source.requiresAutoApproval),
    capabilities: normalizeCapabilities(source.capabilities),
  };
  if (profile.adapter === "codex" || profile.adapter === "claude") profile.capabilities = normalizeCapabilities({ ...profile.capabilities, direct: "supported", plan: "supported", streaming: "supported", usage: "supported", providerModel: "supported", resume: "supported" });
  if (profile.planArgs?.length && profile.capabilities.plan === "unknown") profile.capabilities.plan = "supported";
  return profile;
}

export function agentProfiles(config = {}) {
  const merged = new Map();
  for (const profile of BUILTIN_CLI_AGENTS) merged.set(profile.id, normalizeProfile(profile, "built-in"));
  for (const profile of Array.isArray(config.cliAgents) ? config.cliAgents : []) {
    const normalized = normalizeProfile(profile, "custom");
    if (normalized) merged.set(normalized.id, normalized);
  }
  return [...merged.values()].filter(Boolean);
}

export function cliProfileForAgent(agent, config = {}) {
  const selected = normalizeAgent(agent);
  return agentProfiles(config).find((profile) => profile.id === selected) || null;
}

async function resolveProfile(profile) {
  for (const command of profile.commands) {
    const found = await resolveCommand(command, profile.versionArgs, { timeout: 8_000 });
    if (found) return { ...found, command };
  }
  return null;
}

export async function discoverAgents(config = {}) {
  return Promise.all(agentProfiles(config).map(async (profile) => {
    const found = await resolveProfile(profile);
    return {
      id: profile.id,
      label: profile.label,
      installed: Boolean(found),
      version: found?.version || null,
      binary: found?.binary || null,
      command: found?.command || profile.commands[0],
      source: profile.source,
      adapter: profile.adapter,
      supportsDirect: profile.capabilities.direct === "supported" || Boolean(profile.directArgs?.length),
      supportsPlan: profile.capabilities.plan === "supported" || Boolean(profile.supportsPlan),
      requiresAutoApproval: profile.requiresAutoApproval,
      capabilities: { ...profile.capabilities },
    };
  }));
}

export function capabilitiesForAgent(agent, config = {}) {
  const profile = cliProfileForAgent(agent, config);
  const capabilities = profile?.capabilities || DEFAULT_CAPABILITIES;
  const selected = profile?.id || String(agent || "unknown").trim().toLowerCase() || "unknown";
  const wire = selected === "claude" ? "claude-code" : selected;
  const tags = [`agent:${wire}`];
  const tagsFor = (name, tag = name) => {
    if (capabilities[name] === "supported") tags.push(tag);
    else if (capabilities[name] === "unknown") tags.push(`${tag}:unknown`);
  };
  tagsFor("direct", "task:direct");
  tagsFor("plan", "task:plan");
  tagsFor("cancel", "task:cancel");
  tagsFor("usage", "telemetry:usage");
  tagsFor("providerModel", "telemetry:provider-model");
  tagsFor("resume", "task:resume");
  tags.push("task:pause", "task:checkpoint", "task:priority", "bridge:messages");
  return [...new Set(tags)];
}

export function profileCapabilities(agent, config = {}) {
  const profile = cliProfileForAgent(agent, config);
  return profile ? { ...profile.capabilities } : { ...DEFAULT_CAPABILITIES };
}

function placeholder(value, context) {
  return String(value)
    .replaceAll("{prompt}", context.prompt)
    .replaceAll("{cwd}", context.cwd)
    .replaceAll("{taskDir}", context.cwd)
    .replaceAll("{workspace}", context.cwd)
    .replaceAll("{session}", context.session || "")
    .replaceAll("{model}", context.model || "")
    .replaceAll("{provider}", context.provider || "");
}

function appendPair(args, pair, context) {
  if (!Array.isArray(pair) || pair.length === 0) return args;
  return [...args, ...pair.map((value) => placeholder(value, context))];
}

export function buildCliArgs(profile, { prompt, cwd, config = {}, previousSession = null, executionMode = "direct" }) {
  const template = executionMode === "plan" ? profile.planArgs : profile.directArgs;
  if (!Array.isArray(template) || !template.length) {
    throw new Error(`${profile.label} 没有声明可验证的${executionMode === "plan" ? "只读规划" : "直接执行"}模式。`);
  }
  const context = {
    prompt: String(prompt ?? ""),
    cwd,
    session: previousSession?.sessionId || previousSession?.threadId || "",
    model: cleanString(config.model, 160) || "",
    provider: cleanString(config.provider || config.modelProvider, 80) || "",
  };
  let args = template.map((value) => placeholder(value, context));
  if (context.model && profile.modelArgs?.length && !args.includes(context.model)) args = appendPair(args, profile.modelArgs, context);
  if (context.provider && profile.providerArgs?.length && !args.includes(context.provider)) args = appendPair(args, profile.providerArgs, context);
  if (previousSession && profile.capabilities.resume === "supported" && profile.resumeArgs?.length) args = appendPair(args, profile.resumeArgs, context);
  return args;
}

function textParts(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => textParts(item));
  if (!value || typeof value !== "object") return [];
  if (value.type === "text" && typeof value.text === "string") return [value.text];
  return textParts(value.content ?? value.message ?? value.output ?? value.result ?? value.response ?? value.text);
}

export function cliEventText(event) {
  if (!event || typeof event !== "object") return "";
  return textParts(event.response ?? event.result ?? event.message ?? event.output ?? event.content ?? event.text).join("\n").trim();
}

function sessionIdFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  return cleanString(event.session_id || event.sessionId || event.session?.id || event.conversation_id, 200);
}

function parseLine(line) {
  const raw = String(line ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((item) => item && typeof item === "object");
    return parsed && typeof parsed === "object" ? parsed : { type: "cli.output", text: raw };
  } catch {
    return { type: "cli.output", text: raw.slice(0, MAX_EVENT_TEXT) };
  }
}

function appendLineParser(buffer, chunk, onEvent) {
  const value = `${buffer}${chunk.toString()}`;
  const lines = value.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const line of lines) {
    const parsed = parseLine(line);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of values) if (event) onEvent(event);
  }
  return remainder;
}

function environmentForCli(config = {}) {
  const environment = runtimeEnvironment();
  const modelingEnvironment = typeof config.modelingEnvironment === "string" ? config.modelingEnvironment.trim() : "";
  if (modelingEnvironment) {
    const bin = process.platform === "win32" ? path.join(modelingEnvironment, "Scripts") : path.join(modelingEnvironment, "bin");
    environment.PATH = `${bin}${path.delimiter}${environment.PATH || ""}`;
  }
  return environment;
}

function runCliProcess({ binary, args, cwd, config, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(binary, args, {
      cwd,
      env: environmentForCli(config),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const events = [];
    let stdoutRemainder = "";
    let stderr = "";
    let callbackChain = Promise.resolve();
    let settled = false;
    let cancellationError = null;
    const abort = () => {
      cancellationError = signal?.reason instanceof Error ? signal.reason : new Error("本地 CLI 回合已取消。");
      child.kill();
    };
    const appendEvent = (event) => {
      if (!event || typeof event !== "object") return;
      events.push(event);
      if (onEvent) {
        callbackChain = callbackChain.then(() => onEvent(event)).catch((error) => {
          if (!settled) child.kill();
          throw error;
        });
      }
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutRemainder = appendLineParser(stdoutRemainder, chunk, appendEvent);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-MAX_OUTPUT);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(cancellationError || new Error(`无法启动本地 CLI：${redact(error.message)}`));
    });
    child.on("close", async (code, childSignal) => {
      if (stdoutRemainder.trim()) {
        const parsed = parseLine(stdoutRemainder);
        const values = Array.isArray(parsed) ? parsed : [parsed];
        for (const event of values) appendEvent(event);
      }
      signal?.removeEventListener?.("abort", abort);
      if (cancellationError) {
        await callbackChain.catch(() => {});
        if (!settled) {
          settled = true;
          reject(cancellationError);
        }
        return;
      }
      try {
        await callbackChain;
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
        return;
      }
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, signal: childSignal, stderr, events });
    });
  });
}

function markdownFromEvents({ profile, prompt, sessionId, events, finalResponse }) {
  const lines = [
    `# ${profile.label} 本地任务摘要`,
    "",
    `- Agent：${profile.label}`,
    `- 本地会话：\`${sessionId || "未返回"}\``,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 用户需求",
    "",
    redact(prompt),
    "",
    "## Agent 回合摘要",
    "",
  ];
  for (const event of events) {
    const text = cliEventText(event);
    if (text) lines.push("### Agent 消息", "", redact(text).slice(0, 4_000), "");
    const tools = event.tool_use || event.toolUse || event.tool_calls || event.toolCalls;
    if (Array.isArray(tools) && tools.length) lines.push(`- 工具调用：${redact(tools.map((tool) => tool?.name || tool).join(", "))}`);
    const usage = extractUsageFromEvent(profile.id, event);
    if (usage) lines.push(`- 用量记录：${formatUsage(usage.usage)}`);
  }
  if (finalResponse) lines.push("## 最终摘要", "", redact(finalResponse), "");
  return `${lines.join("\n").trim()}\n`;
}

export async function runCliTurn({ agent, taskDirectory, prompt, config = {}, previousSession = null, onEvent, signal }) {
  const profile = cliProfileForAgent(agent, config);
  if (!profile || profile.adapter !== "cli") throw new Error(`未找到 ${agentLabel(agent)} 的 CLI 适配配置。`);
  const resolved = await resolveProfile(profile);
  if (!resolved) throw new Error(`未发现 ${profile.label}（${profile.commands.join(" / ")}）。请先安装并完成本机登录。`);
  const args = buildCliArgs(profile, {
    prompt,
    cwd: taskDirectory,
    config,
    previousSession,
    executionMode: config.executionMode || "direct",
  });
  const result = await runCliProcess({
    binary: resolved.binary,
    args,
    cwd: taskDirectory,
    config,
    onEvent,
    signal,
  });
  const sessionId = [...result.events].reverse().map(sessionIdFromEvent).find(Boolean) || previousSession?.sessionId || previousSession?.threadId || null;
  const finalResponse = [...result.events].reverse()
    .map(cliEventText)
    .find((value) => value) || "";
  const usageResult = extractAgentUsage(profile.id, result.events);
  if (usageResult.reason) console.warn(`${profile.label} 用量未知：${usageResult.reason}`);
  const failed = result.code !== 0 || result.signal;
  if (failed) {
    const detail = result.stderr.trim() || finalResponse || `退出码 ${result.code}`;
    const error = new Error(`${profile.label} 执行失败：${redact(detail).slice(0, 4_000)}`);
    error.usage = usageResult.usage;
    throw error;
  }
  await fs.mkdir(path.join(taskDirectory, "artifacts"), { recursive: true });
  const sanitizedEvents = result.events.map((event) => sanitize(event));
  await fs.writeFile(path.join(taskDirectory, "events.jsonl"), `${sanitizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await fs.writeFile(path.join(taskDirectory, "artifacts", "conversation.md"), markdownFromEvents({ profile, prompt, sessionId, events: result.events, finalResponse }), "utf8");
  await fs.writeFile(path.join(taskDirectory, "session.json"), `${JSON.stringify({ agent: profile.id, sessionId, attemptId: config.attemptId || null, command: resolved.command, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { agent: profile.id, sessionId, finalResponse, events: result.events, usage: usageResult.usage };
}
