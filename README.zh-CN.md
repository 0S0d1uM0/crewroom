# Crewroom

[English](README.md)

Crewroom 是一个 Windows 桌面工作台，用来让一支编程 Agent 团队在你自己的项目上协作。你只和负责人对话，由负责人拆分工作、协调成员。成员可以使用不同的 Agent CLI 和模型，包括本地模型。

> **实验性项目。** 目前主要由作者在一台 Windows 电脑上使用，可能还有不少问题。请不要在没有备份的项目上使用。

本项目是独立项目，与 Anthropic、OpenAI、DeepSeek、阿里巴巴没有隶属或背书关系。

## 功能

- **混合团队：** 每个成员可以选择自己的 Harness、模型和角色。支持 Claude Code、Codex 和 DSH。
- **统一对接：** 你只和负责人对话，同时能看到整个团队的动态。
- **白板和私信：** 成员通过工具协调，等回复时不需要轮询。
- **范围控制：** 负责人发布工单，写明完成标准和不做的内容。每次交付最多两轮阻塞性评审。
- **按需唤醒：** 只有直接提问才会立刻唤醒成员，其他消息先进收件箱，以减少 token 消耗。
- **权限级别：** 只读、安全读写、全面读写。权限申请直接由你审批。
- **会话持久化：** 项目和会话保留历史，重启后可以继续。

## 环境要求

- Windows 10 或 11
- Node.js 24 或更高版本
- Git
- 至少一个已安装并用你自己的账号登录的 Harness：

| Harness | 默认位置 | 覆盖方式 |
| --- | --- | --- |
| Claude Code | `~/.local/bin/claude.exe` | `CREWROOM_CLAUDE` |
| Codex | 从安装位置自动查找 | `CREWROOM_CODEX` |
| DSH | `D:\DSH` | `CREWROOM_DSH_INSTALL` |

本地模型成员通过 DSH 运行，读取你在 `~/.dsh/profiles/desktop/cordis.patch.yml` 中选择的模型服务。

使用前请先确认各服务的条款。Agent 运行消耗的是你自己的订阅额度或 API 费用。

## 快速开始

```powershell
npm ci
npm run app
```

不想配置 Harness，也不想消耗额度，可以先看演示界面：

```powershell
npm run app:demo
```

打包到 `release/Crewroom`，再创建桌面快捷方式：

```powershell
npm run app:package
npm run app:shortcut
```

## 安全

Agent 会用你的账号在电脑上执行真实命令，请像对待其他可执行代码一样谨慎。

- **慎重选择权限：** 全面读写允许 `git push`。安全读写在启动 GUI、写入工作区之外、结束进程和推送前都会询问你。
- **Windows 上的沙箱并不完整：** 不要把它当作可靠的安全边界。
- **凭据：** Crewroom 会从子进程环境中移除已知的宿主会话令牌和 API Key，并在日志中遮盖已知格式的密钥。这只是尽力而为，不能当作通用的密钥扫描工具。
- **会话数据是私密的：** `%LOCALAPPDATA%\Crewroom` 保存你的提示词、Agent 输出和项目快照。可以用 `CREWROOM_HOME` 改到其他位置。

具体规则见 [docs/PERMISSIONS.md](docs/PERMISSIONS.md)。

## 开发

```powershell
npm run build
npm test
```

`npm test` 离线运行，使用隔离的测试数据，不调用模型。`scripts/` 下大多数 `*-check.mjs`、`*-validation.mjs` 和 `*-probe.mjs` 会驱动真实 Agent，可能消耗额度或费用，运行前请先读脚本。

开发规则见 [AGENTS.md](AGENTS.md)。设计背景见 [docs/AGENTS-PLATFORM-DESIGN.md](docs/AGENTS-PLATFORM-DESIGN.md)，界面决定见 [docs/UI-LAYOUT.md](docs/UI-LAYOUT.md)。

## 许可证

[MIT](LICENSE)
