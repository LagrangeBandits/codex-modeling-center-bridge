import {
  normalizeControlPayload,
  normalizeCheckpoint,
  normalizeCleanupPayload,
  normalizeCleanupRequest,
  normalizeModelPreference,
  normalizeSite,
  normalizeTaskMessage,
  normalizeTaskPriority,
  normalizeTelemetry,
  normalizeQuotaState,
  usagePayload,
} from "./contracts.mjs";

function redactedText(value, limit = 500) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|ghp|github_pat)-[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/(api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, limit);
}

function responseError(response, payload, endpoint) {
  const fallback = response.status === 413 && endpoint.includes("/artifacts")
    ? "交付文件上传被站点或网络平台拒绝。"
    : `站点请求失败（${response.status}）`;
  const error = new Error(redactedText(payload?.error || payload?.message || fallback));
  error.status = response.status;
  error.endpoint = endpoint;
  error.payload = { error: redactedText(payload?.error || payload?.message || fallback) };
  return error;
}

async function decodeResponse(response, endpoint) {
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 500) };
  }
  if (!response.ok) throw responseError(response, payload, endpoint);
  return payload;
}

function joinEndpoint(endpoint) {
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function safeHeaderValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createModelingClient({
  site,
  runnerToken = null,
  siteBypassToken = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const baseUrl = normalizeSite(site);
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的 fetch。");

  const usageSequenceSent = new Map();
  const usageSequenceInFlight = new Map();

  async function request(endpoint, options = {}) {
    const path = joinEndpoint(endpoint);
    const headers = { ...(options.headers || {}) };
    const auth = options.auth || "runner";
    const runner = safeHeaderValue(options.runnerToken ?? runnerToken);
    const bypass = safeHeaderValue(options.siteBypassToken ?? siteBypassToken);
    if ((auth === "runner" || auth === "both") && runner) headers.Authorization = `Bearer ${runner}`;
    if ((auth === "site" || auth === "both") && bypass) headers["OAI-Sites-Authorization"] = `Bearer ${bypass}`;
    const bodyIsForm = typeof FormData !== "undefined" && options.body instanceof FormData;
    if (options.body !== undefined && !bodyIsForm && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

    let signal = options.signal;
    let timer = null;
    if (!signal && Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof AbortSignal?.timeout === "function") signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...options, auth: undefined, runnerToken: undefined, siteBypassToken: undefined, headers, signal });
      return decodeResponse(response, path);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const telemetry = (value) => value === undefined ? {} : normalizeTelemetry(value);

  return {
    site: baseUrl,
    request,
    register(payload) {
      return request("/api/runner/register", { method: "POST", auth: "site", body: JSON.stringify(payload) });
    },
    poll(options = {}) {
      return request("/api/runner/poll", { method: "GET", ...options });
    },
    getCleanup() {
      return request("/api/runner/cleanup", { method: "GET" }).then((payload) => normalizeCleanupPayload(payload));
    },
    acknowledgeCleanup(requestValue, result = {}) {
      const requestValueNormalized = normalizeCleanupRequest(requestValue);
      if (!requestValueNormalized) throw new Error("无效的本地任务清理回执，未发送。");
      const outcome = ["deleted", "not_found", "rejected"].includes(String(result.outcome || "").trim().toLowerCase())
        ? String(result.outcome).trim().toLowerCase()
        : "rejected";
      return request("/api/runner/cleanup/ack", {
        method: "POST",
        body: JSON.stringify({
          requestId: requestValueNormalized.requestId,
          taskId: requestValueNormalized.taskId,
          taskStatus: requestValueNormalized.taskStatus,
          outcome,
          reasonCode: redactedText(result.reasonCode, 120) || undefined,
        }),
      });
    },
    sendEvent(taskId, stage, progress, message, value = undefined, context = undefined) {
      const payload = { taskId, stage, progress, message };
      if (context?.priority !== undefined) payload.priority = normalizeTaskPriority(context.priority);
      if (context?.executionMode) payload.executionMode = String(context.executionMode).slice(0, 20);
      if (value !== undefined) Object.assign(payload, telemetry(value));
      return request("/api/runner/events", { method: "POST", body: JSON.stringify(payload) });
    },
    complete(taskId, status, summary = "", error = "", value = undefined, context = undefined) {
      const payload = { taskId, status, summary, error };
      if (context?.priority !== undefined) payload.priority = normalizeTaskPriority(context.priority);
      if (context?.executionMode) payload.executionMode = String(context.executionMode).slice(0, 20);
      if (value !== undefined) Object.assign(payload, telemetry(value));
      return request("/api/runner/complete", { method: "POST", body: JSON.stringify(payload) });
    },
    heartbeat(payload) {
      return request("/api/runner/heartbeat", { method: "POST", body: JSON.stringify(payload) });
    },
    getMessages(taskId, cursor = null) {
      const query = new URLSearchParams({ taskId: String(taskId) });
      if (cursor) query.set("after", String(cursor));
      return request(`/api/runner/messages?${query.toString()}`, { method: "GET" }).then((payload) => normalizeControlPayload(payload));
    },
    sendMessage(taskId, message, options = {}) {
      const normalized = normalizeTaskMessage({ role: options.role || "assistant", content: message }, "assistant");
      if (!normalized) throw new Error("网页消息为空，未发送。");
      return request("/api/runner/messages", {
        method: "POST",
        body: JSON.stringify({ taskId, role: normalized.role, message: normalized.content, after: options.cursor || undefined }),
      });
    },
    cancel(taskId, reason = "任务已取消", value = undefined) {
      const normalized = normalizeTaskMessage(String(reason || "任务已取消"), "system")?.content || "任务已取消";
      return request("/api/runner/cancel", {
        method: "POST",
        body: JSON.stringify({ taskId, reason: normalized, ...telemetry(value) }),
      });
    },
    async cancelWithFallback(taskId, reason = "任务已取消", value = undefined, context = undefined) {
      try {
        return await this.cancel(taskId, reason, value);
      } catch (error) {
        if (error?.status !== 404 && error?.status !== 405) throw error;
        try {
          return await this.complete(taskId, "cancelled", "", reason, value, context);
        } catch (cancelError) {
          if (cancelError?.status !== 400 && cancelError?.status !== 422) throw cancelError;
          return this.complete(taskId, "failed", "", `任务已取消；当前旧站点不支持 cancelled 状态。${reason}`, value, context);
        }
      }
    },
    checkpoint(taskId, value = {}) {
      const source = value && typeof value === "object" ? value : {};
      const checkpoint = normalizeCheckpoint(source.checkpoint ?? source);
      const payload = {
        taskId,
        attemptId: source.attemptId || source.attempt_id || checkpoint?.attemptId || undefined,
        checkpoint,
        checkpointId: checkpoint?.checkpointId || undefined,
        status: "paused",
        quotaState: normalizeQuotaState(source.quotaState ?? source.quota_state),
        pauseReason: redactedText(source.pauseReason ?? source.pause_reason ?? source.reasonCode ?? source.reason, 240),
        retryAfter: source.retryAfter ?? source.retry_after ?? undefined,
        resumeSupported: source.resumeSupported ?? checkpoint?.resumeSupported ?? null,
        resumeFrom: source.resumeFrom ?? source.resume_from ?? checkpoint?.resumeFrom ?? undefined,
        provider: redactedText(source.provider, 80) || "unknown",
        model: redactedText(source.model, 160) || null,
        usage: usagePayload(source.usage),
      };
      return request("/api/runner/checkpoint", { method: "POST", body: JSON.stringify(payload) });
    },
    async checkpointWithFallback(taskId, value = {}) {
      try {
        return await this.checkpoint(taskId, value);
      } catch (error) {
        if (error?.status !== 404 && error?.status !== 405) throw error;
        const source = value && typeof value === "object" ? value : {};
        const checkpoint = normalizeCheckpoint(source.checkpoint ?? source);
        const payload = {
          taskId,
          attemptId: source.attemptId || source.attempt_id || checkpoint?.attemptId || undefined,
          checkpoint,
          checkpointId: checkpoint?.checkpointId || undefined,
          status: "paused",
          quotaState: normalizeQuotaState(source.quotaState ?? source.quota_state),
          pauseReason: redactedText(source.pauseReason ?? source.pause_reason ?? source.reasonCode ?? source.reason, 240),
          retryAfter: source.retryAfter ?? source.retry_after ?? undefined,
          resumeSupported: source.resumeSupported ?? checkpoint?.resumeSupported ?? null,
          resumeFrom: source.resumeFrom ?? source.resume_from ?? checkpoint?.resumeFrom ?? undefined,
          provider: redactedText(source.provider, 80) || "unknown",
          model: redactedText(source.model, 160) || null,
          usage: usagePayload(source.usage),
        };
        try {
          return await request("/api/runner/pause", { method: "POST", body: JSON.stringify(payload) });
        } catch (pauseError) {
          if (pauseError?.status === 404 || pauseError?.status === 405) {
            const fallback = await this.complete(taskId, "paused", "", payload.pauseReason || "任务已安全暂停。", source, {
              priority: source.priority,
              executionMode: source.executionMode,
            });
            return { ...fallback, legacyFallback: true };
          }
          throw pauseError;
        }
      }
    },
    resume(taskId, value = {}) {
      const source = value && typeof value === "object" ? value : {};
      return request("/api/runner/resume", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          attemptId: source.attemptId || source.attempt_id || undefined,
          checkpointId: source.checkpointId || source.checkpoint_id || undefined,
          resumeFrom: source.resumeFrom || source.resume_from || undefined,
        }),
      });
    },
    async reportUsage(taskId, value) {
      const safe = telemetry(value);
      const sequence = Number.isSafeInteger(safe.sequence) ? safe.sequence : null;
      const key = String(taskId);
      const last = usageSequenceSent.get(key);
      if (sequence !== null && last !== undefined && sequence <= last) {
        return { skipped: true, duplicate: true, sequence };
      }
      const inFlightKey = sequence === null ? null : `${key}:${sequence}`;
      if (inFlightKey && usageSequenceInFlight.has(inFlightKey)) return usageSequenceInFlight.get(inFlightKey);
      const requestPromise = request("/api/runner/usage", { method: "POST", body: JSON.stringify({ taskId, ...safe }) })
        .then((response) => {
          if (sequence !== null) usageSequenceSent.set(key, Math.max(usageSequenceSent.get(key) ?? -1, sequence));
          return response;
        })
        .finally(() => {
          if (inFlightKey) usageSequenceInFlight.delete(inFlightKey);
        });
      if (inFlightKey) usageSequenceInFlight.set(inFlightKey, requestPromise);
      return requestPromise;
    },
    uploadArtifact(taskId, filename, content) {
      const size = content?.byteLength ?? content?.length ?? 0;
      if (size <= 0) throw new Error(`交付文件“${String(filename)}”为空，未上传。`);
      const form = new FormData();
      form.set("taskId", String(taskId));
      form.set("artifact", new Blob([content]), String(filename).split(/[\\/]/).pop());
      return request("/api/runner/artifacts", { method: "POST", body: form });
    },
  };
}

export { usagePayload };
