import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentLabel, BRIDGE_VERSION, defaultTaskDirectory, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, isSafeTaskId, normalizeAgent, normalizeExecutionMode, platformId, platformLabel, resolveTaskAgent } from "./constants.mjs";
import { collectArtifacts, hasCadArtifact } from "./artifacts.mjs";
import { runAgentTurn, sessionReference } from "./agent-session.mjs";
import { identityFromEvent, identityFromEvents, loadLocalAgentIdentity } from "./agent-identity.mjs";
import { loadSession, prepareTaskDirectory, redactForLog } from "./codex-session.mjs";
import { loadConfig } from "./state.mjs";
import { cancelTask, completeTask, pollTask, pollTaskControl, reportTaskUsage, sendEvent, sendHeartbeat, sendTaskMessage, uploadArtifact } from "./site-client.mjs";
import { sleep } from "./process.mjs";
import { extractUsageFromEvent, usagePayload } from "./usage.mjs";
import { collectSystemMetrics, heartbeatPayload } from "./heartbeat.mjs";
import { cancellationState, normalizeControlPayload, normalizeTaskMessages, normalizeTaskPriority, TaskCancelledError, taskMessagesFromTask, taskPromptWithMessages } from "./task-control.mjs";
import { normalizeTask as normalizeModelingTask } from "./vendor/modeling-platform-contracts/2f61b5e/contracts.mjs";

const CONTROL_POLL_INTERVAL_MS = 1_500;

async function report(config, taskId, stage, progress, message, telemetry = undefined, context = undefined) {
  try {
    await sendEvent(config, taskId, stage, progress, message, telemetry, context);
  } catch (error) {
    console.error(`进度回传失败：${redactForLog(error.message)}`);
  }
}

class TaskControlChannel {
  constructor(config, taskId) {
    this.config = config;
    this.taskId = taskId;
    this.cursor = null;
    this.messages = [];
    this.unsupported = false;
    this.inFlight = null;
    this.lastPollAt = 0;
    this.lastWarningAt = 0;
    this.timer = null;
    this.cancellationError = null;
    this.abortController = new AbortController();
  }

  get signal() {
    return this.abortController.signal;
  }

