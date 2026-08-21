const api = window.modelingCenter;
const $ = (id) => document.getElementById(id);

let latestStatus = null;
let latestUpdateState = null;
let environmentBusy = false;
let startingRunner = false;
let feedbackAutomatic = false;
let feedbackContext = {};

function setMessage(message, isError = false) {
  const target = $("statusMessage");
  target.textContent = message || "";
  target.className = isError ? "toast error" : "toast";
}

function setPairingMessage(message, isError = false) {
  const target = $("pairingMessage");
  target.textContent = message || "";
  target.className = isError ? "message error" : "message";
}

function setFeedbackMessage(message, isError = false) {
  const target = $("feedbackMessageStatus");
  target.textContent = message || "";
  target.className = isError ? "message error" : "message";
}

function addLog(line) {
  const log = $("runnerLog");
  if (log.textContent === "等待操作…") log.textContent = "";
  log.textContent = `${log.textContent}${log.textContent ? "\n" : ""}${line}`.slice(-12_000);
  log.scrollTop = log.scrollHeight;
}

function statusValue(ok, value, missing = "未发现") {
  return ok ? `✓ ${value || "已就绪"}` : `— ${missing}`;
}

function platformLabel(value) {
  return { darwin: "macOS", macos: "macOS", win32: "Windows", windows: "Windows", linux: "Linux" }[value] || value || "本机";
}

function agentLabel(value) {
  const labels = {
    codex: "Codex",
    claude: "Claude Code",
    gemini: "Gemini CLI",
    qwen: "Qwen Code",
    trae: "Trae Agent CLI",
    opencode: "OpenCode",
    copilot: "GitHub Copilot CLI",
    aider: "Aider",
  };
  return labels[value] || `${String(value || "Agent").replace(/[._-]+/g, " ")} CLI`;
}

function renderAgentOptions(report, selectedAgent = "codex") {
  const select = $("agent");
  const agents = Array.isArray(report?.agents) ? report.agents : [];
  const values = agents.length ? agents : [
    { id: "codex", label: "Codex", installed: false },
    { id: "claude", label: "Claude Code", installed: false },
  ];
  select.replaceChildren(...values.map((agent) => {
    const option = document.createElement("option");
    option.value = agent.id;
    option.textContent = `${agent.label || agentLabel(agent.id)}${agent.installed ? "" : "（未发现）"}`;
    return option;
  }));
  select.value = values.some((agent) => agent.id === selectedAgent) ? selectedAgent : values[0].id;
}

function renderEnvironment(report) {
  const nodeValue = report.nodeSupported
    ? statusValue(true, report.node)
    : statusValue(false, null, "未发现 Node.js 24+");
  const items = [
    ["平台", platformLabel(report.platform)],
    ["Node.js", nodeValue],
    ["Python", statusValue(Boolean(report.modelingPython), report.modelingPython?.version, "未发现")],
    ["CadQuery", statusValue(report.cadquery?.installed, report.cadquery?.version, "未安装")],
    ...(Array.isArray(report.agents) ? report.agents.map((agent) => [agent.label || agentLabel(agent.id), statusValue(agent.installed, agent.version, "未发现")] ) : []),
    ["云端连接", latestStatus.config.paired ? `✓ ${latestStatus.config.name || "已连接"}` : "— 未连接"],
    ["工作区", latestStatus.config.workspace || "—"],
  ];
  $("environment").replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement("div");
    item.className = "status-item";
    const name = document.createElement("span");
    name.textContent = label;
    const content = document.createElement("strong");
    content.textContent = value;
    item.append(name, content);
    return item;
  }));
}

function renderAgentAvailability(report) {
  const selected = $("agent").value;
  const result = report[selected];
  const target = $("agentAvailability");
  target.className = `agent-availability ${result?.installed ? "ready" : "missing"}`;
  target.textContent = result?.installed
    ? `✓ 已发现 ${agentLabel(selected)}：${result.version || "可用"}`
    : `— 未发现 ${agentLabel(selected)}，请先在本机安装并完成登录。`;
}

function renderCloud(config) {
  const paired = Boolean(config.paired);
  const connectionPill = $("connectionPill");
  connectionPill.className = `status-pill ${paired ? "running" : "neutral"}`;
  connectionPill.textContent = paired ? `已连接 · ${config.name || "本机设备"}` : "尚未连接";
  $("cloudState").textContent = paired ? "已连接" : "尚未连接";
  $("cloudDescription").textContent = paired
    ? "设备已进入云端任务队列，可以领取网站分配的建模任务。"
    : "连接后，这台设备才能领取网站分配的建模任务。";
  $("cloudSiteLabel").textContent = config.site || "尚未设置云端地址";
  for (const id of ["topOpenSiteButton", "heroOpenSiteButton", "openSiteButton"]) $(id).disabled = !config.site;
}

