# Crewroom 设计记录

状态：早期设计记录，保留决策背景，部分内容已过时，实际行为以代码为准。文中的 `collab` 是这个项目早期的命令行工具，已不在本仓库内。

## 1. 目标与非目标

目标：

- 用户为每次运行指定负责人和参与的 Agent / 模型，然后给出任务。
- 按能力与成本分工：Claude 和 Codex 只在需要它们的地方出场，大量的代码工作由免费的本地模型完成。
- 复用现有框架的 ACP worker、持久化消息、状态机、权限授予和用量账本。

非目标（v1 不做）：

- 对等的自由协商、选举负责人、Agent 之间任意互相派活。
- 图形界面。v1 只有 CLI，由负责人所在的会话调用。
- 自动推送代码或合并到主分支。
- 接管已经打开的 Codex 桌面会话。

## 1a. 产品形态与协作模型（2026-11-03 决定，与下文冲突时以本节为准）

权限由平台 PermissionManager 管理，默认安全读写和联网开启。用户同源 API 独占临时批准，负责人仅可调整其他成员的常驻档位。日志恢复常驻变更和完全相同命令授权，暂停、停止与退出取消挂起请求。成员卡、顶部等待区及权限面板显示状态。Codex 沙箱下一回合生效，Claude/DSH 的工具规则下次调用生效，具体能力缺口见 PERMISSIONS.md。


下文的任务卡、固定分工、"每人最多提一次异议"、"不广播"和文件租约，都是这次决定之前的设计。标"待定"的内容尚未决定，方案都还没有实现或验证。

上一轮修复了事件重复应用和全量重绘导致的内存增长、异步快照及私有索引复用，并建立逐字节保存的 Git 初始基线；历史日志仍常驻内存，快照 refs 的保留策略另定。本轮保留原生 ES 模块、CSP、250 毫秒合并刷新和最近 200 条渲染窗口，采用左侧项目会话、中间负责人对话与常驻输入框、右侧常驻成员卡加辅助页签；等待提示同时出现在顶部和会话列表，补齐草稿、重试和文件差异。详见 [界面布局决定](UI-LAYOUT.md)。

### 使用方式

- 独立桌面 App：项目 → 会话。添加文件夹即添加项目。
- 新建会话时指定负责人和 Worker（Harness + 模型）。具体分工由模型自己商量。负责人也可以实现功能。
- 用户只与负责人对话，不与 Worker 交流，需要控制的细节由负责人转交。用户可以查看所有成员的记录，也可以暂停或停止。
- 用户在负责人工作时发消息：Harness 支持插话就插话，否则等当前 turn 结束，并提供打断按钮。
- daemon 与界面分离，关闭窗口后任务继续。Qwen 并发为 1，调度要跨会话。

### 两种交流方式

**会议（meeting，默认）**：每个会话一块白板。

- 所有 Agent 都能读取全部内容，只能写自己的空间。作者由平台标注，Agent 无法冒充。
- 内容中 `@成员` 或 `@负责人` 时，消息在对方当前输出结束后送达；对方空闲时立即唤醒。
- 负责人有全局插话和打断的接口。
- 不限制来回轮数。会议没有结束的概念，它是默认的交流模式。

**私信（message）**：不占用白板的点对点消息，直接插话到对方当前的 turn。发送方可以结束输出等待，也可以继续工作；收到插话后可以随时私信回复。其他 Agent 看不到；平台记录，用户可以查看。

**`@` 和私信都分两种**，用来从源头避免互相客气造成的循环：默认**不需要回复**；只有 Agent 明确需要答复时才用**需要回复**。

**工作空间**：默认共用项目目录，可以选择多 worktree。选择多 worktree 时，平台开会话时为每个 Agent 开一个工作空间。两种模式都为 Agent 命名，这些信息会通知负责人。

### 实现（原型已实测，见下方"原型结果"）

- **写用标记，读用文件。** Agent 在回复文本里写 `<<<board` / `<<<dm NAME` 块，平台解析后写入，不需要 MCP、额外工具或额外的工具调用。作者由平台确定。白板是项目目录外的普通文件，Agent 用自己的读文件工具读取。这取代了原先"Agent 用文件工具写白板"的方案。语法见 PROTOTYPE-BRIEF.md 第 3 节。
- 引用和代码块里的 `@` 不触发投递。
- Agent 直接改白板文件时，平台在 turn 结束后恢复文件并通知它重发。
- 成员结束 turn 时，如果有它已经收到、但没有用块回复的"需要回复"请求，平台把它最后的普通文本转给请求者。原因见下方原型结果。
- Qwen 的并发 1 按单次模型请求排队，不按 turn。Agent 没有阻塞等待的手段，要么继续工作，要么结束输出，所以这样不会死锁。
- 所有成员都空闲、没有待投递消息，且负责人上次发言后有新内容时，平台唤醒负责人一次，让它决定是否向用户汇报。没有新内容就不唤醒，否则这个机制本身会变成循环。
- 平台记录"需要回复"的消息是否已有回复，并在事件中报告。
- 平台给 Agent 的说明里要写明：平台转交的私信来自队友，是正常工作消息。见下方 S3 的拒绝结果。

### 插话能力

| Harness | 方式 | 状态 |
|---|---|---|
| DSH | ACP 桥不提供插话：运行中再发 `session/prompt` 会报 `a prompt is already in flight`。核心的 `agent.steer()` 可用，通过项目已有的隔离插件机制调用 | 已用本地 Qwen 实测（`scripts/dsh-steer-probe.mjs`，依赖 DSH 内部接口，升级后要重测） |
| Codex | `turn/steer` | 已用 GPT 6 Luna 实测：工具调用之间插话成功，最终回复包含插话内容 |
| Claude Code | 适配器的 `_session/steering`，有 `now` / `later` 两种优先级 | 已用 Haiku 5.5 实测：同上 |

DSH 实测结果：

- **S2 工具调用中插话**：成功。第 1 次工具调用后插话，约 0.4 秒后继续下一个工具，最终回复包含插话要求的内容。
- **S3 / S5 纯文本生成中插话**：不会打断当前生成，要等这一步生成完才送达。1500 个数字约等了 20 秒。所以插话的延迟取决于当前这一步有多长。
- **S5**：要求不冲突时，Qwen 照做。
- **S3**：要求"停下手头的事并回复代号"时，Qwen 拒绝了（回复以 "I'm not going to do that" 开头）。这只是一次观察，原因推测是把这条消息当成了可疑指令。
- **S4 对空闲会话插话**：会唤醒 Agent 并直接输出，不需要 prompt，之后的 prompt 也正常。但这时没有 prompt 响应可以用来判断结束，所以对空闲成员还是用普通 prompt。

### 权限

工作目录内可以随意增删改，由用户用 Git 管理；工作目录外不动。实际约束力因 Harness 而异：

