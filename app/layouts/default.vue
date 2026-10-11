<script setup lang="ts">
const { user, clear } = useUserSession();

const links = [
  { to: '/', label: 'This week' },
  { to: '/regulars', label: 'Regulars' },
  { to: '/players', label: 'Players' },
  { to: '/settings', label: 'Settings' },
];

// Global reconnect banner (architecture §8): shown on every page once Pokémon refuses the saved login.
const { data: connection, execute: loadConnection } = await usePokemonConnection({ immediate: false });
watch(
  user,
  (u) => {
    if (u) void loadConnection();
  },
  { immediate: true },
);
const needsReconnect = computed(() => !!user.value && connection.value?.status === 'needs_reconnect');

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' });
  await clear();
  await navigateTo('/login');
}
</script>

<template>
  <div class="min-h-dvh flex flex-col">
    <UBanner
      v-if="needsReconnect"
      color="warning"
      icon="i-lucide-plug-zap"
      title="Pokémon no longer accepts the saved login. Reconnect before submitting attendance."
      :actions="[{ label: 'Reconnect', to: '/settings', color: 'neutral', variant: 'outline' }]"
    />
    <header class="border-b border-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between gap-4">
        <div class="flex items-center gap-4 min-w-0">
          <NuxtLink to="/" class="font-semibold hidden sm:inline">League attendance</NuxtLink>
          <nav v-if="user" class="flex items-center gap-1 text-sm">
            <UButton v-for="link in links" :key="link.to" :to="link.to" :exact="link.to === '/'" size="sm" variant="ghost" color="neutral" active-color="primary" active-variant="soft">
              {{ link.label }}
            </UButton>
          </nav>
        </div>
        <div v-if="user" class="flex items-center gap-3 text-sm">
          <span class="text-muted hidden sm:inline">{{ user.username }}</span>
          <UButton size="sm" variant="ghost" icon="i-lucide-log-out" @click="logout">Log out</UButton>
        </div>
      </div>
    </header>
    <main class="flex-1 mx-auto w-full max-w-5xl px-4 py-6">
      <slot />
    </main>
  </div>
</template>
