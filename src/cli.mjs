#!/usr/bin/env node

import path from "node:path";
import { parseArgs, hasFlag, requiredValue, valueOf } from "./args.mjs";
import { bootstrapModelingEnvironment, formatDoctor, inspectEnvironment } from "./modeling-env.mjs";
import { pairSite } from "./site-client.mjs";
import { configPath, dataDirectory, loadConfig } from "./state.mjs";
import { listLocalSessions, resumeLocalConversation, startRunner } from "./runner.mjs";
import { DEFAULT_NODE_VERSION, isSafeTaskId, isSupportedNodeVersion, platformLabel } from "./constants.mjs";

function help() {
  console.log(`
Codex Modeling Center Bridge

用法:
  codex-modeling-bridge doctor
  codex-modeling-bridge bootstrap --yes
  codex-modeling-bridge pair --site <站点> --code <配对码> --site-auth <桥接授权>
  codex-modeling-bridge onboard --install --yes --site <站点> --code <配对码> --site-auth <桥接授权> --start
  codex-modeling-bridge start [--once] [--concurrency 1]
  codex-modeling-bridge pull                 拉取并执行一条网站任务
  codex-modeling-bridge sessions             查看本机已建立的 Codex 线程
  codex-modeling-bridge resume <任务ID> --message "继续验证并修复模型"

说明:
  - Codex 推理发生在本机，默认继承该设备当前 Codex/ChatGPT 登录状态。
  - 不要设置 OPENAI_API_KEY，否则 Codex 可能改走 API 额度。
  - 站点桥接授权和 Runner token 保存在本机 Keychain/Windows DPAPI，不进入 Git。
`);
}

function requireSupportedNode() {
  if (!isSupportedNodeVersion(process.version)) {
    throw new Error(`当前 Node.js 为 ${process.version}，需要 Node.js ${DEFAULT_NODE_VERSION}+；请运行 scripts/install-macos.sh 或 scripts/install-windows.ps1 让程序准备用户目录运行时。`);
  }
}

async function commandDoctor(parsed) {
  const config = await loadConfig();
  const report = await inspectEnvironment(config);
  if (hasFlag(parsed, "json")) console.log(JSON.stringify({ config: { ...config, secrets: "本地安全存储" }, report }, null, 2));
  else {
    console.log(formatDoctor(report));
    console.log(`配置目录: ${dataDirectory()}`);
    console.log(`配置文件: ${configPath()}`);
  }
  return report;
}

async function commandBootstrap(parsed) {
  requireSupportedNode();
  const config = await loadConfig();
  const result = await bootstrapModelingEnvironment(config, { yes: hasFlag(parsed, "yes") });
  console.log(`建模环境已就绪：${result.python}`);
  console.log(`CadQuery：${result.cadquery}`);
}

async function commandPair(parsed) {
  requireSupportedNode();
  const response = await pairSite({
    site: requiredValue(parsed, "site"),
    code: requiredValue(parsed, "code"),
    siteAuth: valueOf(parsed, "site-auth"),
    name: valueOf(parsed, "name"),
    agent: "codex",
    workspace: valueOf(parsed, "workspace"),
  });
  console.log(`配对成功：${response.name}`);
  console.log(`平台：${platformLabel(response.platform)} · Agent：Codex`);
  console.log("现在可以运行：codex-modeling-bridge start");
}

async function commandOnboard(parsed) {
  requireSupportedNode();
  const config = await loadConfig();
  const report = await commandDoctor({ values: {}, positionals: [] });
  const needsInstall = hasFlag(parsed, "install") || !report.cadquery.installed;
  if (needsInstall) {
    if (!hasFlag(parsed, "yes")) {
      throw new Error("首次安装需要明确确认：重新运行 onboard --install --yes …");
    }
    const result = await bootstrapModelingEnvironment(config, { yes: true });
    console.log(`本地建模依赖已安装：${result.cadquery}`);
  }
  const finalReport = needsInstall ? await inspectEnvironment(config) : report;
  if (!finalReport.codex.installed) {
    throw new Error("建模依赖已准备，但未发现 Codex CLI。请按 https://learn.chatgpt.com/docs/codex/cli 安装 Codex，并在本机运行一次 codex 完成登录后重试 onboard。");
  }
  if (valueOf(parsed, "site") || valueOf(parsed, "code")) {
    await commandPair(parsed);
  } else {
    console.log("环境引导完成；若要接入网站，请补充 --site、--code 和 --site-auth。");
  }
  if (hasFlag(parsed, "start")) await startRunner({ concurrency: valueOf(parsed, "concurrency") });
}

async function commandStart(parsed, once = false) {
  requireSupportedNode();
  const config = await loadConfig();
  const overrides = {};
  if (valueOf(parsed, "model")) overrides.model = valueOf(parsed, "model");
  if (valueOf(parsed, "reasoning-effort")) overrides.reasoningEffort = valueOf(parsed, "reasoning-effort");
  await startRunner({
    once: once || hasFlag(parsed, "once"),
    concurrency: valueOf(parsed, "concurrency", 1),
    ...overrides,
  });
}

async function commandSessions() {
  requireSupportedNode();
  const config = await loadConfig();
  const sessions = await listLocalSessions(config);
  if (!sessions.length) {
    console.log("还没有本地 Codex 线程。");
    return;
  }
  for (const session of sessions) console.log(`${session.taskId}\t${session.threadId}\t${session.updatedAt}`);
}

async function commandResume(parsed) {
  requireSupportedNode();
  const taskId = parsed.positionals[0];
  if (!taskId) throw new Error("用法：resume <任务ID> --message \"继续…\"");
  if (!isSafeTaskId(taskId)) throw new Error("任务 ID 只能包含字母、数字、点、下划线和连字符，且长度不超过 128。");
  const config = await loadConfig();
  const message = requiredValue(parsed, "message");
  await resumeLocalConversation(path.join(config.workspace, "tasks", taskId), message, config);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "doctor" || command === "status") return commandDoctor(parsed);
  if (command === "bootstrap" || command === "install") return commandBootstrap(parsed);
  if (command === "pair") return commandPair(parsed);
  if (command === "onboard") return commandOnboard(parsed);
  if (command === "start") return commandStart(parsed);
  if (command === "pull") return commandStart(parsed, true);
  if (command === "sessions") return commandSessions();
  if (command === "resume") return commandResume(parsed);
  throw new Error(`未知命令：${command}。运行 help 查看用法。`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