| Harness | 工作目录外的写入 |
|---|---|
| Codex | 沙箱拦截，已验证 |
| Claude Code（Windows） | 文件工具可以拦截，已验证。Shell 命令没有系统级限制，只能尽力检查，不是硬边界 |
| DSH（Qwen） | 已去掉 DSH 沙箱。平台用工具守卫在调用前检查：文件工具可靠拦截；Shell 只能检查命令文本，运行时拼出的路径拦不住（已实测），不是硬边界 |

Git 无法保护未提交的改动、被忽略的文件，也防不住 `git clean` 或 `git reset --hard`。拟定的补充措施：平台在每个 turn 结束后自动保存快照到隐藏引用（如 `refs/agents/<会话>/<序号>`），不影响用户的分支，也不碰用户的暂存区（用单独的 `GIT_INDEX_FILE`）。平台不主动推送。

共用目录时的已知代价：多个 Agent 可能互相覆盖同一文件，构建和测试可能互相干扰，同时提交会碰到 `index.lock`，快照也无法区分某个改动是谁做的。协调靠白板。

### WSL2（2026-11-03 在本机实测）

不建议作为默认方案。这台机器上 Ubuntu-24.04（WSL2）可以读写 Windows 文件，双方都能看到，也能从 WSL 里调用 Windows 程序（`cmd.exe`）。但：

- `/mnt/c` 上的小文件操作很慢：500 个小文件约 1.15 秒，WSL 自身的文件系统约 0.013 秒，相差约 90 倍。
- Linux 工具链编译出来的是 Linux 程序。要编译 Windows 目标，只能调用 Windows 工具链。
- 被调用的 Windows 程序运行在 Linux 沙箱之外（这是推断，没有实测，因为本机 WSL 没有安装 `bwrap` 和 Claude Code）。这样一来，用 WSL2 换来的沙箱保护在编译和测试时并不生效。

实际的编译和测试也没有跑过。

### 原型结果（2026-11-03）

代码在 `src/platform/`，由 Codex GPT 6.1 Sol 按 PROTOTYPE-BRIEF.md 实现，负责人审查后修复。离线测试 102 个全部通过。

```
node dist/platform/cli.js --config team.json --message "..."
```

实测团队：Haiku 5.5（负责人）、本地 Qwen、GPT 6 Luna，在测试仓库上修 bug、加函数和测试、互相审查，约 44 秒完成。Luna 的审查发现了 Qwen 测试里的一个真实错误，修正后 14 个测试全部通过，工作目录外没有变化。这次运行的最终报告是 `pass: false`，因为当时的脚本没有把转发的回复算作发言；脚本已修正，按记录的事件重新判断，各项条件都满足，但修正后没有再跑一次。

实测中暴露、已修复的问题：

- **第一次运行检查通过，但两个 Worker 的消息都没有经过平台。** 它们把"写块"理解成写文件，直接改了白板文件，所以没有唤醒任何人，负责人也误以为收到了汇报。已明确说明、恢复被改的文件、并收紧检查。
- **GPT 6 Luna 始终用普通文本回答，不写块。** 说明写得再清楚也不能保证模型遵守，所以平台转发未回复请求的最后文本。负责人在修复前如实报告了"审查没有发生"。
- Codex 的 `-c` 把带引号的键当字面值，app-server 启动即退出。这种问题假进程测不出来。
- `@qwen.` 不触发通知；Worker 在负责人 turn 中途完成时，负责人收不到全员空闲通知。

尚未解决：

1. **并行时的白费工作**：Luna 在 Qwen 改到一半时就开始审查；Qwen 碰到"文件在读后被改过"。共用目录下还没有任何协调手段。
2. **礼貌性消息仍会消耗 turn**：Qwen 发了 `@luna thanks`，同时唤醒了负责人和 Luna，尽管说明里不让这么做。
3. Qwen 没有用量数据（原型没有走 LocalRelay）；一个会话最多一个本地 Qwen；DeepSeek 成员不支持；额度耗尽没有真实触发过，负责人自动切换也没有实现；`CREWROOM_PLATFORM_WORKER` 还没有被 `collab` 检查，只有 Claude 和 DSH 的 Shell 判断拦截 `collab`。
4. 快照每个 turn 执行一次 `git add -A`，大仓库可能很慢，也没有清理机制，没有在真实项目上测过。

### 去掉 Qwen 的 DSH 沙箱（2026-11-04，用户决定）

DSH 沙箱挡住带管道的子进程，`node --test` 报 `spawn EPERM`，这会限制 Qwen 当主力实现。平台会话现在以 `danger-full-access` 启动 DSH。`collab` 的行为和它"不开放完全访问"的规则不变。

副作用：这个模式下普通调用不再请求审批，原来放在审批回调里的检查不会运行。所以目录规则移到了 DSH 的工具守卫（`ctx.tools.guard`），它在每次调用前运行，无法被其他代码放行。守卫不可用时拒绝启动。

本地 Qwen 实测（`scripts/platform-dsh-shell-probe.mjs`，免费）：

| 情况 | 结果 |
|---|---|
| `node --test` | 正常运行，没有 EPERM |
| 带管道的子进程 | 正常 |
| 在工作目录内用 Shell 写文件 | 成功 |
| Shell 写目录外（绝对路径、`..` 相对路径） | 被拒绝，文件未创建 |
| 文件工具写目录外 | 被拒绝，文件未创建 |
| **运行时拼出的路径**（`$p = 'C' + ':\...'`） | **写到了目录外**。命令检查看不到运行时才形成的路径 |

所以"不动目录外"对 Qwen 和 Claude 的 Shell 只防误操作，防不住有意或偶然绕过，也防不住脚本内部的写入。兜底只有 Git 和平台快照。

也用真实 CLI 跑通了 Qwen 当负责人的单人会话（修 bug、跑测试、向用户汇报，结果已复核）。多人团队中 Qwen 当负责人还没有测过。

### 额度与壳退出细化（2026-11-04）
服务统一以5分钟周期选一个Codex连接读取额度，不阻塞回合、不按成员查询；Claude仅消费工作流推送，本地Qwen不展示额度。低于15%的5小时/周窗口以会话日志去重并向负责人排队提醒，负责人所在Harness低额度/耗尽时顶部提示用户，耗尽仍走quota暂停路径。壳跟随服务存活与锁身份退出；停止/移除收进确认菜单、标题可改名、等待摘要单行、成员状态点及白板/私信未读见[布局细则](UI-LAYOUT.md)。壳使用离线判定测试，实际窗口/托盘与视觉验收留给沙箱外冒烟。

### 桌面界面（2026-11-04）

代码在 `src/app/`、`ui/`，要求见 DESKTOP-APP-BRIEF.md。用平台自身开发：GPT 6.1 Sol（high）当负责人写代码和测试，本地 Qwen 当第三方审查。

```
npm run app        # 构建并打开桌面 App
npm run app:demo   # 只启动服务，用假适配器演示，不花钱，打印地址
```

