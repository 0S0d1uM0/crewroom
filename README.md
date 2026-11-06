# Crewroom

[中文说明](README.zh-CN.md)

Crewroom is a Windows desktop workspace for running a team of coding agents on your own project. You talk to one lead. The lead breaks the work down and coordinates workers, which can run on different agent CLIs and models, including a local model.

> **Experimental.** Crewroom has mainly been used by its author on one Windows machine. Expect rough edges, and do not point it at a project you have no backup of. The interface is currently in Chinese.

Crewroom is an independent project. It is not affiliated with or endorsed by Anthropic, OpenAI, DeepSeek or Alibaba.

## What it does

- **Mixed teams:** each member picks a harness, model and role. Supported harnesses are Claude Code, Codex and DSH.
- **One point of contact:** you talk to the lead, and you can still see the whole team's activity.
- **Shared board and direct messages:** members coordinate through tools, and a member can wait for an answer without polling.
- **Scope control:** the lead posts a work order with done criteria and out-of-scope items. Blocking review is capped at two rounds per delivery.
- **Selective wake-ups:** only direct questions wake a member immediately, and other messages wait in the inbox. This keeps token use down.
- **Permission levels:** read-only, safe write and full write, with approval prompts that go straight to you.
- **Durable sessions:** projects and sessions keep their history and can be resumed after a restart.

## Requirements

- Windows 10 or 11
- Node.js 24 or newer
- Git
- At least one harness, installed and signed in with your own account:

| Harness | Default location | Override |
| --- | --- | --- |
| Claude Code | `~/.local/bin/claude.exe` | `CREWROOM_CLAUDE` |
| Codex | found from your installation | `CREWROOM_CODEX` |
| DSH | `D:\DSH` | `CREWROOM_DSH_INSTALL` |

Local-model members run through DSH and read the provider you selected in `~/.dsh/profiles/desktop/cordis.patch.yml`.

Check the terms of each service before you use it with Crewroom. Agent runs use your own subscription or API credit.

## Getting started

```powershell
npm ci
npm run app
```

Try the interface without any harness or model usage:

```powershell
npm run app:demo
```

Build a packaged app in `release/Crewroom`, then create a desktop shortcut:

```powershell
npm run app:package
npm run app:shortcut
```

## Security

Agents run real commands on your machine with your account, so treat a session like any other code you allow to run.

- **Choose permissions deliberately.** Full write allows `git push`. Safe write asks you before GUI launches, writes outside the workspace, killing processes and pushing.
- **Sandboxing is partial on Windows.** Do not rely on it as a hard security boundary.
- **Credentials:** Crewroom removes known host session tokens and API keys from the environment of child processes, and redacts known key patterns from logs. This is best effort, not a general secret scanner.
- **Session data is private.** `%LOCALAPPDATA%\Crewroom` holds your prompts, agent output and project snapshots. Set `CREWROOM_HOME` to use another location.

See [docs/PERMISSIONS.md](docs/PERMISSIONS.md) for the rules.

## Development

```powershell
npm run build
npm test
```

`npm test` runs offline against isolated fixtures and makes no model calls. Most `scripts/*-check.mjs`, `*-validation.mjs` and `*-probe.mjs` files drive real agents and can spend quota or credit, so read a script before you run it.

Start with [AGENTS.md](AGENTS.md) for the project rules. [docs/AGENTS-PLATFORM-DESIGN.md](docs/AGENTS-PLATFORM-DESIGN.md) records the design background, and [docs/UI-LAYOUT.md](docs/UI-LAYOUT.md) records the interface decisions.

## License

[MIT](LICENSE)
