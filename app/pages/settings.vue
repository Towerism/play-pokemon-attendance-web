<script setup lang="ts">
useHead({ title: 'Settings' });
// Timezone, batch delay and app users join this page in later milestones.
</script>

<template>
  <div class="space-y-6">
    <h1 class="text-xl font-semibold">Settings</h1>
    <PokemonConnectionCard />
    <CurationThresholdsCard />
    <StaffImportCard />
  </div>
</template>
