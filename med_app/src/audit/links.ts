/**
 * From an app's inspector to the trail: `/audit?id=<audit_id>&at=<iso>` names one record and roughly when it was
 * written, so the page can look in the right days and open it.
 */
export function deepLinkTo(entry: { audit_id: string; timestamp: string }): string {
  return `/audit?${new URLSearchParams({ id: entry.audit_id, at: entry.timestamp })}`;
}

/** The day before and the day after a timestamp, as dates: where a record written around then is to be found. */
export function daysAround(iso: string): { from: string; to: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { from: '', to: '' };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: day(at.getTime() - 86_400_000), to: day(at.getTime() + 86_400_000) };
}
