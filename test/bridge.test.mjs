import test from "node:test";
import assert from "node:assert/strict";
import { hasFlag, parseArgs, requiredValue } from "../src/args.mjs";
import { normalizeSite } from "../src/site-client.mjs";
import { uploadable, hasCadArtifact } from "../src/artifacts.mjs";
import { agentLabel, isSafeTaskId, isSupportedNodeVersion, normalizeAgent } from "../src/constants.mjs";
import { isSupportedPythonVersion } from "../src/modeling-env.mjs";
import { claudeEventText, parseClaudeEventLine } from "../src/claude-session.mjs";

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
  assert.equal(agentLabel("claude"), "Claude Code");
  assert.throws(() => normalizeAgent("unknown"), /可选值为 codex 或 claude/);
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
