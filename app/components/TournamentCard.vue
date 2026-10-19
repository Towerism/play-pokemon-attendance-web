<script setup lang="ts">
import type { StaffRole } from '~/utils/staff';
import type { CardPair } from '~/utils/tournament-cards';

/**
 * A This week **tournament card** (ADR-0010 decision 10): the play-tools tournament's status, its Staff (as built, M8)
 * and its Results (ADR-0011), with **Edit…** in its menu. Cancel stays on the Tournaments page.
 */
const props = defineProps<{ date: string; pair: CardPair; roles: readonly StaffRole[] | undefined }>();
/** `changed`: staff changed (read the date again); `edit`: open Edit… for this id; `uploaded`: an upload job ended. */
const emit = defineEmits<{ changed: []; edit: [id: string]; uploaded: [] }>();

const headingId = useId();
const tournament = computed(() => props.pair.tournament);
const entry = computed(() => props.pair.entry);
// Another user holds the organizer's connection: their card is read-only here (ADR-0015 §4).
const { data: connections } = usePokemonConnection();
const only = computed(() => onlyText(connections.value, tournament.value.organizer?.playerId));
const note = computed(() => readOnlyNote(tournament.value, only.value));
const staffed = computed(() => (only.value ? { ...tournament.value, editable: false } : tournament.value));
const status = computed(() => (entry.value ? entryStatus(entry.value) : null));
const withResults = computed(() => !tournament.value.missing && !tournament.value.unavailable);
const menu = computed(() =>
  cardEditable(props.pair, only.value)
    ? [[{ label: 'Edit…', icon: 'i-lucide-pencil', onSelect: () => emit('edit', String(entry.value?.plannedId ?? tournament.value.tournamentId)) }]]
    : [],
);
</script>

<template>
  <section :aria-labelledby="headingId" class="space-y-4 rounded-md border border-default p-3">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <h3 :id="headingId" class="font-medium break-words">{{ tournament.label }}</h3>
        <p v-if="organizerText(tournament.organizer)" class="text-sm text-muted break-words">{{ organizerText(tournament.organizer) }}</p>
        <p v-if="status || entry?.displayId" class="flex flex-wrap items-center gap-2 text-sm">
          <UBadge v-if="status" variant="subtle" :color="status.color">{{ status.label }}</UBadge>
          <span v-if="entry?.displayId" class="text-muted tabular-nums">{{ entry.displayId }}</span>
        </p>
      </div>
      <UDropdownMenu v-if="menu.length" :items="menu">
        <UButton icon="i-lucide-ellipsis-vertical" size="sm" variant="ghost" color="neutral" :aria-label="`Tournament actions for ${tournament.label}`" />
      </UDropdownMenu>
    </div>
    <p v-if="note" class="text-sm" :class="note.warning ? 'text-warning' : 'text-muted'">
      {{ note.text }}
      <NuxtLink v-if="note.settings" to="/settings" class="underline">Open Settings</NuxtLink>
    </p>

    <StaffCard :date="date" :tournament="staffed" :roles="roles" @changed="emit('changed')" />
    <TournamentResults
      v-if="withResults"
      :date="date"
      :tournament-id="tournament.tournamentId"
      :label="tournament.label"
      :display-id="entry?.displayId ?? null"
      :roles="roles"
      :readonly="!!only"
      @uploaded="emit('uploaded')"
    />
  </section>
</template>
