# 前端调研（第一轮：选型；第二轮：成熟平台的页面布局）

调研人：Qwen（DSH 本地 Worker）。
- 第 1–8 节＝上一轮（任务书第 9 节）选型调研，抓取时间 2026-11-04，当时读过仓库的 LICENSE、README、package.json 和源码目录，没有本地克隆。
- 第 9–13 节＝本轮（`docs/UI-REWORK-BRIEF.md` 第 3 节）布局调研，抓取时间 2026-11-05，**只读官方文档/README/变更日志，没有读任何外部源码**（任务书第 1 节：AGPL 项目连源码都不读）。

## 1. 结论先行

**不换底座。保留现在的无依赖 vanilla ES module 界面，抄 Harnss（MIT）的组件与交互骨架，借 DeepSeek Harness 对话装配层的"数据模型"思路（不搬代码），团队视图自己写。**

三条理由：

1. **换底座的成本全在我们的构建/安全边界上**。现在 `ui/` 只有三个文件（`app.js` 15KB、`state.js` 7KB、`markdown.js` 1.5KB），由 `src/app/server.ts:173` 直接静态发布，CSP 是 `script-src 'self'; style-src 'self'`，没有前端打包步骤（`npm run build` 只是 `tsc`，`scripts/app-build.mjs` 只组装 Electron）。Harnss / acp-ui / goose / vibe-kanban 都是 React 或 Vue + 打包器 + Tailwind + 组件库，换底座等于新增 Vite 构建、依赖树和 CSP 放宽，而我们要修的问题（增量 reducer、节流刷新、200 条窗口、工具折叠）本身跟框架无关。
2. **没有一个现成项目提供我们的核心视图**：一个负责人 + 多个 Worker，带白板和私信的实时团队视图。DSH 自己也只做到"共享任务板 + 子 Agent 树"（见 §3.1，它自己文档写着 *No mailbox timeline*）；Harnss/vibe-kanban 的多 Agent 是"多个独立会话并列"，不是"一个用户对话 + 团队活动摘要"。所以团队视图确实要自己写。
3. **最值得拿的东西是交互和数据结构，不是组件文件**。Harnss 的 `ChatView.tsx` 用一个"行描述符 + 稳定 key + 只补底部 20 行 + 上方占位 spacer + 后台批量 hydration"和"bottom lock + 用户滚动意图"解决了我们第 3 节点名的两个抱怨（往上翻被拉回底部、整列表重画）。这套逻辑约 300 行纯逻辑，可以按思路重写成 vanilla，不需要 React。

## 2. 我们的现状约束（选型基准）

- 界面：`ui/index.html` + `ui/app.js`（DOM 手写，无框架）+ `ui/state.js`（纯 reducer）+ `ui/markdown.js`（自写安全 markdown → 描述树）。已有好处：reducer 是纯函数，`test/app.test.mjs:27` 能不带 DOM 直接测。
- 事件源：`GET /api/stream` SSE，每帧带 `seq`/`sessionId`/`event`（`src/app/server.ts:40-45`），会话事件是带 `type`/`at` 的 JSONL。**已经有稳定序号**，缺的是"按序号只应用一次"和增量渲染。
- 打包/分发：Electron 44 + 本地 HTTP 服务，无 Node 前端依赖。加依赖要说明理由（任务书第 1 节）。

## 3. 逐个调研

### 3.1 DeepSeek Harness — `packages/client`（对话组件）

- 仓库：<https://github.com/deepseek-ai/deepseek-harness>，根 `LICENSE` 实测为 **MIT**（Copyright (c) 2026 DeepSeek），TypeScript，master 分支，2026-11-04 仍在推。
- 技术栈：React + Lexical（输入框）+ 自研 **Cordis 插件宿主**；`packages/client` 下 30+ 个 `ui-*` 包（`ui-chat`、`ui-conversation`、`ui-trajectory`、`ui-tool`、`ui-agent-team`、`ui-subagent`、`ui-mentions`、`ui-workspace`…），每个都是一个 Cordis 插件，通过 `ctx.uiConversation.events.register(...)`、`ctx.slots.contribute(...)` 挂进宿主。
- 工具调用怎么折叠：`ui-chat` 里一次模型尝试 = 一条 assistant 节点（文本/推理/工具统一成 `items`，工具状态 `running|approved|denied|error|cancelled`）；`tool/started` 和 `tool/completed` 只更新同一节点的状态条。分组由 `groupTree` 位置（`exchange/input/turn/process`）+ **Group Definition** 负责，文档明确说 process 分组和"whole-Turn folding"（整轮折叠）由 Chat 的 group 插件拥有，折叠状态还能按 `statusSourceId` 继承。另有独立的 **Trajectory** 视图：把工具、推理、命令、文件、MCP 单独成行、按轮次显示耗时和退出码 —— 正好是我们"两条消息之间的团队活动折叠成一行摘要，点开看明细"的另一种形态。
- 长对话怎么处理：**装配层是增量的**。`docs/subsystems/conversation.md` 描述：按 `(kind, id)` 关联事件成 Context，最早的 start 初始化 State，后续 Match 只更新；连续 append/prepend 走增量路径，替换窗口/gap 才重建；发布节奏有三档（immediate / animation-frame / none，工具 delta 用 animation frame）；Session Controller 只持有"连续已加载窗口"，历史页 prepend 后再增量补算。这些正是我们 `reduce` + SSE 需要的语义，可以照抄语义而不搬代码。
- 多 Agent：有。`ui-agent-team` = 会话头部面板里的 **共享任务板**（idle/blocked/ongoing/done + 计数）+ 子 Agent 树；`ui-mentions` 提供队友 mention 菜单（`@codex:name` 结构化目标）。但限制写在其 README：*No mailbox timeline*（只显示任务不显示消息）、不能创建/改名/打断成员。**没有**我们这种白板 + 私信 + 成员状态的团队视图。
- 能不能整体用：**不能**。它绑定 Cordis 宿主 + Session Controller 的事件词汇表（`session.prompt`、`turn/start`、`item/*`、`usage/*`…）+ Lexical + 自己的 bundle/loader。我们只有 3 个 UI 文件，接一个插件宿主等于重写全部界面和状态层。另外我们已经在用 DSH 作为 **harness**（`src/platform/adapters/dsh.ts`），它的客户端和我们的宿主进程是两套生命周期，硬接会引入进程内耦合。
- 可借鉴（不搬代码）：`(kind,id)` 幂等 reducer、三档发布节奏（对应我们"最多每 0.25 秒刷新一次"）、Turn/Step Location 分层（对应我们把一轮团队活动归组）、Trajectory 的按轮明细行。

### 3.2 Harnss — `OpenSource03/harnss`

