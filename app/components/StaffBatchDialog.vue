<script setup lang="ts">
import type { TournamentStaffView } from '../../server/modules/staffing/service';
import type { StaffBatchView } from '../../server/modules/submission/staff-batch';

const props = defineProps<{ date: string; tournaments: readonly TournamentStaffView[] }>();
/** The batch ended: every card should read its staff again. */
const emit = defineEmits<{ finished: [] }>();
const toast = useToast();

/** How often the dialog reads the batch while it runs. */
const POLL_MS = 2_000;

const open = ref(false);
const starting = ref(false);
const startError = ref<{ message: string; code?: string } | null>(null);
const batch = ref<StaffBatchView | null>(null);
/** The batch can't be read any more (another league chosen meanwhile). */
const lost = ref(false);

const SETTINGS_CODES = ['not_connected', 'needs_reconnect', 'league_not_selected'];
const targets = computed(() => bulkApplyTargets(props.tournaments));
const shown = computed(() => showsBulkApply(props.tournaments));
const running = computed(() => batch.value?.status === 'running');
const labels = computed(() => new Map(props.tournaments.map((t) => [t.tournamentId, t.label])));
const retryIds = computed(() => (batch.value && !running.value ? retryFailedIds(batch.value.rows) : []));

let timer: ReturnType<typeof setTimeout> | undefined;
const stopPolling = () => {
  if (timer) clearTimeout(timer);
  timer = undefined;
};
onScopeDispose(stopPolling);

/** Reads the batch every POLL_MS while it runs; one failed read just waits for the next. */
function follow(batchId: number) {
  stopPolling();
  lost.value = false;
  const read = async () => {
    try {
      const view = await $fetch<StaffBatchView>(`/api/staff-batches/${batchId}`);
      const wasRunning = batch.value?.id === batchId && batch.value.status === 'running';
      batch.value = view;
      if (view.status !== 'running') {
        if (wasRunning) finished(view);
        return;
      }
    } catch (err) {
      if (apiErrorCode(err) === 'not_found') {
        lost.value = true;
        return;
      }
    }
    timer = setTimeout(read, POLL_MS);
  };
  timer = setTimeout(read, POLL_MS);
}

function finished(view: StaffBatchView) {
  const { label, color } = submissionStatus(view.status, 'staff');
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `Staff for all tournaments: ${label}` });
  emit('finished');
}

/** Starts a batch of `tournamentIds`, then follows it. */
async function start(tournamentIds: readonly string[]) {
  open.value = true;
  startError.value = null;
  starting.value = true;
  try {
    const { batchId } = await $fetch<{ batchId: number }>(`/api/sessions/${props.date}/staff/apply-all`, { method: 'POST', body: { tournamentIds } });
    batch.value = { id: batchId, sessionDate: props.date, status: 'running', startedBy: '', startedAt: new Date(), finishedAt: null, rows: waitingRows(tournamentIds) };
    follow(batchId);
  } catch (err) {
    const code = apiErrorCode(err);
    startError.value = { message: applyStartText(code) ?? apiErrorMessage(err, 'Could not start assigning staff.'), code };
    if (code === 'needs_reconnect' || code === 'not_connected') await refreshPokemonConnection();
  } finally {
    starting.value = false;
  }
}

/** Until the first read, every tournament asked for is waiting. */
function waitingRows(tournamentIds: readonly string[]): StaffBatchView['rows'] {
  return tournamentIds.map((tournamentId, position) => ({
    position,
    tournamentId,
    label: tournamentId,
    organizerName: null,
    status: 'waiting',
    submissionId: null,
    progress: null,
    counts: null,
    refusal: null,
  }));
}

// A batch still running for this date (the page was reloaded or closed): offer it again.
const { data: runningBatch } = useFetch<StaffBatchView | null>(() => `/api/sessions/${props.date}/staff/apply-all`, {
  key: computed(() => `staff-batch-${props.date}`),
  server: false,
  lazy: true,
  retry: false,
});
watch(runningBatch, (view) => {
  if (view && view.status === 'running' && !batch.value) {
    batch.value = view;
    follow(view.id);
  }
});

const rowLabel = (row: StaffBatchView['rows'][number]) => labels.value.get(row.tournamentId) ?? row.label;
</script>

<template>
  <div v-if="shown || batch" class="space-y-2">
    <UButton v-if="running && !open" icon="i-lucide-loader-circle" variant="outline" @click="open = true">Assigning staff for all tournaments… Show</UButton>
    <UButton v-else-if="shown" icon="i-lucide-badge-check" :loading="starting" @click="start(targets)">Assign staff for all tournaments</UButton>

    <UModal v-model:open="open" title="Staff for all tournaments" :description="`Tournaments on ${date}`" :dismissible="!running">
      <template #body>
        <div v-if="starting" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" /> Starting…
        </div>

        <UAlert v-else-if="startError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="startError.message">
          <template v-if="SETTINGS_CODES.includes(startError.code ?? '')" #description>
            <NuxtLink to="/settings" class="underline">Open Settings</NuxtLink>
          </template>
        </UAlert>

        <div v-else-if="batch" class="space-y-3">
          <UAlert v-if="lost" color="warning" variant="subtle" icon="i-lucide-triangle-alert" title="This batch can't be shown any more." />
          <UBadge v-if="!running" :color="submissionStatus(batch.status, 'staff').color" variant="subtle" size="lg" data-testid="staff-batch-status">
            {{ submissionStatus(batch.status, 'staff').label }}
          </UBadge>
          <ul class="space-y-2" aria-label="Tournaments">
            <li v-for="row in batch.rows" :key="row.tournamentId" class="min-w-0 space-y-0.5" data-testid="staff-batch-row">
              <div class="flex flex-wrap items-center gap-2">
                <span class="min-w-0 break-words font-medium">{{ rowLabel(row) }}</span>
                <UBadge :color="batchRowStatus(row.status).color" variant="subtle">{{ batchRowStatus(row.status).label }}</UBadge>
              </div>
              <p v-if="row.organizerName" class="text-xs text-muted">As {{ row.organizerName }}</p>
              <UProgress v-if="row.status === 'running'" :model-value="row.progress ? progressPercent(row.progress.done, row.progress.total) : null" />
              <p v-if="batchRowDetail(row)" class="break-words text-sm text-muted">{{ batchRowDetail(row) }}</p>
              <NuxtLink v-if="row.submissionId" :to="`/history/${row.submissionId}`" class="text-sm underline">Details</NuxtLink>
            </li>
          </ul>
          <p v-if="running" class="text-xs text-muted">
            One tournament at a time, staff at least a second apart. You can close this or leave the page; it keeps going.
          </p>
        </div>
      </template>

      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton v-if="retryIds.length" icon="i-lucide-rotate-ccw" :loading="starting" @click="start(retryIds)">Retry failed</UButton>
          <UButton variant="ghost" color="neutral" @click="open = false">Close</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
