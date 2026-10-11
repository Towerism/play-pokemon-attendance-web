<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';

const toast = useToast();

const search = ref('');
const q = ref('');
let debounce: ReturnType<typeof setTimeout> | undefined;
watch(search, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => (q.value = value), 250);
});
const { data, refresh } = await useFetch('/api/players', { key: 'players', query: { q } });

type Player = NonNullable<typeof data.value>['players'][number];
const columns: TableColumn<Player>[] = [
  { accessorKey: 'displayName', header: 'Name' },
  { accessorKey: 'playerId', header: 'Player ID' },
  { accessorKey: 'isRegular', header: 'Regular' },
  { accessorKey: 'notes', header: 'Notes' },
  { id: 'actions' },
];
// Metrics and the Promotion candidates / Stale regulars tabs arrive in M6.

async function save(player: Player, patch: { name?: string; notes?: string | null; isRegular?: boolean }) {
  return $fetch(`/api/players/${player.playerId}`, { method: 'PATCH', body: patch });
}

/** Optimistic: flip the switch now, put it back if the server says no (architecture §8). */
async function toggleRegular(player: Player, isRegular: boolean) {
  player.isRegular = isRegular;
  try {
    await save(player, { isRegular });
  } catch (err) {
    player.isRegular = !isRegular;
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not change the regular flag.') });
  }
}

const editing = ref<Player | null>(null);
const draft = reactive({ name: '', notes: '' });
const saving = ref(false);
const editOpen = computed({
  get: () => editing.value !== null,
  set: (open: boolean) => {
    if (!open) editing.value = null;
  },
});

function startEdit(player: Player) {
  editing.value = player;
  draft.name = player.displayName;
  draft.notes = player.notes ?? '';
}

async function saveEdit() {
  const player = editing.value;
  if (!player) return;
  saving.value = true;
  try {
    const patch: { name?: string; notes: string | null } = { notes: draft.notes };
    if (draft.name.trim() && draft.name.trim() !== player.displayName) patch.name = draft.name;
    await save(player, patch);
    editing.value = null;
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the player.') });
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold">Players</h1>
        <p class="text-sm text-muted">Everyone who has ever been entered for this league.</p>
      </div>
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search name or ID" class="w-full sm:w-64" />
    </div>

    <UTable :data="data?.players ?? []" :columns="columns" :empty="q ? 'No players match.' : 'No players yet.'">
      <template #displayName-cell="{ row }">
        <span :class="{ 'text-muted italic': !row.original.displayName }">{{ row.original.displayName || 'No name' }}</span>
      </template>
      <template #isRegular-cell="{ row }">
        <USwitch
          :model-value="row.original.isRegular"
          :aria-label="`${row.original.displayName || row.original.playerId} is a regular`"
          @update:model-value="toggleRegular(row.original, $event)"
        />
      </template>
      <template #notes-cell="{ row }">
        <span class="text-muted line-clamp-1">{{ row.original.notes }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="text-right">
          <UButton
            icon="i-lucide-pencil"
            size="sm"
            variant="ghost"
            color="neutral"
            :aria-label="`Edit ${row.original.displayName || row.original.playerId}`"
            @click="startEdit(row.original)"
          />
        </div>
      </template>
    </UTable>

    <UModal v-model:open="editOpen" :title="`Edit player ${editing?.playerId ?? ''}`">
      <template #body>
        <form id="edit-player" class="space-y-4" @submit.prevent="saveEdit">
          <UFormField label="Name">
            <UInput v-model="draft.name" maxlength="100" class="w-full" />
          </UFormField>
          <UFormField label="Notes">
            <UTextarea v-model="draft.notes" maxlength="500" :rows="3" class="w-full" />
          </UFormField>
        </form>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2 w-full">
          <UButton variant="ghost" color="neutral" @click="editing = null">Cancel</UButton>
          <UButton type="submit" form="edit-player" :loading="saving">Save</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