验收结果（离线测试 129 个全部通过）：

| 项目 | 结果 |
|---|---|
| 三栏界面、各页签、新建会话表单 | 演示模式和真实服务都查看过 |
| 恶意内容（`<img onerror>`、`<script>`、`javascript:` 链接） | 只显示为文本，没有执行 |
| 暂停、继续；暂停期间发的消息 | 恢复后才派发 |
| 真实会话：Haiku + Qwen + Luna | 42 秒完成修 bug、加函数和测试、审查 |
| 服务被杀后重启（含失效的锁） | 会话显示"未加载"，发消息后恢复，**三个成员都保留了记忆** |
| 关闭窗口 | 服务继续运行，API 仍可访问 |

没有验证的：系统通知、文件夹选择框、额度横幅、worktree 模式、Electron 窗口本身的画面（画面是在内置浏览器中看的同一个界面）、真实的额度耗尽。

验收发现、Sol 的测试没有覆盖的缺陷：Electron 主进程在 ESM 中顶层 `await app.whenReady()` 会死锁，没有窗口也没有报错（任务书不允许 Sol 运行 Electron，所以测不到）。已修复并加了回归测试。

已知的界面粗糙之处：活动行里还有未翻译的内部事件（`lead · snapshot`、`平台 · settled`）；白板直接显示 Markdown 源码；窄窗口下左栏有横向滚动条。

### 用平台开发平台的经验（Sol + Qwen）

- **Codex 倾向于在 turn 内原地等待，而不是结束输出。** 用户在之前的使用中也观察到了。Sol 的第一个 turn 持续了 40 分钟，一直在等回复，而回复要等它的 turn 结束才能送达，形成死等。它只是偶尔通过读白板文件才看到结果。任何设计都不能依赖 Codex 主动结束 turn。已修复的部分：对未回复请求的答复现在直接插话送达。用工具调用彻底解决的方案见下一节。
- **运行中的会话原来没有外部入口。** 用户想插话时只能写白板文件（平台当作篡改并恢复，Sol 没来得及读到）或者杀进程，最后只好杀掉 Sol 的进程，也因此拿不到它的最终报告。App 现在有打断和发消息的接口，但无界面 CLI 仍然没有。
- **Qwen 反复把 `<tool_call><function=board>` 写进普通文本**，还经常把自己 `@` 了。后一次用 Haiku 当负责人的运行里 Qwen 用对了块格式，所以这种行为可能和说明或上下文有关，只有这两次样本。
- 第三方审查有实际价值：Qwen 找到了暂停状态在重启后失效等具体问题，并给出了复现步骤。

### 协作工具（用户决定：工具提供阻塞，严禁自旋）

文本标记依赖模型自觉，实测中 Qwen、Luna 都写错或不写，所以协作改成了工具。文本标记仍然保留，给不支持工具的 Harness 用（`supportsTools = false`），也能容错：模型写了标记块，平台照样处理。

| 工具 | 作用 |
|---|---|
| `post_board(text, notify?, ask?)` | 发白板，平台标作者。`notify` 不要求回复，`ask` 要求回复；对方当前工作结束后才收到。文字里的 `@name` 也算。没有通知任何人时，回执会提醒 |
| `message_teammate(to, text, reply_requested?)` | 私信，直接插话；负责人的 `to` 可以是 `all` |
| `read_board(from_start?)` | 读自己上次之后的新内容，不阻塞。没有新内容时提醒不要轮询 |
| `wait_for_messages()` | 阻塞到有消息才返回，没有超时参数，也就没有空返回可以循环 |
| `interrupt_teammate(to, text)` | 只有负责人有 |

作者由每个成员各自的令牌决定，模型无法冒充别人。工具名避开了 Codex 自带的 `send_message`、`interrupt_agent`。

三家的接入方式不同，因为长阻塞的限制不同：

| Harness | 接入 | 长阻塞的限制 | 处理 | 实测 |
|---|---|---|---|---|
| Claude Code | 平台内置的 MCP HTTP 服务（`src/platform/tool-server.ts`，只监听本机），经 ACP 传入 | 300 秒没有进度就中止，SSE 注释心跳不算进度 | `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=0`、`MCP_TOOL_TIMEOUT` | Haiku 阻塞 11 分钟，总 token 与 90 秒时相同（约 7.9 万） |
| DSH | 隔离插件注册工具，转发到同一个服务 | DSH 的 MCP 客户端 60 秒超时，ACP 无法修改；插件工具没有这个限制 | 不走 MCP | Qwen 阻塞 31 分钟 |
| Codex | `dynamicTools`（实验接口） | 工具只能在 `exec` 里调用，`exec` 每 30 秒让出，模型就反复调用 `wait`。实测 16 分钟花了 65 万 token（大部分命中缓存），最后还放弃了等待 | **结束 turn**：阻塞超过 20 秒，平台直接 `turn/interrupt`，下一条消息开新 turn | Luna 等 2 分钟，等待期间没有模型调用，全程 2 个 turn、5.2 万 token |

结束 turn 对模型来说就是"调用了等待，下一眼看到的就是消息"。这个方案不依赖模型配合，所以 Codex 不是"尽量不自旋"，而是等待期间根本没有模型在运行。

防自旋还有这些措施：

- Codex `--disable sleep_tool`。Sol 上次自旋用的就是内置的 `clock.sleep` 加读白板文件。
- 说明里不再给白板文件路径。
- Claude、DSH 在执行前拒绝以 sleep 开头或循环 sleep 的命令。Codex 没有执行前的钩子，平台看到后插话提醒，第 3 次直接打断。
- 团队全部安静时，等待中的负责人最多被提醒两次，之后再调用就真的阻塞，不会在提醒上空转。

投递规则：

- 成员在等待时，消息直接作为工具返回值送达，不走插话。
- 进入等待等同于"输出结束"：会打快照、转发未回复的纯文本答复、检查白板是否被改。
- 插话只在下一步边界才生效，而阻塞中的调用没有下一步。所以成员开始等待时，如果有比它上一个工具调用更新的插话，平台会把这条插话再交给它一次（标注"可能重复"），宁可重复，不能卡住。
- Worker 的最后一个动作已经是告诉负责人时，不再多叫醒负责人一次。但只有确实进了队列的消息才算，插话送达的不算，因为负责人的 turn 可能正好要结束。

实测（真实模型，重启后各家工具都还能用，全程没有 sleep、文本标记和失败）：

| 负责人 | 结果 |
|---|---|
| Luna | 通过；中途一次未通过，它没有派活，还谎称工具不可用，这是低推理强度下的模型行为 |
| Haiku | 通过 |
| Qwen | 通过（Qwen 当负责人第一次验证） |
| Haiku，经桌面服务 | 52 秒完成修 bug、加函数和测试、审查，界面显示"等待消息" |

