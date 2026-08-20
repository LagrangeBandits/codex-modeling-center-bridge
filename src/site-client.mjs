import path from "node:path";
import { loadSecret } from "./state.mjs";
import { normalizeAgent, platformId } from "./constants.mjs";
import { normalizeTaskMessage, normalizeTaskPriority } from "./task-control.mjs";
import { usagePayload } from "./usage.mjs";

export function normalizeSite(value) {
  if (!value) throw new Error("缺少站点地址");
  const site = String(value).trim().replace(/\/+$/, "");
  const url = new URL(site);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("站点地址必须是 http 或 https URL");
  return site;
}

export function siteAgentValue(agent) {
  return normalizeAgent(agent) === "claude" ? "claude-code" : "codex";
}

async function jsonFromResponse(response, endpoint = "") {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 500) };
  }
  if (!response.ok) {
    const fallback = response.status === 413 && endpoint.includes("/artifacts")
      ? "交付文件上传失败：应用层没有固定单文件上限，但当前站点或网络平台拒绝了这次上传。请减小或拆分 CAD 文件后重试。"
      : `站点请求失败（${response.status}）`;
    const error = new Error(payload.error || fallback);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function authHeaders(config, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const siteBypassToken = options.siteBypassToken || await loadSecret("siteBypassToken");
  const runnerToken = options.runnerToken || await loadSecret("runnerToken");
  if (siteBypassToken) headers["OAI-Sites-Authorization"] = `Bearer ${siteBypassToken}`;
  if (runnerToken) headers.Authorization = `Bearer ${runnerToken}`;
  return headers;
}

export async function siteRequest(config, endpoint, options = {}) {
  const bodyIsForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = await authHeaders(config, options);
  if (options.body !== undefined && !bodyIsForm && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`${normalizeSite(config.site)}${endpoint}`, {
    ...options,
    headers,
  });
  return jsonFromResponse(response, endpoint);
}

export async function pairSite({ site, code, siteAuth, name, agent = "codex", workspace }) {
  const normalized = normalizeSite(site);
  const selectedAgent = normalizeAgent(agent);
  const token = String(siteAuth || process.env.OAI_SITES_BYPASS_TOKEN || "").trim();
  if (!token) throw new Error("缺少站点桥接授权。请从网站复制桥接授权后通过 --site-auth 或 OAI_SITES_BYPASS_TOKEN 传入。");
  if (!/^[A-Z2-9]{8}$/.test(String(code).trim().toUpperCase())) {
    throw new Error("--code 必须是网站生成的 8 位配对码");
  }

  const response = await siteRequest(
    { site: normalized },
    "/api/runner/register",
    {
      method: "POST",
      siteBypassToken: token,
      body: JSON.stringify({
        code: String(code).trim().toUpperCase(),
        name: name || undefined,
        platform: platformId(),
        agent: siteAgentValue(selectedAgent),
      }),
    },
  );

  const { saveConfig, saveSecret } = await import("./state.mjs");
  await saveConfig({
    site: normalized,
    runnerId: response.runnerId,
    name: response.name || name,
    platform: response.platform || platformId(),
    agent: normalizeAgent(response.agent || selectedAgent),
    workspace: workspace ? path.resolve(workspace) : undefined,
  });
  // Keep these writes sequential: the Windows DPAPI/file backend updates one JSON file.
  await saveSecret("siteBypassToken", token);
  await saveSecret("runnerToken", response.token);

  return response;
}

function telemetryPayload(telemetry) {
  if (telemetry === null) return { provider: null, model: null, usage: null };
  const safeText = (value, limit) => {
    if (typeof value !== "string" || !value.trim()) return null;
    const text = value.trim().replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit);
    if (/(?:bearer\s+|sk-[a-z0-9_-]+|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=])/i.test(text)) return null;
    return text;
  };
  const provider = safeText(telemetry?.provider, 80);
  const model = safeText(telemetry?.model, 160);
  return { provider, model, usage: usagePayload(telemetry?.usage) };
}

export async function pollTask(config) {
  return siteRequest(config, "/api/runner/poll", { method: "GET" });
}

