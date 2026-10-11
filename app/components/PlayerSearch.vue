<script setup lang="ts">
import type { Directive } from 'vue';

const props = defineProps<{ date: string; sessionPlayerIds: ReadonlySet<string> }>();
const emit = defineEmits<{ added: [] }>();
const toast = useToast();

type Found = { playerId: string; displayName: string; isRegular: boolean };
type Item = SearchResult & { label: string; disabled: boolean };

const STATUS_TAG: Record<Exclude<SearchResultStatus, 'addable'>, string> = { regular: 'Regular', alreadyAdded: 'Already added' };

const term = ref('');
/** Bumped to remount the box: in combobox mode the input's text can't be cleared from outside. */
const resetKey = ref(0);
const selected = ref<Item>();
const state = ref<PlayerSearchState<Found[]>>({ status: 'idle' });
const adding = ref(false);
const menu = useTemplateRef('menu');

const search = createPlayerSearch(
  (q) => $fetch('/api/players', { query: { q, limit: SEARCH_LIMIT } }).then((r) => r.players),
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
    ? toSearchResults(state.value.results, props.sessionPlayerIds).map((r) => ({
        ...r,
        label: r.displayName || 'No name',
        disabled: r.status !== 'addable',
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
      return 'No known players match. Add them by ID below.';
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

/** Adds the picked player; on success the box empties and keeps focus for the next one. */
async function add(item: Item | undefined) {
  selected.value = undefined;
  if (!item || item.status !== 'addable') return;
  adding.value = true;
  try {
    await $fetch(`/api/sessions/${props.date}/players`, { method: 'POST', body: { playerId: item.playerId } });
    clear();
    emit('added');
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not add the player.') });
  } finally {
    adding.value = false;
    await nextTick();
    menu.value?.inputRef?.focus();
  }
}
</script>

<template>
  <UFormField label="Find a known player" :ui="{ label: 'sr-only' }">
    <UInputMenu
      ref="menu"
      :key="resetKey"
      v-model="selected"
      v-model:search-term="term"
      :items="items"
      ignore-filter
      :reset-search-term-on-select="false"
      :reset-search-term-on-blur="false"
      :loading="state.status === 'loading' || adding"
      icon="i-lucide-search"
      placeholder="Find a known player (name or ID)…"
      aria-label="Find a known player"
      :maxlength="100"
      autocomplete="off"
      class="w-full"
      @update:model-value="add"
    >
      <template #item-label="{ item }">
        <span v-option-disabled="item.disabled" :class="{ 'text-muted italic': !item.displayName }">{{ item.label }}</span>
      </template>
      <template #item-trailing="{ item }">
        <span class="flex items-center gap-2">
          <UBadge v-if="item.status !== 'addable'" variant="subtle" color="neutral" size="sm">{{ STATUS_TAG[item.status] }}</UBadge>
          <span class="text-muted tabular-nums">{{ item.playerId }}</span>
        </span>
      </template>
      <template #empty>{{ emptyText }}</template>
    </UInputMenu>
  </UFormField>
</template>
