<template>
  <UApp>
    <!-- Slow navigations leave the old page up until the next has its data; this bar shows one is under way (after 200 ms). -->
    <NuxtLoadingIndicator color="var(--ui-primary)" error-color="var(--ui-error)" aria-hidden="true" />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
