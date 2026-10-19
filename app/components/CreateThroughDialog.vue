<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';
import type { CreateThroughPreview, Schedule } from '../../server/modules/tournaments/service';

/**
 * **Create through date…** (ADR-0010 decision 5): lists exactly what the schedule would create up to the date, read
 * live from play-tools, and creates nothing past it. At most 60 at a time; short notice is confirmed.
 */
const props = defineProps<{ schedule: Schedule; today: string }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

const open = ref(true);
/** Eight weeks ahead: a weekly schedule's default horizon (ADR-0010 decision 3). */
const date = ref(addDays(props.today, 56));
const preview = ref<CreateThroughPreview | null>(null);
/** The date the shown preview is for: the confirm sends this one, never a date typed since. */
const previewedDate = ref<string | null>(null);
let previewSeq = 0;
const busy = ref(false);
/** Rows another user's connection organizes: left out of the job, named (ADR-0015 §4). */
const { data: connections } = usePokemonConnection();
const leftOutByOwner = ref<string | null>(null);
const error = ref<string | null>(null);
const submissionId = ref<number | null>(null);
const finished = ref(false);
const view = computed(() => (preview.value ? createThroughView(preview.value) : null));

watch(open, (o) => {
  if (!o) emit('close');
});
watch(date, () => {
  previewSeq++;
  preview.value = null;
  previewedDate.value = null;
});

async function showPreview() {
  const seq = ++previewSeq;
  const asked = date.value;
  busy.value = true;
  error.value = null;
  try {
    const res = await $fetch<CreateThroughPreview>(`/api/tournament-schedules/${props.schedule.id}/create-through`, { query: { date: asked } });
    // A date changed while the live read ran makes this answer stale: it is dropped, never shown.
    if (seq !== previewSeq) return;
    preview.value = res;
    previewedDate.value = asked;
  } catch (err) {
    if (seq === previewSeq) error.value = apiErrorMessage(err, 'Could not preview the tournaments.');
  } finally {
    if (seq === previewSeq) busy.value = false;
  }
}

async function create() {
  if (!preview.value || !previewedDate.value || !view.value?.confirmLabel) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ submissionId: number; refused?: { plannedTournamentId: number; professorPlayerId: string }[] }>(`/api/tournament-schedules/${props.schedule.id}/create-through`, {
      method: 'POST',
      body: { date: previewedDate.value, acknowledgeShortNotice: view.value.shortNotice > 0 },
    });
    submissionId.value = res.submissionId;
    const labelOf = (plannedId: number) => {
      const e = preview.value?.tournaments.find((x) => x.plannedId === plannedId);
      return e ? `${e.name} · ${e.localDate}` : `planned tournament ${plannedId}`;
    };
    leftOutByOwner.value = refusedText(connections.value, res.refused ?? [], labelOf);
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not start creating.');
  } finally {
    busy.value = false;
  }
}

async function useSuggested(through: string) {
  date.value = through;
  // Let the date's watcher clear the old preview before reading the new one.
  await nextTick();
  await showPreview();
}

async function done(job: SubmissionView) {
  finished.value = true;
  const { label, color } = submissionStatus(job.status, job.kind);
  toast.add({ color: color === 'info' ? 'neutral' : color, title: `${job.playSessionLabel}: ${label}` });
  await Promise.all([refreshUpcoming().catch(() => undefined), refreshRequiredEvents(), refreshNuxtData('tournament-schedules')]);
}
</script>

<template>
  <UModal v-model:open="open" title="Create through date" :description="`${schedule.scaffoldName} · ${ruleText(schedule.rule)}`" :dismissible="!submissionId || finished">
    <template #body>
      <template v-if="submissionId">
        <p v-if="leftOutByOwner" class="mb-2 text-sm text-warning" data-testid="left-out">{{ leftOutByOwner }}</p>
        <TournamentJobProgress :submission-id="submissionId" @finished="done" />
      </template>
      <div v-else class="space-y-3 text-sm">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="showPreview">
          <UFormField label="Create through"><UInput v-model="date" type="date" :max="addDays(today, 365)" /></UFormField>
          <UButton type="submit" variant="outline" :loading="busy && !preview">Preview</UButton>
        </form>
        <template v-if="preview && view">
          <UAlert v-if="view.disabledReason" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="view.disabledReason">
            <template v-if="view.suggestedThrough" #actions>
              <UButton size="xs" variant="outline" @click="useSuggested(view.suggestedThrough!)">Use {{ dayLabel(view.suggestedThrough) }}</UButton>
            </template>
          </UAlert>
          <ul v-if="preview.tournaments.length" aria-label="Tournaments to create" class="space-y-1">
            <li v-for="t in preview.tournaments" :key="t.plannedId!" class="flex flex-wrap items-center gap-1">
              <span class="break-words">{{ t.name }} · {{ dayLabel(t.localDate) }} · {{ t.startTime }}</span>
              <UBadge v-if="t.shortNotice" variant="outline" color="warning">Short notice</UBadge>
            </li>
          </ul>
          <UAlert
            v-if="view.shortNotice"
            color="warning"
            variant="subtle"
            icon="i-lucide-clock"
            title="Short notice"
            description="less than 7 days before it is held; the league is expected to sanction 7 days ahead."
          />
          <div v-if="preview.leftOut.length">
            <h3 class="font-medium">Left out</h3>
            <ul aria-label="Left out" class="list-disc pl-5 text-muted">
              <li v-for="l in preview.leftOut" :key="`${l.entry.plannedId}-${l.entry.tournamentId}`">{{ l.entry.name }} · {{ dayLabel(l.entry.localDate) }}: {{ leftOutText(l.reason) }}</li>
            </ul>
          </div>
          <UAlert v-for="u in preview.unread" :key="u.professor.playerId ?? u.message" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="u.message" />
        </template>
        <p v-if="error" class="text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Cancel' }}</UButton>
        <UButton
          v-if="!submissionId && view?.confirmLabel"
          :color="view.shortNotice ? 'warning' : 'primary'"
          icon="i-lucide-send"
          :loading="busy"
          @click="create"
        >
          {{ view.confirmLabel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
