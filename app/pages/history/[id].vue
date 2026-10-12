<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { ItemOutcome, SubmissionItemView, SubmissionView } from '../../../server/modules/submission/service';
import type { StaffRole } from '~/utils/staff';

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
  removed: { label: 'Removed', color: 'success' },
  already_removed: { label: 'Already gone', color: 'neutral' },
  // A staff job's outcomes (ADR-0007).
  assigned: { label: 'Assigned', color: 'success' },
  already_assigned: { label: 'Already assigned', color: 'neutral' },
  already_listed: { label: 'Already listed', color: 'neutral' },
  is_organizer: { label: 'Organizer', color: 'neutral' },
  role_changed: { label: 'Role changed', color: 'success' },
  ineligible: { label: 'Not eligible', color: 'error' },
};
// A staff job's items carry a role, shown by its play-tools label.
const { data: staffRoles, execute: loadStaffRoles } = useFetch<{ roles: StaffRole[] }>('/api/staff/roles', {
  key: 'staff-roles',
  server: false,
  immediate: false,
});
watch(
  () => submission.value?.kind,
  (kind) => {
    if (kind === 'staff' && !staffRoles.value) void loadStaffRoles();
  },
  { immediate: true },
);
const ORIGIN = { session: 'Session player', regular: 'Regular', upstream: 'Added in play-tools' } as const;

// On a phone, Player ID moves under the name so Outcome stays on screen.
const columns: TableColumn<SubmissionItemView>[] = [
  { accessorKey: 'displayName', header: 'Name', meta: { class: { td: WRAP } } },
  { accessorKey: 'playerId', header: 'Player ID', meta: { class: { th: WIDE_ONLY, td: WIDE_ONLY } } },
  { accessorKey: 'outcome', header: 'Outcome', meta: { class: { td: WRAP } } },
];
// Problems first, then what was added, then the rest.
const RANK: Record<ItemOutcome, number> = {
  failed: 0,
  ineligible: 0,
  skipped: 1,
  pending: 2,
  added: 3,
  removed: 3,
  assigned: 3,
  role_changed: 3,
  already_present: 4,
  already_removed: 4,
  already_assigned: 4,
  already_listed: 4,
  is_organizer: 4,
  unrequested: 5,
};
const items = computed(() =>
  [...(submission.value?.items ?? [])].sort((a, b) => RANK[a.outcome] - RANK[b.outcome] || a.displayName.localeCompare(b.displayName)),
);

// Undo: remove the players this submission added (after a confirm).
const undoOpen = ref(false);
const undoing = ref(false);
const candidates = computed(() => undoCandidates(submission.value?.items ?? []));
const blocked = computed(() => (submission.value ? undoBlockedText(submission.value) : null));
async function undo() {
  undoing.value = true;
  try {
    const started = await $fetch<{ submissionId: number }>(`/api/submissions/${id.value}/undo`, { method: 'POST' });
    undoOpen.value = false;
    await router.push(`/history/${started.submissionId}`);
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start the undo.') });
  } finally {
    undoing.value = false;
  }
}

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
            <template v-if="submission.undoOf">
              · undoes <NuxtLink :to="`/history/${submission.undoOf}`" class="underline">#{{ submission.undoOf }}</NuxtLink>
            </template>
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UBadge size="lg" variant="subtle" :color="submissionStatus(submission.status, submission.kind).color">
            {{ submissionStatus(submission.status, submission.kind).label }}
          </UBadge>
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
      <p v-else-if="submission.kind === 'submit'" class="text-sm">{{ submissionSummary(submission.counts) }}</p>
      <UAlert v-if="submission.error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="submission.error" />
      <p v-if="submission.kind === 'submit'" class="text-xs text-muted">Retrying is always safe: it asks play-tools who is still missing and sends only them.</p>

      <div v-if="!liveId" class="flex flex-wrap items-center gap-2">
        <UButton v-if="submission.undoable" color="error" variant="soft" icon="i-lucide-undo-2" @click="undoOpen = true">
          Remove players added by this submission
        </UButton>
        <p v-else-if="blocked" class="text-sm text-muted">{{ blocked }}</p>
      </div>

      <UModal v-model:open="undoOpen" title="Remove players added by this submission" :description="undoConfirmText(candidates.names.length)">
        <template #body>
          <ul class="list-disc space-y-0.5 pl-5 text-sm">
            <li v-for="name in candidates.names" :key="name">{{ name }}</li>
          </ul>
          <p v-if="candidates.withoutRecord" class="mt-2 text-xs text-muted">
            {{ candidates.withoutRecord }} more can't be removed automatically; remove them in play-tools.
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" color="neutral" @click="undoOpen = false">Cancel</UButton>
            <UButton color="error" icon="i-lucide-undo-2" :loading="undoing" @click="undo">Remove</UButton>
          </div>
        </template>
      </UModal>

      <UTable :data="items" :columns="columns">
        <template #displayName-cell="{ row }">
          <div>
            <span :class="{ 'text-muted italic': !row.original.displayName }">{{ row.original.displayName || 'No name' }}</span>
            <p v-if="row.original.role" class="text-xs text-muted">{{ roleLabel(row.original.role, staffRoles?.roles) }}</p>
            <p v-else class="text-xs text-muted">{{ ORIGIN[row.original.origin] }}</p>
            <p class="text-xs text-muted tabular-nums sm:hidden">{{ row.original.playerId }}</p>
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
