# Errors

## 2026-08-21

- `SessionSidebar` 的局部 patch 上下文与当前文件不一致；先读取实际片段后改用精确上下文，随后成功应用。
- `SessionRouter` 的合并 patch 因相邻重复行上下文不一致未应用；拆成精确片段后成功应用。
- pi-web 全量测试首次执行出现 1 个失败但输出被截断；下一步用过滤后的失败摘要定位，不能把定向测试全绿当作全量通过。
- zsh 读取带 `[id]` 的 Next 路径时未加引号导致 glob 错误；后续对动态路由路径统一加单引号。
- 首次创建源码包写入统一交付目录时被当前沙箱拒绝；需申请外部写权限后重试，不能改写到项目目录代替交付路径。

## 2026-08-20

- `pi-web` 没有 `typecheck` npm script；后续使用 `./node_modules/.bin/tsc --noEmit` 做 TypeScript 校验。
- 直接用 Node strip-types 加载 `agent-event-stream-gateway.ts` 时，TS 的无扩展名相对导入无法解析；测试改用项目已有的 `jiti` 加载器。
- 收紧 legacy fallback 后，原有 runtime-route 测试未显式声明 legacy 模式而收到 503；测试已补 `ALLOW_LEGACY_RPC_RUNTIME=1`，与新门禁保持一致。
- zsh 保留变量名 `status`，提取 Web 测试失败时不能用该变量保存退出码；后续使用其他变量名。
- Web 全量测试默认读取 `~/.pi/agent/auth.json`，受沙箱限制在创建 lock 时失败；验证时必须显式注入临时 `PI_CODING_AGENT_DIR`，不能触碰生产 agent 目录。
- 首次批量 patch 因 `package.json` 上下文不完全匹配未应用；改为逐行最小 patch 后成功。
- zsh 中变量名 `path` 与 PATH 环境变量绑定，打包后校验循环导致 `du/ls/shasum` 暂时不可用；后续改用 `node_dir` 等变量名。
- 运行 IssueLog-003 回归时将 Runtime 命令误放在仓库根目录，因根目录无 `package.json` 得到 `ENOENT`；后续按 `personal-runtime` 与 `pi-web` 子目录分别执行。
- 真实 dev Runtime 启动在沙箱内因无法创建用户目录 `~/.pi-dev/.yuanyi-pi/workspaces` 得到 `EPERM`，且进程列表查询受沙箱限制；需在获批的外部权限下重跑真实启停，不能把该环境错误当成业务回归。
- 修改 dev 启动脚本时一次 `apply_patch` 目标路径误重复仓库目录，工具返回文件不存在；未产生文件变更，随后改用正确绝对路径。
- 加载 `webapp-testing` Skill 时误用 `~/.codex/skills` 路径，该 Skill 实际位于 `~/.agents/skills`；首次读取返回文件不存在，随后改用正确路径。
- 隔离 Gateway/Web 已就绪，但 Playwright Chromium 在沙箱内因 macOS Mach port `bootstrap_check_in ... Permission denied` 崩溃；需在获批外部权限下重试页面验收。
- Web 真实验收脚本首次验证“项目→话题”时假设项目按钮使用路径 `title` 属性，实际 DOM 选择器不匹配；项目 Session 创建成功，失败仅为测试脚本定位器，需要先打印 DOM 属性再重试。
- Gateway 新建 Session 在首条 Prompt 前可能尚未出现在磁盘 Session 列表，导致 Web 真实验收只看到 orphan 话题；验收脚本需先发送一次 Prompt 触发持久化，再检查项目选择器。
- Playwright 验收复跑复用了上次临时运行数据，页面已有会话导致初始选择器状态不同，话题下拉断言未命中；后续使用全新临时数据目录并在点击后打印按钮状态。
- Web Session 列表诊断已确认项目按钮存在但其可访问名称包含活动数（`/tmp/issue003-project 1`）；后续改回已确认的精确 `title` 属性定位器。
- Web 最后一轮已正确点中项目按钮，但脚本仍用旧的 `Select project…` 文本定位器读取已变更的选择器，等待超时；产品页面已显示项目按钮，需用稳定的路径/DOM 定位器继续完成切换断言。
- Web 验收脚本再次把下拉项目项的 `title` 当作关闭后的触发器属性；选择成功后触发器 DOM 属性不稳定，后续改用页面上显示项目路径的按钮文本重新打开下拉。
- Web 项目→话题最后一步的严格 accessible-name 断言未命中，尚未区分是 UI 状态未清空还是定位器差异；下一步打印点击后的按钮文本/属性，避免把测试脚本失败误判为产品回归。
- Web 最终 DOM 已显示触发器文本回到 `Select project…`，且项目项仍在打开的下拉中；说明项目目标已清空，失败仅因 accessible-name 定位器不稳定，改用按钮文本断言。
