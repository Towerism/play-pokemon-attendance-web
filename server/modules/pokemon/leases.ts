import { type Logger, silentLogger } from '@towerism/selfhost-kit';
import { type SQL, and, asc, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { dateIn, localDay } from '../../../shared/time/local-time';
import type { SessionDate } from '../../../shared/types/ids';
import type { Db } from '../../db/client';
import type { LEASE_END_REASONS, LEASE_NOTICE_STATES } from '../../db/schema';
import { pokemonConnection, tournamentLease } from '../../db/schema';
import type { Actor } from '../accounts/service';
import type { DeliveryResult, DiscordChannel } from '../messaging/channel';
import { MessagingError } from '../messaging/errors';
import { withoutMentions } from '../messaging/text';
import type { PokemonConnectionService } from './connection';
import { PokemonUpstreamError } from './ports/errors';
import type { PlayToolsGateway, TournamentDetails } from './ports/play-tools-gateway';

export type LeaseEndReason = (typeof LEASE_END_REASONS)[number];
export type NoticeState = (typeof LEASE_NOTICE_STATES)[number];
/** What became of an end notice, as `DELETE /tournament-leases/{id}` reports it. */
export type EndNotice = 'sending' | 'genie_unavailable' | 'no_recipient' | 'none';

export type LeaseRefusalCode =
  | 'not_your_tournament'
  | 'unknown_tournament'
  | 'tournament_cancelled'
  | 'needs_reconnect'
  | 'already_leased'
  | 'no_start_date'
  | 'lease_window_passed'
  | 'ends_at_too_late';

export type LeaseErrorCode = 'lessee_is_you' | 'lessee_not_member' | 'lease_refused' | 'lease_not_found' | 'league_not_selected' | 'ends_at_invalid';

export interface LeaseRefusal {
  tournamentId: string;
  code: LeaseRefusalCode;
  message: string;
}

export class LeaseError extends Error {
  override name = 'LeaseError';
  constructor(
    readonly code: LeaseErrorCode,
    message: string,
    readonly data?: { refusals: LeaseRefusal[] },
  ) {
    super(message);
  }
}

/** A lease as the API returns it (ADR-0015 §5). */
export interface LeaseView {
  id: number;
  tournamentId: string;
  label: string;
  organizer: { playerId: string; name: string | null };
  lessee: { userId: number; username: string; name: string | null };
  grantedBy: string;
  grantedAt: string;
  endsAt: string;
  endedAt: string | null;
  endReason: LeaseEndReason | null;
  /** The grant notice's result. */
  notice: NoticeState | null;
  /** The caller's side of it. */
  mine: 'organizer' | 'lessee' | null;
}

/** Someone a lease can name. */
export interface Lessee {
  userId: number;
  username: string;
  name: string | null;
}

/** A live lease as a tournament card shows it to every member. */
export interface CardLease {
  id: number;
  lesseeUserId: number;
  lesseeName: string;
  organizerName: string;
  endsAt: string;
}

export interface GrantLeasesInput {
  tournamentIds: readonly string[];
  lesseeUserId: number;
  endsAt?: string;
}

/** A lease that just ended, with what its notice needs; read before its connection may be deleted. */
export interface EndedLease {
  id: number;
  tournamentId: string;
  label: string;
  lesseeUserId: number;
  organizerName: string;
  reason: LeaseEndReason;
}

type Row = typeof tournamentLease.$inferSelect;

/** The topic lease notices go out under; results come back to its handler. */
const TOPIC = 'lease';
const DAY_MS = 86_400_000;
/** ADR-0015 §5: a lease lasts at most this long after its tournament starts. */
const MAX_AFTER_START_MS = 30 * DAY_MS;
/** ADR-0015 §5: by default, until the end of the 7th day after the start. */
const DEFAULT_DAYS_AFTER_START = 7;
const END_NOTICE_LIFETIME_MS = DAY_MS;
const LINK_LABEL = 'Open Play! Pokémon Attendance';
/** The Discord channel's limit on a message's text (ADR-0015 §7). */
const MAX_NOTICE_TEXT = 1800;
/** Reads that mean "not this connection's tournament". */
const NOT_THEIRS: ReadonlySet<string> = new Set(['not_found', 'forbidden', 'refused']);

const organizerLabel = (c: { professorName: string | null; professorPlayerId: string | null }) =>
  c.professorName ?? (c.professorPlayerId ? `Professor ${c.professorPlayerId}` : 'the organizer');

/**
 * The lease table's reads and writes, shared by the lease service and the connection service, which ends leases inside
 * its own transactions (disconnect, claim, removal, membership). Plain rows, no notices.
 */
export function createLeaseStore(deps: { db: Db; now?: () => Date }) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const live = () => and(isNull(tournamentLease.endedAt), gt(tournamentLease.endsAt, now()));

  /** Ends every live lease matching `where`, returning what their notices need. Call inside the cause's transaction. */
  function endWhere(where: SQL | undefined, reason: LeaseEndReason): EndedLease[] {
    const rows = db
      .select({ lease: tournamentLease, organizerName: pokemonConnection.professorName, organizerPlayerId: pokemonConnection.professorPlayerId })
      .from(tournamentLease)
      .innerJoin(pokemonConnection, eq(pokemonConnection.id, tournamentLease.connectionId))
      .where(and(live(), where))
      .orderBy(asc(tournamentLease.id))
      .all();
    if (rows.length === 0) return [];
    db.update(tournamentLease)
      .set({ endedAt: now(), endReason: reason })
      .where(
        inArray(
          tournamentLease.id,
          rows.map((r) => r.lease.id),
        ),
      )
      .run();
    return rows.map((r) => ({
      id: r.lease.id,
      tournamentId: r.lease.tournamentId,
      label: r.lease.tournamentLabel,
      lesseeUserId: r.lease.lesseeUserId,
      organizerName: organizerLabel({ professorName: r.organizerName, professorPlayerId: r.organizerPlayerId }),
      reason,
    }));
  }

  return {
    endWhere,
    /** The live lease `userId` holds on `tournamentId` from `connectionId`, if any. */
    liveFor(userId: number, connectionId: number, tournamentId: string): number | null {
      const r = db
        .select({ id: tournamentLease.id })
        .from(tournamentLease)
        .where(and(live(), eq(tournamentLease.lesseeUserId, userId), eq(tournamentLease.connectionId, connectionId), eq(tournamentLease.tournamentId, tournamentId)))
        .get();
      return r?.id ?? null;
    },
    /** Live now: not ended, and its end still ahead. */
    isLive(id: number): boolean {
      return db.select({ id: tournamentLease.id }).from(tournamentLease).where(and(live(), eq(tournamentLease.id, id))).get() !== undefined;
    },
    /** Tournament ids `userId` holds a live lease on. */
    leasedTournamentIdsOf(userId: number): Set<string> {
      return new Set(
        db
          .select({ id: tournamentLease.tournamentId })
          .from(tournamentLease)
          .where(and(live(), eq(tournamentLease.lesseeUserId, userId)))
          .all()
          .map((r) => r.id),
      );
    },
    /** The live leases `userId` holds, oldest first, for their calendar feed (ADR-0016 §5). */
    liveLeasesFor(userId: number): LiveLease[] {
      return db
        .select({ tournamentId: tournamentLease.tournamentId, endsAt: tournamentLease.endsAt, grantedAt: tournamentLease.grantedAt })
        .from(tournamentLease)
        .where(and(live(), eq(tournamentLease.lesseeUserId, userId)))
        .orderBy(asc(tournamentLease.id))
        .all();
    },
    endOnConnection: (connectionId: number, reason: LeaseEndReason) => endWhere(eq(tournamentLease.connectionId, connectionId), reason),
    endHeldBy: (userId: number, reason: LeaseEndReason) => endWhere(eq(tournamentLease.lesseeUserId, userId), reason),
    endForTournament: (tournamentId: string, reason: LeaseEndReason) => endWhere(eq(tournamentLease.tournamentId, tournamentId), reason),
    /** Records every lease whose end has passed as expired (`ended_at` = `ends_at`), optionally only these tournaments'. */
    recordExpired(tournamentIds?: readonly string[]): EndedLease[] {
      const rows = db
        .select({ lease: tournamentLease, organizerName: pokemonConnection.professorName, organizerPlayerId: pokemonConnection.professorPlayerId })
        .from(tournamentLease)
        .innerJoin(pokemonConnection, eq(pokemonConnection.id, tournamentLease.connectionId))
        .where(
          and(
            isNull(tournamentLease.endedAt),
            lte(tournamentLease.endsAt, now()),
            tournamentIds ? inArray(tournamentLease.tournamentId, [...tournamentIds]) : undefined,
          ),
        )
        .orderBy(asc(tournamentLease.id))
        .all();
      for (const r of rows) {
        db.update(tournamentLease).set({ endedAt: r.lease.endsAt, endReason: 'expired' }).where(eq(tournamentLease.id, r.lease.id)).run();
      }
      return rows.map((r) => ({
        id: r.lease.id,
        tournamentId: r.lease.tournamentId,
        label: r.lease.tournamentLabel,
        lesseeUserId: r.lease.lesseeUserId,
        organizerName: organizerLabel({ professorName: r.organizerName, professorPlayerId: r.organizerPlayerId }),
        reason: 'expired' as const,
      }));
    },
  };
}

