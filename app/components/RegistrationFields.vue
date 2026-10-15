<script setup lang="ts">
import type { RegistrationSettings } from '../../server/modules/tournaments/settings';

/** Registration, on site (window and admission) or through a third party, as the template and edit forms take it. */
const model = defineModel<RegistrationSettings | null>({ required: true });

const kind = computed({
  get: () => model.value?.kind ?? 'on_site',
  set: (k: 'on_site' | 'third_party') => {
    model.value = k === 'on_site' ? { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admission: null } : { kind: 'third_party', url: '' };
  },
});
const onSite = computed(() => (model.value?.kind === 'on_site' ? model.value : null));
const thirdParty = computed(() => (model.value?.kind === 'third_party' ? model.value : null));
</script>

<template>
  <fieldset class="space-y-2">
    <legend class="text-sm font-medium">Registration</legend>
    <URadioGroup
      v-model="kind"
      orientation="horizontal"
      :items="[
        { value: 'on_site', label: 'On site' },
        { value: 'third_party', label: 'Third party' },
      ]"
    />
    <div v-if="onSite" class="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <UFormField label="Opens (min before)"><UInputNumber v-model="onSite.opensBeforeMin" :min="0" :max="1440" class="w-full" /></UFormField>
      <UFormField label="Closes (min after)"><UInputNumber v-model="onSite.closesAfterMin" :min="0" :max="1440" class="w-full" /></UFormField>
      <UFormField label="Admission"><UInput :model-value="onSite.admission ?? ''" maxlength="500" placeholder="Free" class="w-full" @update:model-value="onSite.admission = String($event) || null" /></UFormField>
    </div>
    <UFormField v-else-if="thirdParty" label="Registration URL"><UInput v-model="thirdParty.url" type="url" class="w-full" /></UFormField>
  </fieldset>
</template>
