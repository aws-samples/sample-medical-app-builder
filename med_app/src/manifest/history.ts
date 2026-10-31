import type { RegistryEntry, VersionEvent } from './registry';

/**
 * A version's lifecycle as people read it: each event named for what it was — submitted, sent back, recalled,
 * approved, published, superseded — with who did it and what they wrote. Pure functions over the registry's events
 * (`meta.history`, newest first); when a version carries no events (a bundled showcase manifest, a registry from
 * before events were returned) the sign-off on the manifest stands in for the approval.
 */

type OkEntry = Extract<RegistryEntry, { ok: true }>;

export type EventTone = 'neutral' | 'attention' | 'approval';

export interface DescribedEvent {
  readonly event: VersionEvent;
  /** "Sent back to draft", "Approved", … */
  readonly label: string;
  readonly tone: EventTone;
  /** The notes worth showing — a reviewer's reason, an approver's notes; the registry's own bookkeeping lines are dropped. */
  readonly notes?: string;
  /** The event was synthesised from the manifest's sign-off, not read from the registry. */
  readonly inferred?: boolean;
}

export const RECALL_NOTES = 'recalled by the author to make changes';

/** The person behind an event: their name, else their email, else "you", else the sub. */
export function actorName(event: Pick<VersionEvent, 'actor' | 'actor_sub'>, selfSub?: string): string {
  if (event.actor?.name) return event.actor.name;
  if (event.actor?.email) return event.actor.email;
  if (selfSub && event.actor_sub === selfSub) return 'you';
  return event.actor_sub || 'someone';
}

export function describeEvent(event: VersionEvent, entry: Pick<OkEntry, 'meta'>): DescribedEvent {
  const { from_state: from, to_state: to, notes } = event;
  const author = entry.meta?.created_by_sub ?? entry.meta?.owner_sub;
  if (from === null) {
    const iterates = notes?.match(/iterates (\d+\.\d+\.\d+)/)?.[1];
    return { event, label: iterates ? `Created as a draft, iterating on v${iterates}` : 'Created as a draft', tone: 'neutral' };
  }
  if (from === 'draft' && to === 'draft') return { event, label: 'Revised', tone: 'neutral' };
  if (from === 'draft' && to === 'in_review') return { event, label: 'Submitted for review', tone: 'neutral', ...(notes ? { notes } : {}) };
  if (to === 'approved') return { event, label: event.signed ? 'Approved and signed' : 'Approved', tone: 'approval', ...(notes ? { notes } : {}) };
  if (to === 'published') return { event, label: 'Published', tone: 'approval', ...(notes ? { notes } : {}) };
  if (to === 'draft') {
    const recalled = notes === RECALL_NOTES || (author !== undefined && event.actor_sub === author);
    return recalled ? { event, label: 'Recalled by the author', tone: 'neutral', ...(notes && notes !== RECALL_NOTES ? { notes } : {}) } : { event, label: from === 'approved' ? 'Sent back to draft after approval' : 'Sent back to draft', tone: 'attention', ...(notes ? { notes } : {}) };
  }
  if (to === 'deprecated') {
    const successor = notes?.match(/^superseded by (\d+\.\d+\.\d+)$/)?.[1];
    return successor ? { event, label: `Superseded by v${successor}`, tone: 'neutral' } : { event, label: 'Deprecated', tone: 'neutral', ...(notes ? { notes } : {}) };
  }
  return { event, label: `${from.replace('_', ' ')} → ${to.replace('_', ' ')}`, tone: 'neutral', ...(notes ? { notes } : {}) };
}

/** The version's history, newest first — from the registry's events, else inferred from the manifest's sign-off. */
export function historyOf(entry: OkEntry): DescribedEvent[] {
  if (entry.meta?.history?.length) return entry.meta.history.map((e) => describeEvent(e, entry));
  const signoff = entry.manifest.lifecycle.signoff;
  if (signoff?.approved_at && signoff.approver_sub) {
    const event: VersionEvent = { ts: signoff.approved_at, actor_sub: signoff.approver_sub, from_state: 'in_review', to_state: 'approved', ...(signoff.clinical_notes ? { notes: signoff.clinical_notes } : {}), ...(signoff.signature ? { signed: true } : {}) };
    return [{ ...describeEvent(event, entry), inferred: true }];
  }
  return [];
}

/** The send-back an author still has to act on: the version is a draft and the last decision about it was a reviewer's. */
export function sentBack(entry: OkEntry): DescribedEvent | null {
  if (entry.manifest.lifecycle.state !== 'draft') return null;
  for (const d of historyOf(entry)) {
    if (d.label === 'Revised') continue; // the author has been working since; the reason still stands until it is resubmitted
    return d.tone === 'attention' ? d : null;
  }
  return null;
}

/** How a version was approved — the event, or the sign-off it was inferred from. */
export function approvalOf(entry: OkEntry): DescribedEvent | null {
  return historyOf(entry).find((d) => d.event.to_state === 'approved') ?? null;
}
