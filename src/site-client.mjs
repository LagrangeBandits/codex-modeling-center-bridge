import path from "node:path";
import { loadSecret } from "./state.mjs";
import { normalizeAgent, platformId } from "./constants.mjs";
import { createModelingClient } from "./vendor/modeling-platform-contracts/2f61b5e/sdk.mjs";
import {
  normalizeSite as normalizeContractSite,
  normalizeTaskMessage,
} from "./vendor/modeling-platform-contracts/2f61b5e/contracts.mjs";

export function normalizeSite(value) {
  return normalizeContractSite(value);
}

export function siteAgentValue(agent) {
  const normalized = normalizeAgent(agent);
  return normalized === "claude" ? "claude-code" : normalized;
}

function legacyFetch(fetchImpl, siteBypassToken) {
  return async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (siteBypassToken && !headers["OAI-Sites-Authorization"]) {
      headers["OAI-Sites-Authorization"] = `Bearer ${siteBypassToken}`;
    }
    return fetchImpl(url, { ...options, headers });
  };
}

async function modelingClient(config, options = {}) {
  const siteBypassToken = options.siteBypassToken === undefined
    ? await loadSecret("siteBypassToken")
    : options.siteBypassToken;
  const runnerToken = options.runnerToken === undefined
    ? await loadSecret("runnerToken")
    : options.runnerToken;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的 fetch。");
  return createModelingClient({
    site: normalizeSite(config.site),
    runnerToken,
    siteBypassToken,
    fetchImpl: legacyFetch(fetchImpl, siteBypassToken),
    timeoutMs: options.timeoutMs,
  });
}

export async function siteRequest(config, endpoint, options = {}) {
  const {
    fetchImpl,
    timeoutMs,
    runnerToken,
    siteBypassToken,
    ...requestOptions
  } = options;
  const client = await modelingClient(config, {
    fetchImpl,
    timeoutMs,
    runnerToken,
    siteBypassToken,
  });
  return client.request(endpoint, requestOptions);
}

export async function pairSite({ site, code, siteAuth, name, agent = "codex", workspace }) {
  const normalized = normalizeSite(site);
  const selectedAgent = normalizeAgent(agent);
  const token = String(siteAuth || process.env.OAI_SITES_BYPASS_TOKEN || "").trim();
  if (!token) throw new Error("缺少站点桥接授权。请从网站复制桥接授权后通过 --site-auth 或 OAI_SITES_BYPASS_TOKEN 传入。");
  if (!/^[A-Z2-9]{8}$/.test(String(code).trim().toUpperCase())) {
    throw new Error("--code 必须是网站生成的 8 位配对码");
  }

  const client = await modelingClient({ site: normalized }, { siteBypassToken: token, runnerToken: null });
  const response = await client.register({
    code: String(code).trim().toUpperCase(),
    name: name || undefined,
    platform: platformId(),
    agent: siteAgentValue(selectedAgent),
  });

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

export async function pollTask(config, options = {}) {
  const {
    fetchImpl,
    timeoutMs,
    runnerToken,
    siteBypassToken,
    ...pollOptions
  } = options;
  const client = await modelingClient(config, { fetchImpl, timeoutMs, runnerToken, siteBypassToken });
  return client.poll(pollOptions);
}

export async function sendEvent(config, taskId, stage, progress, message, telemetry = undefined, context = undefined) {
  const client = await modelingClient(config);
  return client.sendEvent(taskId, stage, progress, message, telemetry, context);
}

export async function completeTask(config, taskId, status, summary = "", error = "", telemetry = undefined, context = undefined) {
  const client = await modelingClient(config);
  return client.complete(taskId, status, summary, error, telemetry, context);
}

export async function sendHeartbeat(config, heartbeat) {
  const client = await modelingClient(config);
  return client.heartbeat(heartbeat);
}

/** Optional interactive bridge. A 404/405 is handled by the Runner as an old site. */
export async function pollTaskControl(config, taskId, cursor = null) {
  const client = await modelingClient(config);
  return client.getMessages(taskId, cursor);
}

/** Send a redacted assistant summary to a site that stores task-local messages. */
export async function sendTaskMessage(config, taskId, message, options = {}) {
  const client = await modelingClient(config);
  return client.sendMessage(taskId, message, options);
}

/** Report cancellation when the site has the optional endpoint. Legacy sites fall back to failed. */
export async function cancelTask(config, taskId, reason = "", telemetry = undefined, context = undefined) {
  const client = await modelingClient(config);
  const normalizedReason = normalizeTaskMessage(String(reason || "任务已取消"), "system")?.content || "任务已取消";
  return client.cancelWithFallback(taskId, normalizedReason, telemetry, context);
}

export async function reportTaskUsage(config, taskId, telemetry) {
  const client = await modelingClient(config);
  return client.reportUsage(taskId, telemetry);
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
  const client = await modelingClient(config);
  return client.uploadArtifact(taskId, path.basename(filename), content);
}
