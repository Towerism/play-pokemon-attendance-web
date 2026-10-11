<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';

const route = useRoute();
const date = computed(() => (typeof route.query.date === 'string' ? route.query.date : undefined));
const { data } = await useFetch('/api/submissions', { query: { date }, key: computed(() => `submissions-${date.value ?? 'all'}`) });

type Row = NonNullable<typeof data.value>['submissions'][number];
const columns: TableColumn<Row>[] = [
  { accessorKey: 'date', header: 'Date' },
  { accessorKey: 'playSessionLabel', header: 'Play session' },
  { accessorKey: 'status', header: 'Status' },
  { id: 'summary', header: 'Result' },
  { accessorKey: 'startedAt', header: 'Started' },
];
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h1 class="text-2xl font-semibold">History</h1>
      <UButton v-if="date" to="/history" variant="link" color="neutral" icon="i-lucide-x">Only {{ date }}</UButton>
    </div>
    <UTable :data="data?.submissions ?? []" :columns="columns" empty="Nothing submitted yet.">
      <template #date-cell="{ row }">
        <NuxtLink :to="`/history/${row.original.id}`" class="underline tabular-nums">{{ row.original.date }}</NuxtLink>
      </template>
      <template #status-cell="{ row }">
        <UBadge variant="subtle" :color="submissionStatus(row.original.status).color">{{ submissionStatus(row.original.status).label }}</UBadge>
      </template>
      <template #summary-cell="{ row }">
        <span class="text-sm">{{ submissionSummary(row.original.counts) }}</span>
      </template>
      <template #startedAt-cell="{ row }">
        <span class="text-sm text-muted">{{ new Date(row.original.startedAt).toLocaleString() }} · {{ row.original.startedBy }}</span>
      </template>
    </UTable>
  </div>
</template>
