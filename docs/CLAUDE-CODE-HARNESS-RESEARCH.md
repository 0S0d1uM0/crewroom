# Claude Code 作为平台 Harness 的调研（2026-11-03）

状态：调研结论，尚未做真实运行验证。下文的测试模型按用户要求使用 Haiku 5.5（`claude-haiku-5-5`）。

## 1. 依据

- 本机 Claude Code CLI：`2.1.317`，位于 `%USERPROFILE%\.local\bin\claude.exe`。**独立 CLI 目前没有登录**（`claude auth status` 显示 `loggedIn: false`，见第 7 节）。本文早先写的"已用 Claude 订阅登录"是错的：当时的会话是通过桌面 App 认证的。
- `@anthropic-ai/claude-agent-sdk@0.3.317`（与 CLI 版本对应）：只用 `npm pack` 下载并读取 `sdk.d.ts`，没有安装，也没有运行。
- `@agentclientprotocol/claude-agent-acp@0.100.0`（基于 SDK 0.3.316 的 ACP 适配器）：只读了 README。
- 官方文档：Agent SDK overview、Legal and compliance、Sandboxing（code.claude.com/docs）。

## 2. 三种接入方式

| 方式 | 说明 | 优点 | 缺点 |
|---|---|---|---|
| **A. Agent SDK（TypeScript，推荐）** | daemon 内调用 `query()`，SDK 启动本机未修改的 `claude` 可执行文件 | 官方接口；权限回调、结构化输出、会话恢复、额度事件、中断都有类型定义；客户端工具可以在进程内提供 | 新增一个依赖；每个会话一个子进程 |
| B. ACP 适配器 `claude-agent-acp` | 复用现有 `AcpWorker` | 与 DSH 接入方式一致 | 多一层第三方适配；担任负责人所需的客户端工具只能通过 ACP 传入 MCP 服务器；额度事件和结构化输出需要透过适配器扩展获取 |
| C. 直接用 CLI | `claude -p --input-format stream-json --output-format stream-json` | 没有依赖 | 权限回调需要自己实现 SDK 的控制协议，或者使用 `--permission-prompt-tool`（MCP 工具） |

~~推荐 A~~：用户希望各 Agent 像 DSH 一样通过 ACP 接入、不经过 MCP 交流。下面详查 B 后，**改为推荐 B（ACP 适配器）**，A 作为备选。

### 2.1 ACP 适配器详查（`@agentclientprotocol/claude-agent-acp@0.100.0`）

Claude Code 本身不像 DSH 那样内置 ACP 服务端，但 ACP 组织维护了官方适配器（前身是 Zed 的 `claude-code-acp`）。它基于 Agent SDK，把 Claude Code 包装成一个 ACP Agent。

| 项目 | 结果 | 依据 |
|---|---|---|
| 会话能力 | `session/new`、`list`、`resume`、`close`、`fork`、`loadSession` 都支持，满足现有 `AcpWorker` 要求的 resume / list / close | `dist/acp-agent.js` 的 `sessionCapabilities`、README |
| 权限裁决 | 通过 ACP `session/request_permission` 发给客户端，与 DSH 相同 | README |
| 使用本机登录 | 环境变量 `CLAUDE_CODE_EXECUTABLE` 指向本机已登录的 `claude.exe` | `dist` 中读取的环境变量 |
| 工作会话隔离 | 客户端可以在 `session/new` 的 `_meta.claudeCode.options` 中传 SDK 选项，并覆盖适配器的默认值，包括 `settingSources`、`disallowedTools`、`tools`、`env`、`extraArgs`、`mcpServers`。适配器默认会加载 user / project / local 三种设置，所以平台必须显式覆盖 | `acp-agent.js` 中 `...userProvidedOptions` 展开在默认值之后 |
| 用量与费用 | `usage_update` 通知，含上下文占用和 `total_cost_usd` | `acp-agent.js` |
| 订阅额度 | SDK 的 `rate_limit_event` 以 `usage_update._meta["_claude/rateLimit"]` 转发（5h / 7 天窗口、状态、重置时间） | `acp-agent.js` 6271 行 |
| 子代理 | 声明 `clientCapabilities.subagents` 的客户端会把子代理当作子会话收到。平台不声明此能力，并用 `disallowedTools` 去掉子代理工具 | README |
| 协议版本 | 同时支持 ACP v1 和实验中的 v2；`CLAUDE_AGENT_ACP_PROTOCOL` 可以固定版本 | README |

