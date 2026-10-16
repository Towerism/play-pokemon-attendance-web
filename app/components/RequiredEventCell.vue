<script setup lang="ts">
import type { PeriodCoverage, UnreadProfessor } from '../../shared/requirements/coverage';
import type { Requirement } from '../../server/modules/tournaments/requirements';

/** One requirement × period of the Required events grid (ADR-0010 decision 12): status, urgency, what covers it, what fixes it. */
const props = withDefaults(defineProps<{ requirement: Requirement; period: PeriodCoverage; today: string; unread: readonly UnreadProfessor[]; planReady?: boolean }>(), {
  planReady: true,
});
const emit = defineEmits<{ plan: []; create: [plannedId: number]; cover: []; uncover: [] }>();

const view = computed(() => cellView(props.requirement, props.period, { today: props.today, unread: props.unread }));
const name = computed(() => `${requirementLabel(props.requirement)} · ${periodLabel(props.period, props.requirement.cadence)}`);
</script>

<template>
  <li :aria-label="name" class="rounded border border-default p-2 text-sm space-y-1 min-w-0">
    <div class="flex flex-wrap items-center gap-1">
      <span class="font-medium">{{ periodLabel(period, requirement.cadence) }}</span>
      <UBadge variant="subtle" :color="view.status.color">{{ view.status.label }}</UBadge>
      <UBadge v-if="view.urgency" variant="outline" :color="view.urgency.color">{{ view.urgency.label }}</UBadge>
    </div>
    <p v-for="line in view.lines" :key="line" class="text-muted break-words">{{ line }}</p>
    <div class="flex flex-wrap gap-1 pt-1">
      <UButton v-if="view.actions.includes('plan')" size="xs" :loading="!props.planReady" :aria-label="`Plan one… ${name}`" @click="emit('plan')">Plan one…</UButton>
      <UButton v-if="view.actions.includes('create')" size="xs" :aria-label="`Create in play-tools ${name}`" @click="emit('create', view.createPlannedId!)">
        Create in play-tools
      </UButton>
      <UButton
        v-if="view.actions.includes('open')"
        size="xs"
        variant="outline"
        to="https://play-tools.pokemon.com/"
        target="_blank"
        rel="noopener noreferrer"
        icon="i-lucide-external-link"
      >
        Open play-tools · {{ view.openText }}
      </UButton>
      <UButton v-if="view.actions.includes('cover')" size="xs" variant="ghost" :aria-label="`Mark as covered… ${name}`" @click="emit('cover')">Mark as covered…</UButton>
      <UButton v-if="view.actions.includes('uncover')" size="xs" variant="ghost" color="error" :aria-label="`Remove cover ${name}`" @click="emit('uncover')">
        Remove cover
      </UButton>
    </div>
  </li>
</template>
