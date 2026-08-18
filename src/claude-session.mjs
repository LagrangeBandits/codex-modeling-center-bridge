import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { environmentPythonPath } from "./modeling-env.mjs";
import { redactForLog } from "./codex-session.mjs";

const DEFAULT_MAX_TURNS = 50;
const CLAUDE_SETTINGS_FILENAME = "claude-settings.json";

const DEFAULT_SETTINGS = {
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: {
      allowedDomains: [],
      strictAllowlist: true,
    },
  },
  permissions: {
    allow: [
      "Read(./**)",
      "Glob",
      "Grep",
      "Edit(./**)",
      "Write(./**)",
      "Bash(python *)",
      "Bash(python3 *)",
      "PowerShell(python *)",
      "PowerShell(python3 *)",
    ],
    deny: [
      "WebFetch",
      "WebSearch",
      "Bash(curl *)",
      "Bash(wget *)",
      "Bash(git *)",
      "PowerShell(Invoke-WebRequest *)",
      "PowerShell(Invoke-RestMethod *)",
      "PowerShell(curl *)",
      "PowerShell(wget *)",
      "PowerShell(git *)",
    ],
  },
};

function claudeExecutable() {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function environmentForClaude(config = {}) {
  const environment = { ...process.env };
  const pythonPath = environmentPythonPath(config);
  const pythonDirectory = path.dirname(pythonPath);
  environment.PATH = `${pythonDirectory}${path.delimiter}${environment.PATH || ""}`;

  // The bridge intentionally uses the user's locally authenticated Claude CLI.
  // API credentials could silently change the billing/authentication path.
  delete environment.ANTHROPIC_API_KEY;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  return environment;
}

function cloneSettings(value) {
  return JSON.parse(JSON.stringify(value));
}

function sessionIdFromEvent(event) {
  return event?.session_id || event?.sessionId || null;
}

function textParts(value) {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (part?.type === "text" && typeof part.text === "string") return [part.text];
    return [];
  });
}

export function parseClaudeEventLine(line) {
  const value = String(line ?? "").trim();
  if (!value) return null;
  return JSON.parse(value);
}

export function claudeEventText(event) {
  if (!event || typeof event !== "object") return "";
  if (event.type === "assistant") return textParts(event.message?.content).join("\n");
  if (event.type === "result") return typeof event.result === "string" ? event.result : "";
  return "";
}