export type LeaseStore = ReturnType<typeof createLeaseStore>;

export interface LeaseService {
  /** Lends tournaments to one league member, all or none. @throws LeaseError, PokemonUpstreamError */
  grant(leagueId: string, actor: Actor, input: GrantLeasesInput): Promise<{ leases: LeaseView[] }>;
  /** The live leases `actor` granted or holds (the owner: all), and who `actor` could lend to. */
  list(leagueId: string, actor: Actor): { leases: LeaseView[]; lessees: Lessee[] };
  /** Ends a lease (its organizer) or gives it back (its lent user). @throws LeaseError `lease_not_found` */
  end(leagueId: string, actor: Actor, id: number): { lease: LeaseView; endNotice: EndNotice };
  /** Live leases of these tournaments, for card views. Local rows only. */
  leasesFor(tournamentIds: readonly string[]): Map<string, CardLease>;
  /** Ends a tournament's live lease (a cancel through the app), with its notice. */
  endLeasesForTournament(tournamentId: string, reason: 'tournament_cancelled'): void;
  /** The hourly run: records leases past their end as expired and sends their notices. Returns how many. */
  expire(): number;
  /** Sends the end notices of leases ended elsewhere (the connection service), after their transaction committed. */
  notifyEnded(ended: readonly EndedLease[]): void;
  isLive(leaseId: number): boolean;
  leasedTournamentIdsOf(userId: number): Set<string>;
  /** The live leases a user holds, for their calendar feed. Local rows only. */
  liveLeasesFor(userId: number): LiveLease[];
}