另外，Codex 也有 ACP 适配器 `@zed-industries/codex-acp@0.16.0`，三种 Harness 理论上都可以走 ACP。不过 Codex 的 app-server 已经验证通过，而且审查、按 turn 设沙箱、额度查询等能力更完整，建议 Codex 继续用 app-server。

### 2.2 Agent 之间怎么直接交流

ACP 是"客户端 ↔ Agent"的协议，不是"Agent ↔ Agent"的协议。现有框架里 DSH 和 Codex 也从来不直接相连，消息都由 orchestrator 转交。所以"Agent 之间直接交流"的实现方式是：

- 平台作为 ACP 客户端，同时连接每个 Agent。
- 一个 Agent 的回复中写明发给谁（沿用并扩展现有标记，例如 `[TO qwen]`、`[ASK sol]`、`[RESULT]`），平台用确定性代码解析，作为下一条 prompt 投递给对方。
- 对方的回复再按同样的方式送回。

这样不需要 MCP，也不需要任何 Agent 获得额外工具。

代价是交流以 turn 为单位：一个 Agent 发出消息后就结束本轮，等对方回复后，平台再用新的 prompt 叫醒它。它不能在同一轮里一边等待回复一边继续工作。对负责人来说这反而更省 Token，因为它不需要在等待期间维持一个进行中的 turn。

只有需要在 turn 中途发消息、并在同一轮内拿到回复时，才需要工具（Codex 的 `dynamicTools`，或 Claude 的进程内工具）。v1 不需要这种能力。

## 3. 能力对照（来自 SDK 0.3.317 类型定义）

| 能力 | SDK 中对应的接口 | 与 Codex 的差异 |
|---|---|---|
| 持久会话与恢复 | `resume: <sessionId>`、`forkSession`、`sessionId`、`resumeSessionAt`；会话保存在 `~/.claude/projects/` | 待验证：换工作目录后能否恢复（会话按项目目录存放） |
| 工作目录 | `cwd`、`additionalDirectories`（每个 query 一次） | Codex 能按 turn 改；Claude 换目录需要新 query + `resume` |
| 权限裁决 | `canUseTool(toolName, input, { blockedPath, decisionReason, signal })` → `allow` / `deny` | 对文件工具**比 Codex 更强**：`Edit` / `Write` 的输入里有 `file_path`，平台可以按文件租约裁决（C2.2 已验证）。但**不是每次工具调用都回调**：工作目录内的读取，以及 Claude Code 判定为只读的 Shell 命令，都不经过平台（C3.1） |
| 权限模式 | `permissionMode`：`default`、`acceptEdits`、`plan`、`dontAsk`、`auto`、`bypassPermissions`；`query.setPermissionMode()` 可以中途切换 | |
| 工具限制 | `tools`、`allowedTools`、`disallowedTools` | 可以直接去掉 `Agent` 工具（子代理）和网络工具 |
| 沙箱 | `sandbox: SandboxSettings`，`failIfUnavailable` | **Windows 上存在冲突**，见第 5 节 |
| 结构化输出 | `outputFormat: { type: 'json_schema', schema }`，结果在 `result.structured_output` | 与 Codex 的 `outputSchema` 等价 |
| 客户端工具（担任负责人） | `createSdkMcpServer()` + `tool()`，作为进程内 MCP 服务器传给 `mcpServers` | 协议是 MCP，但在 daemon 进程内运行，不安装任何东西，也不改用户配置；需要用户确认是否符合"不使用 MCP"的约定 |
| 中断 | `query.interrupt()`、`abortController` | |
| 用量 | 结果消息里的 `usage`、`modelUsage`、`total_cost_usd` | 订阅用户的 `total_cost_usd` 只是按 API 价格的估算 |
| 订阅额度 | `rate_limit_event` 消息：`status`（`allowed` / `allowed_warning` / `rejected`）、`resetsAt`。各窗口的用量百分比在 `unifiedWindows` 字段里（实测得到，SDK 类型定义中没有声明，以后可能变化） | Codex 可以主动查询额度；Claude 只能在发出请求后从事件中得知，没有主动查询接口 |
| 账户 | `query.accountInfo()`：`subscriptionType`、`tokenSource`、`apiProvider` | |
| 模型与推理强度 | `model`（如 `claude-haiku-5-5`）、`effort`（low–max）、`fallbackModel` | |

