<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { ItemOutcome, SubmissionItemView, SubmissionView } from '../../../server/modules/submission/service';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const id = computed(() => Number(route.params.id));

const { data: submission, refresh, error } = await useFetch<SubmissionView>(() => `/api/submissions/${id.value}`);

// While the job runs, follow its progress and reload when it is over.
const liveId = computed(() => (submission.value && isSubmissionActive(submission.value.status) ? submission.value.id : null));
const { latest, result } = useSubmissionEvents(liveId);
watch(result, () => void refresh());

const OUTCOME: Record<ItemOutcome, { label: string; color: 'success' | 'neutral' | 'error' | 'warning' | 'info' }> = {
  added: { label: 'Added', color: 'success' },
  already_present: { label: 'Already there', color: 'neutral' },
  failed: { label: 'Failed', color: 'error' },
  skipped: { label: 'Not sent', color: 'warning' },
  pending: { label: 'Waiting', color: 'info' },
  unrequested: { label: 'Only in play-tools', color: 'info' },
};
const ORIGIN = { session: 'Session player', regular: 'Regular', upstream: 'Added in play-tools' } as const;

const columns: TableColumn<SubmissionItemView>[] = [
  { accessorKey: 'displayName', header: 'Name' },
  { accessorKey: 'playerId', header: 'Player ID' },
  { accessorKey: 'outcome', header: 'Outcome' },
];
// Problems first, then what was added, then the rest.
const RANK: Record<ItemOutcome, number> = { failed: 0, skipped: 1, pending: 2, added: 3, already_present: 4, unrequested: 5 };
const items = computed(() =>
  [...(submission.value?.items ?? [])].sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.displayName.localeCompare(b.displayName)),
);

const retrying = ref(false);
async function retry() {
  retrying.value = true;
  try {
    const started = await $fetch<{ submissionId: number }>(`/api/submissions/${id.value}/retry`, { method: 'POST', body: {} });
    await router.push(`/history/${started.submissionId}`);
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start again.') });
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="space-y-4">
    <UButton to="/history" variant="link" color="neutral" icon="i-lucide-arrow-left" class="px-0">History</UButton>
    <UAlert v-if="error" color="error" variant="subtle" :title="apiErrorMessage(error, 'Could not load this submission.')" />

    <template v-if="submission">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 class="text-2xl font-semibold">{{ submission.date }}</h1>
          <p class="text-muted">{{ submission.playSessionLabel }}</p>
          <p class="text-sm text-muted">
            Started {{ new Date(submission.startedAt).toLocaleString() }} by {{ submission.startedBy }}
            <template v-if="submission.retryOf">
              · retries <NuxtLink :to="`/history/${submission.retryOf}`" class="underline">#{{ submission.retryOf }}</NuxtLink>
            </template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UBadge size="lg" variant="subtle" :color="submissionStatus(submission.status).color">{{ submissionStatus(submission.status).label }}</UBadge>
          <UButton
            v-if="['partial', 'failed', 'interrupted'].includes(submission.status)"
            icon="i-lucide-rotate-cw"
            :loading="retrying"
            @click="retry"
          >
            {{ submission.status === 'interrupted' ? 'Resume' : 'Retry' }}
          </UButton>
        </div>
      </div>

      <div v-if="liveId" class="space-y-2">
        <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
        <p class="text-sm text-muted">{{ latest?.message ?? 'Starting…' }}</p>
      </div>
      <p v-else class="text-sm">{{ submissionSummary(submission.counts) }}</p>
      <UAlert v-if="submission.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="submission.error" />
      <p class="text-xs text-muted">Retrying is always safe: it asks play-tools who is still missing and sends only them.</p>

      <UTable :data="items" :columns="columns">
        <template #displayName-cell="{ row }">
          <div>
            <span :class="{ 'text-muted italic': !row.original.displayName }">{{ row.original.displayName || 'No name' }}</span>
            <p class="text-xs text-muted">{{ ORIGIN[row.original.origin] }}</p>
          </div>
        </template>
        <template #outcome-cell="{ row }">
          <div class="space-y-0.5">
            <UBadge variant="subtle" :color="OUTCOME[row.original.outcome].color">{{ OUTCOME[row.original.outcome].label }}</UBadge>
            <p v-if="row.original.asStaff" class="text-xs text-muted">In play-tools as staff</p>
            <p v-if="row.original.error" class="text-xs text-error">{{ row.original.error }}</p>
          </div>
        </template>
      </UTable>
    </template>
  </div>
</template>
