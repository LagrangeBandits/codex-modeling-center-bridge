# 共享建模契约同步说明

Bridge 将建模网站的 HTTP、鉴权头、任务字段兼容、消息/取消、用量白名单和错误解析统一到内置的共享快照中。运行时不依赖共享仓库，也不会读取共享仓库中的凭据或用户状态。

当前快照：

- 来源项目：`modeling-platform-contracts`
- 来源分支：`codex/contracts-sdk-v1`
- 来源提交：`00a02e5902e350c0b1dca4bdda928de7b7ca2f91`
- 快照目录：`src/vendor/modeling-platform-contracts/2f61b5e/`

快照目录同时保留 `SOURCE.md`，用于发布后追溯精确来源。更新时先在本地检出目标共享提交，再执行：

```text
MODELING_PLATFORM_CONTRACTS_SOURCE=/path/to/modeling-platform-contracts node scripts/sync-modeling-platform-contracts.mjs
```

同步脚本会拒绝非预期提交，避免把未审核的共享层代码带入公开 Bridge。若新共享提交不兼容，删除或替换快照目录即可回滚到上一版 Bridge 提交；本地 Agent、Keychain/DPAPI、任务目录、CAD 扫描和并发控制仍由 Bridge 自己负责。

本次 Bridge 在内置快照上增加了向后兼容的 usage sequence、quota/pause、checkpoint/resume 和 capability 字段；这些字段均为可选，旧站点仍使用原有 event/complete/messages/cancel fallback。同步共享源时必须重新检查这些本地扩展，不能把 Bridge 的本地 Agent、凭据或检查点实现移入共享层。