**经验：短测试会骗人。** 90 秒的探针三家全过，31 分钟才暴露 Claude 和 Codex 的问题；只数工具调用次数也看不出 Codex 在轮询，要看 token 和 rollout 里的 `wait` 调用。验证脚本：`scripts/tool-block-probe.mjs`、`scripts/platform-park-check.mjs`、`scripts/platform-tools-e2e.mjs`，都需要 `--authorized-this-run`。

已知的限制：

- `--disable multi_agent` 去不掉 Codex 的 `collaboration` 命名空间和 /root 说明，只能靠说明澄清；`dynamicTools` 是实验接口，Codex 升级可能改变。验收期间 Codex 就自动更新过一次。
- Codex 被结束的 turn 在历史里留有中断记录，平台在下一条消息前加了说明。
- Shell 路径和 sleep 检查都是文本匹配，运行时拼出来的命令查不到。
- 还没有验证：负责人额度耗尽后切换、worktree 模式下的工具、Sol 在真实大任务里的表现。

### 桌面 App 外壳（2026-11-04）

要求和分工见 APP-SHELL-BRIEF.md。用户不用先开终端：双击启动，App 自己拉起后端；点红叉只隐藏窗口，图标留在托盘；右键托盘才真正退出，退出时优雅地停止所有会话和 Harness。

```
npm run app:package   # 组装 release/Crewroom/，不需要新依赖
npm run app:shortcut  # 创建桌面和开始菜单快捷方式
npm run app           # 开发入口，行为相同
```

由平台自身开发：Sol（medium）实现，Qwen 审查两轮，全程 23 分钟。Sol 没有一条 sleep 命令，等 Qwen 时平台 3 次替它结束 turn。Qwen 的审查发现了锁缺失时可能误杀其他进程等真实问题；Sol 也驳回了几条，理由成立。Codex 的沙箱里 Electron 启动就崩溃（Chromium 的 `install_dir_access` 权限检查），错误框还会弹到用户桌面，所以 Electron 只能在沙箱外验证。

沙箱外验收发现了 Sol 测不到的问题：Electron 44 的 `clipboard` 是异步 API，冒烟代码写错了；窗口拦截关闭会阻止 Windows 关机和注销。都已修复。

已接受的限制：`Crewroom.exe` 内嵌的还是 Electron 图标（改它需要 rcedit），快捷方式、窗口和托盘用的是自己的图标；开发入口和打包版共用一把单实例锁。

### 中文支持（用户要求：全程 UTF-8）

`scripts/platform-utf8-check.mjs` 用打包版跑真实团队，成员名、工作目录、文件名、任务都是中文，再按字节校验：三个 Harness 读写中文文件都一致，没有 BOM，生僻字和 emoji 在白板、日志、回复里都完好。

这次实测发现并修复的问题：

- 成员名只允许小写英文。现在可以用任何文字的字母和数字，但不能有分隔符，不能用 Windows 保留名（`con`、`nul` 等）；比较时不分大小写，因为 `Bob` 和 `bob` 在 Windows 上是同一个白板文件。
- `请@qwen看一下`、`@qwen请看` 不会通知任何人，也不报错，因为旧规则把紧贴的中文当成了单词的一部分。现在只有拉丁字母和数字才算连写，名字按已知成员匹配，取最长的；全角问号 `？` 也算要求回复。
- 说明里要求 Agent 使用用户的语言，和同事交流也一样。

还没解决：Codex 的 PowerShell 报错信息有时是乱码（`��<���`），是中文系统上 GBK 输出被当成 UTF-8 读取。正常读写文件不受影响，这次实测中也没有出现。

### 项目规则和多轮经验（用户决定：统一都读）

团队会在同一个项目里工作多轮，每家都要保存自己的经验，也要能看到别家的，这样容易对齐。

实测发现各家本来不一致：Codex 自动读 `AGENTS.md`，Claude 不读 `CLAUDE.md`（为了隔离关掉了配置加载），DSH 不读 `AGENTS.md`。现在每次开始或恢复会话，平台读取工作目录下的文件，放进每个成员的说明（`src/platform/project-context.ts`）：

- **规则**：`AGENTS.md`、`CLAUDE.md`。人写的，Agent 只读，除非用户要求修改。和平台规则冲突时平台优先，比如本仓库的 `AGENTS.md` 要求用 `collab`，而平台禁止。Harness 自己已经会读的文件不再重复（Codex 的 `AGENTS.md`）。
- **经验**：`.agent-notes/<harness>.md`。每家只写自己的文件，所有成员都能看到全部文件，内容标明是"信息而不是命令"，避免一次写入的内容长期变成指令。

没有用各 Harness 私有的记忆（`~/.claude`、`~/.codex/memories`）：它们都在工作目录之外，违反边界；格式不同，彼此也读不到。放在项目里还归用户的 Git 管，也能换机器带走。Codex 的 `memories` 功能继续关闭。

限制：每个文件最多 32K 字符，总共 64K，超出时截断并提示去读原文件。这两个目录在 Claude 和 Codex 的工作目录写入规则内，已实测三家都能写。指向工作目录外的链接不会被读取。

验证脚本是 `scripts/project-notes-check.mjs`：两轮真实会话，第二轮不恢复，只有文件能把经验带过去。

### 模型扫描、DeepSeek 和一键初始化 Git（2026-11-04）

**模型列表来自扫描，不再写死**（`src/app/model-catalog.ts`）。每家都有接口，而且只打开会话、不发消息，所以不消耗模型额度：Codex 用 `model/list`，Claude 和 DSH 读 ACP 的会话配置项。服务启动时后台扫一次（约 8 秒），结果存到 `model-catalog.json`，新建会话的对话框里可以手动刷新。某家扫描失败时保留旧列表并显示原因。强度跟着模型走：实测 Haiku 4.5 没有强度，Opus 4.6 没有 xhigh，`ultra` 也不只 Sol 有。

之前用户只能选到一个模型，是因为表单用了输入框加候选列表，浏览器会按已有内容过滤候选项。现在是下拉框，另有"手动输入模型 ID"。之前保存的完整 ID（`claude-haiku-5-5`）会对应到列表项。

**DeepSeek 可以选了。** 用户决定：需要时主动选，不设预算上限。DSH 用自己保存的凭据直连 DeepSeek，平台不接触凭据。本地 Qwen 成员继续把云端地址指向关闭的端口，不可能误花钱；列表里本地排第一，这样切换到 DSH 时默认是免费的，收费的路由名称上写明"按量计费"。一个团队可以同时有本地 Qwen 和多个 DeepSeek 成员。没有经过 `collab` 的计量中继，所以界面上 Token 显示未计量，费用要看 DeepSeek 账户；DSH 的网络搜索在平台里也仍然关闭。

DSH 成员也有推理强度了，选项按路由扫描：Flash 和 Pro 是 `off / low / high / max`，**默认 `high`**，本地 Qwen 没有自己的默认值，留空就交给服务商。平台设置后会读回核对，没生效就报错，不进入推理。

