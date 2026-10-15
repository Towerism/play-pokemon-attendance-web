<script setup lang="ts">
import type { SessionStaff } from '../../server/modules/staffing/service';
import type { Upcoming } from '../../server/modules/tournaments/service';
import { type StaffRole, staffSectionView } from '~/utils/staff';

/**
 * This week's **Tournaments** (ADR-0010 decision 10, #99): a card per play-tools tournament of the league on the date
 * (status, Staff, Results), then the planned ones not in play-tools yet. Formerly the Staff section (M8).
 */
const props = defineProps<{ date: string }>();
/** An upload job ended: the date's attendance may have been imported. */
const emit = defineEmits<{ uploaded: [] }>();
const toast = useToast();

// The date the last answered read was for, taken from the request itself so
// another date's tournaments never show under the selected one (#81).
let answeredDate: string | null = null;

// Read live from play-tools, so only in the browser and never holding up the
// rest of This week (session, regulars, Submit) while it loads or fails.
const {
  data: staff,
  error,
  status,
  refresh,
} = useFetch<SessionStaff>(() => `/api/sessions/${props.date}/staff`, {
  key: computed(() => `staff-${props.date}`),
  server: false,
  lazy: true,
  // Each read goes to play-tools; a failure is shown with Try again, never resent on its own.
  retry: false,
  onResponse: ({ request }) => {
    answeredDate = sessionDateOf(request);
  },
  onRequestError: ({ request }) => {
    answeredDate = sessionDateOf(request);
  },
});

const resultDate = ref<string | null>(null);
watch(status, (s) => {
  if (s === 'success' || s === 'error') resultDate.value = answeredDate;
});
const view = computed(() => staffSectionView({ selectedDate: props.date, resultDate: resultDate.value, failed: !!error.value }));

function sessionDateOf(request: RequestInfo): string | null {
  const url = typeof request === 'string' ? request : request.url;
  return /\/api\/sessions\/([^/]+)\/staff$/.exec(new URL(url, 'http://x').pathname)?.[1] ?? null;
}
// Status and planned rows: the date's Upcoming read, from the server's 5-minute listing cache (#98). Its own key, so
// the Tournaments page's Upcoming isn't replaced; a failure hides only the statuses.
const {
  data: upcomingDay,
  error: upcomingError,
  status: upcomingStatus,
  refresh: refreshUpcomingDay,
} = useFetch<Upcoming>('/api/tournaments/upcoming', {
  key: computed(() => `upcoming-day-${props.date}`),
  query: computed(() => upcomingQuery({ range: { from: props.date, to: props.date } })),
  server: false,
  lazy: true,
  retry: false,
});
const cards = computed(() => (staff.value ? tournamentCards(staff.value, upcomingError.value ? null : (upcomingDay.value ?? null)) : { cards: [], planned: [] }));
const timeZone = computed(() => staff.value?.timeZone ?? upcomingDay.value?.timeZone ?? null);
const today = computed(() => (timeZone.value ? todayIn(timeZone.value, new Date()) : null));

const creating = ref<{ plannedIds: number[]; retry: boolean } | null>(null);
const editing = ref<string | null>(null);

/** After Create… or Edit…: a created tournament becomes a tournament card, a moved one leaves the date. */
async function tournamentsChanged() {
  const results = cards.value.cards.map((c) => `results-${props.date}-${c.tournament.tournamentId}`);
  await Promise.all([refresh(), refreshUpcomingDay(), refreshNuxtData(results)]);
}

const { data: roleList, error: rolesError } = useFetch<{ roles: StaffRole[] }>('/api/staff/roles', { key: 'staff-roles', server: false, lazy: true });
const roles = computed(() => roleList.value?.roles);

const SETTINGS_CODES = ['not_connected', 'needs_reconnect', 'league_not_selected'];
const errorCode = computed(() => apiErrorCode(error.value));

watch(errorCode, async (code) => {
  // The banner and Settings share the connection status; let them see what this read just learned.
  if (code === 'needs_reconnect' || code === 'not_connected') await refreshPokemonConnection();
});
// A professor whose login needs a reconnect: let the banner and Settings see it too (#75).
watch(
  () => staff.value?.unread.some((u) => u.code === 'needs_reconnect'),
  async (any) => {
    if (any) await refreshPokemonConnection();
  },
);
async function uploaded() {
  emit('uploaded');
  await refreshUpcomingDay();
}

watch(rolesError, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the staff roles. Roles show as play-tools codes.' });
});
</script>

<template>
  <section aria-labelledby="tournaments-heading" class="space-y-3">
    <h2 id="tournaments-heading" class="text-lg font-medium">Tournaments</h2>

    <div v-if="view === 'loading'" role="status" class="flex items-center gap-2 text-sm text-muted">
      <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Reading the tournaments from play-tools…
    </div>

    <UAlert
      v-else-if="view === 'error'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="apiErrorMessage(error, 'Could not read the tournaments from play-tools.')"
    >
      <template #description>
        <NuxtLink v-if="SETTINGS_CODES.includes(errorCode ?? '')" to="/settings" class="underline">Open Settings</NuxtLink>
      </template>
      <template v-if="!SETTINGS_CODES.includes(errorCode ?? '')" #actions>
        <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :loading="status === 'pending'" @click="refresh()">
          Try again
        </UButton>
      </template>
    </UAlert>

    <template v-else-if="staff">
      <UAlert
        v-for="u in staff.unread"
        :key="u.professor.playerId ?? 'unidentified'"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="unreadWarning(u).text"
      >
        <template v-if="unreadWarning(u).settings" #description>
          <NuxtLink to="/settings" class="underline">Open Settings</NuxtLink>
        </template>
        <template v-if="unreadWarning(u).retry" #actions>
          <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :loading="status === 'pending'" @click="refresh()">
            Try again
          </UButton>
        </template>
      </UAlert>
      <p v-if="upcomingError" class="flex flex-wrap items-center gap-2 text-sm text-muted">
        Couldn’t read the tournaments’ status.
        <UButton size="sm" variant="outline" color="neutral" icon="i-lucide-refresh-cw" :loading="upcomingStatus === 'pending'" @click="refreshUpcomingDay()">
          Try again
        </UButton>
      </p>
      <p v-if="!staff.tournaments.length && !cards.planned.length && !staff.unread.length" class="text-sm text-muted">
        No tournament in this league on {{ date }} in play-tools.
      </p>
      <StaffBatchDialog :date="date" :tournaments="staff.tournaments" @finished="refresh()" />
      <TournamentCard
        v-for="pair in cards.cards"
        :key="pair.tournament.tournamentId"
        :date="date"
        :pair="pair"
        :roles="roles"
        @changed="refresh()"
        @edit="(id) => (editing = id)"
        @uploaded="uploaded"
      />
      <PlannedTournamentCard
        v-for="entry in cards.planned"
        :key="`planned-${entry.plannedId}`"
        :entry="entry"
        :today="today ?? date"
        @create="(retry) => (creating = { plannedIds: [entry.plannedId!], retry })"
        @edit="(id) => (editing = id)"
      />
      <p class="text-xs text-muted">Times are in {{ staff.timeZone }}.</p>
    </template>

    <CreateTournamentsDialog
      v-if="creating && today"
      :planned-ids="creating.plannedIds"
      :retry="creating.retry"
      :today="today"
      :range="{ from: date, to: date }"
      @close="(creating = null), tournamentsChanged()"
    />
    <EditTournamentDialog v-if="editing && timeZone" :id="editing" :time-zone="timeZone" @close="(editing = null), tournamentsChanged()" />
  </section>
</template>
