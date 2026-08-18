import test from "node:test";
import assert from "node:assert/strict";
import { hasFlag, parseArgs, requiredValue } from "../src/args.mjs";
import { normalizeSite } from "../src/site-client.mjs";
import { uploadable, hasCadArtifact } from "../src/artifacts.mjs";
import { isSafeTaskId, isSupportedNodeVersion } from "../src/constants.mjs";
import { isSupportedPythonVersion } from "../src/modeling-env.mjs";

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