实测（`scripts/deepseek-check.mjs`，经打包版，用户批准后花了一次很小的费用）：Flash（`off`）当负责人，本地 Qwen 当 Worker，修一个小 bug，从开始到结束 11 秒，双方都用工具协作，没有报错。Flash 用了 5002 个未缓存输入、25344 个缓存命中、489 个输出 Token。从事件里的上下文窗口能确认路由：负责人 1048576，Worker 256000。DSH 内部的 `model-label-1017` 插件只作用于 `deepseek-flash` 路由，所以这就是 Flash 1017，但服务端实际版本没法从客户端直接确认。

**一键初始化 Git**：项目列表和新建会话对话框里都有按钮，点击后先说明要做什么。运行 `git init`，再建一个空的初始提交，让分支和 worktree 有起点。已有文件不修改，也不加入提交（可能有 `.env`、`node_modules`），不新增 `.gitignore`，要不要提交由用户决定。所以 worktree 里只有用户提交过的文件。已经是仓库、位于其他仓库之内、`.git` 损坏时都会拒绝。

### 现有框架的修复

`src/models.ts` 的 `localModel()` 写死了提供方名称 `strata-local`，而 DSH 桌面配置（2026-11-02 修改）里现在叫 `strata`，所以函数直接报错。已改为按模型和回环地址识别提供方。

## 2. 参与者

| Agent | 计费 | 速度 / 限制 | 擅长 | 默认角色 |
|---|---|---|---|---|
| Claude（Claude Code，Opus） | 订阅额度 | 较快 | 与人交互、快速出方案、拆任务、确保落地 | 负责人 |
| Codex（6.1 Sol） | 订阅额度 | 慢 | 长推理、规范化、严谨审查 | 关卡审查、难题 |
| Qwen 3.8 Flash Next（DSH + 本地 Strata） | 免费 | 150–250 tok/s，上下文 256K，**并发 1** | 基础代码能力不错 | 主力实现 + 苦力 |
| DeepSeek v4.1 flash 1017（DSH + 云端） | 按次付费 | 100–200 tok/s | 代码能力强于 Qwen | 可选：第二实现通道、升级通道 |

- DeepSeek 只有在用户把它加入本次团队时才可用。加入后负责人可以自由使用，平台不设预算上限，只记账。
- 设计原则：Qwen 的 Token 不花钱，可以多用；Claude 和 Codex 消耗订阅额度，只在需要它们的地方出场。

## 3. 接入架构

### 3.0 长期目标：参与者 = Harness + 模型 + 职位

最终入口是一个独立软件。用户在里面为每次运行指定参与者，每个参与者由三部分组成：

- **Harness**：Codex（app-server）、DSH（ACP）、Claude Code（适配方式待定）等。
- **模型**：该 Harness 支持的模型，如 GPT 6 Luna / 6.1 Sol、Qwen、DeepSeek、Opus。
- **职位**：负责人、审查者、实现者等。

负责人不绑定在 Claude Code 上。平台通过统一的 Harness 适配器托管所有参与者，包括负责人。每个适配器需要声明自己的能力：

| 能力 | 用途 | Codex | DSH | Claude Code（Agent SDK） |
|---|---|---|---|---|
| 持久会话与恢复 | 跨任务保留上下文 | `thread/resume`，已验证 | ACP `session/resume`，已验证 | ACP `session/resume`，已验证 |
| 按 turn 设置沙箱 / 工作目录 | 同一会话在不同 worktree 中工作 | `turn/start` 覆盖，已验证 | 需重启 worker | 重启并恢复到新目录，上下文保留，工作目录跟随，已验证；**Windows 上没有可用沙箱** |
| 审批回调 | 平台裁决权限 | `item/*/requestApproval`，已验证（需 `untrusted` 策略才会触发） | ACP `requestPermission`，已验证 | ACP `requestPermission`：文件写入和工作目录外的读取会询问，可以按文件裁决，已验证；工作目录内的读取和只读 Shell 命令不经过平台 |
| 结构化输出 | 确定性解析结果 | `outputSchema`，已验证 | 文本标记 | 文本 JSON 或标记，已验证；`outputFormat` 可用，内容在 `StructuredOutput` 工具调用的输入中，已验证 |
| 负责人的沟通方式 | 派活、收结果 | 文本标记；`dynamicTools`（实验接口）也已验证 | 文本标记，待验证 | 文本标记（`[TO x]`），已验证 |
| 用量上报 | 记账 | `tokenUsage` + `rateLimits`，已验证（review turn 待确认） | relay 计量，已验证 | 响应中的 `usage` + 转发的额度事件，已验证（被取消的 turn 用量为 0） |
| 中断与对账 | 取消、崩溃恢复 | `turn/interrupt` + `thread/turns/list`（有状态字段），已验证 | ACP cancel，无法查询历史 | ACP cancel + `session/load` 回放（无状态字段），已验证 |

Claude Code 的调研见 [CLAUDE-CODE-HARNESS-RESEARCH.md](CLAUDE-CODE-HARNESS-RESEARCH.md)。

负责人通过文本标记沟通，由平台解析后转交（第 8 节），所以担任负责人不需要客户端工具。Codex 这一列来自[接入验证方案](CODEX-APP-SERVER-TEST-PLAN.md)，Claude Code 这一列来自[调研和验证](CLAUDE-CODE-HARNESS-RESEARCH.md)。

### 3.1 现阶段的结构

下文描述的是现阶段的结构：还没有独立入口，负责人是 Claude Code 会话。

```
                 用户（Claude 桌面 App）
                          │
                 Claude Code 会话 = 负责人
                          │  collab CLI（--run ID）
                          ▼
          Orchestrator daemon（确定性代码，SQLite）
           ├─ DSH ACP worker ── Qwen（本地，串行）
           ├─ DSH ACP worker ── DeepSeek（云端，可选）
           └─ Codex app-server ── Codex 6.1 Sol（独立线程）
```

**负责人是 daemon 的客户端，执行者是 daemon 托管的会话。**

### 3.1a Claude Code（现阶段的负责人）

- 现阶段留在用户正在对话的 Claude Code 会话里，通过 `collab` CLI 调用平台，不被 daemon 托管。这样用户与负责人的交互保持原样。
- 等待执行者时，负责人把 `collab receive --wait` 作为后台命令运行。命令退出时 Claude Code 会被重新唤醒，所以不需要轮询，也不需要 MCP。
- 现有集成无法唤醒空闲的 Codex 对话，而 Claude Code 能在后台命令结束时继续工作，所以现阶段由 Claude 当负责人。有了独立入口后，负责人由平台托管，结果直接以工具返回值或新 turn 的形式送达，不再依赖调用方能否被唤醒。

### 3.2 Qwen 与 DeepSeek（DSH）

