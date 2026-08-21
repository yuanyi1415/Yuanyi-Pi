# Learnings

## 2026-08-21

- **S6-01 测试环境事实**：opencode 内置模型（kimi-k2.6 等）的 `hasConfiguredAuth` 恒为 true（本地网关，无需 API key），临时 agentDir 下 Pi preflight 必然通过。因此"无模型/无认证 → preflight rejected"无法用真实 Pi 栈在单测中确定性触发；改用 fake inner（替换 `(adapter as any).inner`）验证 adapter 的 preflightResult 契约映射，Gateway 事务边界用 fake runtime manager 验证。
- **canonical 路径陷阱**：`mkdtempSync` 返回 `/var/folders/...` 而 `realpathSync` 得到 `/private/var/folders/...`。metadata 里项目路径是 canonical 化的，API 调用若传 raw 路径直接字符串比较会 miss。removeProject 必须同时尝试 canonical 与 raw 两种路径。
- **未落盘 Session 无法 delete**：`resolveNew`/`prepareNew` 创建 runtime 后，Pi 无消息不写 session 文件，`deleteSession` 依赖 `findSessionFile` 会 throw。测试"删除关联 Session 后项目可删"必须先用 `SessionManager.create + appendMessage` 构造落盘 Session。
- **Pi 原生 `preflightResult(success)` 契约**：`AgentSession.prompt(text, { preflightResult })` 在 preflight 失败时回调 `false` 并 throw；preflight 成功后回调 `true` 再进入 agent loop（执行期错误不会回调 false）。事务边界应依据该回调而非"是否 throw"。
- **dev/prod 脚本不同源**：prod 的 `personal-runtime.sh` 是手工维护的生产模式版（PORT=8770 / ~/.pi/agent），与 git 跟踪的 dev 版（8771 / ~/.pi-dev）内容不同，存在本机绝对路径绑定（S6-04）；按红线不直接改 prod，记录为工程债务。
- **SDK `SessionManager.listAll()` 无参只扫 sessions/ 子目录**：扁平 `.jsonl` 会漏扫。Personal Runtime 必须显式传 `sessionDir: join(agentDir, "sessions")`，否则重启后历史 Session 恢复 404（S6-03 真实冒烟发现，已修复 index.ts）。
- **S6-01 Commit Point 验证技巧**：用 Deferred/Controlled Promise 让 fake `sendCommand` 在 `onPromptPreflight(true)` 后挂起，即可断言“Agent 执行未结束时 Session 已 commit+finalize”，无需真实 LLM。
- **沙箱网络限制**：直接执行 `curl` 被策略拦截，改用 `node -e fetch()` 或脚本内 curl（脚本内 curl 可运行）。
