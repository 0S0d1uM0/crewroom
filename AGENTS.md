# Crewroom development guide

Crewroom is a Windows Electron app. `src/platform` runs the agent team, `src/app` holds the local server and Electron shell, and `ui` holds the interface. The other files directly under `src` are shared helpers for launching ACP workers and DSH.

## Commands

- `npm ci` installs dependencies.
- `npm run build` compiles TypeScript.
- `npm test` runs the offline test suite.
- `npm run app` starts the app from source, and `npm run app:demo` starts the server with demo data.
- `npm run app:package` builds `release/Crewroom`.

## Rules

- `npm test` must stay offline. Tests use isolated fixtures and must not make model calls or touch a real `%LOCALAPPDATA%\Crewroom`.
- Scripts that drive real agents can spend quota or credit. Run them only when the person you are working for has asked for it.
- Keep user data and credentials out of the repository. Never read, copy or log credentials or host session tokens. Child processes must get their environment from `scrubbedEnv`.
- Keep the UI as native ES modules with no framework or build step, and do not loosen the Content Security Policy.
- Keep the UI responsive: apply each event once, keep refreshes within 0.25 seconds, render at most the most recent 200 chat items, and do not pull the view to the bottom when the reader has scrolled up.
- Wake-ups are event driven. Do not add timers or polling loops to wake members.
- Permission levels are a security boundary. Change them only with tests covering the new behaviour, and update `docs/PERMISSIONS.md`.
- Update `docs/UI-LAYOUT.md` when an interface decision changes.