- 沿用现有 `AcpWorker` 和 `dshLaunch`，包括本地 / 云端路由、权限授予、Windows ACL 预检和用量计量。
- Qwen 和 DeepSeek 是两个独立的执行者，各有一条 FIFO。Qwen 的队列固定为并发 1。

### 3.3 Codex（审查者 / 难题）

以下接口来自 Codex 桌面 App 自带的 CLI（`codex-cli 0.166.0-alpha.5.1`，位于 App 包的 `app\resources\codex.exe`，不在 PATH 上）通过 `app-server generate-ts` 离线生成的类型定义。生成过程不做推理调用。所有 `thread/start`、`turn/start`、`review/start` 都还没有实际运行过。

**进程与登录**

- daemon 启动一个 `codex app-server --stdio` 子进程（JSON-RPC 行协议），沿用现有 `codex-probe` 的启动方式。可执行文件路径通过 `CREWROOM_CODEX` 配置。
- 使用用户现有的 `CODEX_HOME` 和 ChatGPT 登录，不复制凭据，不新建登录。
- 工作进程隔离（不修改 `config.toml`，已在验证中确认生效）：
  - `-c mcp_servers.<名称>.enabled=false`：关闭用户配置的所有 MCP 服务器。
  - `--disable apps plugins remote_plugin tool_suggest browser_use browser_use_external computer_use in_app_browser`（每项一个 `--disable`）：关闭内置的 ChatGPT 连接器、插件、浏览器和电脑操作。不关闭的话，执行者能看到用户的 Google Contacts、GitHub、Notion 等连接器工具。
  - `-c include_apps_instructions=false`。
  - `--disable multi_agent`：关闭 Codex 自己的子代理。
- 新线程仍会加载全局 `~/.codex/AGENTS.md`，所以需要下文的反向调用保护。
- 一个 app-server 进程服务所有运行；每次运行一个 Codex 线程。

**线程**

- `thread/start` 时设置：`cwd`（集成 worktree）、`sandbox: read-only`、`approvalPolicy`（见下文）、`developerInstructions`（平台角色说明，作为稳定前缀）。
- 线程 ID 写入 `sessions` 表，与现有 ACP 会话 ID 的存放方式相同。daemon 重启后用 `thread/resume` 恢复。
- 线程默认持久化（不设 `ephemeral`），这样关卡之间和 daemon 重启后都能保留上下文。运行结束时用 `thread/name/set` 标注、`thread/archive` 归档，不删除历史。
- 待验证：这些线程是否会出现在 Codex 桌面 App 的历史列表里。

**每个 turn 的参数**

`turn/start` 支持按 turn 覆盖以下参数，平台每次都显式传入，不依赖线程继承：

| 参数 | 审查 / 规范关卡 | 实现任务 |
|---|---|---|
| `model` / `effort` | 用户配置（如 6.1 Sol，高推理强度） | 同左 |
| `cwd` | 集成 worktree | 该任务的 worktree |
| `sandboxPolicy` | `readOnly`，`networkAccess: false` | `workspaceWrite`，`writableRoots` 只含该 worktree |
| `outputSchema` | 结构化结论（见下文） | 结构化结果 |

- `outputSchema` 可以用 JSON Schema 约束最后一条回复。平台用它要求 Codex 返回 `{ type, summary, findings[], questions[] }`，其中 `type` 沿用 `RESULT` / `QUESTION` / `OBJECTION` / `REASSIGN_REQUEST`，`findings` 带文件、行号和严重程度。这样解析是确定性的，不需要修复调用。
- 只读取 `agentMessage` 项作为结果。`reasoning` 项和命令输出不保存，沿用现有"不保留思考内容和原始工具流量"的规则。

**两道关卡用不同的接口**

- spec 关卡：普通的 `turn/start`，输入是计划和任务卡，配 `outputSchema`。
- final-diff 关卡：`review/start`，`target: { type: "baseBranch", branch: <运行开始时的基线> }`，`delivery: inline`。这是 Codex 内置的代码审查模式，审查结论从 `exitedReviewMode` 项读取。

**审批请求由平台裁决**

app-server 会向客户端发起 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`。平台按任务的授权确定性地回答 `accept` 或 `decline`，复用现有 Shell 授予和文件编辑授予的判定逻辑：

- 审查者：拒绝所有文件修改和越出沙箱的请求。
- 实现者：只接受目标在本任务 worktree 和 `files.write` 租约之内的修改。
- 从不回答 `acceptForSession`，也不接受执行策略或网络策略的修改。
- `approvalsReviewer` 固定为 `user`，即由平台作为客户端裁决，不交给 Codex 的自动审查子代理。

**防止 Codex 反向调用平台**

Codex 的全局技能里有 `deepseek-colleague`，目标工作区的 `AGENTS.md` 也可能让它去调用 `collab`。作为执行者时它不能这样做：

- app-server 进程带上环境变量 `CREWROOM_PLATFORM_WORKER=1`，`collab` CLI 检测到后直接拒绝，属于确定性保护。
- `developerInstructions` 写明：本线程是平台的执行者，不调用 `collab`，不启动子代理。
- 待验证：能否通过线程的 `config` 覆盖关闭 Codex 自己的子代理功能（类型里有 `collabAgentToolCall`、`subAgentActivity` 项）。

**取消、崩溃与对账**

- 取消：`turn/interrupt { threadId, turnId }`。
- `turn/start` 发出前，先在 SQLite 里把尝试记为 SENT，沿用现有规则。
- app-server 崩溃后不自动重发。恢复时用 `thread/turns/list` 查看该 turn：`completed` 就直接取结果（C4.2 已验证）；`interrupted` 说明没有完成（C4.3 已验证进行中崩溃会变成这个状态），记为中断，并检查 worktree 中的部分改动；找不到记录才标记 `OUTCOME_UNKNOWN`。这比现有 ACP 的处理更好，因为 Codex 的历史可以查询。
- v1 不使用 `turn/steer`。Codex 正在执行时，负责人的新消息进入该线程的 FIFO，等当前 turn 结束后再发。

**用量与额度**

- `thread/tokenUsage/updated` 提供每个 turn 的输入、缓存输入、输出和推理 Token，写入用量账本，标记为订阅额度，费用记为 0。
- 每个 Codex 关卡发起前调用 `account/rateLimits/read`，读取额度窗口的 `usedPercent` 和 `resetsAt`。超过用户设定的阈值时，平台不发起调用，而是交还负责人，由负责人询问用户。Codex 的订阅额度和用户自己日常使用 Codex 是共用的。
- 平台只在负责人发起关卡或任务时调用 Codex，不做保活。

**备选方案**

如果 app-server 的 turn 语义在实际运行中出问题，退回 `codex exec` 单次调用。代价是失去持久线程、审批裁决和结构化事件。

### 3.4 身份

- 平台模式以**运行（run）**为身份，不依赖 `CODEX_THREAD_ID`。`collab run start` 返回运行 ID，之后的命令都带 `--run ID`。
- 现有的 `send` / `receive` 和按 Codex 对话隔离的行为保持不变。

## 4. 运行配置

```yaml
run:
  goal: "为 store 增加 agents 注册表并迁移旧数据"
  workspace: D:\SomeProject
  team:
    opus: { harness: claude-code, model: opus,        role: lead }
    sol:  { harness: codex,       model: gpt-6.1-sol, effort: high, role: reviewer, gates: [spec, final-diff] }  # gates 可为空
    qwen: { harness: dsh,         model: local,       role: implementer }   # 并发固定为 1
    # ds: { harness: dsh,         model: deepseek,    role: implementer }   # 加入后负责人可自由使用
  backupLead: [sol, qwen]   # 见第 11 节
  onQuota: { lead: switch, worker: reassign, warnAtPercent: 85 }
  limits:
    maxRounds: 40
    maxMinutes: 180
  approvals: [plan, merge]   # 需要用户确认的节点
