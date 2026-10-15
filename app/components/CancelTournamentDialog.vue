<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';
import type { CancelPreview } from '../../server/modules/tournaments/cancelling';

/**
 * **Cancel…** (ADR-0010 decision 8, #94): read fresh from play-tools, then confirmed; with anyone registered, the
 * organizer types the display id first, as Clear session asks for the date.
 */
const props = defineProps<{ id: string }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();

const open = ref(true);
const preview = ref<CancelPreview | null>(null);
const loadError = ref<string | null>(null);
const typed = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const submissionId = ref<number | null>(null);
const finished = ref(false);

const confirmed = computed(() => !!preview.value && cancelConfirmed(typed.value, preview.value.confirmRequired ? preview.value.confirmWith : null));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

watch(open, (o) => {
  if (!o) emit('close');
});

onMounted(async () => {
  try {
    preview.value = await $fetch<CancelPreview>(`/api/tournaments/${props.id}/cancel`);
  } catch (err) {
    loadError.value = apiErrorMessage(err, 'Could not read the tournament from play-tools.');
  }
});

async function cancel() {
  if (!confirmed.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await $fetch<{ submissionId: number | null }>(`/api/tournaments/${props.id}/cancel`, {
      method: 'POST',
      body: preview.value!.confirmRequired ? { confirmation: typed.value.trim() } : {},
    });
    if (res.submissionId !== null) submissionId.value = res.submissionId;
    else {
      toast.add({ color: 'neutral', title: 'Already cancelled in play-tools' });
      await Promise.all([refreshUpcoming(), refreshRequiredEvents()]);
      open.value = false;
    }
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not cancel the tournament.');
  } finally {
    busy.value = false;
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
  <UModal v-model:open="open" title="Cancel tournament" :dismissible="!submissionId || finished">
    <template #body>
      <TournamentJobProgress v-if="submissionId" :submission-id="submissionId" @finished="done" />
      <UAlert v-else-if="loadError" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="loadError" />
      <p v-else-if="!preview" class="text-sm text-muted">Reading the tournament from play-tools…</p>
      <div v-else class="space-y-3 text-sm">
        <p class="font-medium break-words">
          {{ preview.name ?? 'Tournament' }} · {{ preview.localDate ? dayLabel(preview.localDate) : 'no date' }}<template v-if="preview.startTime"> · {{ preview.startTime }}</template> ·
          {{ preview.target.displayId ?? preview.target.tournamentId }}
        </p>
        <p>{{ plural(preview.players, 'player') }} and {{ plural(preview.staff, 'staff member') }} listed. Status in play-tools: {{ preview.upstreamStatus ?? '—' }}.</p>
        <UAlert
          v-if="!preview.cancellable"
          color="warning"
          variant="subtle"
          icon="i-lucide-lock"
          :title="preview.reason === 'already_cancelled' ? 'Already cancelled' : 'play-tools no longer lets it be changed'"
        />
        <template v-else>
          <UAlert color="error" variant="subtle" icon="i-lucide-triangle-alert" title="Cancelling can't be undone from the app." />
          <UFormField v-if="preview.confirmRequired" :label="`Type ${preview.confirmWith} to confirm`">
            <UInput v-model="typed" :placeholder="preview.confirmWith ?? ''" autocomplete="off" class="w-full" @keydown.enter.prevent="cancel" />
          </UFormField>
        </template>
        <p v-if="error" class="text-error">{{ error }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">{{ submissionId ? 'Close' : 'Keep it' }}</UButton>
        <UButton v-if="!submissionId && preview?.cancellable" color="error" :disabled="!confirmed" :loading="busy" @click="cancel">Cancel tournament</UButton>
      </div>
    </template>
  </UModal>
</template>
