import path from "node:path";
import { loadSecret } from "./state.mjs";
import { normalizeAgent, platformId } from "./constants.mjs";

export function normalizeSite(value) {
  if (!value) throw new Error("缺少站点地址");
  const site = String(value).trim().replace(/\/+$/, "");
  const url = new URL(site);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("站点地址必须是 http 或 https URL");
  return site;
}

async function jsonFromResponse(response) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(payload.error || `站点请求失败（${response.status}）`);
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
  return jsonFromResponse(response);
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
        agent: selectedAgent,
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

export async function pollTask(config) {
  return siteRequest(config, "/api/runner/poll", { method: "GET" });
}

export async function sendEvent(config, taskId, stage, progress, message) {
  return siteRequest(config, "/api/runner/events", {
    method: "POST",
    body: JSON.stringify({ taskId, stage, progress, message }),
  });
}

export async function completeTask(config, taskId, status, summary = "", error = "") {
  return siteRequest(config, "/api/runner/complete", {
    method: "POST",
    body: JSON.stringify({ taskId, status, summary, error }),
  });
}

export async function uploadArtifact(config, taskId, filename, content) {
  const form = new FormData();
  form.set("taskId", taskId);
  form.set("artifact", new Blob([content]), path.basename(filename));
  return siteRequest(config, "/api/runner/artifacts", { method: "POST", body: form });
}