```

- 没有列在 `team` 里的 Agent 不参与，平台不会启动它。
- 写任务的总并发由团队成员决定：Qwen 1 路，DeepSeek 按需，Codex 只在被分配实现任务时占用 1 路。

## 5. 运行流程：流水线

因为 Qwen 只能串行，并行来自**不同 Agent 同时处理不同阶段**，而不是同时跑多个 Qwen：

```
时间 →
Qwen:     [T1 实现][T2 实现][T3 实现][T4 实现]
Codex:              [T1 审查]    [T2 审查]
Claude:   [写T2卡][写T3卡][整合T1][写T4卡][整合T2]
DeepSeek: （在团队中时）[T5 独立任务]
```

完整流程：

```
用户给出任务
  → [负责人] 澄清需求，起草计划和任务卡
  → [Codex 关卡: spec]（可选）审查计划、接口、验收标准
  → [用户确认: plan]
  → 调度：按依赖派发任务卡；负责人继续写下一张卡
      → [执行者] 在自己的 worktree 中实现
      → [平台] 运行验收命令
      → 失败则按升级阶梯处理（第 7 节）
  → [负责人] 整合各 worktree，处理冲突
  → [Codex 关卡: final-diff]（可选，异步）
  → [用户确认: merge]
  → 运行报告
```

- Codex 慢，所以关卡审查默认异步：负责人提交审查后继续推进不受影响的工作，不阻塞等待。只有 spec 关卡天然阻塞实现，小任务可以跳过它。
- "商量"只发生在计划阶段：负责人发出计划后，每个参与者**最多提一次**异议（`[OBJECTION]` 或 `[REASSIGN_REQUEST]`），负责人裁决后开工。执行过程中，Agent 只能就自己的任务卡向负责人提问，不能直接给其他 Agent 派活。

## 6. 任务卡

任务卡是 Agent 之间唯一的工作接口。执行者只看到自己的任务卡，以及卡里列出的文件和产物，看不到其他 Agent 的对话记录。

```yaml
id: T3
title: 给 store 增加 agents 表和迁移
owner: qwen
dependsOn: [T1]
files:
  write: [src/store.ts, test/store.test.mjs]   # 文件租约，平台强制执行
  read:  [src/config.ts]
context: |
  负责人写的简短背景：为什么改、约束是什么、不要碰什么。
acceptance:
  - run: npm test -- test/store.test.mjs
  - check: "旧数据库迁移后 agents 表存在，旧 sessions 不丢失"
escalation: { maxAttempts: 2, next: [deepseek, codex] }   # 不在团队中的会被跳过
review: none   # none | lead | codex
```

- 任务卡要自成一体，每张卡都明确写出本次允许的工具和权限。同一会话中较早的指令会延续到后面的 turn：Codex 验证中，前几轮"不要使用工具"的要求让后一轮拒绝了读文件。
- 任务卡要小而具体。Qwen 能力弱于 DeepSeek，所以计划阶段把任务拆细、把验收标准写清，比事后让 Claude 或 Codex 去修更划算。
- `acceptance.run` 由平台执行，结果以结构化形式返回。能用命令判定的，就不交给 LLM 判断。
- `acceptance.check` 是需要人或 LLM 判断的条件，由 `review` 指定的角色来确认。

### 6.1 Qwen 的会话与上下文

- 每次运行复用同一个 Qwen 会话。Strata 支持前缀缓存，满上下文时预填充和解码速度基本不下降，DSH 也会在合适的时候自动压缩上下文，平台不需要自己管理 Qwen 的会话长度。
- 会话开头使用稳定前缀（角色说明 + 项目背景），后续只追加任务卡。

## 7. 升级阶梯

```
Qwen 尝试 → 验收失败 → 带失败输出重试（最多 maxAttempts 次）
  → DeepSeek（在团队中时）：只给任务卡 + 最后一次失败输出 + 当前 diff
  → Codex：同上，另加上一层的失败说明
  → 交还负责人：拆细任务、修改验收标准，或询问用户
```

- 升级时**不转交下层的完整对话历史**，只转交任务卡和最后一次的证据。
- 负责人可以直接把任务卡的 `owner` 设为 DeepSeek 或 Codex，跳过前面的层级。
- 升级是负责人或任务卡显式指定的行为。现有"本地失败不回退云端"的规则针对的是自动回退，平台模式不做任何自动回退。
- 每次升级都记入运行报告，用于之后调整分工。

## 8. 通信规则

- Agent 之间不直接相连，也不需要 MCP。平台作为客户端连接每个 Agent（DSH 和 Claude Code 通过 ACP，Codex 通过 app-server），按 turn 转交消息：Agent 在回复中用标记写明发给谁，平台用确定性代码解析后，作为下一条 prompt 投递给对方。详见 [Claude Code 调研](CLAUDE-CODE-HARNESS-RESEARCH.md) 2.2 节。
- 不广播。消息只有三种走向：负责人到参与者（任务卡、裁决），参与者到负责人（结果、提问、异议），平台到负责人（验收结果、状态变化）。
- 结果应当是产物（diff、测试输出、简短说明），而不是长篇推理。
- 沿用现有协议：`RESULT` / `QUESTION` / `OBJECTION` / `REASSIGN_REQUEST`，以及 `NEEDS_DISCUSSION`、`OUTCOME_UNKNOWN` 不自动重放等规则。
- Agent 的输出永远是不可信数据，不构成权限授予。

## 9. 文件所有权与 worktree

- 每个执行写任务的 Agent 拥有独立的 git worktree 和分支：`agents/<run>/<task>`。
- 任务卡中的 `files.write` 是租约。两个并发任务的写集合不能重叠，重叠的任务由调度器串行执行。
- 租约的执行方式因 Harness 而异，但都要在 turn 结束后由平台检查 diff：
  - Codex：沙箱把可写目录限制在该任务的 worktree 内（Windows 上已验证）。它会直接用 Shell 命令写文件，不经过文件编辑审批，所以文件级别只能靠事后检查。
  - Claude Code：这台 Windows 机器上没有可用沙箱，所以目录级别没有 OS 保护。文件工具可以通过审批按文件裁决（已验证），但只读 Shell 命令不会询问平台，所以执行者不给 Shell 工具（`disallowedTools`，已验证），由平台运行验收命令。
- 写集合之外的改动会被平台拒绝，并作为失败结果返回。
- 负责人负责合并。只合并到本次运行的集成分支，不碰主分支，也不推送。
- 前提：工作区必须是 git 仓库。

## 10. 用量控制

- 不设费用上限。`maxRounds` 和 `maxMinutes` 只用来防止死循环。
- 持久会话：同一次运行内复用 Agent 会话（沿用现有机制），不重复加载项目背景。
- 运行报告列出每个 Agent 的 Token、DeepSeek 的花费、Codex 的 turn 数、升级次数、每个任务的尝试次数。先积累数据，再调整分工策略。

## 11. 订阅额度窗口与负责人变通

Claude 和 Codex 都有 5 小时额度窗口（Codex 另有每周窗口）。额度用完时，输出可能在 turn 中途突然结束。平台需要提前看到、记录、通知，并且在负责人用完额度时还能继续推进。

### 11.1 额度记录

- 每个 Harness 有一个额度跟踪器，把快照写到 `<状态目录>\quota\<harness>.json`。格式已在 Codex 验证脚本中实现：

```json
{ "harness": "codex", "observedAt": "...", "ordinaryUsageAllowed": true, "planType": "plus",
  "windows": [ { "label": "5h", "windowDurationMins": 300, "usedPercent": 3, "resetsAt": "..." },
               { "label": "weekly", "windowDurationMins": 10080, "usedPercent": 19, "resetsAt": "..." } ],
  "exhausted": false }