function sanitize(value) {
  if (typeof value === "string") return redactForLog(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

function claudePermissionMode(config) {
  const mode = String(config.claudePermissionMode || "dontAsk");
  if (!new Set(["dontAsk", "bypassPermissions"]).has(mode)) {
    throw new Error("Claude Code 权限模式只能是 dontAsk 或 bypassPermissions。");
  }
  if (mode === "bypassPermissions") {
    console.warn("警告：Claude Code 使用 bypassPermissions；仍要求沙箱可用，但请只在受控设备上启用。\n");
  }
  return mode;
}

async function writeClaudeSettings(taskDirectory) {
  const settingsPath = path.join(taskDirectory, CLAUDE_SETTINGS_FILENAME);
  await fs.writeFile(settingsPath, `${JSON.stringify(cloneSettings(DEFAULT_SETTINGS), null, 2)}\n`, "utf8");
  return settingsPath;
}

function claudeArgs({ taskDirectory, config, previousSession, settingsPath }) {
  const args = [
    "-p",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(config.claudeMaxTurns || DEFAULT_MAX_TURNS),
    "--settings", settingsPath,
    "--setting-sources", "user",
    "--append-system-prompt-file", path.join(taskDirectory, "AGENTS.md"),
    "--tools", "Read,Glob,Grep,Edit,Write,Bash,PowerShell",
    "--permission-mode", claudePermissionMode(config),
  ];
  if (previousSession?.sessionId) args.push("--resume", previousSession.sessionId);
  return args;
}

function markdownFromEvents({ prompt, sessionId, events, finalResponse }) {
  const lines = [
    "# Claude Code 本地任务摘要",
    "",
    `- Agent：Claude Code`,
    `- 本地会话：\`${sessionId || "未返回"}\``,
    `- 生成时间：${new Date().toISOString()}`,
    "",
    "## 用户需求",
    "",
    redactForLog(prompt),
    "",
    "## Agent 回合摘要",
    "",
  ];

  for (const event of events) {
    if (event.type === "assistant") {
      const text = claudeEventText(event);
      if (text) lines.push("### Agent 消息", "", redactForLog(text), "");
      const tools = Array.isArray(event.message?.content)
        ? event.message.content.filter((part) => part?.type === "tool_use").map((part) => part.name).filter(Boolean)
        : [];
      if (tools.length) lines.push(`- 工具调用：${redactForLog(tools.join(", "))}`);
    } else if (event.type === "result") {
      const usage = event.usage;
      if (usage) lines.push(`- 用量记录：输入 ${usage.input_tokens ?? 0}，输出 ${usage.output_tokens ?? 0}`);
      if (event.is_error) lines.push(`- Agent 错误：${redactForLog(event.result || event.subtype || "未知错误")}`);
    }
  }

  if (finalResponse) lines.push("## 最终摘要", "", redactForLog(finalResponse), "");
  return `${lines.join("\n").trim()}\n`;
}

function appendLineParser(buffer, chunk, onLine) {
  const value = `${buffer}${chunk.toString()}`;
  const lines = value.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const line of lines) onLine(line);
  return remainder;
}

function runClaudeProcess({ taskDirectory, prompt, args, config, onEvent }) {
  return new Promise((resolve, reject) => {
    const child = spawn(claudeExecutable(), args, {
      cwd: taskDirectory,
      env: environmentForClaude(config),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let stdoutRemainder = "";
    let stderr = "";
    let callbackChain = Promise.resolve();
    let settled = false;

    const appendEvent = (line) => {
      if (!String(line).trim()) return;
      let event;
      try {
        event = parseClaudeEventLine(line);
      } catch {
        events.push({ type: "bridge.parse_error", raw: redactForLog(line).slice(0, 2_000) });
        return;
      }
      if (!event || typeof event !== "object") return;
      events.push(event);
      if (onEvent) callbackChain = callbackChain.then(() => onEvent(event));
    };

    child.stdout.on("data", (chunk) => {
      stdoutRemainder = appendLineParser(stdoutRemainder, chunk, appendEvent);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-12_000);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动 Claude Code：${redactForLog(error.message)}`));
    });
    child.on("close", async (code, signal) => {
      if (stdoutRemainder.trim()) appendEvent(stdoutRemainder);
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
      resolve({ code: code ?? 1, signal, stderr, events });
    });

    // Ending stdin immediately is required for print mode; waiting for the
    // process to close would deadlock Claude while it waits for the prompt.
    child.stdin.end(prompt);
  });
}

export async function runClaudeTurn({ taskDirectory, prompt, config, previousSession, onEvent }) {
  await fs.mkdir(path.join(taskDirectory, "artifacts"), { recursive: true });
  const settingsPath = await writeClaudeSettings(taskDirectory);
  const result = await runClaudeProcess({
    taskDirectory,
    prompt,
    args: claudeArgs({ taskDirectory, config, previousSession, settingsPath }),
    config,
    onEvent,
  });

  const sessionId = [...result.events].reverse().map(sessionIdFromEvent).find(Boolean) || previousSession?.sessionId || null;
  const resultEvent = [...result.events].reverse().find((event) => event.type === "result");
  const finalResponse = resultEvent?.result || [...result.events].reverse().map(claudeEventText).find(Boolean) || "";
  const failed = result.code !== 0 || result.signal || resultEvent?.is_error || (resultEvent && resultEvent.subtype && resultEvent.subtype !== "success");
  if (failed) {
    const detail = resultEvent?.result || result.stderr.trim() || resultEvent?.subtype || `退出码 ${result.code}`;
    throw new Error(`Claude Code 执行失败：${redactForLog(detail).slice(0, 4_000)}`);
  }
  if (!sessionId) throw new Error("Claude Code 未返回本地会话 ID，无法安全绑定到网站任务。");

  const sanitizedEvents = result.events.map((event) => sanitize(event));
  await fs.writeFile(path.join(taskDirectory, "events.jsonl"), `${sanitizedEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  await fs.writeFile(path.join(taskDirectory, "artifacts", "conversation.md"), markdownFromEvents({ prompt, sessionId, events: result.events, finalResponse }), "utf8");
  await fs.writeFile(path.join(taskDirectory, "session.json"), `${JSON.stringify({ agent: "claude", sessionId, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  return { agent: "claude", sessionId, finalResponse, events: result.events };
}