## 4. 登录与条款

这是 Claude Code 与 Codex 最不一样的地方，结论分两种情况：

- **你自己使用：可以。** Legal and compliance 页面写明，这些限制不阻止最终用户用自己的 Claude 订阅登录未修改的 Claude Code 可执行文件，包括由平台托管 Claude Code 的情况。平台通过 SDK 启动本机已登录的官方 `claude.exe`，额度计入你自己的订阅，这属于这种情况。
- **将来把这个软件给别人用：需要改变方式。** 官方不允许第三方产品提供 claude.ai 登录，也不允许代用户转发订阅额度，或收集、存储、中转 claude.ai 的凭据和会话令牌。分发给别人时，每个用户要么用自己的 API Key，要么通过 Claude Code 自己的登录流程登录未修改的可执行文件。
- 订阅的额度标准是按"普通的个人使用"设定的。多个 Claude 执行者长时间并行，会很快消耗 5 小时窗口。

由此得出的实现约束：

1. 平台只调用本机已安装、未修改的 `claude.exe`（适配器的 `CLAUDE_CODE_EXECUTABLE`），从不读取、复制或保存 Claude 的登录令牌。
   - 平台可能运行在某个 Claude Code 会话内部。这时环境变量里有桌面 App 的接口地址和会话令牌（`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_*` 等）。子进程不能继承这些变量，否则就是在中转会话凭据。`scripts/validation-common.mjs` 的 `scrubbedEnv()` 会把它们全部去掉。
2. 不使用 `--bare`：该模式只接受 `ANTHROPIC_API_KEY`，会绕开订阅登录。
3. 在界面中明确标出 Claude 参与者消耗的是你的订阅额度。

## 5. 风险与未决问题

1. **这台机器上没有可用的 Windows 沙箱（C2.5 已实测）。** 开启沙箱并设 `failIfUnavailable: true` 后，Claude Code 报错："the Windows sandbox is not active on this session (feature gate off)"。这解释了文档和类型注释的矛盾：代码里有 Windows 沙箱，但功能开关是关的。平台因此不能把沙箱当作写入边界：
   - **执行者不给 Shell 工具**，由平台运行验收命令（C2.6 已验证 `disallowedTools` 能挡住）。不能靠审批来限制 Shell，因为 Claude Code 判定为只读的命令根本不会询问平台（C3.1）。
   - 始终设 `sandbox.failIfUnavailable: true`，让 Claude Code 在沙箱不可用时报错，而不是悄悄以无沙箱方式运行。C2.5 证实这个保护有效。
   - 这与 Codex 不同：Codex 的 Windows 沙箱是可用的（`windowsSandbox/readiness: ready`，C2.2、C2.3 实际拦下了越界写入和网络访问）。
