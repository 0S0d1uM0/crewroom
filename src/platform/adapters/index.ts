import type { AdapterFactory } from '../session.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { DshAdapter } from './dsh.js';
export const createAdapter: AdapterFactory = (member, workspace, dir) => {
  if (member.harness === 'claude') return new ClaudeAdapter(member, workspace, dir);
  if (member.harness === 'codex') return new CodexAdapter(member, workspace);
  return new DshAdapter(member, workspace, dir);
};