/** A live lease as a calendar feed shows it ("Lent to you until …"). */
export interface LiveLease {
  tournamentId: string;
  endsAt: Date;
  grantedAt: Date;
}

export interface LeaseDeps {
  db: Db;
  store: LeaseStore;
  connections: Pick<PokemonConnectionService, 'league' | 'listActingConnections' | 'access'>;
  accounts: { actor(userId: number): Actor | null; activeActors(): Actor[] };
  /** play-tools as one connection, for the grant's fresh reads. */
  gateway: (connectionId: number) => Pick<PlayToolsGateway, 'getTournament'>;
  channel: Pick<DiscordChannel, 'send' | 'available' | 'onResult'>;
  timeZone: string;
  /** `NUXT_PUBLIC_SITE_URL`, or null: notices then carry no link. */
  siteUrl: () => string | null;
  now?: () => Date;
  log?: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Tournament leases (ADR-0015 §5): an organizer lends one or more of their tournaments to one named league member, who
 * may then staff it and upload its results through the organizer's connection until the lease ends. Notices go to the
 * lent user through the Discord channel, without waiting.
 */
export function createLeaseService(deps: LeaseDeps): LeaseService {
  const { db, store, connections } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? silentLogger;
  const zone = deps.timeZone;

  /** "Sat, Nov 14": the last day a lease covers, in the league's time zone. */
  const lastDay = (endsAt: Date) =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(endsAt.getTime() - 1));

