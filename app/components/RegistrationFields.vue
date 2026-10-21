<script setup lang="ts">
import type { RegistrationSettings } from '../../server/modules/tournaments/settings';

/** Registration, on site (window and admission) or through a third party, as the template and edit forms take it. */
const model = defineModel<RegistrationSettings | null>({ required: true });
/** Admission text stored before it was an amount (#194), shown until the template is saved. */
const props = defineProps<{ legacyAdmission?: string | null }>();

const kind = computed({
  get: () => model.value?.kind ?? 'on_site',
  set: (k: 'on_site' | 'third_party') => {
    model.value = k === 'on_site' ? { kind: 'on_site', opensBeforeMin: 60, closesAfterMin: 15, admissionCents: null } : { kind: 'third_party', url: '' };
  },
});
const onSite = computed(() => (model.value?.kind === 'on_site' ? model.value : null));
const thirdParty = computed(() => (model.value?.kind === 'third_party' ? model.value : null));

// The text as typed: an amount that isn't readable stays on screen while the model holds NaN.
const admissionTyped = ref(admissionInputText(onSite.value?.admissionCents ?? null));
watch(
  () => onSite.value?.admissionCents,
  (cents) => {
    if (cents === undefined || Number.isNaN(cents) || admissionInput(admissionTyped.value) === cents) return;
    admissionTyped.value = admissionInputText(cents);
  },
);
function setAdmission(text: string) {
  admissionTyped.value = text;
  if (onSite.value) onSite.value.admissionCents = admissionInput(text);
}
const admissionError = computed(() => registrationProblem(model.value) ?? undefined);
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
      <UFormField
        label="Admission"
        :error="admissionError"
        :help="props.legacyAdmission ? `Was “${props.legacyAdmission}”, which isn't an amount. Enter an amount or leave blank.` : undefined"
      >
        <div class="flex gap-2">
          <UInput :model-value="admissionTyped" inputmode="decimal" placeholder="$0.00" class="w-full" @update:model-value="setAdmission(String($event))" />
          <UButton color="neutral" variant="outline" @click="setAdmission('Free')">Free</UButton>
        </div>
      </UFormField>
    </div>
    <UFormField v-else-if="thirdParty" label="Registration URL"><UInput v-model="thirdParty.url" type="url" class="w-full" /></UFormField>
  </fieldset>
</template>
