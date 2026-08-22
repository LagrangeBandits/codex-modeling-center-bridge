import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentLabel, BRIDGE_VERSION, defaultTaskDirectory, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS, isSafeTaskId, normalizeAgent, normalizeExecutionMode, platformId, platformLabel, resolveTaskAgent } from "./constants.mjs";
import { collectArtifacts, hasCadArtifact } from "./artifacts.mjs";
import { runAgentTurn, sessionReference } from "./agent-session.mjs";
import { identityFromEvent, identityFromEvents, loadLocalAgentIdentity } from "./agent-identity.mjs";
import { loadSession, prepareTaskDirectory, redactForLog } from "./codex-session.mjs";
import { loadLocalCheckpoint, writeLocalCheckpoint } from "./checkpoint.mjs";
import { loadConfig } from "./state.mjs";
import { acknowledgeTaskCleanup, cancelTask, checkpointTask, completeTask, pollTask, pollTaskCleanup, pollTaskControl, reportTaskUsage, sendEvent, sendHeartbeat, sendTaskMessage, uploadArtifact } from "./site-client.mjs";
import { sleep } from "./process.mjs";
import { createUsageAccumulator, usagePayload } from "./usage.mjs";
import { capabilitiesForAgent, profileCapabilities } from "./cli-agents.mjs";
import { collectSystemMetrics, heartbeatPayload } from "./heartbeat.mjs";
import { cancellationState, isQuotaError, normalizeControlPayload, normalizeTaskMessages, normalizeTaskPriority, pauseDirective, TaskCancelledError, TaskPausedError, taskMessagesFromTask, taskPromptWithMessages } from "./task-control.mjs";
import { normalizeCleanupPayload, normalizeTask as normalizeModelingTask } from "./vendor/modeling-platform-contracts/b50bc72/contracts.mjs";
import { cleanupTaskDirectory } from "./task-cleanup.mjs";

const CONTROL_POLL_INTERVAL_MS = 1_500;

async function report(config, taskId, stage, progress, message, telemetry = undefined, context = undefined) {
  try {
    await sendEvent(config, taskId, stage, progress, message, telemetry, context);
  } catch (error) {
    console.error(`进度回传失败：${redactForLog(error.message)}`);
  }
}

async function reportUsage(config, taskId, telemetry) {
  if (!telemetry?.usage || !Number.isSafeInteger(telemetry.sequence)) return;
  try {
    await reportTaskUsage(config, taskId, telemetry);
  } catch (error) {
    console.error(`用量回传失败（不影响当前任务）：${redactForLog(error?.message || error)}`);
  }
}

async function processCleanupRequests(config, requests, activeTaskIds, cleanupState) {
  for (const request of requests) {
    let result;
    try {
      result = await cleanupTaskDirectory(config.workspace, request, activeTaskIds);
    } catch (error) {
      console.warn(`本地任务清理失败（将保留任务目录并稍后重试）：${redactForLog(error?.message || error)}\n`);
      continue;
    }
    if (result.outcome === "deferred") continue;
    try {
      await acknowledgeTaskCleanup(config, request, result);
      structuredRunnerLog("task.cleanup", { taskId: request.taskId, requestId: request.requestId, outcome: result.outcome, reasonCode: result.reasonCode || null });
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        cleanupState.ackUnsupported = true;
        console.warn("站点未提供可选本地清理回执接口；已停止领取新的清理指令，正常任务不受影响。\n");
        return;
      }
      console.warn(`本地任务清理回执失败（下次轮询将幂等重试）：${redactForLog(error?.message || error)}\n`);
    }
  }
}

function resumeSupportedForAgent(agent, config = {}, previousSession = null) {
  if (!previousSession) return false;
  if (agent === "codex" || agent === "claude") return true;
  return profileCapabilities(agent, config).resume === "supported";
}

