import test from "node:test";
import assert from "node:assert/strict";
import { hasFlag, parseArgs, requiredValue } from "../src/args.mjs";
import { normalizeSite, siteAgentValue } from "../src/site-client.mjs";
import { uploadable, hasCadArtifact } from "../src/artifacts.mjs";
import { agentLabel, isSafeTaskId, isSupportedNodeVersion, normalizeAgent, normalizeExecutionMode, resolveTaskAgent } from "../src/constants.mjs";
import { isSupportedPythonVersion } from "../src/modeling-env.mjs";
import { claudeEventText, parseClaudeEventLine } from "../src/claude-session.mjs";
import { extractAgentUsage, usagePayload } from "../src/usage.mjs";
import { heartbeatPayload } from "../src/heartbeat.mjs";
import { identityFromEvents, providerFromBaseUrl, providerFromEvent, providerFromModel } from "../src/agent-identity.mjs";

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

test("only uploads CAD/support files from artifacts", () => {
  assert.equal(uploadable("model.step", "artifacts/model.step"), true);
  assert.equal(uploadable("conversation.md", "artifacts/conversation.md"), true);
  assert.equal(uploadable("events.jsonl", "events.jsonl"), false);
  assert.equal(uploadable(".env", "artifacts/.env"), false);
  assert.equal(hasCadArtifact(["/tmp/a.py", "/tmp/a.step"]), true);
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
    capabilities: ["task:direct", "task:plan", "agent:claude-code"],
  });
});
