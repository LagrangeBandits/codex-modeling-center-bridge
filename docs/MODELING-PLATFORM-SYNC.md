# 共享建模契约同步说明

Bridge 将建模网站的 HTTP、鉴权头、任务字段兼容、消息/取消、用量白名单和错误解析统一到内置的共享快照中。运行时不依赖共享仓库，也不会读取共享仓库中的凭据或用户状态。

当前快照：

- 来源项目：`modeling-platform-contracts`
- 来源分支：`codex/contracts-sdk-v1`
- 来源提交：`b50bc727e8722759a2e5cd8ad91854ab746c7d3c`
- 快照目录：`src/vendor/modeling-platform-contracts/b50bc72/`

快照目录同时保留 `SOURCE.md`，用于发布后追溯精确来源。更新时先在本地检出目标共享提交，再执行：

```text
MODELING_PLATFORM_CONTRACTS_SOURCE=/path/to/modeling-platform-contracts node scripts/sync-modeling-platform-contracts.mjs
```

同步脚本会拒绝非预期提交，避免把未审核的共享层代码带入公开 Bridge。若新共享提交不兼容，删除或替换快照目录即可回滚到上一版 Bridge 提交；本地 Agent、Keychain/DPAPI、任务目录、CAD 扫描和并发控制仍由 Bridge 自己负责。

共享层 v0.2.0 现已正式收纳 usage sequence、quota/pause、checkpoint/resume、终态任务清理和 capability 字段；这些字段均为可选，旧站点仍使用原有 event/complete/messages/cancel fallback。Bridge 继续只保留本机 Agent、凭据、任务目录、清理执行和检查点安全边界，不把本地运行时状态写入共享层。
