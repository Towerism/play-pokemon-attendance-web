import type { Scaffold, Schedule, Template } from '../../server/modules/tournaments/service';

// The Tournaments page's own reads (#191). The page starts every one of them on entry, and each tab joins the read
// already under way (`dedupe: 'defer'`) instead of starting another, so a tab shows what was read while it was hidden.

/** The league's time zone and today's date there, from settings: never play-tools, never the browser's own zone. */
export function useLeagueClock() {
  return useSettings();
}

/** The Templates tab's list; Show archived is shared state so every user of the key asks for the same list. */
export function useTournamentTemplates() {
  const showArchived = useState('tournament-templates-archived', () => false);
  const read = useFetch<{ templates: Template[] }>('/api/tournament-templates', {
    key: 'tournament-templates',
    query: computed(() => (showArchived.value ? { archived: '1' } : {})),
    dedupe: 'defer',
  });
  return { ...read, showArchived };
}

/** Every template, archived too: the Schedules tab names a scaffold's slots by them. */
export function useAllTournamentTemplates() {
  return useFetch<{ templates: Template[] }>('/api/tournament-templates', { key: 'tournament-templates-all', query: { archived: '1' }, dedupe: 'defer' });
}

export function useTournamentScaffolds() {
  return useFetch<{ scaffolds: Scaffold[] }>('/api/tournament-scaffolds', { key: 'tournament-scaffolds', dedupe: 'defer' });
}

export function useTournamentSchedules() {
  return useFetch<{ schedules: Schedule[] }>('/api/tournament-schedules', { key: 'tournament-schedules', dedupe: 'defer' });
}
