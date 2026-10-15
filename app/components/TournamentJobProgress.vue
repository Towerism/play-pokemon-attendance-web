<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';

/**
 * A tournament job followed like Submit (architecture §8): progress while it runs, then its status and each
 * tournament's outcome. Emits `finished` once with the job's view.
 */
const props = defineProps<{ submissionId: number }>();
const emit = defineEmits<{ finished: [view: SubmissionView] }>();

const id = ref<number | null>(props.submissionId);
watch(
  () => props.submissionId,
  (next) => (id.value = next),
);
const { latest, result } = useSubmissionEvents(id);

watch(result, (view) => {
  if (view) emit('finished', view);
});
</script>

<template>
  <div class="space-y-3">
    <template v-if="!result">
      <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
      <p class="text-sm text-muted">{{ latest?.message ?? 'Reading play-tools first…' }}</p>
      <p class="text-xs text-muted">Tournaments go to play-tools one at a time, a few seconds apart. You can close this; it keeps going.</p>
    </template>
    <template v-else>
      <UBadge :color="submissionStatus(result.status, result.kind).color" variant="subtle" size="lg">{{ submissionStatus(result.status, result.kind).label }}</UBadge>
      <p v-if="result.error" class="text-sm text-error break-words">{{ result.error }}</p>
      <TournamentItems :items="result.tournamentItems" />
    </template>
    <NuxtLink :to="`/history/${submissionId}`" class="text-sm underline">Details</NuxtLink>
  </div>
</template>