function structuredRunnerLog(type, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields)
    .filter(([, value]) => value === null || typeof value === "boolean" || Number.isFinite(value) || typeof value === "string")
    .map(([key, value]) => [key, typeof value === "string" ? redactForLog(value).slice(0, 240) : value]));
  console.log(`[bridge-event] ${JSON.stringify({ schemaVersion: 1, type, at: new Date().toISOString(), ...safe })}`);
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
    this.pauseState = { requested: false, action: "none", quotaState: "unknown", reason: null, retryAfter: null, checkpoint: null, attemptId: null };
    this.pauseReported = false;
    this.checkpoint = null;
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
        const directive = pauseDirective(control);
        if (directive.requested) this.pauseState = directive;
        if (control.resumeRequested === true || control.action === "resume") {
          this.pauseState = { ...this.pauseState, requested: false, action: "resume" };
        }
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

  get shouldPause() {
    return this.pauseState.requested === true && !this.pauseReported;
  }

  requestLocalPause(reason, quotaState = "unknown") {
    this.pauseState = {
      ...this.pauseState,
      requested: true,
      action: "pause",
      quotaState,
      reason: reason || this.pauseState.reason || "本地 Agent 用量或网站余额要求暂停。",
    };
  }

  async pauseAtCheckpoint({ taskDirectory, attemptId, agent, provider, model, usage, sessionRef, eventCount, stage, resumeSupported, reasonCode }) {
    if (!this.shouldPause) return null;
    const local = await writeLocalCheckpoint(taskDirectory, {
      taskId: this.taskId,
      attemptId: attemptId || this.pauseState.attemptId,
      agent,
      provider,
      model,
      usage,
      sessionRef,
      eventCount,
      stage,
      resumeSupported,
      reasonCode: reasonCode || this.pauseState.reason || this.pauseState.quotaState,
      checkpoint: this.pauseState.checkpoint,
    });
    try {
      await checkpointTask(this.config, this.taskId, {
        attemptId: attemptId || this.pauseState.attemptId,
        checkpoint: {
          checkpointId: local.checkpointId,
          checkpointVersion: local.checkpointVersion,
          stage: local.stage,
          attemptId: local.attemptId,
          resumeSupported: local.resumeSupported,
          reasonCode: local.reasonCode,
          createdAt: local.createdAt,
        },
        quotaState: this.pauseState.quotaState,
        pauseReason: this.pauseState.reason,
        retryAfter: this.pauseState.retryAfter,
        resumeSupported: local.resumeSupported,
        resumeFrom: local.checkpointId,
        provider,
        model,
        usage,
      });
    } catch (error) {
      const failure = new Error(`安全暂停状态回传失败：${redactForLog(error?.message || error)}`);
      failure.code = "CHECKPOINT_REPORT_FAILED";
      failure.cause = error;
      failure.checkpoint = local;
      throw failure;
    }
    this.pauseReported = true;
    this.checkpoint = local;
    structuredRunnerLog("task.paused", {
      taskId: this.taskId,
      attemptId: local.attemptId,
      checkpointId: local.checkpointId,
      stage: local.stage,
      quotaState: this.pauseState.quotaState,
      resumeSupported: local.resumeSupported,
    });
    throw new TaskPausedError(this.pauseState.reason || "任务已安全暂停，等待网站恢复。", {
      checkpoint: local,
      checkpointSent: true,
      retryAfter: this.pauseState.retryAfter,
      quotaState: this.pauseState.quotaState,
    });
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
  const attemptId = task.attemptId || task.attempt_id || randomUUID();
  const taskConfig = { ...config, ...resolveTaskPreferences(task), agent: selectedAgent, executionMode, attemptId };
  const selectedAgentLabel = agentLabel(selectedAgent);
  const priority = normalizeTaskPriority(task?.priority);
  const taskContext = { priority, executionMode };
  const control = new TaskControlChannel(config, task.id);
  execution.control = control;
  execution.attemptId = attemptId;
  control.start();
  const taskPause = pauseDirective(task);
  if (taskPause.requested) {
    control.requestLocalPause(taskPause.reason, taskPause.quotaState);
    control.pauseState = {
      ...control.pauseState,
      retryAfter: taskPause.retryAfter,
      checkpoint: taskPause.checkpoint,
      attemptId: taskPause.attemptId || attemptId,
    };
  }
  const initialCancellation = cancellationState(task);
  if (initialCancellation.requested) control.requestCancellation(initialCancellation.reason);
  await control.check(true);
  const taskPrompt = taskPromptWithMessages(task.prompt, [...taskMessagesFromTask(task), ...control.messages]);
  const initialIdentity = await loadLocalAgentIdentity(selectedAgent, taskConfig);
  const telemetry = {
    provider: initialIdentity.provider,
    model: initialIdentity.model,
    usage: null,
    attemptId,
  };
  execution.telemetry = telemetry;
  execution.onTelemetry?.(telemetry);
  const taskDirectory = defaultTaskDirectory(config.workspace, task.id);
  await prepareTaskDirectory(taskDirectory, { ...task, prompt: taskPrompt });
  const previousSession = await loadSession(taskDirectory);
  const localCheckpoint = await loadLocalCheckpoint(taskDirectory);
  if (previousSession?.agent && previousSession.agent !== selectedAgent) {
    throw new Error(`该任务已有 ${agentLabel(previousSession.agent)} 本地会话，不能改用 ${selectedAgentLabel} 继续；请使用原 Agent 或建立新任务。`);
  }
  if (control.shouldPause) {
    await control.pauseAtCheckpoint({
      taskDirectory,
      attemptId,
      agent: selectedAgent,
      provider: initialIdentity.provider,
      model: initialIdentity.model,
      usage: null,
      sessionRef: sessionReference(previousSession) || localCheckpoint?.sessionRef || null,
      eventCount: 0,
      stage: "before_turn",
      resumeSupported: resumeSupportedForAgent(selectedAgent, taskConfig, previousSession),
    });
  }
  const usageAccumulator = createUsageAccumulator({ attemptId, usageSource: `${selectedAgent}:event` });
  execution.usageAccumulator = usageAccumulator;
  let lastEventAt = 0;

  const recordUsage = async (event) => {
    const envelope = usageAccumulator.update(selectedAgent, event);
    if (!envelope) return false;
    telemetry.usage = usagePayload(envelope.usage);
    telemetry.sequence = envelope.sequence;
    telemetry.usageMode = envelope.usageMode;
    telemetry.usageSource = envelope.usageSource;
    telemetry.usageComplete = envelope.usageComplete;
    telemetry.observedAt = envelope.observedAt;
    execution.onTelemetry?.(telemetry);
    await reportUsage(config, task.id, telemetry);
    structuredRunnerLog("usage.update", {
      taskId: task.id,
      attemptId,
      sequence: envelope.sequence,
      usageMode: envelope.usageMode,
      usageComplete: envelope.usageComplete,
    });
    return true;
  };

  await report(config, task.id, "planning", 16, executionMode === "plan"
    ? `${selectedAgentLabel} 正在整理建模方案，不会运行 CAD 或上传模型文件。`
    : `${selectedAgentLabel} 正在解析尺寸、方向和交付约束。`, telemetry, taskContext);
  if (executionMode === "direct") {
    await report(config, task.id, "modeling", 30, `${selectedAgentLabel} 正在本地生成参数化 CAD。`, telemetry, taskContext);
  }

  let result;
  try {
    result = await runAgentTurn({
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
      const hasUsage = await recordUsage(event);
      if (hasUsage) {
        await report(config, task.id, telemetry.usageComplete ? "validating" : "modeling", telemetry.usageComplete ? 72 : 60, telemetry.usageComplete
          ? `${selectedAgentLabel} 回合完成，正在整理用量和任务结果。`
          : `${selectedAgentLabel} 正在接收本地 Agent 用量进度。`, telemetry, taskContext);
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
  } catch (error) {
    if (isQuotaError(error) && previousSession && resumeSupportedForAgent(selectedAgent, taskConfig, previousSession)) {
      control.requestLocalPause(redactForLog(error?.message || "本地 Agent 额度不足。"), Number(error?.status) === 429 ? "rate_limited" : "insufficient");
      await control.pauseAtCheckpoint({
        taskDirectory,
        attemptId,
        agent: selectedAgent,
        provider: telemetry.provider,
        model: telemetry.model,
        usage: error?.usage ?? telemetry.usage,
        sessionRef: sessionReference(previousSession),
        eventCount: 0,
        stage: "agent_error",
        resumeSupported: true,
        reasonCode: Number(error?.status) === 429 ? "RATE_LIMITED" : "INSUFFICIENT_BALANCE",
      });
    }
    throw error;
  }

  await control.check(true);

  if (result.provider && result.provider !== "unknown") telemetry.provider = result.provider;
  telemetry.model = result.model || telemetry.model;
  if (usageAccumulator.sequence === 0 && result.usage) {
    await recordUsage({
      type: selectedAgent === "codex" ? "turn.completed" : selectedAgent === "claude" ? "result" : "result",
      usage: result.usage,
      usageMode: "cumulative",
      usageSource: `${selectedAgent}:result`,
    });
  } else {
    telemetry.usage = usagePayload(telemetry.usage ?? result.usage);
  }
  execution.onTelemetry?.(telemetry);

  if (control.shouldPause) {
    await control.pauseAtCheckpoint({
      taskDirectory,
      attemptId,
      agent: selectedAgent,
      provider: telemetry.provider,
      model: telemetry.model,
      usage: telemetry.usage,
      sessionRef: sessionReference(result) || sessionReference(previousSession),
      eventCount: Array.isArray(result.events) ? result.events.length : 0,
      stage: "turn_boundary",
      resumeSupported: resumeSupportedForAgent(selectedAgent, taskConfig, result),
    });
  }

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
  if (control.shouldPause) {
    await control.pauseAtCheckpoint({
      taskDirectory,
      attemptId,
      agent: selectedAgent,
      provider: telemetry.provider,
      model: telemetry.model,
      usage: telemetry.usage,
      sessionRef: sessionReference(result),
      eventCount: Array.isArray(result.events) ? result.events.length : 0,
      stage: "before_upload",
      resumeSupported: resumeSupportedForAgent(selectedAgent, taskConfig, result),
    });
  }
  const artifacts = await collectArtifacts(taskDirectory);
  if (!hasCadArtifact(artifacts)) throw new Error("没有发现 STEP、STL 或其他 CAD 输出文件。");

  await report(config, task.id, "delivering", 88, `发现 ${artifacts.length} 个交付文件，正在上传到私有对象存储。`, telemetry, taskContext);
  for (const file of artifacts) {
    await control.check(true);
    if (control.shouldPause) {
      await control.pauseAtCheckpoint({
        taskDirectory,
        attemptId,
        agent: selectedAgent,
        provider: telemetry.provider,
        model: telemetry.model,
        usage: telemetry.usage,
        sessionRef: sessionReference(result),
        eventCount: Array.isArray(result.events) ? result.events.length : 0,
        stage: "before_upload",
        resumeSupported: resumeSupportedForAgent(selectedAgent, taskConfig, result),
      });
    }
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
    if (error?.code === "TASK_PAUSED") {
      console.log(`任务已暂停 ${task.id}：${message}`);
      structuredRunnerLog("task.paused", { taskId: task.id, checkpointId: error.checkpoint?.checkpointId, resumeSupported: error.checkpoint?.resumeSupported });
      return;
    }
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
  const activeTaskIds = new Set();
  const cleanupState = { unsupported: false, ackUnsupported: false, lastWarningAt: 0 };
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
      capabilities: capabilitiesForAgent(config.agent, config),
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
    if (!cleanupState.unsupported && !cleanupState.ackUnsupported) {
      try {
        const requests = await pollTaskCleanup(config);
        await processCleanupRequests(config, requests, activeTaskIds, cleanupState);
      } catch (error) {
        if (error?.status === 404 || error?.status === 405) {
          cleanupState.unsupported = true;
          console.warn("站点未提供可选本地任务清理接口；继续使用旧版任务协议。\n");
        } else {
          const now = Date.now();
          if (now - cleanupState.lastWarningAt >= 15_000) {
            cleanupState.lastWarningAt = now;
            console.warn(`本地任务清理轮询失败（不影响任务领取）：${redactForLog(error?.message || error)}\n`);
          }
        }
      }
    }
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
      if (!cleanupState.ackUnsupported) {
        const piggybackRequests = normalizeCleanupPayload(payload);
        if (piggybackRequests.length) await processCleanupRequests(config, piggybackRequests, activeTaskIds, cleanupState);
      }
      if (!payload?.task) break;
      const serverControl = payload.control && typeof payload.control === "object" ? payload.control : {};
      const task = {
        ...payload.task,
        ...(payload.action !== undefined || serverControl.action !== undefined ? { action: payload.action ?? serverControl.action } : {}),
        ...(payload.controlAction !== undefined || serverControl.controlAction !== undefined ? { controlAction: payload.controlAction ?? serverControl.controlAction } : {}),
        ...(payload.quotaState !== undefined || serverControl.quotaState !== undefined ? { quotaState: payload.quotaState ?? serverControl.quotaState } : {}),
        ...(payload.pauseRequested !== undefined || serverControl.pauseRequested !== undefined ? { pauseRequested: payload.pauseRequested ?? serverControl.pauseRequested } : {}),
        ...(payload.pauseReason !== undefined || serverControl.pauseReason !== undefined ? { pauseReason: payload.pauseReason ?? serverControl.pauseReason } : {}),
        ...(payload.retryAfter !== undefined || serverControl.retryAfter !== undefined ? { retryAfter: payload.retryAfter ?? serverControl.retryAfter } : {}),
        ...(payload.checkpoint !== undefined || serverControl.checkpoint !== undefined ? { checkpoint: payload.checkpoint ?? serverControl.checkpoint } : {}),
        ...(payload.attemptId !== undefined || serverControl.attemptId !== undefined ? { attemptId: payload.attemptId ?? serverControl.attemptId } : {}),
      };
      activeTaskIds.add(task.id);
      const taskPromise = runOne(config, task, absorbTelemetry).finally(() => {
        active.delete(taskPromise);
        activeTaskIds.delete(task.id);
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
    attemptId: session?.attemptId || randomUUID(),
    sequence: 1,
    usageMode: "cumulative",
    usageSource: "bridge:reconcile",
    usageComplete: true,
    observedAt: new Date().toISOString(),
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
