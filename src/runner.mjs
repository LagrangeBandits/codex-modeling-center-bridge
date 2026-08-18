import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultTaskDirectory, DEFAULT_POLL_INTERVAL_MS, isSafeTaskId, platformLabel } from "./constants.mjs";
import { collectArtifacts, hasCadArtifact } from "./artifacts.mjs";
import { loadSession, prepareTaskDirectory, runCodexTurn, redactForLog } from "./codex-session.mjs";
import { loadConfig } from "./state.mjs";
import { completeTask, pollTask, sendEvent, uploadArtifact } from "./site-client.mjs";
import { sleep } from "./process.mjs";

function agentLabel() {
  return "Codex";
}

async function report(config, taskId, stage, progress, message) {
  try {
    await sendEvent(config, taskId, stage, progress, message);
  } catch (error) {
    console.error(`进度回传失败：${redactForLog(error.message)}`);
  }
}

async function runTask(config, task) {
  if (!isSafeTaskId(task?.id)) throw new Error("网站返回了不安全的任务 ID，已拒绝写入本地工作区。");
  const taskDirectory = defaultTaskDirectory(config.workspace, task.id);
  await prepareTaskDirectory(taskDirectory, task);
  const previousSession = await loadSession(taskDirectory);
  let lastEventAt = 0;

  await report(config, task.id, "planning", 16, `${agentLabel()} 正在解析尺寸、方向和交付约束。`);
  await report(config, task.id, "modeling", 30, `${agentLabel()} 已拉起本地 Codex 会话，正在生成参数化 CAD。`);

  const result = await runCodexTurn({
    taskDirectory,
    prompt: [
      "你正在执行私有 CAD 建模任务。",
      "不要等待用户追问；对低风险缺失参数做明确工程假设并写入验证报告。",
      "严格在当前任务目录工作，最终文件放进 artifacts/。",
      "\n用户需求：",
      task.prompt,
    ].join("\n"),
    config,
    previousThreadId: previousSession?.threadId,
    onEvent: async (event) => {
      const now = Date.now();
      if (now - lastEventAt < 2_500 && event.type !== "turn.failed") return;
      lastEventAt = now;
      if (event.type === "item.started" || event.type === "item.updated") {
        const item = event.item;
        if (item?.type === "command_execution") {
          await report(config, task.id, "modeling", 46, `Codex 正在本地执行建模命令：${String(item.command).slice(0, 220)}`);
        } else if (item?.type === "file_change") {
          await report(config, task.id, "modeling", 58, "Codex 正在写入参数化脚本和验证文件。");
        }
      }
      if (event.type === "turn.completed") {
        await report(config, task.id, "validating", 72, "Codex 回合完成，正在检查交付目录和验证报告。");
      }
    },
  });

  const artifacts = await collectArtifacts(taskDirectory);
  if (!hasCadArtifact(artifacts)) throw new Error("没有发现 STEP、STL 或其他 CAD 输出文件。");

  await report(config, task.id, "delivering", 88, `发现 ${artifacts.length} 个交付文件，正在上传到私有对象存储。`);
  for (const file of artifacts) {
    await uploadArtifact(config, task.id, path.basename(file), await fs.readFile(file));
  }
  const summary = String(result.finalResponse || "Codex 已完成建模、验证并生成交付文件。").slice(0, 6_000);
  await completeTask(config, task.id, "completed", summary);
  console.log(`任务完成：${task.id} · 本地线程 ${result.threadId || "未返回"}`);
}

async function runOne(config, task) {
  try {
    await runTask(config, task);
  } catch (error) {
    const message = redactForLog(error instanceof Error ? error.message : String(error));
    console.error(`任务失败 ${task.id}：${message}`);
    try {
      await completeTask(config, task.id, "failed", "", message);
    } catch (reportError) {
      console.error(`失败状态回传失败：${redactForLog(reportError.message)}`);
    }
  }
}

export async function startRunner(options = {}) {
  const config = { ...await loadConfig(), ...options };
  if (!config.site || !config.runnerId) {
    throw new Error("还没有配对站点。先运行 pair 或 onboard 完成配对。");
  }
  if (process.env.OPENAI_API_KEY) {
    console.warn("检测到 OPENAI_API_KEY。若要使用本机 ChatGPT/Codex 登录额度，请先在当前终端取消它。");
  }
  await fs.mkdir(config.workspace, { recursive: true });
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || 1)));
  const active = new Set();
  console.log(`Runner 已启动：${config.name || `${os.hostname()} · ${platformLabel(config.platform)}`}`);
  console.log(`任务工作区：${config.workspace}`);
  console.log(`并发槽位：${concurrency}（每台设备默认一次处理一个任务）`);
  console.log("等待私有任务；按 Ctrl+C 停止。\n");

  while (true) {
    while (active.size < concurrency) {
      const payload = await pollTask(config);
      if (!payload.task) break;
      const taskPromise = runOne(config, payload.task).finally(() => active.delete(taskPromise));
      active.add(taskPromise);
    }

    if (options.once) {
      if (active.size) await Promise.allSettled([...active]);
      return;
    }
    await sleep(active.size ? 1_000 : (options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS));
  }
}

export async function resumeLocalConversation(taskDirectory, message, config) {
  const session = await loadSession(taskDirectory);
  if (!session?.threadId) throw new Error("该任务没有可恢复的本地 Codex 线程。");
  const task = { id: path.basename(taskDirectory), prompt: message };
  const result = await runCodexTurn({
    taskDirectory,
    prompt: message,
    config,
    previousThreadId: session.threadId,
  });
  console.log(`已继续本地线程：${result.threadId}`);
  return task;
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
        if (session.threadId) sessions.push({ taskId: entry.name, ...session });
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