- 仓库：<https://github.com/OpenSource03/harnss>，`LICENSE` 实测 **MIT**（Copyright (c) 2025-2026 Dejan Zegarac），README 也写 MIT。版本 0.22.0-beta.2。
- 状态：**早期开发，README 顶部明确说"pending a large rewrite"**（要重写以提升可用性和性能）。所以别把它当稳定依赖，只当参考实现。
- 技术栈：Electron 40 + Vite 7 + **React 19** + TypeScript + Tailwind 4 + shadcn/radix + zustand；ACP SDK `@agentclientprotocol/sdk` ^0.15；另有 `@tanstack/react-virtual`、`@xterm/xterm`、Monaco、react-markdown + dompurify + `diff`。pnpm。
- 工具调用怎么折叠：`src/components/ToolCall.tsx`（单个调用卡片，文件改动显示**词级 diff** + 语法高亮，bash 输出内联）、`ToolGroupBlock.tsx`（连续工具调用合成一组，`computeToolGroups` 有 `autoGroupTools`、`avoidGroupingEdits`、`isFinalized`：组"定稿"后收起成一行，未定稿时逐条显示）、`ThinkingBlock.tsx`、`TurnChangesSummary.tsx`（一轮结束后把改动汇总成一条）。用户设置里有 `autoExpandTools` / `expandEditToolCallsByDefault`（默认折叠可调）。
- 长对话怎么处理：`src/components/ChatView.tsx`（我读了整份）：
  - 行模型 `RowDescriptor`（message / tool_group / turn_summary / processing）+ `getRowKey()` 稳定 key + `canReuseRowDescriptor()` 复用旧行对象 → 只有真正变化的行才重渲染；
  - **渐进渲染**：`INITIAL_RENDER_ROWS = 20`（先只渲染底部 20 行），上方所有未 hydration 的行用**一个** spacer div 按 `estimateRowHeight()` 撑高，再每帧 `startTransition` 补 `HYDRATION_BATCH_SIZE = 40` 行；
  - **bottom lock + 用户滚动意图**：`wheel`/`touchmove` 被动监听标记意图时间窗（`USER_SCROLL_INTENT_WINDOW_MS`），只有用户自己滚到底才重新锁底；窗口内程序改变高度不会把用户拽回底部；`ResizeObserver` 处理输入框高度变化。这正是我们第 3 节"往上翻不能被拉回底部"的现成解法。
  - 搜索定位：`data-message-id` + 需要时先 hydration 目标区间再 `scrollIntoView`。
  - 注意：`@tanstack/react-virtual` 在依赖里，但 `ChatView` 走的是 spacer+hydration 而不是虚拟列表；虚拟化用在哪我没确认（不确定）。
- 多 Agent：**并列会话**，不是团队协作。`BackgroundAgentsPanel.tsx`（后台任务 Agent）、`AgentTranscriptViewer.tsx`（看子 Agent 记录）、`TodoPanel.tsx`、`WorkspaceSplitView`（多会话并排）。没有共享白板/私信概念。
- 能不能整体用：不能（Electron+React 应用，且作者说要重写；ACP-only，我们的 Codex 走 app-server JSON-RPC 不是 ACP）。**抄组件骨架最划算**：`ToolGroupBlock`、`TurnChangesSummary`、`ChatView` 的行模型/滚动策略，全部 MIT，保留版权声明即可。

### 3.3 ACP UI — `formulahendry/acp-ui`

- 仓库：<https://github.com/formulahendry/acp-ui>，`LICENSE` 实测 **MIT**（Copyright (c) 2026 Jun Han）。
- 技术栈：**Tauri 2（Rust 宿主）+ Vue 3 + Pinia + vue-router + marked**；同一份前端出桌面（Win/mac/Linux）、Android/iOS、以及浏览器版（`https://acp-ui.github.io`，通过 `@rebornix/stdio-to-ws` 把 stdio ACP 桥成 WebSocket）。0.1.16。
- 工具调用怎么折叠：README 列了 "Tool Call Visualization" 和 "Collapsible 'Agent Thinking'"，即工具调用一条可展开条目 + 思考过程可折叠；实现集中在 `src/App.vue`（25KB 单文件）+ `src/components/`，粒度粗。
- 长对话怎么处理：没有找到虚拟化/分页依赖（package.json 里只有 marked/pinia/router），推测是全量渲染 + 简单滚动（**不确定**，没逐行读 `App.vue`）。
- 多 Agent：README 的 "Multi-Agent Support" 指"能连任意 ACP Agent"，一个客户端同时配多个 Agent；不是多 Agent 协作视图。
- 能不能整体用：**技术上最接近可整体用**（跨桌面/移动/Web，纯 ACP），但它跟我们的模型不匹配：我们三个 harness 里只有 Claude 和 DSH 走 ACP，**Codex 走自己的 app-server JSON-RPC**（`src/platform/adapters/codex.ts`），且我们的白板/私信/额度/快照都不在 ACP 里。它的可取之处只有"远程 Agent over WebSocket"这一条传输思路（我们现在是本地 HTTP + SSE，够用）。

### 3.4 Vibe Kanban — `BloopAI/vibe-kanban`

- 仓库：<https://github.com/BloopAI/vibe-kanban>，GitHub API 实测 license **Apache-2.0**，28.6k stars，2026-11-04 仍在推，默认分支 main。
- 技术栈：Rust 后端 + 前端 React（+ 部分 SolidJS），本地 executors 跑 Claude Code / Codex / Gemini 等。
- 形态：**任务看板驱动**——任务卡片 → 指派给某个 Agent → 并行/串行执行 → 每卡片一条试次的对话与 diff。这是"人派活给多个 Agent"的视图，跟我们的"负责人派活给 Worker + 白板"最像。
- 工具调用折叠 / 长对话：没细读实现（**不确定**）。
- 能不能整体用：不能当底座（Rust 后端 + 自己的执行模型，跟我们已写好的 PlatformSession 完全重叠）。但**它的信息架构值得抄**：卡片/列对应"成员 + 状态"，比我们现在右侧纯文本面板更适合团队视图。Apache-2.0 抄代码要保留 NOTICE 并标注修改（见 §5）。

### 3.5 goose — `block/goose`

- 仓库：<https://github.com/block/goose>，`LICENSE` 实测 **Apache-2.0**（Copyright 2024 Block, Inc.）。
- 技术栈：Rust 核心（CLI/`goosed` 服务）+ 桌面 App（第三方资料说是 Electron + React，通过 HTTP/WebSocket 连 `goosed`；我没核实当前目录结构，**不确定**）。扩展/子 Agent 有 subagent 机制。
- 相关性：它的"一个后端进程 + 前端只是观察者"的分层跟我们的 server/SSE 结构一致，可作架构对照；界面本身没有我们需要的团队视图（**不确定**，未细读其 UI 源码）。

### 3.6 AionUi — `iOfficeAI/AionUi`