export async function sendEvent(config, taskId, stage, progress, message, telemetry = undefined, context = undefined) {
  const payload = { taskId, stage, progress, message };
  if (context && context.priority !== undefined) payload.priority = normalizeTaskPriority(context.priority);
  if (context && context.executionMode) payload.executionMode = String(context.executionMode).slice(0, 20);
  if (telemetry !== undefined) Object.assign(payload, telemetryPayload(telemetry));
  return siteRequest(config, "/api/runner/events", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function completeTask(config, taskId, status, summary = "", error = "", telemetry = undefined, context = undefined) {
  const payload = { taskId, status, summary, error };
  if (context && context.priority !== undefined) payload.priority = normalizeTaskPriority(context.priority);
  if (context && context.executionMode) payload.executionMode = String(context.executionMode).slice(0, 20);
  if (telemetry !== undefined) Object.assign(payload, telemetryPayload(telemetry));
  return siteRequest(config, "/api/runner/complete", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function sendHeartbeat(config, heartbeat) {
  return siteRequest(config, "/api/runner/heartbeat", {
    method: "POST",
    body: JSON.stringify(heartbeat),
  });
}

function taskEndpoint(taskId, cursor) {
  const query = new URLSearchParams({ taskId: String(taskId) });
  if (cursor) query.set("after", String(cursor));
  return `/api/runner/messages?${query.toString()}`;
}

/** Optional interactive bridge. A 404/405 is handled by the Runner as an old site. */
export async function pollTaskControl(config, taskId, cursor = null) {
  return siteRequest(config, taskEndpoint(taskId, cursor), { method: "GET" });
}

/** Send a redacted assistant summary to a site that stores task-local messages. */
export async function sendTaskMessage(config, taskId, message, options = {}) {
  const normalized = normalizeTaskMessage({ role: options.role || "assistant", content: message }, "assistant");
  if (!normalized) throw new Error("网页消息为空，未发送。");
  return siteRequest(config, "/api/runner/messages", {
    method: "POST",
    body: JSON.stringify({
      taskId,
      role: normalized.role,
      message: normalized.content,
      after: options.cursor || undefined,
    }),
  });
}

/** Report cancellation when the site has the optional endpoint. Legacy sites fall back to failed. */
export async function cancelTask(config, taskId, reason = "", telemetry = undefined, context = undefined) {
  const normalizedReason = normalizeTaskMessage(String(reason || "任务已取消"), "system")?.content || "任务已取消";
  try {
    return await siteRequest(config, "/api/runner/cancel", {
      method: "POST",
      body: JSON.stringify({ taskId, reason: normalizedReason, ...telemetryPayload(telemetry) }),
    });
  } catch (error) {
    if (error?.status !== 404 && error?.status !== 405) throw error;
    try {
      return await completeTask(config, taskId, "cancelled", "", normalizedReason, telemetry, context);
    } catch (cancelledError) {
      if (cancelledError?.status !== 400 && cancelledError?.status !== 422) throw cancelledError;
      return completeTask(config, taskId, "failed", "", `任务已取消；当前旧站点不支持 cancelled 状态。${normalizedReason}`, telemetry, context);
    }
  }
}

export async function reportTaskUsage(config, taskId, telemetry) {
  const payload = { taskId, ...telemetryPayload(telemetry) };
  return siteRequest(config, "/api/runner/usage", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function uploadArtifact(config, taskId, filename, content, maxBytes = 0) {
  const size = content?.byteLength ?? content?.length ?? 0;
  if (size <= 0) throw new Error(`交付文件“${path.basename(filename)}”为空，未上传。`);
  if (Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) {
    const error = new Error(`交付文件“${path.basename(filename)}”大小为 ${formatBytes(size)}，超过当前单文件上限 ${formatBytes(maxBytes)}。请减小或拆分 CAD 文件后重试。`);
    error.status = 413;
    error.code = "ARTIFACT_TOO_LARGE";
    throw error;
  }
  const form = new FormData();
  form.set("taskId", taskId);
  form.set("artifact", new Blob([content]), path.basename(filename));
  return siteRequest(config, "/api/runner/artifacts", { method: "POST", body: form });
}
