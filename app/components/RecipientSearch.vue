<script setup lang="ts">
import type { StaffListEntry } from '../../server/modules/staffing/service';
import type { Recipient } from '~/utils/professors';

// Who an invite is for (ADR-0015 §6): searches the league's players and staff list side by side, like This week's Find
// a known player, or takes a player ID the league doesn't know. Players are tagged, since they include minors.

const model = defineModel<Recipient | null>({ required: true });

type Found = { players: { playerId: string; displayName: string; isRegular: boolean; metrics: unknown }[]; staff: StaffListEntry[] };

const term = ref('');
const state = ref<PlayerSearchState<Found>>({ status: 'idle' });
const search = createPlayerSearch<Found>(
  async (q) => {
    const query = { q, limit: SEARCH_LIMIT };
    const [players, staff] = await Promise.allSettled([
      $fetch<{ players: Found['players'] }>('/api/players', { query }),
      $fetch<StaffListEntry[]>('/api/staff', { query }),
    ]);
    if (players.status === 'rejected' && staff.status === 'rejected') throw players.reason;
    return { players: players.status === 'fulfilled' ? players.value.players : [], staff: staff.status === 'fulfilled' ? staff.value : [] };
  },
  (s) => (state.value = s),
);
watch(term, (typed) => search.update(typed));
onScopeDispose(search.reset);

const results = computed(() => (state.value.status === 'done' ? recipients(state.value.results.players, state.value.results.staff, term.value) : []));

function pick(r: Recipient) {
  model.value = r;
  term.value = '';
}
</script>

<template>
  <div class="space-y-2">
    <div v-if="model" class="flex flex-wrap items-center gap-2 text-sm" data-testid="recipient">
      <span class="font-medium">{{ model.name ?? `Player ${model.playerId}` }}</span>
      <span class="font-mono text-muted">{{ model.playerId }}</span>
      <UBadge v-if="model.player" color="warning" variant="subtle">Player</UBadge>
      <UBadge v-if="!model.known" color="neutral" variant="subtle">Not known here</UBadge>
      <UButton size="xs" variant="link" @click="model = null">Change</UButton>
    </div>
    <template v-else>
      <UFormField label="Player ID or name" hint="Optional: binds the invite to that Pokémon account">
        <UInput v-model="term" placeholder="Search, or type a player ID" class="w-full" autocomplete="off" />
      </UFormField>
      <p v-if="state.status === 'loading'" class="text-sm text-muted">Searching…</p>
      <p v-else-if="state.status === 'error'" class="text-sm text-error">Could not search. Type the player ID instead.</p>
      <ul v-else-if="results.length" class="divide-y divide-default rounded-md border border-default">
        <li v-for="r in results" :key="r.playerId">
          <button type="button" class="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-elevated" @click="pick(r)">
            <span class="font-medium">{{ r.name ?? `Player ${r.playerId}` }}</span>
            <span class="font-mono text-muted">{{ r.playerId }}</span>
            <UBadge v-if="r.player" color="warning" variant="subtle">Player</UBadge>
            <UBadge v-if="!r.known" color="neutral" variant="subtle">Not known here</UBadge>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>