  start() {
    if (this.timer || this.unsupported) return;
    this.timer = setInterval(() => {
      void this.poll(true);
    }, CONTROL_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  requestCancellation(reason) {
    if (this.cancellationError) return;
    this.cancellationError = new TaskCancelledError(reason);
    this.abortController.abort(this.cancellationError);
  }

  async poll(force = false) {
    if (this.unsupported || this.cancellationError) return null;
    const now = Date.now();
    if (!force && now - this.lastPollAt < CONTROL_POLL_INTERVAL_MS) return null;
    if (this.inFlight) return this.inFlight;
    this.lastPollAt = now;
    this.inFlight = pollTaskControl(this.config, this.taskId, this.cursor)
      .then((payload) => {
        const control = normalizeControlPayload(payload);
        if (control.cursor) this.cursor = control.cursor;
        if (control.messages.length) {
          this.messages = normalizeTaskMessages([...this.messages, ...control.messages]);
        }
        if (control.cancelRequested) this.requestCancellation(control.cancelReason);
        return control;
      })
      .catch((error) => {
        if (error?.status === 404 || error?.status === 405) {
          this.unsupported = true;
          return null;
        }
        if (now - this.lastWarningAt >= 15_000) {
          this.lastWarningAt = now;
          console.warn(`任务控制消息回传失败（不影响当前任务）：${redactForLog(error?.message || error)}\n`);
        }
        return null;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async check(force = false) {
    await this.poll(force);
    if (this.cancellationError) throw this.cancellationError;
  }

  async publishAssistantMessage(message) {
    if (this.unsupported) return false;
    try {
      await sendTaskMessage(this.config, this.taskId, message, { cursor: this.cursor });
      return true;
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        this.unsupported = true;
        return false;
      }
      console.warn(`网页消息回传失败（不影响任务完成）：${redactForLog(error?.message || error)}\n`);
      return false;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }
}

function firstPreferenceValue(task, preference, keys) {
  for (const key of keys) {
    const value = task?.[key] ?? preference?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 160);
  }
  return null;
}

export function resolveTaskPreferences(task) {
  const rawPreference = task?.modelPreference ?? task?.model_preference ?? task?.modelPreferences;
  const preference = rawPreference && typeof rawPreference === "object" && !Array.isArray(rawPreference)
    ? rawPreference
    : {};
  const resolved = {};
  const model = firstPreferenceValue(task, preference, ["model", "modelName", "model_name"]);
  const provider = firstPreferenceValue(task, preference, ["provider", "modelProvider", "model_provider"]);
  const reasoningEffort = firstPreferenceValue(task, preference, ["reasoningEffort", "reasoning_effort"]);
  const baseUrl = firstPreferenceValue(task, preference, ["baseUrl", "base_url", "apiBaseUrl", "api_base_url"]);
  if (model) resolved.model = model;
  else if (typeof rawPreference === "string" && rawPreference.trim() && rawPreference.trim().toLowerCase() !== "auto") {
    resolved.model = rawPreference.trim().slice(0, 160);
  }
  if (provider) resolved.provider = provider;
  if (reasoningEffort) resolved.reasoningEffort = reasoningEffort;
  if (baseUrl) resolved.baseUrl = baseUrl;
  return resolved;
}

async function runTaskInternal(config, task, execution) {
  task = normalizeModelingTask(task);
  if (!isSafeTaskId(task?.id)) throw new Error("网站返回了不安全的任务 ID，已拒绝写入本地工作区。");
  const selectedAgent = resolveTaskAgent(task?.agent, config.agent);
  const executionMode = normalizeExecutionMode(task?.executionMode ?? task?.execution_mode);
  if (task?.agent && task.agent !== "any" && selectedAgent !== config.agent) {
    throw new Error(`任务要求使用 ${agentLabel(selectedAgent)}，但本机已配对为 ${agentLabel(config.agent)}。请让网站把任务分配给匹配的设备，或重新配对。`);
  }
  const taskConfig = { ...config, ...resolveTaskPreferences(task), agent: selectedAgent, executionMode };
  const selectedAgentLabel = agentLabel(selectedAgent);
  const priority = normalizeTaskPriority(task?.priority);
  const taskContext = { priority, executionMode };
  const control = new TaskControlChannel(config, task.id);
  execution.control = control;
  control.start();
  const initialCancellation = cancellationState(task);
  if (initialCancellation.requested) control.requestCancellation(initialCancellation.reason);
  await control.check(true);
  const taskPrompt = taskPromptWithMessages(task.prompt, [...taskMessagesFromTask(task), ...control.messages]);
  const initialIdentity = await loadLocalAgentIdentity(selectedAgent, taskConfig);
  const telemetry = {
    provider: initialIdentity.provider,
    model: initialIdentity.model,
    usage: null,
  };
  execution.telemetry = telemetry;
  execution.onTelemetry?.(telemetry);
  const taskDirectory = defaultTaskDirectory(config.workspace, task.id);
  await prepareTaskDirectory(taskDirectory, { ...task, prompt: taskPrompt });
  const previousSession = await loadSession(taskDirectory);
  if (previousSession?.agent && previousSession.agent !== selectedAgent) {
    throw new Error(`该任务已有 ${agentLabel(previousSession.agent)} 本地会话，不能改用 ${selectedAgentLabel} 继续；请使用原 Agent 或建立新任务。`);
  }
  let lastEventAt = 0;

  await report(config, task.id, "planning", 16, executionMode === "plan"
    ? `${selectedAgentLabel} 正在整理建模方案，不会运行 CAD 或上传模型文件。`
    : `${selectedAgentLabel} 正在解析尺寸、方向和交付约束。`, telemetry, taskContext);
  if (executionMode === "direct") {
    await report(config, task.id, "modeling", 30, `${selectedAgentLabel} 正在本地生成参数化 CAD。`, telemetry, taskContext);
  }

  const result = await runAgentTurn({
    agent: selectedAgent,
    taskDirectory,
    prompt: [
      "你正在执行私有 CAD 建模任务。",
      executionMode === "plan"
        ? "当前是方案规划模式：只输出可执行的建模方案、参数假设、坐标系、建模步骤、验证计划和交付格式。不要运行任何命令、Python、CadQuery 或 CAD 工具，不要创建或修改 CAD 文件，不要上传文件。"
      : "不要等待用户追问；对低风险缺失参数做明确工程假设并写入验证报告。",
      executionMode === "plan"
        ? "可以直接以最终文本回答；不要把方案伪装成已生成的模型。"
        : "严格在当前任务目录工作，最终文件放进 artifacts/。",
      "\n用户需求：",
      taskPrompt,
    ].join("\n"),
    config: taskConfig,
    previousSession,
    initialIdentity,
    signal: control.signal,
    onEvent: async (event) => {
      await control.check();
      const eventIdentity = identityFromEvent(event, { ...telemetry, agent: selectedAgent });
      if (eventIdentity.provider && eventIdentity.provider !== "unknown") telemetry.provider = eventIdentity.provider;
      if (eventIdentity.model) telemetry.model = eventIdentity.model;
      execution.onTelemetry?.(telemetry);
      const eventUsage = extractUsageFromEvent(selectedAgent, event);
      if (eventUsage) {
        telemetry.usage = usagePayload(eventUsage.usage);
        execution.onTelemetry?.(telemetry);
        await report(config, task.id, "validating", 72, `${selectedAgentLabel} 回合完成，正在整理用量和任务结果。`, telemetry, taskContext);
        return;
      }
      const now = Date.now();
      if (now - lastEventAt < 2_500 && event.type !== "turn.failed") return;
      lastEventAt = now;
      if (event.type === "item.started" || event.type === "item.updated") {
        const item = event.item;
        if (item?.type === "command_execution") {
          await report(config, task.id, "modeling", 46, `${selectedAgentLabel} 正在本地执行建模命令：${redactForLog(String(item.command)).slice(0, 220)}`, telemetry, taskContext);
        } else if (item?.type === "file_change") {
          await report(config, task.id, "modeling", 58, `${selectedAgentLabel} 正在写入参数化脚本和验证文件。`, telemetry, taskContext);
        }
      }
      if (event.type === "assistant") {
        const tools = Array.isArray(event.message?.content)
          ? event.message.content.filter((part) => part?.type === "tool_use").map((part) => part.name).filter(Boolean)
          : [];
        if (tools.length) await report(config, task.id, "modeling", 58, `${selectedAgentLabel} 正在使用本地工具：${tools.join(", ")}`, telemetry, taskContext);
      }
      if (!new Set(["codex", "claude"]).has(selectedAgent)) {
        const type = String(event.type || "").toLowerCase();
        if (["tool_use", "tool_call", "tool_result", "command", "cli.output", "message", "assistant"].includes(type)) {
          await report(config, task.id, "modeling", type.includes("tool") || type === "command" ? 58 : 52, `${selectedAgentLabel} 正在通过本地 CLI 执行建模步骤。`, telemetry, taskContext);
        }
      }
    },
  });

  await control.check(true);

  if (result.provider && result.provider !== "unknown") telemetry.provider = result.provider;
  telemetry.model = result.model || telemetry.model;
  telemetry.usage = usagePayload(result.usage ?? telemetry.usage);
  execution.onTelemetry?.(telemetry);

  const summary = String(result.finalResponse || (executionMode === "plan"
    ? `${selectedAgentLabel} 已完成建模方案。`
    : `${selectedAgentLabel} 已完成建模、验证并生成交付文件。`)).slice(0, 6_000);
  const safeSummary = redactForLog(summary);
  if (executionMode === "plan") {
    await report(config, task.id, "planning", 92, `${selectedAgentLabel} 已生成建模方案，等待网站确认后再执行。`, telemetry, taskContext);
    await control.publishAssistantMessage(safeSummary);
    await completeTask(config, task.id, "planned", safeSummary, "", telemetry, taskContext);
    console.log(`任务已规划：${task.id} · ${selectedAgentLabel} 本地会话 ${sessionReference(result) || "未返回"}`);
    return;
  }

  await control.check(true);
  const artifacts = await collectArtifacts(taskDirectory);
  if (!hasCadArtifact(artifacts)) throw new Error("没有发现 STEP、STL 或其他 CAD 输出文件。");

  await report(config, task.id, "delivering", 88, `发现 ${artifacts.length} 个交付文件，正在上传到私有对象存储。`, telemetry, taskContext);
  for (const file of artifacts) {
    await control.check(true);
    await uploadArtifact(config, task.id, path.basename(file), await fs.readFile(file), task.maxArtifactBytes);
  }
  await control.check(true);
  await completeTask(config, task.id, "completed", safeSummary, "", telemetry, taskContext);
  console.log(`任务完成：${task.id} · ${selectedAgentLabel} 本地会话 ${sessionReference(result) || "未返回"}`);
}

async function runTask(config, task, onTelemetry = undefined) {
  const execution = { telemetry: null, onTelemetry };
  try {
    await runTaskInternal(config, task, execution);
  } catch (error) {
    if (execution.control?.cancellationError && error?.code !== "TASK_CANCELLED") error = execution.control.cancellationError;
    if (error && typeof error === "object") {
      if (execution.telemetry && error.usage !== undefined) {
        execution.telemetry.usage = usagePayload(error.usage);
      }
      error.telemetry = execution.telemetry;
    }
    throw error;
  } finally {
    await execution.control?.stop();
  }
}

async function runOne(config, task, onTelemetry = undefined) {
  try {
    await runTask(config, task, onTelemetry);
  } catch (error) {
    const message = redactForLog(error instanceof Error ? error.message : String(error));
    console.error(`任务失败 ${task.id}：${message}`);
    if (error?.code === "TASK_CANCELLED") {
      try {
        await cancelTask(config, task.id, message, error?.telemetry ?? null, {
          priority: normalizeTaskPriority(task?.priority),
          executionMode: task?.executionMode ?? task?.execution_mode,
        });
      } catch (reportError) {
        console.error(`取消状态回传失败：${redactForLog(reportError.message)}`);
      }
      return;
    }
    try {
      await completeTask(config, task.id, "failed", "", message, error?.telemetry ?? null, {
        priority: normalizeTaskPriority(task?.priority),
        executionMode: task?.executionMode ?? task?.execution_mode,
      });
    } catch (reportError) {
      console.error(`失败状态回传失败：${redactForLog(reportError.message)}`);
    }
  }
}

export async function startRunner(options = {}) {
  const savedConfig = await loadConfig();
  const config = {
    ...savedConfig,
    ...options,
    agent: normalizeAgent(options.agent || savedConfig.agent),
  };
  if (!config.site || !config.runnerId) {
    throw new Error("还没有配对站点。先运行 pair 或 onboard 完成配对。");
  }
  if (config.agent === "codex" && process.env.OPENAI_API_KEY) {
    console.warn("检测到 OPENAI_API_KEY。若要使用本机 ChatGPT/Codex 登录额度，请先在当前终端取消它。");
  }
  await fs.mkdir(config.workspace, { recursive: true });
  const requestedConcurrency = Number(options.concurrency || 1);
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(8, requestedConcurrency))
    : 1;
  const active = new Set();
  const runnerIdentity = await loadLocalAgentIdentity(config.agent, config);
  const requestedHeartbeatInterval = Number(options.heartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS);
  const heartbeatIntervalMs = Number.isFinite(requestedHeartbeatInterval)
    ? Math.max(5_000, requestedHeartbeatInterval)
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatState = {
    lastSentAt: 0,
    inFlight: false,
    pending: false,
    unsupported: false,
    previousCpuSnapshot: null,
  };
  let lastPollWarningAt = 0;
  const absorbTelemetry = (telemetry) => {
    if (!telemetry) return;
    if (typeof telemetry.provider === "string" && telemetry.provider.trim() && telemetry.provider !== "unknown") {
      runnerIdentity.provider = telemetry.provider.trim().slice(0, 80);
    }
    if (typeof telemetry.model === "string" && telemetry.model.trim()) {
      runnerIdentity.model = telemetry.model.trim().slice(0, 160);
    }
  };
  const triggerHeartbeat = (force = false) => {
    if (heartbeatState.unsupported) return;
    const now = Date.now();
    if (heartbeatState.inFlight) {
      if (force) heartbeatState.pending = true;
      return;
    }
    if (!force && now - heartbeatState.lastSentAt < heartbeatIntervalMs) return;
    heartbeatState.lastSentAt = now;
    heartbeatState.inFlight = true;
    const metrics = collectSystemMetrics(heartbeatState.previousCpuSnapshot);
    heartbeatState.previousCpuSnapshot = metrics.cpuSnapshot;
    const payload = heartbeatPayload({
      runnerId: config.runnerId,
      platform: config.platform || platformId(),
      agent: config.agent,
      provider: runnerIdentity.provider,
      model: runnerIdentity.model,
      softwareVersion: BRIDGE_VERSION,
      activeTasks: active.size,
      capacity: concurrency,
      metrics,
    });
    Promise.resolve(sendHeartbeat(config, payload))
      .catch((error) => {
        if (error?.status === 404 || error?.status === 405) {
          heartbeatState.unsupported = true;
          console.warn("站点未提供可选 Runner 心跳接口；继续使用旧版轮询协议。\n");
          return;
        }
        console.warn(`Runner 心跳回传失败（不影响任务轮询）：${redactForLog(error?.message || error)}\n`);
      })
      .finally(() => {
        heartbeatState.inFlight = false;
        if (heartbeatState.pending && !heartbeatState.unsupported) {
          heartbeatState.pending = false;
          triggerHeartbeat(true);
        }
      });
  };
  console.log(`Runner 已启动：${config.name || `${os.hostname()} · ${platformLabel(config.platform)}`}`);
  console.log(`本机 Agent：${agentLabel(config.agent)}`);
  console.log(`任务工作区：${config.workspace}`);
  console.log(`并发槽位：${concurrency}（每台设备默认一次处理一个任务）`);
  console.log("等待私有任务；按 Ctrl+C 停止。\n");
  triggerHeartbeat(true);

  while (true) {
    triggerHeartbeat();
    while (active.size < concurrency) {
      let payload;
      try {
        payload = await pollTask(config);
      } catch (error) {
        const now = Date.now();
        if (now - lastPollWarningAt >= 15_000) {
          lastPollWarningAt = now;
          console.warn(`任务轮询失败（将自动重试，不影响已运行任务）：${redactForLog(error?.message || error)}\n`);
        }
        break;
      }
      if (!payload?.task) break;
      const taskPromise = runOne(config, payload.task, absorbTelemetry).finally(() => {
        active.delete(taskPromise);
        triggerHeartbeat(true);
      });
      active.add(taskPromise);
      triggerHeartbeat(true);
    }

    if (options.once) {
      if (active.size) await Promise.allSettled([...active]);
      triggerHeartbeat(true);
      return;
    }
    await sleep(active.size ? 1_000 : (options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
  }
}

export async function resumeLocalConversation(taskDirectory, message, config) {
  const session = await loadSession(taskDirectory);
  const reference = sessionReference(session);
  if (!reference) throw new Error("该任务没有可恢复的本地 Agent 会话。");
  const selectedAgent = normalizeAgent(session.agent || config.agent);
  const task = { id: path.basename(taskDirectory), prompt: message };
  const result = await runAgentTurn({
    agent: selectedAgent,
    taskDirectory,
    prompt: message,
    config: { ...config, agent: selectedAgent },
    previousSession: session,
  });
  console.log(`已继续 ${agentLabel(selectedAgent)} 本地会话：${sessionReference(result)}`);
  return task;
}

export async function reconcileLocalUsage(config, taskId) {
  if (!isSafeTaskId(taskId)) throw new Error("任务 ID 只能包含字母、数字、点、下划线和连字符，且长度不超过 128。");
  const taskDirectory = defaultTaskDirectory(config.workspace, taskId);
  const session = await loadSession(taskDirectory);
  const selectedAgent = normalizeAgent(session?.agent || config.agent);
  let rawEvents;
  try {
    rawEvents = await fs.readFile(path.join(taskDirectory, "events.jsonl"), "utf8");
  } catch {
    throw new Error("本地任务没有 events.jsonl，无法从 Agent 事件补回用量。");
  }
  const events = rawEvents.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const usageResult = extractAgentUsage(selectedAgent, events);
  if (!usageResult.usage || usageResult.usage.totalTokens == null) {
    throw new Error(`本地事件中没有可识别的完整 token 用量${usageResult.reason ? `：${usageResult.reason}` : ""}`);
  }
  const identity = identityFromEvents(selectedAgent, events, await loadLocalAgentIdentity(selectedAgent, { ...config, agent: selectedAgent }));
  const telemetry = {
    provider: identity.provider,
    model: identity.model,
    usage: usagePayload(usageResult.usage),
  };
  const response = await reportTaskUsage(config, taskId, telemetry);
  console.log(`已补回任务用量：${taskId} · ${telemetry.provider}/${telemetry.model || "unknown"} · ${telemetry.usage.totalTokens} tokens`);
  return response;
}

export async function listLocalSessions(config) {
  const tasksDirectory = path.join(config.workspace, "tasks");
  try {
    const entries = await fs.readdir(tasksDirectory, { withFileTypes: true });
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const session = JSON.parse(await fs.readFile(path.join(tasksDirectory, entry.name, "session.json"), "utf8"));
        if (sessionReference(session)) sessions.push({ taskId: entry.name, ...session });
      } catch {
        // A task can exist before its first Codex turn completes.
      }
    }
    return sessions.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
