<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';
import type { UpcomingEntry } from '../../server/modules/tournaments/service';

/**
 * **Create in play-tools** (ADR-0010 decisions 5 and 6): lists what it creates, flags short notice (confirmed with
 * **Create anyway**), then follows the job. In `retry` mode, for a create that may have landed, it first reads
 * play-tools fresh and shows the organizer's tournaments that day, so a duplicate is a deliberate choice.
 */
const props = defineProps<{ plannedIds: number[]; today: string; retry?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

const open = ref(true);
const entries = ref<UpcomingEntry[]>([]);
const sameDay = ref<UpcomingEntry[]>([]);
const sentAt = ref<string | null>(null);
/** Why the confirm is held back: an id the read doesn't list, or a retry the fresh read can't vouch for. */
const blocked = ref<string | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const error = ref<string | null>(null);
const starting = ref(false);
/** Ids the server says are short notice after a day rolled over (422 short_notice_not_acknowledged). */
const serverShortNotice = ref<number[]>([]);
const submissionId = ref<number | null>(null);
const finished = ref(false);

const shortNotice = computed(() => entries.value.filter((e) => isShortNotice(e.localDate, props.today) || serverShortNotice.value.includes(e.plannedId!)));
const confirmLabel = computed(() =>
  props.retry ? (shortNotice.value.length ? 'Retry create anyway' : 'Retry create') : shortNotice.value.length ? 'Create anyway' : 'Create in play-tools',
);

watch(open, (o) => {
  if (!o) emit('close');
});

onMounted(async () => {
  try {
    // A retry reads play-tools fresh (not the 5-minute cache): its list decides whether a duplicate is risked.
    const upcoming = await refreshUpcoming({ upstream: !!props.retry });
    entries.value = props.plannedIds.map((id) => upcoming.tournaments.find((e) => e.plannedId === id)).filter((e): e is UpcomingEntry => !!e);
    // Only what is listed here is sent: a tournament the read no longer shows is left for another look.
    if (entries.value.length < props.plannedIds.length) blocked.value = 'Some of these tournaments changed meanwhile. Close this and look at Upcoming again.';
    if (props.retry && entries.value[0]) {
      const ctx = retryContext(entries.value[0], upcoming.tournaments, upcoming.unread);
      sameDay.value = ctx.sameDay;
      sentAt.value = ctx.sentAt;
      blocked.value = ctx.blocked ?? blocked.value;
    }
  } catch (err) {
    loadError.value = apiErrorMessage(err, 'Could not read play-tools.');
  } finally {
    loading.value = false;
  }
});

async function start() {
  starting.value = true;
  error.value = null;
  try {
    const started = await $fetch<{ submissionId: number }>('/api/tournaments/create', {
      method: 'POST',
      body: { plannedIds: entries.value.map((e) => e.plannedId!), acknowledgeShortNotice: shortNotice.value.length > 0, retryUnknown: !!props.retry },
    });
    submissionId.value = started.submissionId;
  } catch (err) {
    if (apiErrorCode(err) === 'short_notice_not_acknowledged') {
      const ids = (err as { data?: { data?: { plannedTournamentIds?: number[] } } }).data?.data?.plannedTournamentIds ?? [];
      serverShortNotice.value = ids.length ? ids : props.plannedIds;
    } else error.value = apiErrorMessage(err, 'Could not start creating.');
  } finally {
    starting.value = false;
  }
}

async function done(view: SubmissionView) {
  finished.value = true;
  const { label, color } = submissionStatus(view.status, view.kind);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `${view.playSessionLabel}: ${label}` });
  await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
}
</script>

<template>
  <UModal v-model:open="open" title="Create in play-tools" :dismissible="!submissionId || finished">
    <template #body>
      <TournamentJobProgress v-if="submissionId" :submission-id="submissionId" @finished="done" />
      <div v-else-if="loading" class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-loader-circle" class="animate-spin" /> {{ retry ? 'Checking play-tools…' : 'Reading the tournaments…' }}
      </div>
      <UAlert v-else-if="loadError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="loadError" />
      <div v-else class="space-y-3">
        <template v-if="retry">
          <UAlert color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="This may make a duplicate">
            <template #description>
              An earlier create was sent at {{ sentAt ? new Date(sentAt).toLocaleString() : 'an unknown time' }} and may still land in play-tools. Retrying can make a
              duplicate.
            </template>
          </UAlert>
          <div class="text-sm space-y-1">
            <p class="font-medium">The organizer's tournaments in play-tools that day</p>
            <ul v-if="sameDay.length" class="list-disc pl-5">
              <li v-for="t in sameDay" :key="t.tournamentId!">{{ t.name }} · {{ t.startTime }} · {{ t.displayId }}</li>
            </ul>
            <p v-else class="text-muted">None listed.</p>
          </div>
        </template>
        <ul class="space-y-1 text-sm" aria-label="Tournaments to create">
          <li v-for="e in entries" :key="e.plannedId!" class="flex flex-wrap items-center gap-1">
            <span class="break-words">{{ e.name }} · {{ dayLabel(e.localDate) }} · {{ e.startTime }} · {{ professorName(e.organizer) }}</span>
            <UBadge v-if="shortNotice.includes(e)" variant="outline" color="warning">Short notice</UBadge>
          </li>
        </ul>
        <UAlert
          v-if="shortNotice.length"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock"
          title="Short notice"
          description="less than 7 days before it is held; the league is expected to sanction 7 days ahead."
        />
        <p class="text-xs text-muted">Each is created as its organizer, one at a time. A tournament already in play-tools is linked, not created again.</p>
        <UAlert v-if="blocked" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="blocked" />
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Cancel' }}</UButton>
        <UButton
          v-if="!submissionId"
          icon="i-lucide-send"
          :color="retry ? 'warning' : 'primary'"
          :disabled="loading || !!loadError || !!blocked || entries.length === 0"
          :loading="starting"
          @click="start"
        >
          {{ confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
