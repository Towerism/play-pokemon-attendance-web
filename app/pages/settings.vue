<script setup lang="ts">
useHead({ title: 'Settings' });
// The owner's cards (professors, the league, thresholds, imports, integrations) show to the owner only (ADR-0015 §8).
const { data: settings } = await useSettings();
const isOwner = computed(() => settings.value?.access.role === 'owner');
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-semibold">Settings</h1>
    <PokemonConnectionCard />
    <template v-if="isOwner">
      <ProfessorsCard />
      <CurationThresholdsCard />
      <StaffImportCard />
      <PlayerImportCard />
      <IntegrationTokensCard />
    </template>
  </div>
</template>
