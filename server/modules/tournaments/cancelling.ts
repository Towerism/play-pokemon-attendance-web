import { and, eq } from 'drizzle-orm';
import type { CancelBody, EditTarget } from '../../../shared/schemas/tournaments';
import { dateIn } from '../../../shared/time/local-time';
import type { Db } from '../../db/client';
import { plannedTournament, tournamentTemplate } from '../../db/schema';
import type { Actor } from '../accounts/service';
import type { ActingConnection, PokemonConnectionService } from '../pokemon/connection';
import { PokemonUpstreamError } from '../pokemon/ports/errors';
import type { TournamentDetails } from '../pokemon/ports/play-tools-gateway';
import type { StaffingService } from '../staffing/service';
import { cancellability, confirmationFor, participantCounts } from './cancel';
import { type LocalDate, addDays, timeIn } from './dates';
import { TournamentsError } from './errors';
import { type OrganizerRead, assertMayActAs, organizerReads } from './organizer';
import { heldSkipped } from './plan';
import type { TournamentsGateway } from './service';

type PlannedRow = typeof plannedTournament.$inferSelect;

/** The confirm dialog of Cancel… (`GET /tournaments/{id}/cancel`, #94), from fresh reads as the organizer. */
export interface CancelPreview {
  target: { plannedId: number | null; tournamentId: string; displayId: string | null };
  name: string | null;
  /** In the venue's zone, else the league's; null when play-tools has no start. */
  localDate: LocalDate | null;
  startTime: string | null;
  organizer: { playerId: string; name: string | null };
  upstreamStatus: string | null;
  /** Listed, not staff. Counts only: who never leaves the server. */
  players: number;
  /** Staff other than the organizer. */
  staff: number;
  cancellable: boolean;
  reason: 'already_cancelled' | 'tournament_locked' | null;
  /** Start + 90 days in the league `TZ`: the last day play-tools lets it be cancelled. */
  closesOn: LocalDate | null;
  /** Anyone listed: the organizer types `confirmWith`. */
  confirmRequired: boolean;
  confirmWith: string | null;
}

/** The one tournament a cancel job sends to, as stored on its item. */
export interface CancelItem {
  plannedId: number | null;
  tournamentId: string;
  label: string;
  professorPlayerId: string;
  /** The organizer typed the confirmation; an unconfirmed item is refused once anyone is listed. */
  confirmed: boolean;
}

export type CancelPlan = { kind: 'already_cancelled'; item: CancelItem } | { kind: 'cancel'; item: CancelItem };

/** A cancel item's turn, from a fresh read as its organizer. */
export type CancelRead =
  | { kind: 'send'; connectionId: number; read: TournamentDetails }
  | { kind: 'already_cancelled'; connectionId: number; read: TournamentDetails }
  | { kind: 'fail'; code: 'unknown_tournament' | 'tournament_locked' | 'confirmation_required'; message: string; connectionId: number; read?: TournamentDetails };

/** What the routes and the submission module's `tournament_cancel` job use (#94), as `editing` is for edits. */
export interface TournamentCancelling {
  /** @throws TournamentsError `not_found`, `not_in_play_tools`, `not_editable`, `organizer_not_connected`, `needs_reconnect`, `league_not_selected`; PokemonUpstreamError */
  preview(leagueId: string, target: EditTarget): Promise<CancelPreview>;
  /** The preview again, then the apply's refusals. Reads only. @throws the preview's, `not_your_connection`, `confirmation_mismatch`, `tournament_locked` */
  /** The tournament must be `actor`'s to change (ADR-0015 §4). */
  prepare(leagueId: string, target: EditTarget, body: CancelBody, actor: Actor): Promise<CancelPlan>;
  /** Fresh read and checks. @throws PokemonUpstreamError `not_connected`, `needs_reconnect`, or the read's own: the job stops */
  readItem(leagueId: string, item: CancelItem): Promise<CancelRead>;
  /** play-tools has it cancelled: the planned row is `cancelled`, its staff dropped or tombstoned. One transaction. */
  recordCancelled(leagueId: string, item: Pick<CancelItem, 'plannedId' | 'tournamentId'>): { dropped: number; removed: number };
  recordReconciled(leagueId: string, plannedId: number, fresh: { displayId: string | null; status: string | null }): void;
}

