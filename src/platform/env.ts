const HOST_SESSION = /^(ANTHROPIC_|CLAUDE|OPENAI_API_KEY$|OPENAI_BASE_URL$|CODEX_API_KEY$|CODEX_THREAD_ID$|CODEX_SESSION_ID$)/i;
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(source).filter(([k]) => !HOST_SESSION.test(k) || k === 'CLAUDE_CONFIG_DIR')), CREWROOM_PLATFORM_WORKER: '1' };
}
