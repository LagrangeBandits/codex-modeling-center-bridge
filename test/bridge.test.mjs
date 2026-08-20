import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { hasFlag, parseArgs, requiredValue } from "../src/args.mjs";
import { normalizeSite, siteAgentValue, siteRequest, uploadArtifact } from "../src/site-client.mjs";
import { createModelingClient } from "../src/vendor/modeling-platform-contracts/2f61b5e/sdk.mjs";
import { uploadable, hasCadArtifact } from "../src/artifacts.mjs";
import { agentLabel, isSafeTaskId, isSupportedNodeVersion, normalizeAgent, normalizeExecutionMode, resolveTaskAgent } from "../src/constants.mjs";
import { isSupportedPythonVersion } from "../src/modeling-env.mjs";
import { claudeEventText, parseClaudeEventLine } from "../src/claude-session.mjs";
import { extractAgentUsage, usagePayload } from "../src/usage.mjs";
import { heartbeatPayload } from "../src/heartbeat.mjs";
import { identityFromEvents, providerFromBaseUrl, providerFromEvent, providerFromModel } from "../src/agent-identity.mjs";
import { cancellationState, normalizeControlPayload, normalizeTaskMessages, normalizeTaskPriority, taskPromptWithMessages, TaskCancelledError } from "../src/task-control.mjs";
import { resolveTaskPreferences } from "../src/runner.mjs";
import { compareVersions, createUpdateController, normalizeDownloadProgress, normalizeUpdateInfo, UPDATE_STATUS } from "../src/update-manager.mjs";

test("parses boolean and value flags without shell evaluation", () => {
  const parsed = parseArgs(["--site", "https://example.test", "--yes", "--concurrency=2", "pull"]);
  assert.equal(parsed.values.site, "https://example.test");
  assert.equal(hasFlag(parsed, "yes"), true);
  assert.equal(parsed.values.concurrency, "2");
  assert.deepEqual(parsed.positionals, ["pull"]);
});

test("requires non-empty values", () => {
  assert.throws(() => requiredValue(parseArgs([]), "site"), /缺少 --site/);
});

test("normalizes site URLs and rejects unsafe schemes", () => {
  assert.equal(normalizeSite("https://example.test///"), "https://example.test");
  assert.throws(() => normalizeSite("file:///tmp/site"), /必须是 http 或 https/);
});