2. **与负责人共用额度。** 现阶段负责人是你在桌面 App 中使用的 Claude Code 会话。平台再启动 Claude 执行者，两者会消耗同一个 5 小时窗口。
3. **额度只能被动得知，而且有漏报的可能。** 没有主动查询接口。平台只能在请求后根据 `rate_limit_event` 更新 `quota/claude.json`；还没有发出请求时，只能显示上次观察到的值。此外，适配器只有在已经收到 assistant 用量后才转发这个事件（`acp-agent.js` 6271 行），所以一个会话的第一个事件可能被丢弃（C1.1 时事件数为 0）。如果额度在会话第一个请求时就已耗尽，平台可能只能从错误信息判断。
4. ~~换工作目录后的会话恢复。~~ C4.4 已验证：在另一个 worktree 中 `resume` 后上下文保留，实际工作目录也跟着改变（相对路径读到了 `WORKTREE-B`）。所以一个 Claude 会话可以跨 worktree 使用，但换目录需要重启进程并恢复会话。
5. **崩溃对账比 Codex 弱。** 进行中被杀的 turn 没有状态字段。`session/load` 回放时能看到用户消息，但没有 assistant 文本（C4.3）。平台要结合自己的发送记录判断。这个用例中 turn 没有调用工具，所以尚不清楚中途的工具调用会怎样出现在回放中。
8. **真实的额度耗尽没有测过。** Codex 和 Claude 的验证都没有真正触发过额度用完的情况，"中途结束"的错误形式和处理路径都还没有实际验证。
6. ~~客户端工具的形式。~~ 改用 ACP 适配器，并按 turn 路由消息后，v1 不需要客户端工具，也不需要 MCP（见 2.2 节）。
7. **ACP 适配器的第三方层。** 它不是 Anthropic 发布的，版本更新频繁（0.100.0），依赖固定的 SDK 版本（0.3.316）。平台需要锁定版本，升级时重跑验证。

## 6. 工作会话的隔离参数（拟定）

| 目的 | 参数 |
|---|---|
| 不加载你的用户设置、hooks、`CLAUDE.md` | `settingSources: []`（需要目标项目的 `CLAUDE.md` 时只加 `'project'`） |
| 不加载你的 MCP 服务器和插件 | `strictMcpConfig: true`，`mcpServers` 只放平台的工具，`plugins: []` |
| 不开放子代理和网络 | `disallowedTools: ['Agent', 'WebFetch', 'WebSearch']` |
| 平台裁决每次工具调用 | `permissionMode: 'default'` + `canUseTool` |
| 防止反向调用平台 | `env` 中带 `CREWROOM_PLATFORM_WORKER=1`，与 Codex 相同 |
| 结构化结果 | `outputFormat: { type: 'json_schema', schema }` |
| 待评估 | CLI 的 `--restricted` 模式（去掉运行代码的工具，忽略用户 / 项目设置，把文件工具限制在工作目录内），可以通过 `extraArgs` 传入 |

## 7. 验证方案（草案，未执行）

结构与 Codex 验证相同，模型使用 `claude-haiku-5-5`，低推理强度，每次运行都需要你批准。改用 ACP 适配器后，脚本通过现有的 `AcpWorker` 连接 `claude-agent-acp`，隔离参数放在 `session/new` 的 `_meta.claudeCode.options` 中。阶段 5 改为测试按 turn 的消息路由：Claude 在回复中用标记给 `qwen` 派活，平台解析后投递，不使用工具。

| 阶段 | 用例 | 额度 |
|---|---|---|
| 0 | 启动 SDK，`accountInfo()`、`supportedModels()`，确认 Haiku 5.5 可用；在隔离参数下列出可用工具和 MCP 服务器 | 不发起推理 |
| 1 | 结构化输出；多轮上下文；进程重启后 `resume` | 约 3 个 turn |
| 2 | **Windows 沙箱实测**；`canUseTool` 按文件租约放行 `Edit` / `Write`、拒绝越界写入；拒绝后不绕过；环境变量传递 | 约 4 个 turn |
| 3 | 审查：给出预埋 bug 的 diff，用结构化输出返回问题列表（Claude Code 没有与 Codex `review/start` 对应的接口） | 1 个 turn |
| 4 | `interrupt()`；完成后崩溃与进行中崩溃的对账；在另一个工作目录中 `resume` | 约 3 个 turn |
| 5 | 进程内工具 `dispatch_task` / `collect_results`：Claude 作为负责人 | 约 1 个 turn |
| 6 | 汇总 `usage` 和 `rate_limit_event`，写入 `quota/claude.json` | 不发起推理 |

