<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';

const route = useRoute();
const date = computed(() => (typeof route.query.date === 'string' ? route.query.date : undefined));
const { data } = await useFetch('/api/submissions', { query: { date }, key: computed(() => `submissions-${date.value ?? 'all'}`) });

type Row = NonNullable<typeof data.value>['submissions'][number];
// On a phone, Play session and Started move under the date so Status and Result stay on screen.
const columns: TableColumn<Row>[] = [
  { accessorKey: 'date', header: 'Date', meta: { class: { td: WRAP } } },
  { accessorKey: 'playSessionLabel', header: 'Play session', meta: { class: { th: WIDE_ONLY, td: `${WIDE_ONLY} ${WRAP}` } } },
  { accessorKey: 'status', header: 'Status' },
  { id: 'summary', header: 'Result', meta: { class: { td: WRAP } } },
  { accessorKey: 'startedAt', header: 'Started', meta: { class: { th: WIDE_ONLY, td: `${WIDE_ONLY} ${WRAP}` } } },
];
const started = (row: Row) => `${new Date(row.startedAt).toLocaleString()} · ${startedByText(row)}`;
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">History</h1>
      <UButton v-if="date" to="/history" variant="link" color="neutral" icon="i-lucide-x">Only {{ date }}</UButton>
    </div>
    <UTable :data="data?.submissions ?? []" :columns="columns" empty="Nothing submitted yet.">
      <template #date-cell="{ row }">
        <NuxtLink :to="`/history/${row.original.id}`" class="underline tabular-nums whitespace-nowrap">{{ row.original.date }}</NuxtLink>
        <div class="text-xs text-muted sm:hidden">
          <p>{{ row.original.playSessionLabel }}</p>
          <p>{{ started(row.original) }}</p>
        </div>
      </template>
      <template #status-cell="{ row }">
        <UBadge variant="subtle" :color="submissionStatus(row.original.status, row.original.kind).color">
          {{ submissionStatus(row.original.status, row.original.kind).label }}
        </UBadge>
      </template>
      <template #summary-cell="{ row }">
        <span v-if="historyLabel(row.original)" class="text-sm">{{ historyLabel(row.original) }}</span>
        <span v-else class="text-sm">{{ submissionSummary(row.original.counts) }}</span>
      </template>
      <template #startedAt-cell="{ row }">
        <span class="text-sm text-muted">{{ started(row.original) }}</span>
      </template>
    </UTable>
  </div>
</template>