function renderRunner(runner) {
  const badge = $("runnerBadge");
  badge.className = `status-pill ${runner.running ? "running" : "neutral"}`;
  badge.textContent = runner.running
    ? `运行中 · ${agentLabel(runner.agent)}`
    : "未启动";
  $("startButton").disabled = runner.running || startingRunner || environmentBusy;
  $("stopButton").disabled = !runner.running;
  if (runner.output?.length) $("runnerLog").textContent = runner.output.join("\n");
  renderUpdate(latestUpdateState);
}

function renderUpdate(state) {
  if (!state) return;
  latestUpdateState = state;
  const status = state.status || "idle";
  const update = state.update;
  const labels = {
    disabled: "开发模式",
    idle: "待检查",
    checking: "检查中",
    "not-available": "已是最新",
    available: "有新版本",
    downloading: "下载中",
    downloaded: "待安装",
    installing: "安装中",
    error: "检查失败",
  };
  const currentVersion = state.currentVersion && state.currentVersion !== "unknown" ? `v${state.currentVersion}` : "未知";
  $("appVersion").textContent = currentVersion;
  const stateLabel = $("updateState");
  stateLabel.className = `state-label update-state ${status}`;
  stateLabel.textContent = labels[status] || "当前版本";

  let description = "启动后会自动检查公开 Release；下载和安装都需要你的确认。";
  if (status === "disabled") description = "开发模式不会连接更新服务；正式安装包才会检查公开 Release。";
  if (status === "checking") description = "正在检查公开 Release，请稍候…";
  if (status === "not-available") description = "当前已经是最新版本。";
  if (status === "available") description = `发现新版本 v${update?.version || "未知"}，请确认后下载。`;
  if (status === "downloading") description = `正在下载 v${update?.version || "未知"}，Runner 可以继续运行。`;
  if (status === "downloaded") description = latestStatus?.runner?.running
    ? `v${update?.version || "未知"} 已下载完成；请先停止 Runner，再确认重启并安装。`
    : `v${update?.version || "未知"} 已下载完成，可以确认重启并安装。`;
  if (status === "installing") description = "正在准备重启并安装更新…";
  if (status === "error") description = `更新失败：${state.error || "请稍后重试。"}`;
  $("updateDescription").textContent = description;

  const busy = ["checking", "downloading", "installing"].includes(status);
  $("checkUpdateButton").disabled = busy || status === "disabled";
  $("checkUpdateButton").textContent = status === "checking" ? "检查中…" : "检查更新";
  $("releaseNotesButton").disabled = !update?.releaseNotesUrl;
  $("downloadUpdateButton").disabled = status !== "available" || !update?.isNewer;
  $("installUpdateButton").disabled = status !== "downloaded" || Boolean(latestStatus?.runner?.running);

  const progress = state.progress;
  const progressPanel = $("updateProgressPanel");
  progressPanel.hidden = !progress || !["downloading", "downloaded"].includes(status);
  if (progress) {
    const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
    $("updateProgress").textContent = `${percent}%`;
    $("updateProgressBar").style.width = `${percent}%`;
  } else {
    $("updateProgress").textContent = "0%";
    $("updateProgressBar").style.width = "0%";
  }
}

function renderStatus(payload) {
  latestStatus = payload;
  const { config, report, runner } = payload;
  renderAgentOptions(report, config.agent || "codex");
  if (config.agent) $("agent").value = config.agent;
  if (config.site) $("site").value = config.site;
  renderEnvironment(report);
  renderAgentAvailability(report);
  renderCloud(config);
  renderRunner(runner);
}