### 7.1 脚本与当前状态

- 依赖已安装：`@agentclientprotocol/claude-agent-acp@0.100.0`（固定版本），带上 SDK `0.3.316`。可选依赖中包含一份约 335 MB 的 Claude Code 可执行文件，但平台不使用它，而是用本机的 `claude.exe`。`npm run build` 通过，现有 65 个测试全部通过。
- 驱动脚本：[scripts/claude-validation.mjs](../scripts/claude-validation.mjs)，与 Codex 脚本共用 [scripts/validation-common.mjs](../scripts/validation-common.mjs)（夹具、快照、环境清理）。
- 额度快照写入 `%LOCALAPPDATA%\Crewroom\\legacy-state\quota\claude.json`，格式与 Codex 相同。

阶段 0 已运行（未发起推理）。用户先自己运行 `claude auth login` 登录了独立 CLI；脚本不会替用户登录，也不会借用桌面 App 的会话。

| 用例 | 结果 | 观察 |
|---|---|---|
| C0.1 登录状态 | 通过 | 去掉会话环境变量（34 个）后，CLI 显示已登录，方式 `claude.ai`，订阅 `pro`。账户邮箱不会被记录 |
| C0.2 适配器握手 | 通过 | 协议 v1；`loadSession`、`resume`、`list`、`close`、`fork` 都可用 |
| C0.3 建会话 | 通过 | 模型 `haiku`（显示名 Haiku 5.5），effort `low`，权限模式 `default` |

需要注意的模型细节：

- 会话的**默认模型是 Opus 5.5**。如果设置模型失败，会悄悄消耗更贵的额度。所以脚本在发送任何 prompt 之前，都会比较模型的显示名，不符就停止；第一个 turn 之后还会检查实际回答的模型（`usage_update._meta["_claude/model"]`）。平台实现时也要这样做。
- 模型列表中没有 `claude-haiku-5-5` 这个值。适配器把它解析成别名 `haiku`，显示名是 Haiku 5.5。列表里另有 `claude-haiku-4-5-20251001`（Haiku 4.5），所以只检查名字里有 "haiku" 是不够的。

运行方式：

```powershell
# 阶段 0，不发起推理：
node scripts/claude-validation.mjs
# 阶段 1–5，消耗 Claude 订阅额度，需要用户对本次运行的明确批准：
node scripts/claude-validation.mjs --stage 1,2,3,4,5 --authorized-this-run
```

与第 7 节草案相比的变化：C1.4 测试 `outputFormat` 能否穿过适配器；C2.2 测试按文件的租约；C2.5 实测 Windows 沙箱（探测文件写到临时夹具中，事后删除）；C4.4 测试在另一个 worktree 中恢复会话。

### 7.2 阶段 1–5 结果（2026-11-03，经用户批准，Haiku 5.5，low）

16 个 turn，全部由 `claude-haiku-5-5` 回答。必测用例全部通过，记录性用例见下表。按 API 价格估算约 0.02 美元（实际消耗的是订阅额度，不是这笔钱）。运行结束时 5h 窗口 39%，每周窗口 16%；这些数值包括账户上的其他使用，运行期间的 4 个事件都是这个值，这次运行本身的消耗无法单独分离出来。