- 仓库：<https://github.com/iOfficeAI/AionUi>，`LICENSE` 实测 **Apache-2.0**（Copyright 2025 AionUi）。
- 定位：桌面 GUI，统一入口跑多个 CLI/ACP Agent。README 抓取失败（`main` 分支 404，可能默认分支不同），**技术栈和折叠实现未核实**，只能列为"待查"。

### 3.7 反面样本：Claude Code UI — `siteboon/claudecodeui`

- `LICENSE` 实测 **AGPL-3.0-or-later**，并带 Section 7 附加条款（署名 banner、商标不得用于背书、还有 relicensing 声明：2026-03-28 前部分贡献是 GPL-3.0，之后统一 AGPL-3.0+）。
- 结论：**不要复制它的代码**，哪怕一小段 —— AGPL 的网络分发条款对我们要打包分发的桌面 App 不合适，附加署名条款还会污染文件头。交互可以参考，代码不要抄。

### 3.8 其他（简略，未深入）

- `droidsembly`（npm，自称 MIT）：多 Agent 协作的可视化面板/看板，思路接近我们的团队视图，需要下一轮再看实现。
- `@surething/cockpit`（npm，自称 MIT）：一个 Claude Code GUI，5 个引擎标签并列、并行会话、收件箱红点 + 桌面通知。跟我们的"额度/通知/多引擎"点接近，未核实仓库。

## 4. 对比表

| 项目 | 许可证（看 LICENSE 实测） | 技术栈 | 工具调用折叠 | 长对话 | 多 Agent | 可复用程度 |
|---|---|---|---|---|---|---|
| DSH `packages/client` | MIT（根 LICENSE） | React + Lexical + Cordis 插件宿主 | assistant 节点内统一 items；groupTree/Group Definition 做 process 分组与整轮折叠；另有 Trajectory 明细视图 | 增量装配（`(kind,id)` Context、append/prepend、三档发布节奏、已加载窗口） | 有子 Agent 树 + 共享任务板，无消息时间线 | 只借数据模型/交互，代码不可搬 |
| Harnss | MIT | Electron + Vite + React 19 + Tailwind + zustand | 工具卡片 + 连续调用分组（定稿后折叠）+ 词级 diff + 轮次改动摘要 | 稳定 key 行模型 + 底部 20 行先渲染 + spacer + 批量 hydration + bottom lock | 并列会话/后台 Agent，非协作 | **抄组件骨架最值**（作者自称要重写，别当依赖） |
| acp-ui | MIT | Tauri 2 + Vue 3 + Pinia + marked | 工具条目 + 可折叠 Agent Thinking | 未见虚拟化（不确定） | 多 Agent = 多引擎可连 | 只借 WebSocket 远程 Agent 思路 |
| vibe-kanban | Apache-2.0 | Rust + React/SolidJS | 未细读 | 未细读 | 看板驱动派活给多个 Agent（最像我们的团队视图） | 抄信息架构，不抄实现 |
| goose | Apache-2.0 | Rust + 桌面 React（未核实） | 未细读 | 未细读 | subagent | 架构对照 |
| AionUi | Apache-2.0 | 未核实 | 未核实 | 未核实 | 未核实 | 待查 |
| claudecodeui | **AGPL-3.0+ 附加条款** | React/Node | 有（未细读） | 未细读 | 多项目/多会话 | **禁止复制代码** |

## 5. 许可与合规

- MIT（DSH、Harnss、acp-ui）：可以复制源码片段，条件是**保留版权与许可声明**。做法：新建文件顶部注释写明来源仓库、路径、commit/版本、"MIT licensed, Copyright (c) …"，并在 `docs/` 或 `THIRD-PARTY-NOTICES` 里列一份；纯"照着思路重写"不受限制但注明来源更稳。
- Apache-2.0（vibe-kanban、goose、AionUi）：除版权声明外还要保留 `NOTICE` 文件内容，**修改过的文件要标注修改**；如果要引入依赖，依赖树里的 `NOTICE` 也要一起分发。成本比 MIT 高，所以只借思路。
- AGPL/GPL（claudecodeui 等）：不复制任何代码。我们自己仓库现在没有任何 `NOTICE`/`THIRD-PARTY-NOTICES` 文件，真要抄 MIT/Apache 代码时需要新建一个。

## 6. 给下一阶段的具体建议

1. **不引入前端框架**。把 Harnss `ChatView.tsx` 的三件事按 vanilla 重写：(a) 行模型 + 稳定 key（用事件的 `seq` 或 `event.id`）做增量 DOM 增删；(b) 只渲染最近 N 条 + 上方一个占位块，向上翻时再补（我们现在没有服务端分页，`GET /api/sessions/:id/events?after=` 已经能分页，够用）；(c) 一个 "bottom lock" 标志：用户一旦手动上翻就停止自动吸底，滚回底部才恢复。这三件事直接覆盖第 3 节里"整列表重画、被拉回底部、200 条窗口"三条。
2. **reducer 语义照 DSH 的装配层**：按稳定 id 幂等应用（重复/乱序不改变数字）、增量 state（不 `structuredClone`）、发布节奏合并（每 ≤250ms 一次）。我们已有 `seq`，比 DSH 的处境更简单。
3. **工具/团队活动折叠借 Harnss 的 group 语义**：连续非对话活动合成一组，未定稿时展开、定稿后收一行摘要；失败项强制展开（对应简报"失败的调用和成员失败要自动露出来"）。
4. **团队视图自己写**，但借 vibe-kanban 的"每成员一列/卡片 + 状态"信息架构，替代现在右侧的纯文本面板；借 DSH `ui-agent-team` 的"共享任务 + 计数（idle/blocked/ongoing/done）"作为白板之外的第二块团队信息。
5. **额度与通知**：借 cockpit/cockpit 类产品的"红点 + 桌面通知"点（我们现在已有 `window.desktop?.notify`），不必引依赖。

## 7. 不确定项（下一轮要复核）

- goose、AionUi、vibe-kanban、droidsembly、cockpit 的**具体折叠与长对话实现没有逐行读过**，表中相关格写"未细读"。
- Harnss 声明要重写、acp-ui 0.1.x、AionUi README 抓取失败：这些项目的**结构和分支可能随时变**；真要抄代码前先 `git clone` 到**仓库内隔离的临时目录**（例如 `.tmp-research/<repo>/`，用完删掉；本轮本来就不 commit，也不要把它留在工作区里），并锁定 commit，再核对那一版 LICENSE 是否仍相同（claudecodeui 就是中途改过许可证的例子）。注意这与任务书第 1 节一致：不要在仓库外读写其他目录，也不要把外部仓库源码带进 `src/`、`ui/`。
- `@tanstack/react-virtual` 是否框架无关核心可用于 vanilla：未验证（我倾向自己写占位块，不引依赖）。

## 8. 参考链接

- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>（MIT：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/LICENSE>；对话装配：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/conversation.md>；对话包：<https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/README.md>；团队面板：<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-agent-team/README.md>）
- Harnss：<https://github.com/OpenSource03/harnss>（MIT：<https://raw.githubusercontent.com/OpenSource03/harnss/master/LICENSE>；`ChatView.tsx`：<https://raw.githubusercontent.com/OpenSource03/harnss/master/src/components/ChatView.tsx>；`package.json`：<https://raw.githubusercontent.com/OpenSource03/harnss/master/package.json>）
- ACP UI：<https://github.com/formulahendry/acp-ui>（MIT：<https://raw.githubusercontent.com/formulahendry/acp-ui/main/LICENSE>）
- Vibe Kanban：<https://github.com/BloopAI/vibe-kanban>
- goose：<https://github.com/block/goose>（Apache-2.0：<https://raw.githubusercontent.com/block/goose/main/LICENSE>）
- AionUi：<https://github.com/iOfficeAI/AionUi>（Apache-2.0：<https://raw.githubusercontent.com/iOfficeAI/AionUi/main/LICENSE>）
- Claude Code UI（AGPL 反例）：<https://github.com/siteboon/claudecodeui>（LICENSE：<https://raw.githubusercontent.com/siteboon/claudecodeui/main/LICENSE>）

---

# 第二轮：成熟平台把功能放在哪（UI-REWORK-BRIEF 第 3 节）

抓取时间 2026-11-05。方法：**只读官方文档页、README 和官方变更日志**，没有 clone 仓库、没有读任何外部项目源码（含 AGPL 的 claudecodeui，本轮完全没碰）。第 2 节里已经写过的技术栈/许可结论不重复。

## 9. 证据类型图例（先看清，别把推断当事实）

- **【文档】**＝官方文档/README 正文里明确写了这条布局行为。
- **【截图alt】**＝官方页面里有截图，但抓取只返回文本，我**没看到画面**，只读到截图的 alt 与说明文字。这一类只描述"有什么面板/按钮"，不描述视觉细节。
- **【源码·上一轮】**＝第 3 节那轮读源码得到的布局事实，本轮未复核，只作背景，不据此新增结论。
- **【看不到】**＝公开资料没有说明，我不凭印象补。

OpenAI 的文档站 `developers.openai.com` 拒绝我们的抓取器（HTTP 404），所以 Codex 三页是通过第三方文档镜像读的（镜像声明是官方 devhub 原文快照）。引用时我同时给官方 URL 和实际抓到的镜像 URL，结论按官方 URL 核对。

## 10. 逐平台（每格后面直接跟证据类型）

### 10.1 Claude Code 桌面版（Claude Desktop 的 Code 标签页）

