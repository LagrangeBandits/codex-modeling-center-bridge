# CAD 任务交接规范

这份规范用于云端建模系统、Runner 和本地 Agent 之间的单任务交接。它不授权跨设备复制个人 Agent 会话，也不改变网站的任务所有权。

## 交接字段

- `taskId`：只允许安全的任务标识，作为本地任务目录名。
- `priority`：由网站队列决定；Runner 只回传和展示，不在本地重新排序。
- `executionMode`：`plan` 只输出建模方案，`direct` 才允许运行 CAD 并上传交付文件。
- `agent`：安全 Agent ID，例如 `codex`、`claude-code`、`gemini`、`qwen`、`trae`、`opencode`、`copilot` 或 `aider`；必须与设备配对的本地 CLI 匹配。
- `modelPreference`：可选的 provider、model、reasoning effort 和兼容端点；不得放入 API key、Cookie 或 OAuth 内容。
- `messages`：只属于当前任务的用户补充消息；消息有长度上限，必须经过规范化。

## Agent 执行边界

每个任务使用自己的工作目录和本地会话记录。Agent 必须读取任务目录中的 `AGENTS.md`，将可复现脚本、验证报告和 CAD 文件放到 `artifacts/`。不得读取其他任务目录、个人聊天历史、Keychain/DPAPI 内容或 Harness 状态。

`plan` 模式必须使用只读沙箱/权限：不运行 Python、CadQuery、CAD 命令，不创建或修改模型文件，不上传文件。方案完成后以 `planned` 结算，网站确认后再重新排队 `direct`。

`direct` 模式需要真实生成并验证 STEP、STL 或其他约定 CAD 文件。Runner 在上传前再次检查取消信号、文件大小和 CAD 扩展名；取消任务不会继续上传剩余文件。

## 取消与网页消息

Runner 优先读取 `GET /api/runner/messages?taskId=...` 的 `cancelRequestedAt` 和用户补充消息，在 Agent 启动、流式事件、文件上传前和最终结算前检查。收到取消后通过 `/api/runner/cancel` 结算，并终止当前 Codex SDK/Claude Code 回合。站点若暂不支持可选控制接口，Runner 保持旧轮询流程，不伪造取消成功。

方案摘要可通过 `POST /api/runner/messages` 回传为 assistant 消息，但网站仍以 `/api/runner/complete` 的 `summary` 和 `planned` 状态为正式结果。消息桥接失败不能覆盖已完成的本地建模结果。

## 交接验收

交给网站维护者的结果至少包括：

1. 任务状态和优先级是否与网站一致；
2. Agent、真实 provider/model 和可用 token usage；无法可靠识别时明确为 `unknown`/`null`；
3. `plan` 是否未产生或上传 CAD 文件，`direct` 是否存在验证后的 CAD 文件；
4. 取消时是否在安全检查点停止；
5. 本地日志是否没有密钥、登录状态、完整 transcript 或未脱敏命令参数。

## 配额暂停与恢复

余额不足、限流或站点明确 `pauseRequested` 时，Runner 会先写入不含 transcript、密钥和完整本地路径的 `checkpoint.json`，再回传 `checkpointId`、`attemptId`、阶段、聚合 usage、`resumeSupported` 和原因码。只有 Agent 真正支持会话恢复时才允许标记可恢复；不支持恢复的 CLI 不得伪装成可继续执行。