| 用例 | 结果 | 观察 |
|---|---|---|
| C1.1 回复与用量 | 通过 | 首个 turn 约 1.86 万 Token 写入缓存，与 Codex 隔离后的 1.94 万接近 |
| C1.2 多轮上下文 | 通过 | |
| C1.3 进程重启后恢复 | 通过 | |
| C1.4 `outputFormat`（记录） | — | 模型调用了 `StructuredOutput` 工具，回复文本为空，结构化内容不在响应中。上次运行没有捕获工具输入，尚不确定能否拿到 |
| C2.1 只读 / 写入被拒 | 通过 | 读文件没有询问；写文件的请求到达平台，拒绝后文件没有创建 |
| C2.2 按文件租约 | 通过 | **关键结果**：`notes.txt` 放行；同目录的 `other.txt` 和另一个 worktree 的文件都被拒绝且没有创建 |
| C2.3 拒绝 Shell | 通过 | 拒绝后 Claude 报告失败，没有换方式 |
| C2.4 环境变量传递 | 通过 | `VALUE=1`。Shell 是 Git Bash |
| C2.5 Windows 沙箱（记录） | — | 不可用（功能开关关闭），`failIfUnavailable` 让它报错，而不是无沙箱运行 |
| C3.1 审查 | 通过 | 准确指出 `src/calc.mjs:4` 的差一错误。**但 Shell 命令没有经过平台**：`approvals` 为空，工具状态是 completed |
| C4.1 取消 | 通过 | 约 0.8 秒后 `stopReason: cancelled`。被取消的 turn 用量显示为 0，所以这部分消耗不会被记账 |
| C4.2 完成后崩溃 | 通过 | `session/load` 回放能取回完整回复 |
| C4.3 进行中崩溃（记录） | — | 可以加载；回放有用户消息，无 assistant 文本；没有状态字段 |
| C4.4 换 worktree 恢复（记录） | — | 恢复成功，上下文保留；实际工作目录未确认 |
| C5.1 按 turn 转交消息 | 通过 | 没有使用工具。Claude 输出两行 `[TO qwen]`，收到 `[FROM qwen]` 后输出 `[RESULT]` |

上次运行后已修正的脚本问题（修正本身没有消耗额度）：

- 额度百分比在 `unifiedWindows` 里，脚本读错了字段，所以 **80% 停止线在这次运行中没有生效**。这次没有接近上限，没有造成影响。
- 工具输入在 `tool_call_update` 中才到达，脚本之前只看 `tool_call`，所以没有记录到命令内容和 `StructuredOutput` 的内容。

已知的空白：隔离参数是否真的挡住了用户的 MCP、插件和记忆，目前只有间接证据（用户的权限规则没有生效，基础 Token 数接近），没有直接列出工具来确认。

### 7.3 后续用例结果（2026-11-03，经用户批准，5 个 turn）

| 用例 | 结果 | 观察 |
|---|---|---|
| C1.4 `outputFormat`（记录） | 可用 | 结构化内容不在回复文本里，而在 `StructuredOutput` 工具调用的 `tool_call_update.rawInput` 中：`{"type":"RESULT","summary":"ok"}`。它会分批到达（先是 `{"type":"RESULT"}`），所以要等工具状态变成 completed 后再取 |
| C2.6 去掉 Shell 工具 | 通过（见下） | `disallowedTools` 中列出 `Bash`、`PowerShell`、`Monitor` 后，命令没有执行，也没有发起审批 |
| C2.7 读取工作目录外的文件 | 通过 | 读取请求到达平台，拒绝后内容没有泄露。工作目录内的读取则不询问 |
| C4.4 换 worktree 恢复（记录） | 可用 | 上下文保留，实际工作目录跟着改变 |

**C2.6 脚本当时报告失败，这是脚本的判定条件错了。** Haiku 仍然尝试调用了 Bash，脚本把这次尝试算成了执行。会话记录显示 Claude Code 直接拒绝了调用：`No such tool available: Bash. Bash is disabled for this session, in subagents as well as here.`。判定条件已改为只统计状态为 completed 的调用，这个用例没有因此重跑。这次只观察到 Bash 被挡住，模型没有尝试 PowerShell 和 Monitor。

额度解析修正后已经正常：5h 窗口 43%，每周窗口 17%。两次运行之间 5h 窗口从 39% 涨到 43%，这期间账户上可能还有其他使用（比如同账户的桌面会话），所以不能当作这 5 个 turn 的消耗。

测试留下的内容：`~/.claude/projects` 下有 7 个以测试夹具路径命名的会话目录，`%TEMP%` 下有 `crewroom-claude-validation` 和 `crewroom-codex-validation` 夹具。都没有自动删除。
