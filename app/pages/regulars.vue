<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { PlayerInput } from '#shared/schemas/roster';

const toast = useToast();
const { data, refresh } = await useFetch('/api/regulars', { key: 'regulars' });

type Regular = NonNullable<typeof data.value>['regulars'][number];
const columns: TableColumn<Regular>[] = [
  { accessorKey: 'displayName', header: 'Name' },
  { accessorKey: 'playerId', header: 'Player ID' },
  { accessorKey: 'regularSince', header: 'Regular since' },
  { id: 'actions' },
];
// Last seen and 8-week rate join this table with metrics (M6).

const form = useTemplateRef('form');
const adding = ref(false);

async function addRegular(player: PlayerInput) {
  adding.value = true;
  try {
    await $fetch('/api/regulars', { method: 'POST', body: player });
    form.value?.reset();
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not add the regular.') });
  } finally {
    adding.value = false;
  }
}

async function removeRegular(regular: Regular) {
  try {
    await $fetch(`/api/regulars/${regular.playerId}`, { method: 'DELETE' });
    toast.add({ title: `${regular.displayName || regular.playerId} is no longer a regular` });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not remove the regular.') });
  }
  await refresh();
}

const fileInput = useTemplateRef('fileInput');
const importing = ref(false);

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  const read = await readRegularsFile(file);
  if (!read.ok) {
    toast.add({ color: 'error', title: read.error });
    return;
  }
  importing.value = true;
  try {
    const result = await $fetch('/api/regulars/import', { method: 'POST', body: read.value as object });
    toast.add({
      color: 'success',
      title: `Imported ${file.name}`,
      description: `${result.added} added, ${result.alreadyRegular} already regulars.`,
    });
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, `Could not import ${file.name}.`) });
  } finally {
    importing.value = false;
  }
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString();
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Regulars</h1>
        <p class="text-sm text-muted">Submitted every session, whether or not they play in the tournament.</p>
      </div>
      <div>
        <input ref="fileInput" type="file" accept=".json,application/json" class="hidden" @change="importFile" >
        <UButton icon="i-lucide-upload" variant="outline" :loading="importing" @click="fileInput?.click()">
          Import regulars.json
        </UButton>
      </div>
    </div>

    <AddPlayerForm ref="form" submit-label="Add regular" :busy="adding" @submit="addRegular" />

    <UTable :data="data?.regulars ?? []" :columns="columns" empty="No regulars yet. Add them here, or import the CLI's regulars.json.">
      <template #displayName-cell="{ row }">
        <span :class="{ 'text-muted italic': !row.original.displayName }">{{ row.original.displayName || 'No name' }}</span>
      </template>
      <template #regularSince-cell="{ row }">
        {{ formatDate(row.original.regularSince) }}
      </template>
      <template #actions-cell="{ row }">
        <div class="text-right">
          <UButton
            icon="i-lucide-user-minus"
            size="sm"
            variant="ghost"
            color="neutral"
            :aria-label="`Remove ${row.original.displayName || row.original.playerId} from regulars`"
            @click="removeRegular(row.original)"
          />
        </div>
      </template>
    </UTable>
  </div>
</template>
