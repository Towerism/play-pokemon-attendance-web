<script setup lang="ts">
import type { Directive } from 'vue';
import type { StaffListEntry, TournamentStaffView } from '../../server/modules/staffing/service';
import type { StaffResult, StaffRole } from '~/utils/staff';

const props = defineProps<{ date: string; tournament: TournamentStaffView; roles: readonly StaffRole[] | undefined }>();
/** A staffer was added, or the card turned out to be stale. */
const emit = defineEmits<{ changed: [] }>();

type Found = { staff: StaffListEntry[]; players: { playerId: string; displayName: string }[] };
type Item = StaffResult & { label: string; disabled: boolean; tag: string | undefined };

const term = ref('');
/** Bumped to remount the box: in combobox mode the input's text can't be cleared from outside. */
const resetKey = ref(0);
const selected = ref<Item>();
const state = ref<PlayerSearchState<Found>>({ status: 'idle' });
const busy = ref(false);
const menu = useTemplateRef('menu');
const addStaff = useAddStaff(
  () => props.date,
  () => props.roles,
  () => emit('changed'),
);

// The staff list and every known player, side by side; one failing still shows the other.
const search = createPlayerSearch<Found>(
  async (q) => {
    const query = { q, limit: SEARCH_LIMIT };
    const [staff, players] = await Promise.allSettled([
      $fetch<StaffListEntry[]>('/api/staff', { query }),
      $fetch<{ players: Found['players'] }>('/api/players', { query }),
    ]);
    if (staff.status === 'rejected' && players.status === 'rejected') throw staff.reason;
    return { staff: staff.status === 'fulfilled' ? staff.value : [], players: players.status === 'fulfilled' ? players.value.players : [] };
  },
  (s) => (state.value = s),
);
watch(term, (typed) => search.update(typed));
watch(
  () => props.date,
  () => clear(),
);
onScopeDispose(search.reset);

const items = computed<Item[]>(() =>
  state.value.status === 'done'
    ? toStaffResults(state.value.results.staff, state.value.results.players, props.tournament).map((r) => ({
        ...r,
        label: r.name || 'No name',
        disabled: r.status !== 'addable',
        tag: staffTag(r, props.roles),
      }))
    : [],
);

const emptyText = computed(() => {
  switch (state.value.status) {
    case 'loading':
      return 'Searching…';
    case 'error':
      return 'Search failed. Try again.';
    case 'done':
      return 'Nobody matches. Add a first-time staffer by ID below.';
    default:
      return `Type at least ${SEARCH_MIN_LENGTH} characters.`;
  }
});

function clear() {
  term.value = '';
  resetKey.value++;
}

/**
 * Reka marks a disabled option with a bare `disabled` attribute, which a `div`
 * doesn't expose to assistive tech; this sets `aria-disabled` on the option.
 */
const vOptionDisabled: Directive<HTMLElement, boolean> = (el, { value }) => {
  el.closest('[role="option"]')?.setAttribute('aria-disabled', String(value));
};

/** Wants the picked person here in their last role (Judge for a first staffer). On success the box empties and keeps focus. */
async function pick(item: Item | undefined) {
  selected.value = undefined;
  if (!item || item.disabled) return;
  busy.value = true;
  try {
    const role = defaultRole(item.lastRole, props.roles);
    if (await addStaff({ tournamentId: props.tournament.tournamentId, playerId: item.playerId, role }, item.name)) {
      clear();
      emit('changed');
    }
  } finally {
    busy.value = false;
    await nextTick();
    menu.value?.inputRef?.focus();
  }
}
</script>

<template>
  <UFormField :label="`Find staff for ${tournament.label}`" :ui="{ label: 'sr-only' }">
    <UInputMenu
      ref="menu"
      :key="resetKey"
      v-model="selected"
      v-model:search-term="term"
      :items="items"
      ignore-filter
      :reset-search-term-on-select="false"
      :reset-search-term-on-blur="false"
      :loading="state.status === 'loading' || busy"
      icon="i-lucide-search"
      placeholder="Find staff (name or ID)…"
      :aria-label="`Find staff for ${tournament.label}`"
      :maxlength="100"
      autocomplete="off"
      class="w-full"
      @update:model-value="pick"
    >
      <template #item-label="{ item }">
        <span v-option-disabled="item.disabled" class="break-words" :class="{ 'text-muted italic': !item.name }">{{ item.label }}</span>
      </template>
      <template #item-trailing="{ item }">
        <span class="flex flex-wrap items-center justify-end gap-x-2">
          <UBadge v-if="item.tag" variant="subtle" color="neutral" size="sm">{{ item.tag }}</UBadge>
          <span v-else-if="item.lastRole" class="text-xs text-muted">last: {{ roleLabel(item.lastRole, roles) }}</span>
          <span class="text-muted tabular-nums">{{ item.playerId }}</span>
        </span>
      </template>
      <template #empty>{{ emptyText }}</template>
    </UInputMenu>
  </UFormField>
</template>
