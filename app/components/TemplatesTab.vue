<script setup lang="ts">
import type { Scaffold, Template } from '../../server/modules/tournaments/service';

/** Templates (ADR-0010 decision 10): list, create, edit, archive. Archived ones show on request. */
const props = defineProps<{ timeZone: string; today: string }>();
const toast = useToast();

const showArchived = ref(false);
const { data, refresh, error } = await useFetch<{ templates: Template[] }>('/api/tournament-templates', {
  key: 'tournament-templates',
  query: computed(() => (showArchived.value ? { archived: '1' } : {})),
});
const editing = ref<Template | null | 'new'>(null);

const typeText = (t: Template) => (t.type.kind === 'custom' ? 'Custom' : t.type.seriesMatch);

async function archive(t: Template) {
  if (!window.confirm(`Archive “${t.name}”? It stays on tournaments already planned.`)) return;
  try {
    await $fetch(`/api/tournament-templates/${t.id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    if (apiErrorCode(err) === 'template_in_use') {
      const ids = (err as { data?: { data?: { scaffoldIds?: number[] } } }).data?.data?.scaffoldIds ?? [];
      const scaffolds = await $fetch<{ scaffolds: Scaffold[] }>('/api/tournament-scaffolds').catch(() => ({ scaffolds: [] }));
      const names = ids.map((id) => scaffolds.scaffolds.find((s) => s.id === id)?.name ?? `#${id}`);
      toast.add({ color: 'error', title: `“${t.name}” is used by ${names.join(', ')}. Archive or change those scaffolds first.` });
    } else toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not archive the template.') });
  }
}
</script>

<template>
  <section aria-label="Templates" class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <USwitch v-model="showArchived" label="Show archived" />
      <UButton size="sm" icon="i-lucide-plus" @click="editing = 'new'">New template</UButton>
    </div>
    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="apiErrorMessage(error, 'Could not read the templates.')" />
    <p v-else-if="data && data.templates.length === 0" class="text-sm text-muted">No templates yet. A template holds everything a tournament needs, set up once.</p>
    <ul class="space-y-2">
      <li v-for="t in data?.templates ?? []" :key="t.id" :aria-label="t.name" class="rounded border border-default p-3 text-sm space-y-1 min-w-0">
        <div class="flex flex-wrap items-center gap-1">
          <span class="font-medium break-words">{{ t.name }}</span>
          <UBadge v-if="t.archived" variant="subtle" color="neutral">Archived</UBadge>
        </div>
        <p class="text-muted break-words">
          {{ GAME[t.product] }} · {{ typeText(t) }} · {{ t.category }} · {{ t.venue.label }} · {{ t.startTime }} · organizer {{ t.organizerPlayerId }}
        </p>
        <div v-if="!t.archived" class="flex gap-1">
          <UButton size="xs" variant="outline" :aria-label="`Edit… ${t.name}`" @click="editing = t">Edit…</UButton>
          <UButton size="xs" variant="ghost" color="error" :aria-label="`Archive… ${t.name}`" @click="archive(t)">Archive…</UButton>
        </div>
      </li>
    </ul>
    <TemplateForm
      v-if="editing"
      :template="editing === 'new' ? null : editing"
      :time-zone="props.timeZone"
      :today="props.today"
      @saved="refresh()"
      @close="editing = null"
    />
  </section>
</template>
