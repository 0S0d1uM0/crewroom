import type { ToolDefinition } from './types.js';

// The collaboration interface every harness gets, whatever way it reaches the model.
export function collaborationTools(self: string, names: string[], lead: boolean): ToolDefinition[] {
  const others = names.filter(name => name !== self);
  const teammate = others.length ? { type: 'string', enum: others } : { type: 'string' };
  const tools: ToolDefinition[] = [
    { name: 'post_board', description: 'Post to the team board, which everyone can read. Your name is added for you. notify and ordinary mentions go to an inbox without waking idle or waiting teammates, unless the lead posts them; working teammates receive a steer. ask wakes recipients for a response. Reports should not request replies; use ask when blocked, needing a decision, raising an objection, or handing work to a teammate, never merely for earlier visibility. Returns a receipt.', inputSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', description: 'What to post' },
      notify: { type: 'array', items: teammate, description: 'Teammates to tell. No reply is expected, and a teammate who is not working sees it only when next woken. The default way to report.' },
      ask: { type: 'array', items: teammate, description: 'Teammates who must reply. Only when you really need an answer.' },
    } } },
    { name: 'message_teammate', description: `Send a private message. Ordinary reports go to an inbox without waking idle or waiting teammates, and steer working teammates. Messages from the lead always wake. Use reply_requested when blocked, needing a decision, raising an objection, or handing work to a teammate, never merely for earlier visibility. Returns a receipt.`, inputSchema: { type: 'object', additionalProperties: false, required: ['to', 'text'], properties: {
      to: lead ? { type: 'string', enum: [...others, 'all'], description: 'One teammate, or all of them' } : teammate,
      text: { type: 'string', description: 'The message' },
      reply_requested: { type: 'boolean', description: 'True only when you really need an answer. Defaults to false.' },
    } } },
    { name: 'read_board', description: 'Return board entries posted since your last read. It never blocks. It is not a way to wait: use wait_for_messages for that.', inputSchema: { type: 'object', additionalProperties: false, properties: {
      from_start: { type: 'boolean', description: 'Return the whole board instead of only new entries' },
    } } },
    { name: 'wait_for_messages', description: 'Block until a message requires your response, then return it together with collected inbox notifications. It takes as long as it takes, minutes or hours, and uses no budget meanwhile. This is the only correct way to wait for a teammate or the user. Ordinary notifications alone do not end this wait.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  ];
  if (lead) tools.push({ name: 'set_member_permission', description: '修改其他成员的常驻权限，最高不超过自己，不能修改自己或联网开关，不能批准临时申请。', inputSchema: { type: 'object', required: ['member','level'], properties: { member: teammate, level: { type: 'string', enum: ['read-only','safe-write','full-write'] } } } });
  if (lead) tools.push({ name: 'interrupt_teammate', description: 'Stop what a teammate is doing right now and give them new instructions. Only for work that has gone wrong or is no longer wanted.', inputSchema: { type: 'object', additionalProperties: false, required: ['to', 'text'], properties: {
    to: { type: 'string', enum: [...others, 'all'], description: 'One teammate, or all of them' },
    text: { type: 'string', description: 'What they should do instead' },
  } } });
  return tools;
}
