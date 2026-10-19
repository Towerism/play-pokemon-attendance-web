<script setup lang="ts">
import type { UpcomingEntry } from '../../server/modules/tournaments/service';

/**
 * A planned tournament not in play-tools yet, on This week (ADR-0010 decision 10): its status and sanction-by date,
 * with **Create in play-tools** (or **Retry create…**) and **Edit…**. Creating goes through the same dialog as Upcoming.
 */
const props = defineProps<{ entry: UpcomingEntry; today: string }>();
const emit = defineEmits<{ create: [retry: boolean]; edit: [id: string] }>();

const headingId = useId();
const status = computed(() => entryStatus(props.entry));
const tag = computed(() => sanctionTag(props.entry, props.today));
// Another user holds the template organizer's connection: nothing here is the viewer's to change (ADR-0015 §4).
const { data: connections } = usePokemonConnection();
const decided = computed(() => rowActions(props.entry, onlyText(connections.value, props.entry.organizer?.playerId)));
const label = computed(() => `${props.entry.name} · ${dayLabel(props.entry.localDate)}`);
const menu = computed(() =>
  decided.value.actions.includes('edit') ? [[{ label: 'Edit…', icon: 'i-lucide-pencil', onSelect: () => emit('edit', String(props.entry.plannedId)) }]] : [],
);
</script>

<template>
  <section :aria-labelledby="headingId" class="space-y-3 rounded-md border border-dashed border-default p-3">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1 space-y-1">
        <h3 :id="headingId" class="font-medium break-words">{{ label }}</h3>
        <p class="text-sm text-muted break-words">{{ entry.startTime }} · Organized by {{ professorName(entry.organizer) }}</p>
        <p class="flex flex-wrap items-center gap-2 text-sm">
          <UBadge variant="subtle" :color="status.color">{{ status.label }}</UBadge>
          <UBadge v-if="tag" variant="outline" :color="tag.startsWith('Create by') ? 'neutral' : 'warning'">{{ tag }}</UBadge>
        </p>
      </div>
      <UDropdownMenu v-if="menu.length" :items="menu">
        <UButton icon="i-lucide-ellipsis-vertical" size="sm" variant="ghost" color="neutral" :aria-label="`Tournament actions for ${label}`" />
      </UDropdownMenu>
    </div>
    <p v-if="entry.state === 'creating'" class="text-sm text-muted">Being created in play-tools…</p>
    <p v-if="decided.organizerNote" class="text-sm" :class="decided.settings ? 'text-warning' : 'text-muted'">
      {{ decided.organizerNote }}
      <NuxtLink v-if="decided.settings" to="/settings" class="underline">Open Settings</NuxtLink>
    </p>
    <div v-if="decided.actions.includes('create') || decided.actions.includes('retry_create')" class="flex flex-wrap gap-2">
      <UButton v-if="decided.actions.includes('create')" size="sm" :aria-label="`Create in play-tools ${label}`" @click="emit('create', false)">Create in play-tools</UButton>
      <UButton v-if="decided.actions.includes('retry_create')" size="sm" variant="outline" color="warning" :aria-label="`Retry create… ${label}`" @click="emit('create', true)">
        Retry create…
      </UButton>
    </div>
  </section>
</template>
