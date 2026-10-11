<script setup lang="ts">
import { PlayerInput } from '#shared/schemas/roster';

const props = defineProps<{ submitLabel: string; busy?: boolean }>();
const emit = defineEmits<{ submit: [player: PlayerInput] }>();

const state = reactive({ playerId: '', name: '' });

/** Clears the form after the parent saved the player. */
function reset() {
  state.playerId = '';
  state.name = '';
}
defineExpose({ reset });

function onSubmit() {
  emit('submit', PlayerInput.parse(state));
}
</script>

<template>
  <UForm :schema="PlayerInput" :state="state" class="flex flex-col sm:flex-row gap-2 sm:items-start" @submit="onSubmit">
    <UFormField name="playerId" class="sm:w-44">
      <UInput v-model="state.playerId" placeholder="Player ID" inputmode="numeric" autocomplete="off" class="w-full" />
    </UFormField>
    <UFormField name="name" class="flex-1">
      <UInput v-model="state.name" placeholder="Name (optional)" autocomplete="off" class="w-full" />
    </UFormField>
    <UButton type="submit" icon="i-lucide-user-plus" :loading="props.busy">{{ props.submitLabel }}</UButton>
  </UForm>
</template>
