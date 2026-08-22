import fs from "node:fs/promises";
import path from "node:path";
import { isSafeTaskId } from "./constants.mjs";

function outcome(request, outcomeValue, reasonCode = null) {
  return {
    requestId: request?.requestId || null,
    taskId: request?.taskId || null,
    outcome: outcomeValue,
    ...(reasonCode ? { reasonCode } : {}),
  };
}

/**
 * Delete only one direct child of <workspace>/tasks. The requested folder and
 * the tasks root are resolved and checked first; symlink targets are refused.
 */
export async function cleanupTaskDirectory(workspace, request, activeTaskIds = new Set()) {
  if (!request?.taskId || !isSafeTaskId(request.taskId)) return outcome(request, "rejected", "UNSAFE_TASK_ID");
  if (!request?.requestId) return outcome(request, "rejected", "MISSING_REQUEST_ID");
  if (activeTaskIds.has(request.taskId)) return outcome(request, "deferred", "TASK_ACTIVE");

  const declaredTasksDirectory = path.resolve(String(workspace || ""), "tasks");
  let tasksDirectory;
  try {
    tasksDirectory = await fs.realpath(declaredTasksDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return outcome(request, "not_found");
    throw error;
  }
  const taskDirectory = path.resolve(tasksDirectory, request.taskId);
  const relative = path.relative(tasksDirectory, taskDirectory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.dirname(taskDirectory) !== tasksDirectory) {
    return outcome(request, "rejected", "OUTSIDE_TASKS_DIRECTORY");
  }

  let stat;
  try {
    stat = await fs.lstat(taskDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return outcome(request, "not_found");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return outcome(request, "rejected", "TASK_DIRECTORY_NOT_PLAIN_DIRECTORY");

  await fs.rm(taskDirectory, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
  return outcome(request, "deleted");
}
