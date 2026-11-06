# 权限能力与实现规则

## 能力核对

本轮核对仓库适配器、ACP SDK 1.4.0、Claude ACP 0.100.0、已安装 DSH 的 dsh-tools 源码及 OpenAI 官方 JSON schema。本机 Appx 查询未找到 Codex 安装位置，因此本机版本的 schema 和真实运行仍待验收。

Codex 命令及文件申请使用 accept、acceptForSession、decline、cancel。平台的会话授权按成员、原始命令和目录精确保存，每次向 Codex 回复 accept，避免 Harness 扩大会话缓存的范围。permissions 申请返回所请求 permissions 的批准子集及 scope 为 turn，该协议只能授予回合权限，界面会说明这一点且不给出会话记忆按钮。命令、文件、宽权限申请均交给平台等待用户。来源见 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 和 [官方 JSON schema](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/codex_app_server_protocol.schemas.json)。

Codex 的 sandboxPolicy 使用 readOnly、workspaceWrite、dangerFullAccess。前两者支持布尔 networkAccess。全面读写缺少独立断网能力。每回合开始前以 thread/resume 的 config.web_search 更新内置搜索开关。沙箱按下一回合生效，审批入口规则使用当前设置，已运行命令不会撤回。来源同上。

Claude 的 requestPermission 返回 Promise，选项 kind 为 allow_once、allow_always、reject_once、reject_always，响应结构为 outcome.outcome 等于 selected 且包含 optionId，取消为 outcome.outcome 等于 cancelled。平台只选择 allow_once 或 reject_once，自行管理精确命令授权。已安装 SDK 的该请求路径没有配置等待超时，支持 cancellationSignal，平台不设置默认拒绝期限。底层服务取消仍可能结束请求。

Claude 使用 SDK settings.permissions.ask 显式要求 Read、Glob、Grep、Bash、Write、Edit、MultiEdit、NotebookEdit、WebSearch、WebFetch 进入权限回调。已核对 SDK Options.settings 接受 Settings，ACP 将 userProvidedOptions 传入 SDK。配置效果尚待真实验收。源码依据为 node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js 和 node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts。

DSH 维持 danger-full-access。其 tools.guard 只允许同步检查，普通工具经异步 tools/pre-execute 等待平台审批，同步 guard 用 WeakMap 确认同一个执行对象完成了检查。缺少 hook 或 guard 时拒绝启动。检查通道使用带心跳的 SSE，避免 HTTP 空闲超时。DSH 自身最长等待时间尚未真实验证。源码依据为已安装 DSH 包内 dsh-tools/lib/index.js 的 prepareExecution、guardReason 和 guard。

## 常驻规则与继承

新会话和缺少字段的旧配置默认安全读写、联网开启。旧事件保持原样，权限变更、联网变更、申请、结果、授权、撤销以新增事件持久化。

只读允许常见读取命令，其他操作申请。安全读写允许目录内普通操作和目录外非凭据读取。外部写入、GUI、进程终止、git push、破坏性 Git 操作和批量删除申请。无法确认的环境变量路径、父目录切换和命令也走申请。进程终止暂统一申请，尚未维护可自动放行的子进程归属清单。全面读写自动允许。断网仍在支持的规则入口拦截搜索、抓取和常见 shell 联网方式。

只读和安全读写遇到 .env、pem/key、SSH 私钥、credentials、.ssh、.aws 和常见 Harness 认证文件时直接按平台规则拒绝，不弹申请。拒绝原因写日志，ACP 放入下一条消息前缀，Codex 尝试插入当前回合并保留到下一条消息，避免把平台拒绝误称为用户拒绝。子进程继续使用 scrubbedEnv，UI 令牌不会下发给成员。

用户可修改所有成员，但同事不能高于负责人。只有负责人能调用 set_member_permission，不能修改自己和联网开关。下调负责人级联下调同事，上调不恢复。负责人上调同事触发新事件桌面通知。

## 临时审批与生命周期

审批只能来自带用户令牌和同源 Origin 的 permissions API。成员端点只负责检查，成员工具、白板、网页、自然语言不能批准。界面显示成员、命令或路径、目录和理由，并告知批准后可能脱离沙箱、子进程也不再受工作目录限制。

允许一次只解决当前申请。本会话允许严格绑定成员、原始命令和工作目录，重启后从日志恢复并可撤销。凭据保护和断网规则优先于缓存授权。宽权限和无命令的文件申请只能允许一次。暂停、停止、成员中断和退出取消等待，其他成员可继续工作。异常重启时追加取消结果，历史申请不会重新变成待批准或已批准。

顶部、会话列表和成员卡显示等待，权限面板列出档位、执行方式、授权和最近记录。新申请和负责人上调通知遵循 shouldAlert 的历史时间边界，并按申请标识去重。面板按需加载，事件仍按序号幂等合并，对话保留原有渲染和滚动策略。

## 能力缺口与验收

Codex 的系统沙箱不能保证目录内 git push、历史改写、批量删除、GUI 或凭据读取都会触发审批，这些操作若未经过审批入口，平台无法逐条检查。全面读写的系统断网也无法兑现。界面直接标明限制。Claude、DSH 是规则检查，不能防有意绕过，脚本间接写入和自定义网络代码不保证拦截。

离线测试覆盖判定表、身份和继承、单次与精确授权、恢复撤销、生命周期、API 来源、文本无权批准、历史通知及适配器协议。真实运行、无限等待、系统沙箱和桌面像素布局尚未验证。

先运行 npm run build，再在沙箱外运行 node scripts/permission-check.mjs --authorized-this-run。脚本在仓库 .test-state 创建独立项目和 CREWROOM_HOME，分别以 Luna、Haiku、本地 Qwen 发起一轮只读档写文件操作，模拟允许、拒绝、允许，检查申请和文件效果。每家最多等待三分钟，验收超时会停止该脚本创建的会话。脚本不进入 npm test，未带授权标志时立即退出。本轮只测试了授权门禁和语法，没有调用真实模型。