export interface CancellingContext {
  db: Db;
  connections: Pick<PokemonConnectionService, 'league' | 'listActingConnections' | 'actingConnection'>;
  gateway: (connectionId: number) => Pick<TournamentsGateway, 'getTournament' | 'listTournamentParticipants'>;
  staffing?: Pick<StaffingService, 'cancelTournament'>;
  timeZone: string;
  now: () => Date;
  plannedRow(leagueId: string, id: number): PlannedRow;
}

/** Rows a create holds or may have made: they wait for it to settle (#92). */
const UNSETTLED = new Set(['creating', 'unknown']);

export function createCancelling(ctx: CancellingContext): TournamentCancelling {
  const { db } = ctx;
  const reads = organizerReads(ctx);

  /** The tournament behind `{id}`, read fresh as its organizer, with the row that links it. */
  async function locate(leagueId: string, target: EditTarget): Promise<OrganizerRead & { row: PlannedRow | null }> {
    const group = ctx.connections.league(leagueId)?.id;
    if (!group) throw new TournamentsError('league_not_selected', 'Choose the league in Settings first.');
    const row =
      target.kind === 'planned'
        ? ctx.plannedRow(leagueId, target.id)
        : (db
            .select()
            .from(plannedTournament)
            .where(and(eq(plannedTournament.leagueId, leagueId), eq(plannedTournament.tournamentId, target.id)))
            .get() ?? null);
    if (!row) return { ...(await reads.ofGuid(group, (target as Extract<EditTarget, { kind: 'tournament' }>).id)), row: null };
    if (UNSETTLED.has(row.state)) {
      throw new TournamentsError('not_editable', 'A create holds this tournament or may have made it. Wait for it to settle.', { state: row.state });
    }
    if (heldSkipped(row) && !row.tournamentId) {
      throw new TournamentsError('not_editable', 'This tournament may have been created in play-tools. It can be cancelled once it shows up there.', {
        state: 'skipped',
        skippedWhileUnknown: true,
      });
    }
    if (!row.tournamentId) {
      throw new TournamentsError('not_in_play_tools', "This tournament isn't in play-tools. Skip it instead.", { state: row.state });
    }
    const template = db.select().from(tournamentTemplate).where(eq(tournamentTemplate.id, row.templateId)).get()!;
    return { ...(await reads.ofRow(group, row.tournamentId, template.organizerPlayerId)), row };
  }

  async function preview(leagueId: string, target: EditTarget): Promise<CancelPreview> {
    const { row, read, organizer, tournamentId } = await locate(leagueId, target);
    const counts = participantCounts(await ctx.gateway(organizer.id).listTournamentParticipants(tournamentId));
    const zone = read.venue?.timeZone ?? ctx.timeZone;
    const state = cancellability(read, ctx.now());
    const confirm = confirmationFor(read, counts, ctx.timeZone);
    return {
      target: { plannedId: row?.id ?? null, tournamentId, displayId: read.displayId },
      name: read.name,
      localDate: read.startsAt ? dateIn(read.startsAt, zone) : null,
      startTime: read.startsAt ? timeIn(read.startsAt, zone) : null,
      organizer: { playerId: organizer.professorPlayerId!, name: read.organizerName ?? organizer.professorName },
      upstreamStatus: read.applicationState ?? read.status,
      players: counts.players,
      staff: counts.staff,
      cancellable: state.cancellable,
      reason: state.reason,
      closesOn: read.startsAt ? addDays(dateIn(read.startsAt, ctx.timeZone), 90) : null,
      confirmRequired: confirm.required,
      confirmWith: confirm.with,
    };
  }

  /** As `organizer.ts`'s `requireActing`, but a job's error: `not_connected` / `needs_reconnect` stop the job. */
  function organizerOf(playerId: string): ActingConnection {
    const c = ctx.connections.listActingConnections().find((x) => x.professorPlayerId === playerId);
    if (!c) throw new PokemonUpstreamError('not_connected', `Professor ${playerId}'s Pokémon account is no longer connected.`);
    if (c.status === 'needs_reconnect') throw new PokemonUpstreamError('needs_reconnect', `Reconnect ${c.professorName ?? `Professor ${playerId}`} in Settings.`);
    return c;
  }

  return {
    preview,

    async prepare(leagueId, target, body, actor) {
      const p = await preview(leagueId, target);
      assertMayActAs(ctx.connections, actor, p.organizer.playerId);
      // The typed confirmation comes first: even the already-cancelled path writes locally.
      if (p.confirmRequired && body.confirmation !== p.confirmWith) {
        throw new TournamentsError('confirmation_mismatch', `Type ${p.confirmWith} exactly to confirm cancelling this tournament.`, { required: true });
      }
      if (p.reason === 'tournament_locked') {
        throw new TournamentsError('tournament_locked', 'play-tools no longer lets a professor cancel this tournament.', { status: p.upstreamStatus });
      }
      const item: CancelItem = {
        plannedId: p.target.plannedId,
        tournamentId: p.target.tournamentId,
        label: [p.name ?? 'Tournament', p.localDate].filter(Boolean).join(' · '),
        professorPlayerId: p.organizer.playerId,
        confirmed: p.confirmRequired,
      };
      return { kind: p.reason === 'already_cancelled' ? 'already_cancelled' : 'cancel', item };
    },

    async readItem(_leagueId, item) {
      const c = organizerOf(item.professorPlayerId);
      let fresh: TournamentDetails;
      try {
        fresh = await ctx.gateway(c.id).getTournament(item.tournamentId);
      } catch (err) {
        if (err instanceof PokemonUpstreamError && err.code === 'not_found') {
          return { kind: 'fail', code: 'unknown_tournament', message: 'play-tools no longer has this tournament.', connectionId: c.id };
        }
        throw err;
      }
      const state = cancellability(fresh, ctx.now());
      if (state.reason === 'already_cancelled') return { kind: 'already_cancelled', connectionId: c.id, read: fresh };
      if (state.reason === 'tournament_locked') {
        return { kind: 'fail', code: 'tournament_locked', message: 'play-tools no longer lets a professor cancel this tournament.', connectionId: c.id, read: fresh };
      }
      if (!item.confirmed) {
        const counts = participantCounts(await ctx.gateway(c.id).listTournamentParticipants(item.tournamentId));
        if (counts.players + counts.staff > 0) {
          return {
            kind: 'fail',
            code: 'confirmation_required',
            message: 'People have registered since the cancel was confirmed. Cancel it again to confirm with its display id.',
            connectionId: c.id,
            read: fresh,
          };
        }
      }
      return { kind: 'send', connectionId: c.id, read: fresh };
    },

    recordCancelled(leagueId, item) {
      return db.transaction(() => {
        if (item.plannedId !== null) {
          db.update(plannedTournament)
            .set({ state: 'cancelled', upstreamStatus: 'cancelled' })
            .where(and(eq(plannedTournament.id, item.plannedId), eq(plannedTournament.leagueId, leagueId)))
            .run();
        }
        return ctx.staffing?.cancelTournament(leagueId, item.tournamentId) ?? { dropped: 0, removed: 0 };
      });
    },

    recordReconciled(leagueId, plannedId, fresh) {
      db.update(plannedTournament)
        .set({ displayId: fresh.displayId, upstreamStatus: fresh.status })
        .where(and(eq(plannedTournament.id, plannedId), eq(plannedTournament.leagueId, leagueId)))
        .run();
    },
  };
}
