<script setup lang="ts">
import type { Scaffold, Template } from '../../server/modules/tournaments/service';

/** A scaffold (ADR-0010 decision 3): 1–10 slots of template, day offset and start time, held back to back. */
const props = defineProps<{ scaffold?: Scaffold | null; templates: Template[] }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const toast = useToast();

type Slot = { templateId: number | undefined; dayOffset: number; startTime: string };
const open = ref(true);
const name = ref(props.scaffold?.name ?? '');
const slots = ref<Slot[]>(
  props.scaffold?.slots.map((s) => ({ templateId: s.templateId, dayOffset: s.dayOffset, startTime: s.startTime ?? '' })) ?? [{ templateId: undefined, dayOffset: 0, startTime: '' }],
);
const saving = ref(false);
const error = ref<string | null>(null);
const usable = computed(() => props.templates.filter((t) => !t.archived).map((t) => ({ value: t.id, label: t.name })));
const ready = computed(() => name.value.trim() !== '' && slots.value.length > 0 && slots.value.every((s) => s.templateId));

watch(open, (o) => {
  if (!o) emit('close');
});

function move(i: number, by: -1 | 1) {
  const next = [...slots.value];
  [next[i], next[i + by]] = [next[i + by]!, next[i]!];
  slots.value = next;
}

async function save() {
  if (!ready.value) return;
  saving.value = true;
  error.value = null;
  const body = { name: name.value, slots: slots.value.map((s) => ({ templateId: s.templateId!, dayOffset: s.dayOffset, startTime: s.startTime || null })) };
  try {
    if (props.scaffold) await $fetch(`/api/tournament-scaffolds/${props.scaffold.id}`, { method: 'PATCH', body });
    else await $fetch('/api/tournament-scaffolds', { method: 'POST', body });
    toast.add({ color: 'success', title: `Saved ${name.value}` });
    emit('saved');
    open.value = false;
  } catch (err) {
    error.value = apiErrorMessage(err, 'Could not save the scaffold.');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="scaffold ? 'Edit scaffold' : 'New scaffold'" description="Tournaments held together, such as a TCG and a VGC event on the same night.">
    <template #body>
      <form class="space-y-3" @submit.prevent="save">
        <UFormField label="Name"><UInput v-model="name" maxlength="80" class="w-full" /></UFormField>
        <ol class="space-y-2" aria-label="Slots">
          <li v-for="(s, i) in slots" :key="i" class="rounded border border-default p-2 space-y-2">
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <UFormField :label="`Slot ${i + 1} template`"><USelect v-model="s.templateId" :items="usable" placeholder="Template" class="w-full" /></UFormField>
              <UFormField label="Day offset"><UInputNumber v-model="s.dayOffset" :min="0" :max="6" class="w-full" /></UFormField>
              <UFormField label="Start time" help="Empty: the template's"><UInput v-model="s.startTime" type="time" class="w-full" /></UFormField>
            </div>
            <div class="flex gap-1">
              <UButton size="xs" variant="ghost" icon="i-lucide-arrow-up" :disabled="i === 0" :aria-label="`Move slot ${i + 1} up`" @click="move(i, -1)" />
              <UButton size="xs" variant="ghost" icon="i-lucide-arrow-down" :disabled="i === slots.length - 1" :aria-label="`Move slot ${i + 1} down`" @click="move(i, 1)" />
              <UButton size="xs" variant="ghost" color="error" :disabled="slots.length === 1" :aria-label="`Remove slot ${i + 1}`" @click="slots.splice(i, 1)">Remove</UButton>
            </div>
          </li>
        </ol>
        <UButton size="xs" variant="outline" icon="i-lucide-plus" :disabled="slots.length >= 10" @click="slots.push({ templateId: undefined, dayOffset: 0, startTime: '' })">Add slot</UButton>
        <p v-if="error" class="text-sm text-error">{{ error }}</p>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" @click="open = false">Cancel</UButton>
        <UButton :disabled="!ready" :loading="saving" @click="save">Save scaffold</UButton>
      </div>
    </template>
  </UModal>
</template>
