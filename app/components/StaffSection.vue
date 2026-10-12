<script setup lang="ts">
import type { SessionStaff } from '../../server/modules/staffing/service';
import { type StaffRole, staffSectionView } from '~/utils/staff';

const props = defineProps<{ date: string }>();
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
watch(rolesError, (err) => {
  if (err) toast.add({ color: 'error', title: 'Could not load the staff roles. Roles show as play-tools codes.' });
});
</script>

<template>
  <section aria-labelledby="staff-heading" class="space-y-3">
    <h2 id="staff-heading" class="text-lg font-medium">Staff</h2>

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
      <p v-if="!staff.tournaments.length && !staff.unread.length" class="text-sm text-muted">No tournament in this league on {{ date }} in play-tools.</p>
      <StaffBatchDialog :date="date" :tournaments="staff.tournaments" @finished="refresh()" />
      <StaffCard v-for="tournament in staff.tournaments" :key="tournament.tournamentId" :date="date" :tournament="tournament" :roles="roles" @changed="refresh()" />
      <p class="text-xs text-muted">Times are in {{ staff.timeZone }}.</p>
    </template>
  </section>
</template>
