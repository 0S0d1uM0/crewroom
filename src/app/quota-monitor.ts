import { normalizeQuota } from './quota.js';
export const QUOTA_POLL_MS = 5 * 60 * 1000;
export class QuotaMonitor {
  private reading = false;
  async poll(sessions: Iterable<any>) {
    if (this.reading) return;
    const candidates = [...sessions].filter(s=>!s.paused).flatMap(s=>[...s.members.values()].map((m:any)=>({s,m})));
    const usable = candidates.filter(({m})=>m.config.harness==='codex' && m.state!=='paused' && !m.failed && m.adapter.readQuota);
    this.reading=true;
    try {
      // The first member whose harness is running answers for the whole harness; one not started yet has nothing to ask.
      for (const {s,m} of usable) {
        try { const data=await m.adapter.readQuota(); if(!data) continue; s.storage.event('rate-limits',{member:m.config.name,...data}); return; }
        catch(error) { s.storage.event('protocol-warning',{text:'额度查询失败，继续工作：'+String(error)}); return; }
      }
    } finally { this.reading=false; }
  }
}
// Reset times of one window move by a few seconds between reads (seen in real Codex logs), so only a
// real jump counts as a new cycle. Otherwise the lead would be told again on every wobble.
const CYCLE_TOLERANCE_MS = 10 * 60 * 1000;
function sameCycle(a?:string,b?:string) {
  if(a===undefined||b===undefined) return false;
  if(a===b) return true;
  const gap=Math.abs(Date.parse(a)-Date.parse(b));
  return Number.isFinite(gap) && gap<CYCLE_TOLERANCE_MS;
}
export function quotaNotices(harness:string,data:any,previous:any[]=[]) {
  const q=normalizeQuota(harness,data), active=new Map<string,string>(), events:any[]=[];
  for(const e of previous) if(e.harness===harness) {
    if(e.type==='quota-notice') active.set(e.window,e.cycle);
    if(e.type==='quota-rearmed') active.delete(e.window);
  }
  for(const w of q.windows) {
    if(!['5h','weekly'].includes(w.label) || !Number.isFinite(w.usedPercent)) continue;
    const cycle=w.resetsAt??'unknown';
    if(w.usedPercent<=85 || (w.resetsAt && Date.parse(w.resetsAt)<=Date.now())) {
      if(active.has(w.label)) events.push({type:'quota-rearmed',harness,window:w.label});
    } else if(!sameCycle(active.get(w.label),cycle)) { active.set(w.label,cycle); events.push({type:'quota-notice',harness,window:w.label,cycle,text:`${harness} ${w.label==='5h'?'5 小时':'每周'}窗口剩余 ${Math.max(0,100-w.usedPercent)}%，重置时间：${w.resetsAt??'未知'}`}); }
  }
  return {q,events};
}
