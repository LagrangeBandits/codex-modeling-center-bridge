# 新设备交接清单

给朋友或另一台设备使用时，按这个顺序交接：

1. 从同一个 GitHub 仓库克隆本程序。
2. macOS 运行 `./scripts/install-macos.sh`，Windows 运行 `Set-ExecutionPolicy -Scope Process Bypass; .\scripts\install-windows.ps1`；脚本会在没有 Node 时准备用户目录 Node 24，并创建 Python 3.11+ / CadQuery 环境。
3. 按 [OpenAI 官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 安装 Codex，并由设备使用者自己运行一次 `codex` 完成 ChatGPT 登录。
4. 从网站生成一次性配对码，并在当前设备短暂设置桥接授权环境变量。
5. 运行 `onboard --install --yes ...` 或再次运行安装脚本，确认 `doctor` 显示 Node 24+、Python 3.11+、CadQuery 和 Codex CLI。
6. 回到网站确认设备状态为在线，再提交一个小型测试任务。
7. 测试成功后，用 `start` 保持设备在线；需要只拉一条任务时用 `pull`。

不要做这些事：

- 不要把 Mac 的 `~/.codex`、Windows 的 Codex 登录目录、`config.json` 或 `secrets.json` 复制给另一台设备。
- 不要把桥接授权或 Runner token 写入 README、Issue、GitHub Actions 日志或聊天。
- 不要同时以管理员身份运行整个 Runner；只有系统依赖安装步骤在需要时接受系统确认。
- 不要让多个设备共享同一个本地工作区；每台设备使用自己的默认工作区。
- 不要把一台设备的本地 `threadId`、`events.jsonl` 或任务目录复制到另一台设备；跨设备只同步网站任务和允许上传的交付文件。
