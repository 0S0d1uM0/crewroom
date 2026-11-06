function iso(v: any) { if (v == null) return null; const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); return Number.isFinite(d.getTime()) ? d.toISOString() : null; }
export function normalizeQuota(harness: string, data: any) {
  let windows: any[] = [];
  if (harness === 'codex') {
    const buckets: any[] = data.rateLimitsByLimitId ? Object.values(data.rateLimitsByLimitId).filter(Boolean) : [data.rateLimits].filter(Boolean);
    windows = buckets.flatMap(b => ['primary', 'secondary'].filter(k => b[k]).map(k => ({ label: b[k].windowDurationMins === 300 ? '5h' : b[k].windowDurationMins === 10080 ? 'weekly' : String(b[k].windowDurationMins), windowDurationMins: b[k].windowDurationMins, usedPercent: b[k].usedPercent ?? null, resetsAt: iso(b[k].resetsAt), status: b.rateLimitReachedType ?? 'observed' })));
  } else {
    windows = data.windows ?? Object.entries(data.unifiedWindows ?? {}).map(([name, w]: [string, any]) => ({ name, usedPercent: w.utilization == null ? null : w.utilization * 100, resetsAt: w.resetsAt, status: w.status ?? data.status }));
    windows = windows.map(w => ({ ...w, label: /5h|five_hour/i.test(w.name ?? w.label) ? '5h' : /7d|weekly|seven_day/i.test(w.name ?? w.label) ? 'weekly' : w.name ?? w.label, resetsAt: iso(w.resetsAt) }));
  }
  return { harness, observedAt: new Date().toISOString(), ordinaryUsageAllowed: data.ordinaryUsageAllowed ?? null, planType: data.rateLimits?.planType ?? Object.values(data.rateLimitsByLimitId ?? {}).map((b: any) => b?.planType).find(Boolean) ?? null, windows, exhausted: data.ordinaryUsageAllowed === false || windows.some(w => w.usedPercent >= 100 || w.status === 'rejected') };
}