  const connectionsOf = (userId: number) => connections.listActingConnections().filter((c) => c.userId === userId);

  /** A user's name in lease lines: their connection's display name when they hold exactly one named connection. */
  function nameOf(userId: number): string | null {
    const named = connectionsOf(userId).filter((c) => c.professorName !== null);
    return named.length === 1 ? named[0]!.professorName : null;
  }

  /** Can `a` be named in a lease, and use one: the owner, or a professor who is a league member and needn't re-verify. */
  const usableMember = (a: Actor) => connections.access(a).member;

  /** The player ID a user's notices go to: their connection's; for the owner, their lowest-numbered member connection. */
  function recipientOf(userId: number): string | null {
    const mine = connectionsOf(userId).sort((x, y) => x.id - y.id);
    const pick = mine.find((c) => c.membership === 'member' && c.status === 'connected') ?? mine[0];
    return pick?.professorPlayerId ?? null;
  }

  function link() {
    const site = deps.siteUrl();
    return site ? { label: LINK_LABEL, url: site } : undefined;
  }

  /** Queues a notice without waiting. The row is written before `send` first yields, so callers needn't await it. */
  function queue(userId: number, text: string, expiresAt: Date, ref: string, sender: string): Promise<{ state: NoticeState | 'none'; messageId: number | null }> {
    const playerId = recipientOf(userId);
    if (playerId === null) return Promise.resolve({ state: 'no_recipient', messageId: null });
    if (!deps.channel.available()) return Promise.resolve({ state: 'genie_unavailable', messageId: null });
    return deps.channel.send({ playerId, text, link: link(), expiresAt, topic: TOPIC, ref }, { waitMs: 0, sender }).then(
      ({ messageId }) => ({ state: 'sending' as const, messageId }),
      (err: unknown) => {
        if (err instanceof MessagingError && err.code === 'genie_unavailable') return { state: 'genie_unavailable' as const, messageId: null };
        throw err;
      },
    );
  }

  const REASON_TEXT: Record<Exclude<LeaseEndReason, 'given_back' | 'lessee_removed'>, (organizer: string) => string> = {
    expired: () => 'it reached its end date',
    ended: (o) => `${o} ended it`,
    connection_gone: (o) => `${o}'s Pokémon account was disconnected from the app`,
    lessee_outside: () => "your Pokémon account isn't in the league",
    tournament_cancelled: () => 'the tournament was cancelled',
  };

  /** Sends one ended lease's notice without waiting; none when the lent user gave it back or was removed (ADR-0015 §5). */
  function notifyOne(e: EndedLease, sender: string): EndNotice {
    if (e.reason === 'given_back' || e.reason === 'lessee_removed') return 'none';
    const playerId = recipientOf(e.lesseeUserId);
    if (playerId === null) return 'no_recipient';
    if (!deps.channel.available()) return 'genie_unavailable';
    const text = `Your lease on ${withoutMentions(e.label)} has ended: ${withoutMentions(REASON_TEXT[e.reason](e.organizerName))}.`.slice(0, MAX_NOTICE_TEXT);
    const expiresAt = new Date(now().getTime() + END_NOTICE_LIFETIME_MS);
    // `send` writes the message before it first yields, so nothing here needs to wait for it.
    deps.channel.send({ playerId, text, link: link(), expiresAt, topic: TOPIC, ref: `end:${e.id}` }, { waitMs: 0, sender }).catch((err: unknown) => {
      log.warn(`A lease end notice could not be queued (${(err as Error).message}).`, { leaseId: e.id });
    });
    return 'sending';
  }

  function logEnded(e: EndedLease, by: string | null) {
    log.info('tournament lease ended', { leaseId: e.id, reason: e.reason, by });
  }

