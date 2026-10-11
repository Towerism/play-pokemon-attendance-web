<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui';
import type { PlayerInput } from '#shared/schemas/roster';

const route = useRoute();
const router = useRouter();
const toast = useToast();

const date = computed({
  get: () => sessionDateFromQuery(route.query.date),
  set: (value: string) => router.replace({ query: { ...route.query, date: value } }),
});

const { data: session, refresh } = await useFetch(() => `/api/sessions/${date.value}`, {
  key: computed(() => `session-${date.value}`),
});

type SessionPlayer = NonNullable<typeof session.value>['players'][number];
const columns: TableColumn<SessionPlayer>[] = [
  { accessorKey: 'displayName', header: 'Name' },
  { accessorKey: 'playerId', header: 'Player ID' },
  { accessorKey: 'source', header: 'Added from' },
  { id: 'actions' },
];

const form = useTemplateRef('form');
const adding = ref(false);

async function addPlayer(player: PlayerInput) {
  adding.value = true;
  try {
    await $fetch(`/api/sessions/${date.value}/players`, { method: 'POST', body: player });
    form.value?.reset();
    await refresh();
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not add the player.') });
  } finally {
    adding.value = false;
  }
}

async function removePlayer(player: SessionPlayer) {
  try {
    await $fetch(`/api/sessions/${date.value}/players/${player.playerId}`, { method: 'DELETE' });
    toast.add({ title: `Removed ${player.displayName || player.playerId} from ${date.value}` });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not remove the player.') });
  }
  await refresh();
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <h1 class="text-2xl font-semibold">This week</h1>
      <UFormField label="Session date">
        <UInput v-model="date" type="date" />
      </UFormField>
    </div>

    <section class="space-y-3">
      <h2 class="text-lg font-medium">
        Session players <span class="text-muted">({{ session?.players.length ?? 0 }})</span>
      </h2>
      <AddPlayerForm ref="form" submit-label="Add" :busy="adding" @submit="addPlayer" />
      <UTable :data="session?.players ?? []" :columns="columns" empty="No session players yet. Add them by ID, or import a TDF (coming soon).">
        <template #displayName-cell="{ row }">
          <span :class="{ 'text-muted italic': !row.original.displayName }">{{ row.original.displayName || 'No name' }}</span>
        </template>
        <template #source-cell="{ row }">
          <UBadge variant="subtle" color="neutral">{{ row.original.source === 'tdf' ? 'TDF' : 'By hand' }}</UBadge>
        </template>
        <template #actions-cell="{ row }">
          <div class="text-right">
            <UButton
              icon="i-lucide-x"
              size="sm"
              variant="ghost"
              color="neutral"
              :aria-label="`Remove ${row.original.displayName || row.original.playerId}`"
              @click="removePlayer(row.original)"
            />
          </div>
        </template>
      </UTable>
    </section>

    <section class="space-y-2">
      <UCollapsible>
        <UButton variant="link" color="neutral" trailing-icon="i-lucide-chevron-down" class="px-0 text-lg font-medium text-left">
          Regulars ({{ session?.regulars.length ?? 0 }})
          <span class="text-sm font-normal text-muted">· submitted every session</span>
        </UButton>
        <template #content>
          <ul class="mt-2 grid gap-1 sm:grid-cols-2 text-sm">
            <li v-for="regular in session?.regulars" :key="regular.playerId" class="flex justify-between gap-2 border-b border-default py-1">
              <span>{{ regular.displayName || 'No name' }}</span>
              <span class="text-muted tabular-nums">{{ regular.playerId }}</span>
            </li>
          </ul>
          <p v-if="!session?.regulars.length" class="text-sm text-muted">
            No regulars yet. <NuxtLink to="/regulars" class="underline">Add or import them</NuxtLink>.
          </p>
        </template>
      </UCollapsible>
    </section>
  </div>
</template>