async function refresh() {
  try {
    renderStatus(await api.getStatus());
    renderUpdate(await api.updateStatus());
    setMessage("");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

function openPairing() {
  if (latestStatus?.config.site) $("site").value = latestStatus.config.site;
  setPairingMessage("");
  const dialog = $("pairingDialog");
  if (!dialog.open) dialog.showModal();
}

function closePairing() {
  const dialog = $("pairingDialog");
  if (dialog.open) dialog.close();
}

function openFeedback(prefill = {}) {
  feedbackAutomatic = Boolean(prefill.automatic);
  feedbackContext = prefill.context && typeof prefill.context === "object" ? prefill.context : {};
  $("feedbackModalTitle").textContent = feedbackAutomatic ? "是否上传异常反馈？" : "反馈异常";
  $("feedbackModalIntro").textContent = feedbackAutomatic
    ? "异常日志已经先保存到本机。你可以上传脱敏摘要帮助改进；选择“仅保留本地日志”则不会上传。"
    : "反馈会先保存到云端建模中心。提交时只会附带脱敏的运行摘要，不会上传站点授权、API 密钥或完整聊天记录。";
  $("feedbackSubmitButton").textContent = feedbackAutomatic ? "上传反馈" : "提交反馈";
  $("closeFeedbackButtonSecondary").textContent = feedbackAutomatic ? "仅保留本地日志" : "取消";
  $("feedbackCategory").value = prefill.category || "cli";
  $("feedbackMessage").value = prefill.message || "";
  setFeedbackMessage(prefill.notice || "");
  const dialog = $("feedbackDialog");
  if (!dialog.open) dialog.showModal();
  $("feedbackMessage")?.focus();
}

function closeFeedback() {
  const dialog = $("feedbackDialog");
  if (dialog.open) dialog.close();
  feedbackAutomatic = false;
  feedbackContext = {};
}

function dismissFeedback() {
  const automatic = feedbackAutomatic;
  closeFeedback();
  if (automatic) setMessage("异常日志已保留在本机，未上传反馈。");
}

async function submitFeedback(event) {
  event.preventDefault();
  const button = $("feedbackSubmitButton");
  const message = $("feedbackMessage").value.trim();
  if (!message) {
    setFeedbackMessage("请先填写异常描述。", true);
    return;
  }
  button.disabled = true;
  setFeedbackMessage("正在提交反馈…");
  try {
    const result = await api.submitFeedback({
      category: $("feedbackCategory").value,
      message,
      context: {
        ...feedbackContext,
        page: "bridge",
        selectedAgent: $("agent").value,
        paired: Boolean(latestStatus?.config?.paired),
      },
    });
    setFeedbackMessage(result?.githubSynced ? "反馈已提交，并已同步到开发反馈库。" : "反馈已保存；开发端将在配置完成后同步。", false);
    $("feedbackMessage").value = "";
    window.setTimeout(closeFeedback, 1_200);
  } catch (error) {
    setFeedbackMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function openSite() {
  try {
    await api.openSite();
    setMessage("已打开云端建模系统。");
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function checkForUpdates() {
  try {
    setMessage("正在检查软件更新…");
    const state = await api.checkForUpdates();
    renderUpdate(state);
    if (state.status === "error") setMessage(state.error, true);
    else if (state.status === "available") setMessage(`发现新版本 v${state.update?.version || "未知"}。`);
    else if (state.status === "not-available") setMessage("当前已经是最新版本。");
    else if (state.status === "disabled") setMessage("开发模式不会检查真实更新。", true);
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function downloadUpdate() {
  try {
    setMessage("正在下载软件更新…");
    const state = await api.downloadUpdate();
    renderUpdate(state);
    if (state.status === "error") setMessage(state.error, true);
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function installUpdate() {
  if (latestStatus?.runner?.running) {
    setMessage("Runner 正在运行。请先停止 Runner，再确认重启并安装。", true);
    return;
  }
  try {
    const state = await api.installUpdate();
    renderUpdate(state);
    if (state.status === "error") setMessage(state.error, true);
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function openUpdateNotes() {
  try {
    await api.openUpdateNotes();
  } catch (error) {
    setMessage(error.message || String(error), true);
  }
}

async function prepareEnvironment() {
  if (environmentBusy) return;
  environmentBusy = true;
  $("repairEnvironmentButton").disabled = true;
  $("environmentProgress").textContent = "正在准备环境，请不要关闭软件…";
  setMessage("正在安装或修复本机建模环境…");
  renderRunner(latestStatus?.runner || { running: false });
  try {
    const result = await api.prepareEnvironment();
    if (result?.status) renderStatus(result.status);
    $("environmentProgress").textContent = "工作环境已准备完成，可以重新刷新状态或启动 Runner。";
    setMessage("本机建模环境已准备完成。");
  } catch (error) {
    $("environmentProgress").textContent = `准备失败：${error.message || error}`;
    setMessage(error.message || String(error), true);
  } finally {
    environmentBusy = false;
    $("repairEnvironmentButton").disabled = false;
    if (latestStatus) renderRunner(latestStatus.runner);
  }
}

async function submitPairing(event) {
  event.preventDefault();
  const button = $("pairButton");
  button.disabled = true;
  setPairingMessage("正在验证配对码并保存本机安全凭据…");
  try {
    const result = await api.pair({
      site: $("site").value.trim(),
      code: $("code").value.trim(),
      siteAuth: $("siteAuth").value,
      name: $("deviceName").value.trim(),
      agent: $("agent").value,
    });
    $("code").value = "";
    $("siteAuth").value = "";
    renderStatus(result.status);
    closePairing();
    setMessage(`连接成功：${result.response.name || "设备已连接"}`);
  } catch (error) {
    setPairingMessage(error.message || String(error), true);
  } finally {
    button.disabled = false;
  }
}

async function startRunner() {
  if (startingRunner) return;
  startingRunner = true;
  renderRunner(latestStatus?.runner || { running: false });
  setMessage("正在启动本地 Runner…");
  try {
    const state = await api.startRunner({ agent: $("agent").value });
    if (latestStatus) latestStatus.runner = state;
    renderRunner(state);
    addLog(`已启动 ${agentLabel(state.agent)} Runner。`);
    setMessage("本地 Runner 已启动，正在等待云端任务。");
  } catch (error) {
    setMessage(error.message || String(error), true);
    addLog(`启动失败：${error.message || error}`);
  } finally {
    startingRunner = false;
    if (latestStatus) renderRunner(latestStatus.runner);
  }
}

async function stopRunner() {
  const state = await api.stopRunner();
  if (latestStatus) latestStatus.runner = state;
  renderRunner(state);
  addLog("已请求停止 Runner。已有任务会由网站按失败/超时策略处理。");
}

$("refreshButton").addEventListener("click", refresh);
$("repairEnvironmentButton").addEventListener("click", prepareEnvironment);
$("heroPairButton").addEventListener("click", openPairing);
$("openPairingButton").addEventListener("click", openPairing);
$("topOpenSiteButton").addEventListener("click", openSite);
$("heroOpenSiteButton").addEventListener("click", openSite);
$("openSiteButton").addEventListener("click", openSite);
$("checkUpdateButton").addEventListener("click", checkForUpdates);
$("downloadUpdateButton").addEventListener("click", downloadUpdate);
$("installUpdateButton").addEventListener("click", installUpdate);
$("releaseNotesButton").addEventListener("click", openUpdateNotes);
$("feedbackButton").addEventListener("click", openFeedback);
$("closePairingButton").addEventListener("click", closePairing);
$("cancelPairingButton").addEventListener("click", closePairing);
$("closeFeedbackButton").addEventListener("click", dismissFeedback);
$("closeFeedbackButtonSecondary").addEventListener("click", dismissFeedback);
$("pairingForm").addEventListener("submit", submitPairing);
$("feedbackForm").addEventListener("submit", submitFeedback);
$("startButton").addEventListener("click", startRunner);
$("stopButton").addEventListener("click", stopRunner);
$("agent").addEventListener("change", () => {
  if (latestStatus) renderAgentAvailability(latestStatus.report);
});

api.onRunnerEvent((event) => {
  if (event.type === "output") addLog(`[${event.stream}] ${event.line}`);
  if (event.type === "started") addLog(`Runner 已启动，使用 ${event.agentLabel}。`);
  if (event.type === "stopped") addLog(`Runner 已停止（退出码 ${event.code ?? "未知"}）。`);
  if (event.type === "error") setMessage(event.message, true);
  if (event.type === "error-saved") setMessage(event.message, Boolean(event.saved === false));
  if (event.type === "feedback-prompt") openFeedback({ automatic: true, category: event.category, message: event.message, context: event.context, notice: "日志已保存到本机，请选择是否上传反馈。" });
  if (["started", "stopped"].includes(event.type)) {
    api.runnerStatus().then((state) => {
      if (latestStatus) latestStatus.runner = state;
      renderRunner(state);
    });
  }
});

api.onEnvironmentEvent((event) => {
  if (event.type === "progress") $("environmentProgress").textContent = event.message;
  if (event.type === "complete" && event.status) renderStatus(event.status);
  if (event.type === "error") $("environmentProgress").textContent = `准备失败：${event.message}`;
});

api.onUpdateEvent((state) => {
  renderUpdate(state);
  if (state.status === "error") setMessage(state.error, true);
});

refresh();