  // Every final result of a grant notice is shown on the leases it named (ADR-0015 §5). End notices aren't shown.
  deps.channel.onResult(TOPIC, (ref, result: DeliveryResult) => {
    if (!ref?.startsWith('grant:')) return;
    const ids = ref
      .slice('grant:'.length)
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length === 0) return;
    db.update(tournamentLease).set({ noticeDelivery: result.status }).where(inArray(tournamentLease.id, ids)).run();
  });

  function view(r: Row, actor: Actor | null): LeaseView {
    const conn = connections.listActingConnections().find((c) => c.id === r.connectionId);
    const lessee = deps.accounts.actor(r.lesseeUserId);
    return {
      id: r.id,
      tournamentId: r.tournamentId,
      label: r.tournamentLabel,
      organizer: { playerId: conn?.professorPlayerId ?? '', name: conn?.professorName ?? null },
      lessee: { userId: r.lesseeUserId, username: lessee?.username ?? '', name: nameOf(r.lesseeUserId) },
      grantedBy: r.grantedBy,
      grantedAt: r.grantedAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      endReason: r.endReason ?? null,
      notice: r.noticeDelivery ?? null,
      mine: actor === null ? null : conn?.userId === actor.userId ? 'organizer' : r.lesseeUserId === actor.userId ? 'lessee' : null,
    };
  }

  const liveRows = () =>
    db
      .select()
      .from(tournamentLease)
      .where(and(isNull(tournamentLease.endedAt), gt(tournamentLease.endsAt, now())))
      .orderBy(asc(tournamentLease.id))
      .all();

  /** The first instant of the day after the 7th day after `startsAt`, in the league's time zone. */
  function defaultEnd(startsAt: Date): Date {
    const [y, m, d] = dateIn(startsAt, zone).split('-').map(Number) as [number, number, number];
    const day = new Date(Date.UTC(y, m - 1, d + DEFAULT_DAYS_AFTER_START)).toISOString().slice(0, 10) as SessionDate;
    return localDay(day, zone).to;
  }

  /** Reads `tournamentId` as each of the caller's connected connections until one can. Other users' are never used. */
  async function readAsCaller(actor: Actor, tournamentId: string): Promise<TournamentDetails | null> {
    for (const c of connectionsOf(actor.userId).filter((x) => x.status === 'connected' && x.professorPlayerId !== null)) {
      try {
        return await deps.gateway(c.id).getTournament(tournamentId);
      } catch (err) {
        if (err instanceof PokemonUpstreamError && NOT_THEIRS.has(err.code)) continue;
        throw err;
      }
    }
    return null;
  }

  const refuse = (tournamentId: string, code: LeaseRefusalCode, message: string): LeaseRefusal => ({ tournamentId, code, message });

  function notifyEnded(ended: readonly EndedLease[]) {
    for (const e of ended) notifyOne(e, 'system');
  }

  return {
    async grant(leagueId, actor, input) {
      if (input.lesseeUserId === actor.userId) throw new LeaseError('lessee_is_you', "You can't lend a tournament to yourself.");
      const lessee = deps.accounts.actor(input.lesseeUserId);
      if (!lessee || !usableMember(lessee)) {
        throw new LeaseError('lessee_not_member', "That person isn't a member of the league, so nothing can be lent to them.");
      }
      const league = connections.league(leagueId);
      if (!league) throw new LeaseError('league_not_selected', 'Choose the league in Settings first.');
      const explicitEnd = input.endsAt === undefined ? null : new Date(input.endsAt);
      if (explicitEnd !== null && !(explicitEnd.getTime() > now().getTime())) {
        throw new LeaseError('ends_at_invalid', 'The end of a lease must be in the future.');
      }

      const mine = connectionsOf(actor.userId);
      const planned: { read: TournamentDetails; connectionId: number; endsAt: Date }[] = [];
      const refusals: LeaseRefusal[] = [];
      for (const tournamentId of input.tournamentIds) {
        const read = await readAsCaller(actor, tournamentId);
        const organizer = read ? mine.find((c) => c.professorPlayerId === read.organizerPlayerId) : undefined;
        if (!read || !organizer) {
          refusals.push(refuse(tournamentId, 'not_your_tournament', 'Only its organizer can lend this tournament.'));
          continue;
        }
        const name = read.name ?? 'This tournament';
        if (read.groupId !== league.id) {
          refusals.push(refuse(tournamentId, 'unknown_tournament', `${name} isn't one of the league's tournaments.`));
          continue;
        }
        if (read.status === 'cancelled' || read.applicationState === 'cancelled') {
          refusals.push(refuse(tournamentId, 'tournament_cancelled', `${name} is cancelled.`));
          continue;
        }
        if (organizer.status === 'needs_reconnect') {
          refusals.push(refuse(tournamentId, 'needs_reconnect', `Reconnect ${organizerLabel(organizer)} in Settings first.`));
          continue;
        }
        if (read.startsAt === null) {
          refusals.push(refuse(tournamentId, 'no_start_date', `${name} has no start date in play-tools, so a lease can't be timed.`));
          continue;
        }
        const latest = new Date(read.startsAt.getTime() + MAX_AFTER_START_MS);
        if (latest.getTime() <= now().getTime()) {
          refusals.push(refuse(tournamentId, 'lease_window_passed', `${name} started more than 30 days ago.`));
          continue;
        }
        const endsAt = explicitEnd ?? defaultEnd(read.startsAt);
        if (endsAt.getTime() > latest.getTime()) {
          refusals.push(refuse(tournamentId, 'ends_at_too_late', `A lease on ${name} can last until ${lastDay(new Date(latest.getTime() + 1))} at the latest.`));
          continue;
        }
        planned.push({ read, connectionId: organizer.id, endsAt });
      }

      const leased = (ids: readonly string[]) =>
        new Set(
          liveRows()
            .filter((r) => ids.includes(r.tournamentId))
            .map((r) => r.tournamentId),
        );
      const alreadyLeased = (id: string) => refuse(id, 'already_leased', 'This tournament is already lent to someone. End that lease first.');
      for (const id of leased(planned.map((p) => p.read.id))) refusals.push(alreadyLeased(id));
      if (refusals.length > 0) {
        refusals.sort((a, b) => input.tournamentIds.indexOf(a.tournamentId) - input.tournamentIds.indexOf(b.tournamentId));
        throw new LeaseError('lease_refused', 'Nothing was lent.', { refusals });
      }

      const at = now();
      let rows: Row[];
      try {
        rows = db.transaction(
          () => {
            const ended = store.recordExpired(planned.map((p) => p.read.id));
            for (const e of ended) logEnded(e, null);
            const taken = leased(planned.map((p) => p.read.id));
            if (taken.size > 0) throw new LeaseError('lease_refused', 'Nothing was lent.', { refusals: [...taken].map(alreadyLeased) });
            return planned.map((p) =>
              db
                .insert(tournamentLease)
                .values({
                  leagueId,
                  connectionId: p.connectionId,
                  tournamentId: p.read.id,
                  tournamentLabel: `${p.read.name ?? 'Tournament'} · ${dateIn(p.read.startsAt!, zone)}`,
                  lesseeUserId: lessee.userId,
                  grantedBy: actor.username,
                  grantedAt: at,
                  endsAt: p.endsAt,
                })
                .returning()
                .get(),
            );
          },
          { behavior: 'immediate' },
        );
      } catch (err) {
        // Another grant of the same tournament committed between the check and the insert.
        if (err instanceof Error && /UNIQUE constraint failed: tournament_lease/.test(err.message)) {
          throw new LeaseError('lease_refused', 'Nothing was lent.', { refusals: planned.map((p) => alreadyLeased(p.read.id)) });
        }
        throw err;
      }
      for (const r of rows) {
        const p = planned.find((x) => x.read.id === r.tournamentId)!;
        log.info('tournament lease granted', {
          leaseId: r.id,
          tournamentId: r.tournamentId,
          organizerPlayerId: p.read.organizerPlayerId,
          lessee: lessee.username,
          endsAt: r.endsAt.toISOString(),
          by: actor.username,
        });
      }

      const earliest = new Date(Math.min(...rows.map((r) => r.endsAt.getTime())));
      const it = rows.length > 1 ? 'them' : 'it';
      const textWith = (shown: number) => {
        const labels = rows.slice(0, shown).map((r) => withoutMentions(r.tournamentLabel));
        if (shown < rows.length) labels.push(`and ${rows.length - shown} more`);
        return `${withoutMentions(actor.username)} lent you ${labels.join(', ')} on Play! Pokémon Attendance until ${lastDay(earliest)}. You can staff ${it} and upload ${rows.length > 1 ? 'their' : 'its'} results there.`;
      };
      // The channel takes at most 1,800 characters; long names drop off the end, counted, so the send can't fail.
      let shown = rows.length;
      while (shown > 1 && textWith(shown).length > MAX_NOTICE_TEXT) shown -= 1;
      const text = textWith(shown).slice(0, MAX_NOTICE_TEXT);
      const notice = await queue(lessee.userId, text, earliest, `grant:${rows.map((r) => r.id).join(',')}`, actor.username);
      const delivery = notice.state === 'none' ? null : notice.state;
      db.update(tournamentLease)
        .set({ noticeMessageId: notice.messageId, noticeDelivery: delivery })
        .where(
          inArray(
            tournamentLease.id,
            rows.map((r) => r.id),
          ),
        )
        .run();
      return { leases: rows.map((r) => view({ ...r, noticeMessageId: notice.messageId, noticeDelivery: delivery }, actor)) };
    },

    list(_leagueId, actor) {
      const rows = liveRows();
      const held = new Set(connectionsOf(actor.userId).map((c) => c.id));
      const leases = rows.filter((r) => actor.role === 'owner' || held.has(r.connectionId) || r.lesseeUserId === actor.userId).map((r) => view(r, actor));
      const lessees = deps.accounts
        .activeActors()
        .filter((a) => a.userId !== actor.userId && usableMember(a))
        .map((a) => ({ userId: a.userId, username: a.username, name: nameOf(a.userId) }));
      return { leases, lessees };
    },

    end(_leagueId, actor, id) {
      const r = db.select().from(tournamentLease).where(eq(tournamentLease.id, id)).get();
      const holder = r && connections.listActingConnections().find((c) => c.id === r.connectionId)?.userId === actor.userId;
      const isLessee = r?.lesseeUserId === actor.userId;
      if (!r || (!holder && !isLessee)) throw new LeaseError('lease_not_found', 'No such lease.');
      if (r.endedAt !== null || r.endsAt.getTime() <= now().getTime()) return { lease: view(r, actor), endNotice: 'none' };
      const reason: LeaseEndReason = holder ? 'ended' : 'given_back';
      const [ended] = db.transaction(() => store.endWhere(eq(tournamentLease.id, id), reason));
      logEnded(ended!, actor.username);
      const endNotice = notifyOne(ended!, actor.username);
      return { lease: view(db.select().from(tournamentLease).where(eq(tournamentLease.id, id)).get()!, actor), endNotice };
    },

    leasesFor(tournamentIds) {
      const out = new Map<string, CardLease>();
      for (const r of liveRows().filter((x) => tournamentIds.includes(x.tournamentId))) {
        const conn = connections.listActingConnections().find((c) => c.id === r.connectionId);
        out.set(r.tournamentId, {
          id: r.id,
          lesseeUserId: r.lesseeUserId,
          lesseeName: nameOf(r.lesseeUserId) ?? deps.accounts.actor(r.lesseeUserId)?.username ?? '',
          organizerName: conn ? organizerLabel(conn) : 'the organizer',
          endsAt: r.endsAt.toISOString(),
        });
      }
      return out;
    },

    endLeasesForTournament(tournamentId, reason) {
      const ended = db.transaction(() => store.endForTournament(tournamentId, reason));
      for (const e of ended) logEnded(e, null);
      notifyEnded(ended);
    },

    expire() {
      const ended = db.transaction(() => store.recordExpired());
      for (const e of ended) logEnded(e, null);
      notifyEnded(ended);
      return ended.length;
    },

    notifyEnded,

    isLive: (leaseId) => store.isLive(leaseId),
    leasedTournamentIdsOf: (userId) => store.leasedTournamentIdsOf(userId),
    liveLeasesFor: (userId) => store.liveLeasesFor(userId),
  };
}
