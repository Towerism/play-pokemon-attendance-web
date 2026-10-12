<script setup lang="ts">
import type { SubmissionView } from '../../server/modules/submission/service';

// Import staff from play-tools (ADR-0007 decision 5): a read-only job that
// seeds the staff list from every tournament the account organizes.
const toast = useToast();
const { data: connection } = await usePokemonConnection();
const { data: history } = await useFetch('/api/submissions', { key: 'submissions-all' });

/** The import this card follows: the one just started, else the latest (EC: leaving and coming back). */
const startedId = ref<number | null>(null);
const shownId = computed(() => startedId.value ?? history.value?.submissions.find((s) => s.kind === 'staff_import')?.id ?? null);
const { data: shown, refresh } = await useFetch<SubmissionView>(() => `/api/submissions/${shownId.value}`, {
  immediate: shownId.value !== null,
  watch: false,
});
watch(shownId, (id) => id !== null && void refresh());

const liveId = computed(() => (shown.value && isSubmissionActive(shown.value.status) ? shown.value.id : null));
const { latest, result } = useSubmissionEvents(liveId);
watch(result, (view) => {
  if (view) shown.value = view;
});

const blocked = computed(() => staffImportBlocked(leagueConnection(connection.value)));
const starting = ref(false);
async function start() {
  starting.value = true;
  try {
    const { submissionId } = await $fetch<{ submissionId: number }>('/api/staff/import', { method: 'POST' });
    startedId.value = submissionId;
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start the import.') });
  } finally {
    starting.value = false;
  }
}

const progress = computed(() => {
  if (!latest.value) return 'Starting…';
  return latest.value.total > 0 ? `Read ${latest.value.done} of ${latest.value.total} tournaments` : latest.value.message;
});
</script>

<template>
  <UCard as="section" aria-labelledby="staff-list-heading">
    <template #header>
      <h2 id="staff-list-heading" class="font-semibold">Staff list</h2>
      <p class="text-sm text-muted">
        Reads every tournament your Pokémon account organizes, in any league, and adds the staff it finds to the staff list. It only reads
        from play-tools, and running it again is harmless.
      </p>
    </template>

    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <UButton icon="i-lucide-download" :loading="starting || liveId !== null" :disabled="blocked !== null || liveId !== null" @click="start">
          Import staff from play-tools
        </UButton>
        <p v-if="blocked" class="text-sm text-muted">{{ blocked }}</p>
      </div>

      <div aria-live="polite" class="space-y-2">
        <template v-if="liveId !== null">
          <UProgress :model-value="latest ? progressPercent(latest.done, latest.total) : null" />
          <p class="text-sm text-muted">{{ progress }}</p>
        </template>
        <template v-else-if="shown?.staffImport">
          <p class="text-sm">
            <UBadge variant="subtle" :color="submissionStatus(shown.status, shown.kind).color" class="mr-2">
              {{ submissionStatus(shown.status, shown.kind).label }}
            </UBadge>
            {{ staffImportSummary(shown.staffImport) }}
          </p>
          <p v-if="shown.error" class="text-sm text-error">{{ staffImportErrorText(shown.error) }}</p>
          <div v-if="shown.staffImport.newPlayers.length" class="text-sm">
            <p class="text-muted">
              New on the staff list, named as play-tools shows them. Check their names on
              <NuxtLink to="/players?tab=staff" class="underline">Players → Staff</NuxtLink>:
            </p>
            <ul class="mt-1 list-disc space-y-0.5 pl-5">
              <li v-for="p in shown.staffImport.newPlayers" :key="p.playerId">
                {{ p.name || 'No name' }} <span class="tabular-nums text-muted">· {{ p.playerId }}</span>
              </li>
            </ul>
          </div>
          <NuxtLink :to="`/history/${shown.id}`" class="text-sm underline">See it in History</NuxtLink>
        </template>
      </div>
    </div>
  </UCard>
</template>
