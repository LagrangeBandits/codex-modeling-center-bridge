# Modeling Center Bridge

给朋友接入私有云建模网站的跨平台本地程序。Mac 和 Windows 共用同一套 Node.js Runner 与任务协议，桌面界面使用 Electron；网站只负责私有白名单、任务队列、状态和交付文件。

## 产品边界

- 程序只连接私有建模网站，不是个人 Codex/Claude 聊天同步器。
- 每个网站任务在领取设备上使用一个任务绑定的本地 Agent 会话；不会扫描、上传或复制用户完整的 Codex/Claude 历史。
- 建模 Agent 可选 `Codex` 或 `Claude Code`。它们只是本机建模引擎选项，二者的登录状态和额度仍由设备使用者自己管理。
- 新设备可以由安装脚本准备 Node.js 24、Python 3.11、虚拟环境和 CadQuery/OpenCascade；Agent CLI 的安装和首次登录由设备使用者确认完成。
- 生成 STEP、参数化脚本、验证报告和脱敏摘要后，Runner 才会把允许的交付文件上传到网站。

## Agent 与登录边界

Codex 和 Claude Code 都从本机启动，网站不会获得任何 Agent 登录状态。

- Codex：设备使用者按 [OpenAI 官方 Codex CLI 文档](https://learn.chatgpt.com/docs/codex/cli) 安装并完成自己的登录。
- Claude Code：设备使用者按 [Claude Code 官方安装文档](https://code.claude.com/docs/en/getting-started) 安装并完成自己的本地登录。
- 不要设置共享 API key 来替代本机登录。Codex Runner 会提示 `OPENAI_API_KEY` 可能改变计费路径；Claude 子进程会移除 `ANTHROPIC_API_KEY` 和 `ANTHROPIC_AUTH_TOKEN`。
- Claude Code 的沙箱在 macOS/Linux 可用，原生 Windows 不提供相同的内置沙箱。Windows 无人值守使用 Claude Agent 时，应先准备 WSL2；不满足沙箱条件时程序会失败并提示，不会自动降级到无保护执行。Windows 本机可选择 Codex。

## 新设备安装

安装脚本会优先使用已有 Node.js 24+；如果没有，则把固定版本的官方 Node.js 24 运行时下载到当前用户目录并校验 SHA-256，不写入系统目录。随后优先使用已有 Python 3.11+；若没有，会准备用户目录 uv，用 uv 管理 Python 3.11，再创建独立虚拟环境安装 CadQuery。失败时已有虚拟环境不会被删除。

### macOS

```bash
git clone https://github.com/LagrangeBandits/codex-modeling-center-bridge.git
cd codex-modeling-center-bridge
chmod +x scripts/install-macos.sh
./scripts/install-macos.sh
```

### Windows PowerShell

```powershell
git clone https://github.com/LagrangeBandits/codex-modeling-center-bridge.git
Set-Location codex-modeling-center-bridge
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

安装脚本会运行 `npm ci`，准备用户目录 Node 运行时，并执行本地建模环境引导。也可以分步执行：

```bash
node src/cli.mjs doctor
node src/cli.mjs bootstrap --yes
```

## 启动桌面程序

在源码目录安装依赖后运行：

```bash
npm run desktop:dev
```

桌面界面提供本机状态、Agent 选择、临时配对窗口、云端系统入口以及 Runner 启动/停止。新设备可以直接点击“一键安装 / 修复工作环境”，准备用户目录 Node.js 24、Python 3.11 和 CadQuery；Codex/Claude Code 的安装与首次登录仍由设备使用者确认。正式安装包必须在目标平台构建：

```bash
npm run desktop:dist
```

Electron 主进程使用窄 IPC 接口处理文件、配对和 Runner；渲染页面没有 Node 集成。项目要求外部 Node.js 24 运行时，桌面壳不会把 Electron 内置 Node 当作建模 Runner 运行时。

## 下载可安装包

公开 Release 会提供目标平台原生安装包：

- macOS：`.dmg`
- Windows：`.exe`
- `SHA256SUMS.txt`：安装包校验值

当前 Release 使用未签名构建。macOS 首次打开可能需要在“系统设置 → 隐私与安全性”中允许，Windows 可能显示 SmartScreen 提示；这不代表安装包包含网站授权或 Agent 登录信息。正式分发前应补充 Apple Developer 签名/公证和 Windows 代码签名证书。

## 从网站配对

1. 在云端建模系统登录后生成 Runner 一次性配对码。
2. 复制“站点桥接授权”到当前设备；不要把它发到聊天、Issue 或 Git。
3. 在桌面页面点击“连接至云端建模系统”，临时填写网站地址、配对码和授权。授权成功后会写入 macOS Keychain 或 Windows 当前用户 DPAPI，并从页面清空。
4. 配对完成后，可以点击“一键前往建模网站”打开云端系统；配对表单不会常驻主界面。

CLI 用户可以使用下面的方式：

```bash
export OAI_SITES_BYPASS_TOKEN="从网站复制的桥接授权"
node src/cli.mjs pair \
  --agent codex \
  --site https://你的私有网站地址 \
  --code 网站显示的8位配对码 \
  --site-auth "$OAI_SITES_BYPASS_TOKEN" \
  --name "我的 Mac"
node src/cli.mjs start
```

要选择 Claude Code，把 `--agent codex` 改为 `--agent claude`。Windows PowerShell 使用 `$env:OAI_SITES_BYPASS_TOKEN`，不要把授权直接写入 Git 或脚本文件。

也可以合并引导、安装和配对：

```bash
node src/cli.mjs onboard --agent claude --install --yes \
  --site https://你的私有网站地址 \
  --code 网站显示的8位配对码 \
  --site-auth "$OAI_SITES_BYPASS_TOKEN" \
  --start
```

## CLI 维护命令

```bash
node src/cli.mjs doctor
node src/cli.mjs pull
node src/cli.mjs sessions
node src/cli.mjs resume <任务ID> --message "继续验证模型并修复报告中的问题"
node src/cli.mjs start --agent codex --concurrency 1
```

`pull` 只领取一条任务；长期运行用 `start`。每台机器默认一个并发槽位，只有在本机资源足够时才增加并发。

## 本机文件与安全

本机状态位于用户数据目录，而不是仓库：

- macOS：`~/Library/Application Support/CodexModelingCenter/`
- Windows：`%LOCALAPPDATA%\CodexModelingCenter\`

站点桥接授权和 Runner token 保存在操作系统安全存储；任务工作区保存 `REQUEST.md`、`AGENTS.md`、`session.json`、脱敏的 `artifacts/conversation.md` 和原始本地 `events.jsonl`。原始事件只留在本机，网站只接收允许的交付文件和摘要。

不要以管理员身份运行整个 Runner，不要复制任何设备的 Agent 登录目录，不要让不同设备共享工作区。完整安装与回滚注意事项见 [`docs/INSTALL-CHECKLIST.md`](docs/INSTALL-CHECKLIST.md)，架构与站点字段见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 和 [`docs/SITE-PROTOCOL.md`](docs/SITE-PROTOCOL.md)。
