<script setup lang="ts">
const { user, clear } = useUserSession();

const links = [
  { to: '/', label: 'This week' },
  { to: '/regulars', label: 'Regulars' },
  { to: '/players', label: 'Players' },
  { to: '/history', label: 'History' },
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

// Phones get the links in a drawer (below `sm`); any navigation closes it as soon as the URL changes.
// The layout's `useRoute()` only follows once the new page has loaded, which would close a drawer
// opened in between, so this watches the router's route instead.
const menuOpen = ref(false);
const route = useRoute();
const router = useRouter();
watch(
  () => router.currentRoute.value.fullPath,
  () => {
    menuOpen.value = false;
  },
);

/** The drawer's links say which page is open; `/` matches exactly, the rest by prefix, like the active highlight. */
function isCurrent(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path === to || route.path.startsWith(`${to}/`);
}

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
          <NuxtLink to="/" class="font-semibold truncate">League attendance</NuxtLink>
          <nav v-if="user" class="hidden sm:flex items-center gap-1 text-sm">
            <UButton v-for="link in links" :key="link.to" :to="link.to" :exact="link.to === '/'" size="sm" variant="ghost" color="neutral" active-color="primary" active-variant="soft">
              {{ link.label }}
            </UButton>
          </nav>
        </div>
        <div v-if="user" class="hidden sm:flex items-center gap-3 text-sm">
          <span class="text-muted">{{ user.username }}</span>
          <UButton size="sm" variant="ghost" icon="i-lucide-log-out" @click="logout">Log out</UButton>
        </div>
        <USlideover
          v-if="user"
          v-model:open="menuOpen"
          title="Menu"
          description="Pages and account"
          class="sm:hidden"
          :ui="{ content: 'max-w-[85vw]', description: 'sr-only' }"
        >
          <UButton icon="i-lucide-menu" variant="ghost" color="neutral" aria-label="Open menu" class="min-h-11 min-w-11 justify-center" />

          <template #close="{ ui }">
            <UButton icon="i-lucide-x" variant="ghost" color="neutral" aria-label="Close menu" :class="ui.close({ class: 'min-h-11 min-w-11 justify-center' })" />
          </template>

          <template #body>
            <nav class="flex flex-col gap-1">
              <UButton
                v-for="link in links"
                :key="link.to"
                :to="link.to"
                :exact="link.to === '/'"
                :aria-current="isCurrent(link.to) ? 'page' : undefined"
                size="lg"
                variant="ghost"
                color="neutral"
                active-color="primary"
                active-variant="soft"
                block
                class="min-h-11 justify-start"
              >
                {{ link.label }}
              </UButton>
            </nav>
            <div class="mt-6 pt-4 border-t border-default flex flex-col gap-2">
              <span class="text-sm text-muted truncate">{{ user.username }}</span>
              <UButton size="lg" variant="ghost" icon="i-lucide-log-out" block class="min-h-11 justify-start" @click="logout">Log out</UButton>
            </div>
          </template>
        </USlideover>
      </div>
    </header>
    <main class="flex-1 mx-auto w-full max-w-5xl px-4 py-6">
      <slot />
    </main>
  </div>
</template>