test("uses shared transport for legacy auth and preserves the caller AbortSignal", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const controller = new AbortController();
  try {
    await siteRequest({ site: "https://example.test///" }, "/api/runner/events", {
      method: "POST",
      runnerToken: "runner-token",
      siteBypassToken: "site-token",
      signal: controller.signal,
      body: JSON.stringify({ taskId: "task-1", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }),
    });
    assert.equal(calls[0].url, "https://example.test/api/runner/events");
    assert.equal(calls[0].options.headers.Authorization, "Bearer runner-token");
    assert.equal(calls[0].options.headers["OAI-Sites-Authorization"], "Bearer site-token");
    assert.equal(calls[0].options.headers["Content-Type"], "application/json");
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[0].options.body.includes("runner-token"), false);
    assert.equal(calls[0].options.body.includes("site-token"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("vendored SDK whitelists telemetry and keeps messages/cancel compatibility", async () => {
  const calls = [];
  let cancelAttempt = 0;
  const client = createModelingClient({
    site: "https://example.test",
    runnerToken: "runner-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/messages?") && options.method === "GET") {
        return new Response(JSON.stringify({ nextCursor: "cursor-2", messages: [{ role: "user", message: "继续" }] }), { status: 200 });
      }
      if (url.endsWith("/cancel")) {
        cancelAttempt += 1;
        return new Response(JSON.stringify({ error: "not supported" }), { status: cancelAttempt === 1 ? 404 : 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  });

  const controls = await client.getMessages("task-1", "cursor-1");
  assert.equal(controls.cursor, "cursor-2");
  assert.equal(controls.messages[0].content, "继续");
  await client.sendMessage("task-1", "已收到", { cursor: controls.cursor });
  await client.cancelWithFallback("task-1", "用户取消", { usage: { inputTokens: 1 }, apiKey: "do-not-send" });
  await client.sendEvent("task-1", "modeling", 30, "处理中", {
    provider: "deepseek",
    model: "deepseek-chat",
    usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9, transcript: "do-not-send" },
  });

  const eventCall = calls.at(-1);
  const eventPayload = JSON.parse(eventCall.options.body);
  assert.deepEqual(eventPayload.usage, {
    inputTokens: 4,
    outputTokens: 5,
    totalTokens: 9,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    reasoningOutputTokens: null,
  });
  assert.equal("transcript" in eventPayload.usage, false);
  assert.equal("apiKey" in JSON.parse(calls.find(({ url }) => url.endsWith("/cancel"))?.options.body || "{}"), false);
  assert.equal(calls.some(({ url }) => url.endsWith("/complete")), true);
});

test("only uploads CAD/support files from artifacts", () => {
  assert.equal(uploadable("model.step", "artifacts/model.step"), true);
  assert.equal(uploadable("conversation.md", "artifacts/conversation.md"), true);
  assert.equal(uploadable("events.jsonl", "events.jsonl"), false);
  assert.equal(uploadable(".env", "artifacts/.env"), false);
  assert.equal(hasCadArtifact(["/tmp/a.py", "/tmp/a.step"]), true);
});

test("rejects an oversized artifact before opening an upload request", async () => {
  await assert.rejects(
    () => uploadArtifact({ site: "https://example.test" }, "task-1", "model.step", Buffer.alloc(6), 5),
    (error) => error?.status === 413 && /model\.step/.test(error.message) && /单文件上限/.test(error.message),
  );
});

test("treats an artifact limit of zero as unlimited", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (_url, options) => {
    called = true;
    assert.equal(options?.method, "POST");
    return new Response(JSON.stringify({ artifact: { id: "artifact-1" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await uploadArtifact({ site: "https://example.test" }, "task-1", "model.step", Buffer.alloc(6), 0);
    assert.equal(called, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("requires the supported local runtimes", () => {
  assert.equal(isSupportedNodeVersion("v24.19.0"), true);
  assert.equal(isSupportedNodeVersion("v22.19.0"), false);
  assert.equal(isSupportedPythonVersion("3.11.9"), true);
  assert.equal(isSupportedPythonVersion("Python 3.12.4"), true);
  assert.equal(isSupportedPythonVersion("3.9.6"), false);
  assert.equal(isSafeTaskId("task-2026.08_01"), true);
  assert.equal(isSafeTaskId("../../outside"), false);
});

test("supports selectable local modeling agents", () => {
  assert.equal(normalizeAgent(undefined), "codex");
  assert.equal(normalizeAgent("Claude"), "claude");
  assert.equal(normalizeAgent("claude-code"), "claude");
  assert.equal(siteAgentValue("claude"), "claude-code");
  assert.equal(siteAgentValue("codex"), "codex");
  assert.equal(agentLabel("claude"), "Claude Code");
  assert.throws(() => normalizeAgent("unknown"), /可选值为 codex 或 claude/);
  assert.equal(resolveTaskAgent("any", "claude"), "claude");
  assert.equal(resolveTaskAgent("auto", "codex"), "codex");
  assert.equal(resolveTaskAgent("codex", "claude"), "codex");
  assert.equal(normalizeExecutionMode(undefined), "direct");
  assert.equal(normalizeExecutionMode("PLAN"), "plan");
  assert.throws(() => normalizeExecutionMode("execute"), /可选值为 direct 或 plan/);
});

test("parses Claude stream-json events without executing a CLI", () => {
  const assistant = parseClaudeEventLine(JSON.stringify({
    type: "assistant",
    session_id: "claude-session-1",
    message: { content: [{ type: "text", text: "已生成模型" }, { type: "tool_use", name: "Bash" }] },
  }));
  const result = parseClaudeEventLine(JSON.stringify({ type: "result", subtype: "success", session_id: "claude-session-1", result: "完成" }));
  assert.equal(assistant.session_id, "claude-session-1");
  assert.equal(claudeEventText(assistant), "已生成模型");
  assert.equal(claudeEventText(result), "完成");
  assert.equal(parseClaudeEventLine(""), null);
  assert.throws(() => parseClaudeEventLine("not-json"), SyntaxError);
});

test("normalizes real Codex and Claude usage without uploading raw fields", () => {
  const codex = extractAgentUsage("codex", [
    { type: "item.completed", usage: { input_tokens: 999, output_tokens: 999 } },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 120,
        cached_input_tokens: 30,
        cache_write_input_tokens: 4,
        output_tokens: 18,
        reasoning_output_tokens: 7,
      },
    },
  ]);
  assert.equal(codex.reason, null);
  assert.deepEqual(codex.usage, {
    inputTokens: 120,
    outputTokens: 18,
    totalTokens: 138,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 4,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    reasoningOutputTokens: 7,
  });

  const claude = extractAgentUsage("claude", [{
    type: "result",
    usage: {
      input_tokens: 80,
      cache_creation_input_tokens: 12,
      cache_read_input_tokens: 20,
      output_tokens: 25,
    },
  }]);
  assert.equal(claude.reason, null);
  assert.equal(claude.usage.totalTokens, 105);
  assert.equal(claude.usage.cachedInputTokens, 20);
  assert.equal(claude.usage.cacheCreationInputTokens, 12);
  assert.equal(claude.usage.cacheReadInputTokens, 20);

  const unknown = extractAgentUsage("claude", [{ type: "result", usage: { cost_usd: 0.01, transcript: "do not upload" } }]);
  assert.match(unknown.reason, /没有可识别的 token/);
  assert.equal(unknown.usage.inputTokens, null);
  assert.deepEqual(usagePayload({ inputTokens: 4, apiKey: "secret", transcript: "private" }), {
    inputTokens: 4,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    reasoningOutputTokens: null,
  });
});

test("resolves provider from evidence instead of the selected Agent", () => {
  assert.equal(providerFromModel("deepseek-chat"), "deepseek");
  assert.equal(providerFromModel("qwen-plus"), "qwen");
  assert.equal(providerFromModel("gpt-5.4"), null);
  assert.equal(providerFromBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"), "dashscope");
  assert.equal(providerFromBaseUrl("https://example-compatible.test/v1"), "openai-compatible");
  assert.equal(providerFromEvent({ model_provider: "deepseek" }), "deepseek");

  assert.deepEqual(identityFromEvents("codex", [{ type: "turn.completed", model: "deepseek-chat" }], {}), {
    provider: "deepseek",
    model: "deepseek-chat",
  });
  assert.deepEqual(identityFromEvents("codex", [], { model: "custom-model", provider: "unknown" }), {
    provider: "unknown",
    model: "custom-model",
  });
  assert.deepEqual(identityFromEvents("codex", [], { model: "custom-model", baseUrl: "https://api.example.test/v1" }), {
    provider: "openai-compatible",
    model: "custom-model",
  });
});

test("builds a heartbeat with null-safe metrics and no credentials", () => {
  assert.deepEqual(heartbeatPayload({
    runnerId: "runner-1",
    agent: "claude",
    provider: "unknown",
    model: "claude-sonnet-4",
    softwareVersion: "0.1.2",
    platform: "unknown",
    activeTasks: 0,
    capacity: 1,
    metrics: { cpuPercent: null, memoryUsedBytes: null, memoryTotalBytes: null, load1m: null },
  }), {
    runnerId: "runner-1",
    platform: "unknown",
    agent: "claude-code",
    provider: "unknown",
    model: "claude-sonnet-4",
    softwareVersion: "0.1.2",
    activeTasks: 0,
    capacity: 1,
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    load1m: null,
    capabilities: ["task:direct", "task:plan", "task:cancel", "task:priority", "bridge:messages", "agent:claude-code"],
  });
});

test("normalizes optional task control without uploading raw events", () => {
  assert.equal(normalizeTaskPriority("12.9"), 12);
  assert.equal(normalizeTaskPriority("not-a-number"), 0);
  assert.deepEqual(normalizeTaskMessages([
    { id: "m1", role: "user", content: "请补充一个安装孔。" },
    { id: "m1", role: "user", content: "重复消息不应再次注入。" },
    { role: "assistant", text: "不要把 token 放进消息。" },
  ]), [
    { id: "m1", role: "user", content: "请补充一个安装孔。" },
    { id: null, role: "assistant", content: "不要把 token 放进消息。" },
  ]);
  assert.equal(taskPromptWithMessages("生成法兰", [{ role: "user", content: "孔距 30 mm" }]), "生成法兰\n\n## 网站补充消息\n- user: 孔距 30 mm");
  assert.deepEqual(cancellationState({ cancel_requested_at: "2026-08-20T10:00:00Z" }), { requested: true, reason: null });
  assert.deepEqual(normalizeControlPayload({ cursor: "next", messages: [{ content: "继续" }], cancelRequested: false }), {
    cursor: "next",
    cancelRequested: false,
    cancelReason: null,
    messages: [{ id: null, role: "user", content: "继续" }],
  });
  const error = new TaskCancelledError("网站取消");
  assert.equal(error.code, "TASK_CANCELLED");
  assert.equal(error.message, "网站取消");
});

test("passes modelPreference strings and objects to the local Agent", () => {
  assert.deepEqual(resolveTaskPreferences({ modelPreference: "auto" }), {});
  assert.deepEqual(resolveTaskPreferences({ modelPreference: "deepseek-chat" }), { model: "deepseek-chat" });
  assert.deepEqual(resolveTaskPreferences({ modelPreference: "qwen-plus" }), { model: "qwen-plus" });
  assert.deepEqual(resolveTaskPreferences({ modelPreference: { provider: "dashscope", model: "qwen-plus", reasoningEffort: "high" } }), {
    provider: "dashscope",
    model: "qwen-plus",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveTaskPreferences({ modelPreference: "auto", model: "local-model" }), { model: "local-model" });
});

test("compares update versions and normalizes release metadata safely", () => {
  assert.equal(compareVersions("0.1.10", "0.1.9"), 1);
  assert.equal(compareVersions("v0.1.10-beta.1", "0.1.10"), -1);
  assert.equal(compareVersions("not-a-version", "0.1.0"), null);
  assert.deepEqual(normalizeDownloadProgress({ percent: 140.26, transferred: "20", total: "100" }), {
    percent: 100,
    transferred: 20,
    total: 100,
    bytesPerSecond: null,
  });
  const info = normalizeUpdateInfo({
    version: "v0.1.10",
    releaseName: "Release https://private.example/secret",
    releaseNotes: "修复完成。Bearer hidden-token https://private.example/path",
    path: "dist\\Modeling-Center-Bridge-0.1.10-arm64.zip",
  }, "0.1.9");
  assert.equal(info.version, "0.1.10");
  assert.equal(info.isNewer, true);
  assert.equal(info.assetName, "Modeling-Center-Bridge-0.1.10-arm64.zip");
  assert.equal(info.releaseNotesUrl, "https://github.com/LagrangeBandits/codex-modeling-center-bridge/releases/tag/v0.1.10");
  assert.equal(info.releaseNotes.includes("private.example"), false);
  assert.equal(info.releaseName.includes("private.example"), false);
});

test("does not contact the update service in development mode", async () => {
  let calls = 0;
  const updater = {
    on() { calls += 1; },
    checkForUpdates() { calls += 1; },
    downloadUpdate() { calls += 1; },
    quitAndInstall() { calls += 1; },
  };
  const controller = createUpdateController({ updater, isPackaged: false, currentVersion: "0.1.10" });
  assert.equal(controller.initialize().status, UPDATE_STATUS.DISABLED);
  assert.equal((await controller.check()).status, UPDATE_STATUS.DISABLED);
  assert.equal((await controller.download()).status, UPDATE_STATUS.DISABLED);
  assert.equal(controller.install().status, UPDATE_STATUS.DISABLED);
  assert.equal(calls, 0);
});

test("requires explicit download/install confirmation and protects an active Runner", async () => {
  const updater = new EventEmitter();
  updater.autoDownload = true;
  let runnerRunning = false;
  let installCalls = 0;
  updater.checkForUpdates = async () => ({
    updateInfo: { version: "0.1.11", releaseNotes: "安全修复" },
  });
  updater.downloadUpdate = async () => {
    updater.emit("download-progress", { percent: 42, transferred: 42, total: 100, bytesPerSecond: 10 });
    updater.emit("update-downloaded", { info: { version: "0.1.11", path: "Modeling-Center-Bridge-0.1.11-arm64.zip" } });
  };
  updater.quitAndInstall = () => { installCalls += 1; };
  const controller = createUpdateController({
    updater,
    isPackaged: true,
    currentVersion: "0.1.10",
    getRunnerStatus: () => ({ running: runnerRunning }),
  });
  controller.initialize();
  assert.equal(updater.autoDownload, false);
  assert.equal((await controller.check()).status, UPDATE_STATUS.AVAILABLE);
  assert.equal((await controller.download()).status, UPDATE_STATUS.DOWNLOADED);
  runnerRunning = true;
  assert.equal(controller.install().status, UPDATE_STATUS.DOWNLOADED);
  assert.equal(installCalls, 0);
  runnerRunning = false;
  assert.equal(controller.install().status, UPDATE_STATUS.INSTALLING);
  assert.equal(installCalls, 1);
});

test("sanitizes updater event errors before exposing them to the renderer", () => {
  const updater = new EventEmitter();
  const controller = createUpdateController({ updater, isPackaged: true, currentVersion: "0.1.10" });
  controller.initialize();
  updater.emit("error", new Error("Bearer secret-token https://private.example/site?pairingCode=secret"));
  const state = controller.getState();
  assert.equal(state.status, UPDATE_STATUS.ERROR);
  assert.equal(state.error.includes("secret-token"), false);
  assert.equal(state.error.includes("private.example"), false);
});
