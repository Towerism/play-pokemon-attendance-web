<script setup lang="ts">
const { user, clear } = useUserSession();

async function logout() {
  await $fetch('/api/auth/logout', { method: 'POST' });
  await clear();
  await navigateTo('/login');
}
</script>

<template>
  <div class="min-h-dvh flex flex-col">
    <header class="border-b border-default">
      <div class="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between gap-4">
        <NuxtLink to="/" class="font-semibold">League attendance</NuxtLink>
        <div v-if="user" class="flex items-center gap-3 text-sm">
          <span class="text-muted">{{ user.username }}</span>
          <UButton size="sm" variant="ghost" icon="i-lucide-log-out" @click="logout">Log out</UButton>
        </div>
      </div>
    </header>
    <main class="flex-1 mx-auto w-full max-w-5xl px-4 py-6">
      <slot />
    </main>
  </div>
</template>