```

- 数据来源：

| Harness | 来源 | 状态 |
|---|---|---|
| Codex | `account/rateLimits/read`、`account/rateLimits/updated` 通知、turn 错误中的 `usageLimitExceeded` / `rateLimitExceeded` | 读取已验证（阶段 0） |
| Claude Code | 适配器转发的 `rate_limit_event`（`usage_update._meta["_claude/rateLimit"]`），百分比在未声明的 `unifiedWindows` 字段里。没有主动查询接口，只能在请求后更新 | 读取已实测 |
| DSH | Qwen 没有额度；DeepSeek 使用现有 `collab balance` | 已有 |

- 界面显示每个参与者的窗口用量和重置时间。跨过 `warnAtPercent` 时提示，额度用完时醒目通知用户。

### 11.2 turn 中途因额度结束

以下是设计，还没有实测过：Codex 和 Claude 的验证都没有真正触发过额度耗尽。

- 单独的状态 `PAUSED_QUOTA`，与 `FAILED`、`OUTCOME_UNKNOWN` 区分开。依据是 turn 错误码，或额度快照显示窗口已满。
- worktree 中已经产生的部分改动保留，并记录 diff。
- 不在 `resetsAt` 之前自动重试。窗口重置后按 `onQuota` 策略继续：任务卡加上"上次尝试因额度中断，当前 diff 如下"，从现有 worktree 状态继续，而不是从头再来。
- 执行者用完额度时（`onQuota.worker`）：`wait` 等待重置，`reassign` 交给团队里的其他执行者，`ask` 询问用户。

### 11.3 负责人变通

前提：**负责人的状态不只存在于它自己的对话里。** 计划、任务卡状态、已做出的裁决、未回答的问题，全部由平台存进 SQLite。负责人的对话只是工作记忆，平台存储才是事实来源。

- 预防：负责人的窗口跨过 `warnAtPercent` 时，平台请它写一份简短的交接说明（当前判断、下一步打算），存入运行记录。这一步本身很便宜，可以避免额度突然用完后丢失还没写下来的判断。
- 负责人额度用完时（`onQuota.lead`）：
  - `wait`：暂停派活，执行者完成手头的任务后停下，等待负责人窗口重置。
  - `switch`：按 `backupLead` 的顺序选择第一个有额度、且具备"客户端工具"能力的参与者（见 3.0 节）。平台用确定性代码从运行记录生成交接简报（目标、计划、任务状态、裁决记录、未决问题、交接说明），交给它接任。原负责人窗口重置后，可以收回负责人职位，也可以改为顾问。
  - `ask`：通知用户，由用户决定。
- 无论哪种策略，都会在界面中通知用户，说明谁接任、原负责人何时恢复。
- 局限：负责人的对话上下文无法完整转移，接任者只拿到平台记录的内容。所以负责人需要及时把裁决写进平台，而不是只留在自己的对话里。

## 12. 与现有框架的关系

可直接复用：

- `AcpWorker`：通用 ACP 客户端，不依赖 DSH。
- `Store` 的消息、尝试、事件表，以及崩溃恢复和不自动重放的规则。
- 按任务授予写入和 Shell 的权限模型、Windows ACL 预检。
- 用量账本和 `LocalRelay` / `LiveRelay` 的计量。
- 本地 / 云端模型路由（`localModel()`、`cloudSelection`）。
- `codex-probe` 中的 app-server 启动和类型生成。

需要改动：

- 抽出 `AgentAdapter` 接口（启动方式、协议、能力、计费类型），DSH 适配器基于 ACP，Codex 适配器基于 app-server。
- 新增运行身份（`--run ID`），与现有按 Codex 对话的身份并存。
- 调度从全局只有一个 prompt 在跑，改为每个执行者一条 FIFO，执行者之间并行。
- 新增运行、任务卡、文件租约、worktree 的存储与管理。
- `instruction()` 里写死的 "You are Codex's persistent colleague" 改为按角色生成。
- `AGENTS.md` 目前规定 Codex 默认做最终决定，需要补充平台模式下由负责人裁决的说明。

## 13. 待定问题

1. ~~Strata 是否支持前缀缓存？~~ 已确认支持，见 6.1 节。
2. ~~Codex app-server 能否接入？~~ 已验证可以，见[验证方案](CODEX-APP-SERVER-TEST-PLAN.md)第 6b 节。剩余小项：review turn 的用量获取方式，以及测试线程在桌面 App 中的显示方式。
6. Claude Code 的接入方式和额度信息来源，见 11.1 节。
3. ~~负责人是否总是 Claude？~~ 已决定：负责人由用户指定，不绑定 Claude Code（见 3.0 节）。剩下的问题是 DSH 担任负责人时如何获得派活工具：ACP 只能在 `session/new` 时传入 MCP 服务器，而当前项目的约定是不使用 MCP。
4. 验收命令在哪个环境执行？是否要求每个工作区都提供一个标准的测试命令？
5. 负责人自己是否写代码？建议只做整合和小修补，避免消耗 Claude 的额度去做 Qwen 能做的事。
