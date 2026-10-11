import type { PlayerId } from '../../../shared/types/ids';
import type { AttendanceRecord } from '../pokemon/ports/play-tools-gateway';

export type Origin = 'session' | 'regular';

export interface DesiredPlayer {
  playerId: PlayerId;
  origin: Origin;
}

export interface Plan {
  /** Session players first, then regulars (as the CLI sent them). */
  toAdd: DesiredPlayer[];
  /** Desired and already recorded upstream, in any role. */
  alreadyPresent: (DesiredPlayer & { recordId: string; asStaff: boolean })[];
  /** Upstream players nobody here asked for: reported, never deleted. */
  extra: AttendanceRecord[];
}

/**
 * The plan step of ADR-0004: `toAdd = desired − existing`. It never asks
 * "did I send this before?", only "what is upstream missing?". Staff records
 * count as present, because upstream refuses to add a participant twice (S4).
 */
export function planSubmission(desired: readonly DesiredPlayer[], existing: readonly AttendanceRecord[]): Plan {
  const upstream = new Map(existing.map((r) => [r.playerId, r]));
  const wanted = new Map<PlayerId, DesiredPlayer>();
  for (const origin of ['session', 'regular'] as const) {
    for (const p of desired) if (p.origin === origin && !wanted.has(p.playerId)) wanted.set(p.playerId, p);
  }

  const plan: Plan = { toAdd: [], alreadyPresent: [], extra: [] };
  for (const p of wanted.values()) {
    const record = upstream.get(p.playerId);
    if (record) plan.alreadyPresent.push({ ...p, recordId: record.recordId, asStaff: !record.isPlayer });
    else plan.toAdd.push(p);
  }
  plan.extra = existing.filter((r) => r.isPlayer && !wanted.has(r.playerId));
  return plan;
}
