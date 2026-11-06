// Deliberately excluded from npm test. Each selected provider receives at most one request.
import { cleanTitle, generateTitle, requestTitle, TITLE_TIMEOUT_MS, LUNA_MODEL } from '../dist/app/title.js';
if (!process.argv.includes('--authorized-this-run')) {
  console.error('真实模型验收需要 --authorized-this-run；可加 --skip-luna 只测本地 Qwen。');
  process.exitCode = 1;
} else {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const both = process.argv.includes('--both');
  const skipLuna = process.argv.includes('--skip-luna');
  const text = '请修复会话列表刷新时标题和选中状态不同步的问题，并补充测试。';
  const called = new Set(), pending = new Set();
  const transport = async (model, input, signal) => {
    called.add(model);
    const start = performance.now();
    try {
      const task = requestTitle(model, input, signal); pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      const title = await task;
      console.log(JSON.stringify({ model: model === 'luna' ? LUNA_MODEL : 'local Qwen / iq3_s', elapsedMs: Math.round(performance.now()-start), title: cleanTitle(title) }));
      return title;
    } catch {
      console.log(JSON.stringify({ model: model === 'luna' ? LUNA_MODEL : 'local Qwen / iq3_s', elapsedMs: Math.round(performance.now()-start), error: signal.aborted ? '超时或取消' : '调用失败' }));
      throw new Error('TITLE_CHECK_FAILED');
    }
  };
  try {
    const title = await generateTitle(text, controller.signal, transport, TITLE_TIMEOUT_MS, skipLuna);
    if (!title) process.exitCode = 1;
    // --both explicitly checks Qwen even if Luna succeeded; never calls either provider twice.
    if (both && !called.has('qwen') && !controller.signal.aborted) {
      if (!await generateTitle(text, controller.signal, transport, TITLE_TIMEOUT_MS, true)) process.exitCode = 1;
    }
  } finally { controller.abort(); await Promise.allSettled([...pending]); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
