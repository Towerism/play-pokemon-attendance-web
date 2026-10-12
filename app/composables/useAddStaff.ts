import type { StaffAssignmentView } from '../../server/modules/staffing/service';
import type { StaffRole } from '~/utils/staff';

/** Refusals after which the card is stale: read the date's staff again. */
const REFETCH = ['already_listed', 'tournament_locked', 'unknown_tournament'];

/**
 * Wants a staffer on one of the date's tournaments (`POST /sessions/{date}/staff`).
 * Toasts every outcome but a plain add; true when they're on the card now.
 * `onStale` runs when the card no longer matches play-tools.
 */
export function useAddStaff(date: MaybeRefOrGetter<string>, roles: MaybeRefOrGetter<readonly StaffRole[] | undefined>, onStale: () => void) {
  const toast = useToast();

  return async function addStaff(body: { tournamentId: string; playerId: string; role: string; name?: string }, shownName: string): Promise<boolean> {
    try {
      const res = await $fetch.raw<{ assignment: StaffAssignmentView }>(`/api/sessions/${toValue(date)}/staff`, { method: 'POST', body });
      if (res.status === 200 && res._data) {
        toast.add({ title: alreadyStaffingText({ ...res._data.assignment, name: shownName || res._data.assignment.name }, toValue(roles)) });
      }
      return true;
    } catch (err) {
      const code = apiErrorCode(err);
      const title =
        code === 'already_listed'
          ? alreadyListedText({ name: shownName, playerId: body.playerId }, apiErrorHow(err))
          : apiErrorMessage(err, 'Could not add the staffer.');
      toast.add({ color: 'error', title });
      if (REFETCH.includes(code ?? '')) onStale();
      return false;
    }
  };
}
