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
const date = ref(addDays(props.today, 56));
const preview = ref<CreateThroughPreview | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const submissionId = ref<number | null>(null);
const finished = ref(false);
const view = computed(() => (preview.value ? createThroughView(preview.value) : null));

watch(open, (o) => {
  if (!o) emit('close');
});
watch(date, () => (preview.value = null));

async function showPreview() {
  busy.value = true;
  error.value = null;
  try {
    preview.value = await $fetch<CreateThroughPreview>(`/api/tournament-schedules/${props.schedule.id}/create-through`, { query: { date: date.value } });
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not preview the tournaments.');
  } finally {
    busy.value = false;
  }
}

async function create() {
  if (!preview.value || !view.value?.confirmLabel) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ submissionId: number }>(`/api/tournament-schedules/${props.schedule.id}/create-through`, {
      method: 'POST',
      body: { date: date.value, acknowledgeShortNotice: view.value.shortNotice > 0 },
    });
    submissionId.value = res.submissionId;
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not start creating.');
  } finally {
    busy.value = false;
  }
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
      <TournamentJobProgress v-if="submissionId" :submission-id="submissionId" @finished="done" />
      <div v-else class="space-y-3 text-sm">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="showPreview">
          <UFormField label="Create through"><UInput v-model="date" type="date" :max="addDays(today, 365)" /></UFormField>
          <UButton type="submit" variant="outline" :loading="busy && !preview">Preview</UButton>
        </form>
        <template v-if="preview && view">
          <UAlert v-if="view.disabledReason" color="warning" variant="subtle" icon="i-lucide-circle-alert" :title="view.disabledReason">
            <template v-if="view.suggestedThrough" #actions>
              <UButton size="xs" variant="outline" @click="(date = view.suggestedThrough!), showPreview()">Use {{ dayLabel(view.suggestedThrough) }}</UButton>
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