来源：<https://code.claude.com/docs/en/desktop>（一整页官方参考文档，2026-11 抓取）

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | 左栏 sidebar 列会话，可并行多个；**默认按文件夹分组、按时间排序**；子会话（任务派出来的）在 sidebar 里挂在父会话下面；行悬停出菜单（Archive 等）；`+ New` / `Ctrl+Tab` 切换会话【文档】。行里具体显示哪些字段：【看不到】 |
| 对话区与工具调用 | 会话标题栏（title bar）上有一排面板开关按钮：Terminal、Changes（diff）、Browser、Files；窗口窄时放不下的按钮**自动收进 ⋮ 菜单**；没有按钮的面板（Background tasks、Plan）**等会话里有内容时才出现在 ⋮ 列表里**【文档】。转录详细度由**会话菜单里的 View modes**（Normal / Thinking / Verbose，`Ctrl+O` 循环）统一控制：Normal 和 Thinking 下工具调用折叠成摘要，Verbose 才逐条展开【文档】 |
| 输入框与控件 | 输入框下方固定一行控制条：**环境选择器 → 项目文件夹 → 权限模式 → 模型**（模型靠右）；`+` 按钮放附件/skills/connectors/plugins；停止按钮在输入区；**用量环（usage ring）也在这一行**；Worktree 开关也在这一行【文档】。空输入框里会灰字显示"建议的下一条 prompt"（Tab/→ 取用）【文档】 |
| 运行状态 | **会话详情面板**（session details panel）在对话右侧，是一组卡片：在哪跑（Environment）、改了什么（Changes）、正在跑什么、上下文占用百分比（Context 卡头部直接写百分比，展开按类别看）；**聊天足够宽时才出现**【文档】。后台工作（子 Agent、后台 shell、dynamic workflows）在 **Background tasks 面板**，点条目→在 subagent 面板看输出或直接 stop【文档】。跨会话状态：去 sidebar 看，或者直接问 Claude【文档】 |
| 等用户决定 | 权限请求以**卡片形式插在对话流里**（首次访问外部站点：Allow once / Always allow / Deny），Claude 等在那里【文档】。App 在后台时靠**手机推送**（Dispatch 会话完成或需要审批时推）【文档】；断线重连后仍能看到等他的请求【文档】。桌面端"某某在等你"的醒目横幅：【看不到】 |
| 代码改动 | 两个入口：①会话详情面板 **Changes 卡上的行数（如 `+12 -1`）**点进去；②会话标题栏的 **Changes** 按钮【文档】。diff 里悬停行→行号旁出现 `+`→写行内评论，多条一次提交（`Cmd/Ctrl+Enter`）【文档】。PR 建好后 PR 出现在 Changes 卡里带 CI 状态，⋮ 菜单里有 Auto-fix / Merge when ready【文档】 |
| 用量与额度 | 两处：Context 卡＝本会话上下文窗口占用；**输入框下那行的 usage ring＝账户/套餐额度（跨所有 Claude Code 界面共享）**，点开看套餐用量【文档】。`/context` 在对话里打明细【文档】 |
| 多 Agent | 面板体系里就有 **tasks 面板 + subagent 面板**；派出的会话在 sidebar 挂在父会话下【文档】。任务卡可 `Start all`（每个任务起一个自己的会话，不串行等待）【文档】。"团队白板/成员协作"这种视图：没有【文档，未见此类功能】 |
| 侧栏与面板开关 | 面板是**可拖拽的独立 pane**：chat、diff、browser、terminal、file、plan、tasks、subagent，拖标题栏换位置、拖边改尺寸，`Ctrl+\` 关当前 pane；可以把 pane 弹出成独立窗口再插回【文档】。窄窗口下按钮进菜单（见上）【文档】 |

### 10.2 Codex 桌面 App 与 Codex IDE 扩展（OpenAI）

来源：官方 <https://developers.openai.com/codex/app/features>、<https://developers.openai.com/codex/app/review>、<https://developers.openai.com/codex/app/settings>、<https://developers.openai.com/codex/ide>、<https://developers.openai.com/codex/ide/features>；实际抓取到的镜像：<https://cdn.jsdelivr.net/gh/crasuna/openai-dev-docs-cn-mirror@main/sources/en/codex/app/features.md>、`…/app/review.md`、`…/app/settings.md`、`…/codex/ide.md`、`…/ide/features.md`

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | App 左栏：**先选项目、再列该项目线程（thread）**，一个窗口跨多个项目并行跑；线程可 pin / archive，归档线程在 Settings > Archived threads 里列（带日期和项目上下文）【文档】。截图说明写的是"sidebar 里多个项目、主区显示线程"【截图alt】。IDE 扩展：VS Code 里**默认在右侧栏**，可以拖回左栏【文档】 |
| 对话区与工具调用 | 线程=一个对话；命令输出多少在 Settings > General 里调【文档】。折叠默认状态与展开入口的明确说明：【看不到】 |
| 输入框与控件 | IDE 扩展：**模型切换器在输入框下方**，同一个切换器里选推理强度 low/medium/high，**审批模式（Chat / Agent / Agent (Full Access)）也在这个切换器里**【文档】。App：新建线程时选模式 **Local / Worktree / Cloud**（在 composer 里）【截图alt+文档】；语音输入 `Ctrl+M`【文档】；把常用命令做成 action 按钮放到**窗口顶部**【文档】 |
| 运行状态 | **任务侧栏（task sidebar）**在一条线程跑的时候显示：计划（plan）、来源（sources）、产出物（artifacts）、任务总结【文档】。浮动的 "Codex pets" 覆盖层会显示当前线程并区分三种状态：**running / waiting for input / ready for review**【文档】 |
| 等用户决定 | 审批提示出现在**消息 composer 上方**（截图示例是 Windows 沙箱设置提示，alt 明写"above the message composer"）【截图alt】；文案区分 "approve once" / "approve for this session"（不同授权范围）【文档】；有 automatic review 时在**权限选择器**里选【文档】。**App 在后台时默认发系统通知：任务完成或需要审批**【文档】，可在 Settings > Notifications 改成从不/总是【文档】 |
| 代码改动 | **Review 面板**：默认看未提交改动，可切 **All branch changes / Last turn changes**，本地还能切 Unstaged/Staged；点文件名在编辑器打开、点文件名背景展开该文件 diff；行级 inline 评论（悬停→`+`→写→然后回线程发消息让他处理）；**按 diff 整体/单文件/单 hunk 做 stage / unstage / revert**；PR 分支时侧栏显示 PR 上下文和评审意见【文档】 |
| 用量与额度 | Settings > **Profile** 里看活动统计、累计 token、峰值 token、连续天数、最长任务【文档】。App 内的"5 小时窗口/额度剩余"读数：【看不到】 |
| 多 Agent | App 支持"另开后台线程"的显式请求（在 worktree 里）；线程自动化（thread automations）定期回到同一线程继续【文档】。但没有"成员卡片/协作视图"【文档，未见此功能】 |
| 侧栏与面板开关 | 集成终端是**底部抽屉**：右上角终端图标或 `Cmd+J`【文档】；`Cmd+K` 命令面板【文档】；线程可以**弹出成独立浮窗**并置顶（方便前端迭代时贴在浏览器旁边）【文档】 |

### 10.3 Cursor（Agent 侧栏 / Agents Window / Projects）

来源：<https://cursor.com/docs/agent/overview.md>、<https://cursor.com/docs/agent/agents-window.md>、<https://cursor.com/docs/agent/projects.md>、<https://cursor.com/docs/agent/security/run-modes.md>、<https://cursor.com/docs/agent/agent-review.md>、<https://cursor.com/help/models-and-usage/usage-limits.md>（Cursor 文档支持 `.md` 纯文本）

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | **Agents Window** 是"Agent 优先"的独立窗口，**左导航含 Projects 区**；聊天行可以拖到某个 Project 行上归入它【文档】。Project 打开后就是"与其协调 Agent 的对话"【文档】。左侧列表每行显示什么字段：【看不到】 |
| 对话区与工具调用 | 工具调用条目在对话流里（search/web/read/edit/shell/browser/image/**ask questions**）【文档】；**Checkpoints（检查点）挂在聊天时间线上**，点任一 checkpoint 预览当时的文件、可恢复【文档】。折叠默认状态：【看不到】（社区论坛抱怨新版把探索类调用折成 "Explored"，但那是论坛不是官方文档） |
| 输入框与控件 | Agent 在侧栏，`Cmd+I` 打开【文档】。**运行中输入框直接工作**：回车＝排队（消息按顺序显示在活动任务下方，可拖动重排）；`Cmd+Enter`＝立刻插入；"Send now"＝在下一个工具调用处转向【文档】 |
| 运行状态 | 排队消息显示在活动任务下方【文档】；官方文档没有"谁在干活"的专用状态区说明：【看不到】 |
| 等用户决定 | 审批卡（approval card）会显示完整路径和"为什么要"（读工作区外文件时）【文档】；Run Modes 在 **Settings > Agents > Approvals & Execution**（Auto-review / Allowlist / Run Everything）【文档】；**撞额度时在编辑器里发通知**【文档】。顶栏横幅式的"等你回答"：【看不到】 |
| 代码改动 | Agents Window 有**新的 diff 视图**：审阅并提交改动、管理 PR，不用离开 Cursor【文档】；Agent Review 也能从 Source Control 标签跑（对比主分支全部本地改动）【文档】；浏览器预览里可以在页面上标元素做评论【文档】 |
| 用量与额度 | **主入口是网页 dashboard**（Usage / Spending 页）；文档明确"**编辑器设置里显示同样的剩余用量**"，撞上限时编辑器内通知【文档】 |
| 多 Agent | **Projects＝一个协调 Agent（不写代码）+ 它派出的多个 Agent**；"打开协调者启动的任一 Agent，就能跟他的工作或直接对话"；**Project 的聊天输入框上方有 Agents 列表**（从那里打开/移出成员）；订阅事件时输入框上方出现 **Listening 药丸**，点开看监听哪些事件【文档】 |
| 侧栏与面板开关 | 编辑器里 Agent 是侧栏（`Cmd+I`），Agents Window 与 IDE 可同开、可互切（命令面板 Open Agents Window / Open IDE）【文档】 |

### 10.4 Zed Agent Panel

来源：<https://zed.dev/docs/ai/agent-panel>

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | **Threads Sidebar**（`Ctrl+Alt+J`）**按项目分组**列所有线程；`Ctrl+Tab` 在最近线程间循环【文档】；不再做的线程悬停归档（`Shift+Backspace`），Thread History 跨项目按时间排【文档】 |
| 对话区与工具调用 | 响应流式进来，**用指示器显示模型正在用哪个工具**【文档】；折叠默认状态：【看不到】。长线程导航：面板底部**滚动箭头**跳到最近一次 prompt 或开头，并有键盘跳转【文档】 |
| 输入框与控件 | 消息编辑器在面板底部；**模型选择器在编辑器里**（`Ctrl+Alt+/`，收藏模型可 `Alt+L` 轮换）；`@` 加上下文、`+` 菜单加选区/图片【文档】；"Follow the agent" 十字准星按钮在**面板左下**，点了编辑器跟着跳到 Agent 正在改的文件【文档】 |
| 运行状态 | 生成中时系统不睡眠（等用户确认时不保持）——侧面说明**生成 vs 等待确认是两个不同状态**【文档】；**token 用量显示在编辑器里的 profile 选择器附近**【文档】；上下文不够时**在编辑器上方出现横幅**让你起新线程【文档】 |
| 等用户决定 | 有 `agent.notify_when_agent_waiting` 与 `agent.play_sound_when_agent_done` 两个设置（桌面通知 + 声音），Agent 在等你时通知【文档】。权限确认的界面位置：Tool Permissions 决定 允许/拒绝/确认，但确认卡出现在哪：【看不到】 |
| 代码改动 | **改动摘要条就在消息编辑器上方**：手风琴条显示改了哪些文件、多少个、多少行；或 `Ctrl+Shift+R` 打开 **Review Changes** 多缓冲 diff 页，按 hunk 或整体 accept/reject【文档】 |
| 用量与额度 | 当前线程 token 数在编辑器 profile 选择器附近；额度（付费）不在面板里：【看不到】 |
| 多 Agent | 多线程并行、各自独立上下文，可按项目隔离；两个线程可能改同文件时可把其中一个**隔离到新 Git worktree**（标题栏 worktree 选择器）【文档】。没有成员协作视图【文档，未见此功能】 |
| 侧栏与面板开关 | 面板由状态栏 ✨ 图标或命令面板打开；`New Thread…` 菜单在**左上角的 Agent 选择按钮**或右上角 `+`【文档】 |

### 10.5 Vibe Kanban（Workspaces 四栏界面）

来源：<https://vibekanban.com/docs/workspaces/interface.md>（含多张标注截图，我只读到 alt/说明）、<https://vibekanban.com/docs/workspaces/chat-interface.md>

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | 最左 **Workspace Sidebar**：所有 workspace + 状态指示器（**Running / Idle（等你输入）/ Needs Attention（举手的图标＝待审批）/ Pinned / Dev Server 蓝点 / PR 状态徽标**）；搜索、置顶、归档；列表可在**平铺**与**按状态分组的折叠列表**之间切换；截图说明写"显示 workspace、时间戳和改动行数"【文档+截图alt】 |
| 对话区与工具调用 | 会话面板在左主区；命令执行显示终端图标+退出码，**失败时有 "Fix Script" 按钮**，点开完整输出到 Logs 面板；搜索类操作显示摘要、点开展开【文档】 |
| 输入框与控件 | 聊天工具条里有 **Agent 下拉** 和 **Variant 下拉**（Default/Approvals/Opus/Plan + Customise）【文档+截图alt】；**Queue 按钮**（运行中排队）和 **Stop 按钮**；发送 `Cmd/Ctrl+Enter`【文档】 |
| 运行状态 | 状态词表：Idle / Running / Queued / Sending【文档】；**聊天工具条上有任务进度条**（如 5/5 completed，点开看每一步）【文档+截图alt】；错误消息**红色 + 警告图标，点开看详情**【文档】 |
| 等用户决定 | 两处：①计划审批＝**对话流里的审批卡**（读摘要→展开细节→Approve / Request Changes）【文档】；②动作审批＝**在该动作下方出现一行 Approve/Deny 按钮（勾/叉）**【文档】；不理会可能**超时**，要重发消息才继续【文档】 |
| 代码改动 | 右主区 Context 面板的 **Changes 视图**（可切 side-by-side / inline）；对话里的文件改动摘要绿/红行数**点一下跳到 Changes 面板**；在 Changes 面板里做行内评论，评论会自动带进下一条消息【文档】 |
| 用量与额度 | **Context gauge**（上下文窗口百分比，灰/默认/橙/红四档，80%+ 提示新开会话）——是上下文不是额度；账号额度：【看不到】 |
| 多 Agent | 一个 workspace 里多个会话（Session 下拉）；"多 Agent" 指把任务分给不同 Agent 跑，没有成员协作面板【文档，未见此功能】 |
| 侧栏与面板开关 | **顶栏一排开关**：左栏、会话面板、Changes、Logs、Preview、右栏；`Cmd/Ctrl+K` 命令面板也能切；**面板开合状态按 workspace 记住**【文档】。最右 **Details Sidebar**：Git、可折叠终端（xterm.js，跨面板切换保持状态）、Notes【文档】。还有一个**可拖动浮动工具条**（在 IDE 打开、复制路径、Dev Server、Preview、Changes）【文档】 |

### 10.6 Conductor（conductor.build，macOS，多 worktree 并行）

来源：<https://www.conductor.build/docs/reference/diff-viewer>（整页读到）、<https://www.conductor.build/changelog/0.35.0-workspace-status>、<https://www.conductor.build/docs/cloud/collaboration>、<https://www.conductor.build/docs>（索引摘要）。**注意：它多个文档页我们的抓取器返回 404，只拿到部分页面**；除 diff-viewer 是整页外，changelog 与 collaboration 的内容只来自搜索结果的引文片段（片段里就是官方原文，但没读到整页），下面凡"仅摘要"的都在链接里可复核。

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | 左栏 workspace 列表；**按状态分区：backlog / in progress / in review / done**，有 PR 时用 PR 标题作标签；`⌘+Shift+N` 新建【changelog+文档摘要】。Cloud 组织下 Home 看全组织 workspace，左栏有 **Pinned / My workspaces** 两块，Team 下点某人＝过滤他的 workspace【文档】 |
| 对话区与工具调用 | 每个 workspace 有自己的 branch、文件、终端、diff 和 review 路径【文档摘要】；工具调用折叠方式：【看不到】 |
| 输入框与控件 | 【看不到】 |
| 运行状态 | workspace 生命周期状态在 API 里是 initializing / ready / sleeping / archived / …【文档摘要】；界面如何显示：【看不到】 |
| 等用户决定 | 【看不到】 |
| 代码改动 | **Diff Viewer**（`⌘+Shift+D`）：文件列表在侧、unified/commit 过滤、评论可指到具体改动行（比泛泛的聊天消息更精确），GitHub 的 review 评论也进这里；"建议下一步动作"随 workspace 走向合并出现（Create PR / respond / fix checks / merge）【文档】 |
| 用量与额度 | 【看不到】 |
| 多 Agent | 多 workspace 并行（每 workspace 一个 Agent、一个 worktree），靠状态分区看全局【changelog】；成员协作视图：没有【文档，未见此功能】 |
| 侧栏与面板开关 | 【看不到】 |

### 10.7 goose 桌面版

来源：<https://goose-docs.ai/docs/guides/desktop-navigation>、<https://goose-docs.ai/docs/guides/sessions/session-management>、<https://goose-docs.ai/docs/guides/managing-tools/adjust-tool-output>、<https://goose-docs.ai/docs/guides/context-engineering/subagents>

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | **可自定义的导航侧栏**（Home/Chat/Recipes/Apps/Scheduler/Extensions/Settings），可 **Tile 或 List**、可放**左/右/上/下**、模式 **Push（挤开内容）或 Overlay（浮层）**；窄窗（<700px）List 样式自动收成只有图标【文档】。**Chat 区列最近 10 个会话**，每行显示会话名（自动生成）+ **状态指示：蓝色旋转＝正在处理、绿点＝你在看别的会话时它完成了、红点＝出错**，配方会话还显示配方图标【文档】 |
| 对话区与工具调用 | **Response Styles** 决定工具调用默认折叠还是展开：**Concise（默认）＝工具调用默认折叠，只显示用了哪个工具；Detailed＝默认展开并显示返回内容**；无论选哪种都能手动展开/折叠【文档】 |
| 输入框与控件 | 文档说"直接在输入框里打字或说话"；控件明细（模型/强度/停止/附件）：【看不到】（只在别处提到语音输入） |
| 运行状态 | 侧栏三态点（见上）+ 会话历史页；出错＝红点【文档】 |
| 等用户决定 | 没有"等你输入"的状态点（Idle 语义靠绿点/红点表达），审批提醒：【看不到】 |
| 代码改动 | 改动/diff 界面：【看不到】 |
| 用量与额度 | CLI 的状态行显示上下文百分比 `●○○ 5% (9695/200000 tokens)`，`/r` 切换是否截断工具参数【文档】；桌面版：【看不到】 |
| 多 Agent | **子 Agent 的工具调用在对话里作为可展开小节出现**，实时看到他在干什么；CLI 里内联显示工具名+扩展名【文档】 |
| 侧栏与面板开关 | 左上角按钮开关侧栏；`Cmd+/` 切侧栏；侧栏开合状态跨会话记住；**工作目录切换器在窗口底部**【文档】 |

### 10.8 Harnss（MIT，Electron）

来源：README <https://github.com/OpenSource03/harnss>（本轮只读 README，不读源码；第 3.2 节的源码级结论仍有效）

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | 项目映射到磁盘目录，**Spaces** 把项目分组成命名组；**会话、历史、面板设置都按项目作用域**；多引擎会话并行、可即时切换【README】。列表行字段：【看不到】（README 未列） |
| 对话区与工具调用 | 每个工具调用是**交互卡**，文件编辑显示词级 diff + 语法高亮，bash 输出内联；**子 Agent 任务嵌套显示、逐步进度**；**每轮改动汇总 + 专门的 Changes 面板**【README】；默认折叠还是展开：【源码·上一轮】组"定稿"后收起成一行（`autoExpandTools` 可调） |
| 输入框与控件 | 图片附件 + **内置标注工具**（画/高亮/标记后发送）；语音输入【README】；模型/强度控件：【看不到】 |
| 运行状态 | **后台任务 Agent 有专门面板**（会话里派出的任务 Agent 在后台继续跑、被追踪）【README】 |
| 等用户决定 | **可配置的 OS 通知，覆盖四类事件：计划审批请求、权限提示、Agent 提问、会话完成**；**Plan 模式 + 三档权限（Ask First / Accept Edits / Allow All）可随时切**【README】。界面内提醒位置：【看不到】 |
| 代码改动 | Changes 面板 + Git 集成（stage/unstage/commit/push、分支、历史、worktree；从暂存 diff 生成提交信息）【README】 |
| 用量与额度 | 【看不到】 |
| 多 Agent | 多引擎并行会话各有状态/历史/上下文；子 Agent 嵌套进度；后台任务面板【README】 |
| 侧栏与面板开关 | **MCP Servers 面板在右侧工具条**；终端、浏览器、Git、文件面板**按项目作用域且保持挂载**【README】 |

### 10.9 AionUi

来源：官方 wiki 中文快速上手 <https://raw.githubusercontent.com/wiki/iOfficeAI/AionUi/Getting-Started-Chinese.md>

| 维度 | 观察 |
|---|---|
| 项目/会话列表 | 左侧边栏图标进入"聊天"；**左侧历史列表切换会话，每个会话独立记忆**；行字段：【看不到】 |
| 对话区与工具调用 | 【看不到】 |
| 输入框与控件 | **模型选择器在输入框左下方**（每个 Agent 有自己的模型列表）；输入框里的 **`+` 按钮**选文件/文件夹、支持拖拽；发送按钮【文档+截图alt】 |
| 运行状态 | 【看不到】 |
| 等用户决定 | 【看不到】 |
| 代码改动 | 【看不到】 |
| 用量与额度 | 【看不到】 |
| 多 Agent | "多 Agent"＝把机器上已装的 CLI Agent（Claude Code/Codex/Qwen Code…）**汇集到同一个界面**，欢迎页选 Agent；不是协作视图【文档】 |
| 侧栏与面板开关 | 打开文件夹后**右侧出现"项目"面板（目录树），可浏览并把文件加入对话**；**项目文件夹在会话期间锁定**，要换就新建会话【文档】 |

### 10.10 DeepSeek Harness 客户端（只引用第一轮，不重复）

第一轮读的是它的文档与 README（见 3.1 节）：会话头部面板里有**共享任务板（idle/blocked/ongoing/done + 计数）**和子 Agent 树，`ui-mentions` 提供 `@codex:name` 目标选择；装配层按 `(kind,id)` 幂等增量、三档发布节奏；**明确没有消息时间线（No mailbox timeline）**。本轮未复核：【源码·上一轮 / 官方 README】

## 11. 九个维度的共同做法 vs 少数做法

**几乎人人一样（可当默认，不必再论证）**

1. **最左一列＝项目/会话列表，每行带状态点**：Vibe Kanban（Running/Idle/Needs Attention + 举手图标）、goose（蓝旋转/绿点/红点）、Claude Code（按文件夹分组）、Codex App（项目→线程，可 pin/archive）、Zed（按项目分组的 Threads Sidebar）、Conductor（按 backlog/in progress/in review/done 分区）。
2. **输入框固定在底部，控件全在输入框下那一行或框内**：Claude Code（环境→文件夹→权限模式→模型＋`+`＋用量环）、Codex IDE（模型/强度/审批模式三合一在输入框下方）、AionUi（模型选择器在框左下，`+` 在框内）、Zed/Cursor/goose 同构。
3. **代码改动从"对话里的行数"进 diff 面板，diff 里能做行内评论**：Claude Code（Changes 卡的 `+12 -1`）、Vibe Kanban（绿/红行数点击跳 Changes）、Codex App（Review 面板 + 行内 `+` 评论）、Zed（编辑器上方改动摘要条 + Review Changes）、Conductor（Diff Viewer + 行评论）。
4. **工具调用默认折叠、点开看明细，且有全局"详细度"开关**：goose 最明确（Concise 默认折叠 / Detailed 默认展开），Claude Code 用 View modes（Normal/Thinking/Verbose），Vibe Kanban（命令/搜索都是摘要+点开），Harnss（卡片可展开，README+上轮源码）。
5. **审批就地出现在需要它的位置，并区分授权范围**：Claude Code（对话流里的权限卡：Allow once / Always allow / Deny）、Vibe Kanban（动作下面一行勾/叉）、Codex App（composer 上方提示；approve once / for this session）、Cursor（审批卡写清完整路径和原因）。
6. **Agent 在等你时发系统级通知**：Harnss（四类事件）、Zed（`notify_when_agent_waiting`）、Codex App（完成/需审批，后台时默认发）、Claude Code（手机端推送完成或需审批）。

**多数这样做，但有变化**

7. **运行状态在"对话旁边"的一栏里，而不是塞进聊天流**：Claude Code 的 session details 卡片组（在哪跑/改了什么/正在跑什么/上下文%）、Codex App 的 task sidebar（plan/sources/artifacts/summary）、Vibe Kanban 的右 Details + Context 面板。宽度不够时这些栏会**自动隐藏或收进菜单**（Claude Code 只在聊天够宽时出现；按钮放不下进 ⋮；goose <700px 收图标）。
8. **停止 + 排队/转向**：Cursor（回车排队、`Cmd+Enter` 立刻、Send now 转向）、Vibe Kanban（Queue/Stop）、Zed（默认排队 + Steer + "Send now" 双回车）、Claude Code（停止按钮；或者不停止直接发更正）。**没有一家的"停止"藏在菜单里。**
9. **右栏/面板开关集中在一处并可记忆**：Vibe Kanban 顶栏一排开关 + 按 workspace 记住状态；Claude Code 标题栏图标 + ⋮；Codex App 顶部图标 + `Cmd+J` 终端抽屉；goose 侧栏样式/位置/Push-Overlay 可配。

**只有一两家（是差异化点，不是行业默认，抄之前要想清楚）**

10. **多 Agent 的"成员列表放在聊天输入框上方"**：Cursor Projects（Agents 列表 + Listening 药丸都在输入框上方）——这是本轮看到的**最贴近我们"负责人 + Worker"模型**的入口布局。
11. **状态三分法 running / waiting for input / ready for review**：Codex App 的 pet 覆盖层明确用了这三态词；Vibe Kanban 的 Running / Idle(等你输入) / Needs Attention 语义相同。**没有一家把"等你"只放在聊天流里**（这正是上一轮我们出问题的那点）。
12. **额度读数的位置分歧很大**：Claude Code 把**套餐额度环放在输入框那一行**（唯一在我看到的界面主区里放套餐额度的）；Cursor 明确把用量放**网页 dashboard**、编辑器只在撞限时通知；Codex App 的统计藏在 **Settings > Profile**；Vibe Kanban/Zed 只显示**上下文窗口**百分比不是套餐额度；Harnss/AionUi/Conductor：看不到。**上下文占用**几乎每家都有，**套餐额度/5 小时窗口**基本没有——所以我们要自己决定放哪（建议跟 Claude Code：在输入框那一行或左栏底部一行，不要塞进设置页）。
13. **可拖拽 pane 系统**只有 Claude Code（8 种 pane 任意排布）和 Vibe Kanban（四栏 + 浮动工具条）做到这个程度；Zed/goose/Codex 只提供固定分栏 + 开关。我们不需要做到 Claude Code 那种程度。
14. **失败提示的颜色与可达性**：goose 红点（会话行）、Vibe Kanban 红色错误消息+警告图标可点开、Harnss 失败任务在后台任务面板里。没有一家只把错误写进聊天流。

## 12. 本轮看不到 / 没查到的（不要当作结论）

- Conductor 的输入框、运行状态、审批提醒、用量、面板开关：官方文档页多次抓取 404，只拿到 diff-viewer、changelog、collaboration 与索引摘要。
- Codex App 与 Codex IDE：**工具调用默认折叠还是展开、展开入口在哪**没写；**5 小时额度/速率限制读数在界面哪里**没写。
- Cursor：**工具调用的折叠默认**与"谁在干活"的状态区没有官方说明（论坛抱怨 "Explored" 折叠，属用户反馈不是文档）；Agents Window 左栏每行字段没写。
- Zed：权限确认卡出现在哪个位置没写；付费额度不在面板里。
- AionUi：只读到"快速上手"级别的布局（左栏、输入框、右侧项目面板），其余（工具调用折叠、状态、审批、改动、额度）wiki 里没有对应页面。
- Harnss：README 只讲功能不讲位置；额度：看不到。
- goose：桌面版的改动/diff 界面、审批提醒、额度显示位置都没文档；输入框控件清单没文档。
- Claude Code：sidebar 会话行的具体字段没写；桌面端有没有"某某在等你"的横幅/徽标没写（只写了手机端推送）。
- **本轮没有看任何截图画面**（抓取只返回文本），凡是【截图alt】的格子都只到"有什么"层级，不到"长什么样"层级。
- 本轮按任务书**没读任何外部源码**；上一轮的源码结论仍标在第 3 节，不要和本轮混引。

## 13. 给 Sol 的可抄点（只是候选，最终由 UI-LAYOUT.md 定）

1. 左栏会话行加**三态状态点**，用 goose 的词法（干活/完成/出错）+ Vibe Kanban 的 **Needs Attention 举手图标**；等用户的会话在列表里必须一眼可见。
2. **"等你回答 / 团队工作中"这条横幅不要只存在于聊天流**：Codex App 和 Vibe Kanban 都把它做成独立状态栏语义，并且**同时在系统通知里发一份**（Harnss 的四类事件是现成的清单：计划审批、权限、提问、完成）。
3. 输入框下方一行放：模型 + 强度 + 停止 + 附件 + **额度**（Claude Code 就是这一行；额度别放进设置页）。
4. 右栏常驻"成员卡 + 正在做什么"（对应 Codex task sidebar 的 plan/summary 思路），**成员列表入口放到输入框上方**（Cursor Projects 的做法）——这两条合起来正好覆盖任务表里"经常：看每个成员在做什么、卡在哪"。
5. 改动入口：对话里显示行数摘要（`+12 -1`）点进 diff（Claude Code / Vibe Kanban），diff 里支持行内评论回话（三家都有）。
6. 折叠默认 Concise、明细可点开、失败强制展开（goose 的 Response Styles 是最干净的模型）；"展开某成员完整记录"用 Claude Code 的 subagent 面板语义（点条目→明细面板→可 stop）。
