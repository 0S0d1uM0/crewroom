import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, AdapterEvent } from '../platform/types.js';
import type { AdapterFactory } from '../platform/session.js';
export const demoFactory: AdapterFactory = member => {
  let count = 0, cancelled = false;
  const id = randomUUID();
  const adapter: HarnessAdapter = {
    onMessage: () => {}, onEvent: () => {}, getSessionId: () => id,
    async start() {}, async resume() {}, async stop() { cancelled = true; }, async interrupt() { cancelled = true; },
    async steer(text) { adapter.onEvent({ type: 'demo-steer', text }); return 'steered'; },
    async prompt() {
      cancelled = false; count++;
      await new Promise(r => setTimeout(r, member.role === 'lead' && count > 1 ? 2000 : 180));
      if (cancelled) return { status: 'cancelled' };
      if (member.role === 'lead' && count === 1) {
        adapter.onEvent({ type: 'tool', title: '读取项目', status: 'completed' });
        adapter.onEvent({ type: 'rate-limits', windows: [{ name: 'five_hour', usedPercent: 88, status: 'allowed', resetsAt: new Date(Date.now() + 3600000).toISOString() }] } as AdapterEvent);
        adapter.onMessage('开始安排团队任务。\n<<<board\n@qwen? 请检查项目。@sol? 请检查测试。\n>>>');
      } else if (member.role === 'worker' && count === 1) {
        adapter.onMessage(`<<<board\n${member.name} 已完成检查。\n>>>\n<<<dm lead\n检查结果：可以继续。\n>>>`);
      } else if (member.role === 'lead') adapter.onMessage('团队检查完成。**演示就绪**，可继续发送消息。\n\n```js\nconsole.log("你好");\n```');
      return { status: 'completed', usage: { inputTokens: 120, outputTokens: 40 } };
    },
  };
  return adapter;
};
