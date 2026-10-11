<script setup lang="ts">
const toast = useToast();
const { data: connection } = await usePokemonConnection();

const status = computed(() => connection.value?.status ?? 'not_connected');
const badge = computed(
  () =>
    ({
      connected: { label: 'Connected', color: 'success' as const },
      needs_reconnect: { label: 'Needs reconnect', color: 'warning' as const },
      not_connected: { label: 'Not connected', color: 'neutral' as const },
    })[status.value],
);
const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

// Connect (paste-back, architecture §4.2 a): open Pokémon's login, then paste the play-tools address.
interface ConnectAttempt {
  authorizeUrl: string;
  expiresAt: string;
}
const attempt = ref<ConnectAttempt | null>(null);
const pasted = ref('');
const busy = ref(false);

async function startConnect() {
  busy.value = true;
  try {
    // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
    attempt.value = await $fetch<ConnectAttempt>('/api/pokemon/connect/start', { method: 'POST', body: {} });
    pasted.value = '';
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not start the connection.') });
  } finally {
    busy.value = false;
  }
}

async function completeConnect() {
  busy.value = true;
  try {
    const result = await $fetch('/api/pokemon/connect/complete', { method: 'POST', body: { url: pasted.value } });
    attempt.value = null;
    await refreshPokemonConnection();
    toast.add({ color: 'success', title: result.league ? `Connected to ${result.league.name}` : 'Connected. Now pick your league.' });
    if (!result.league) await loadLeagues();
  } catch (err) {
    const code = apiErrorCode(err);
    if (code === 'unknown_attempt' || code === 'expired' || code === 'code_rejected') attempt.value = null;
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not connect.') });
  } finally {
    busy.value = false;
  }
}

// League discovery: which play-tools league attendance goes to.
const leagues = ref<{ id: string; name: string; displayId: string | null; canSubmit: boolean }[] | null>(null);
const chosenId = ref<string | undefined>();
const leagueItems = computed(() =>
  (leagues.value ?? []).map((l) => ({ label: l.displayId ? `${l.name} (${l.displayId})` : l.name, value: l.id })),
);
const chosen = computed(() => leagues.value?.find((l) => l.id === chosenId.value));

async function loadLeagues() {
  busy.value = true;
  try {
    const result = await $fetch('/api/leagues/upstream');
    leagues.value = result.leagues;
    chosenId.value = result.selectedId ?? result.leagues[0]?.id;
  } catch (err) {
    if (apiErrorCode(err) === 'needs_reconnect') await refreshPokemonConnection();
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not load your leagues from play-tools.') });
  } finally {
    busy.value = false;
  }
}

async function saveLeague() {
  if (!chosenId.value) return;
  busy.value = true;
  try {
    await $fetch('/api/settings', { method: 'PUT', body: { activityGroupId: chosenId.value } });
    leagues.value = null;
    await refreshPokemonConnection();
    toast.add({ color: 'success', title: 'League saved' });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the league.') });
  } finally {
    busy.value = false;
  }
}

async function disconnect() {
  if (!window.confirm('Disconnect the Pokémon account? Submitting attendance will need a new connection.')) return;
  busy.value = true;
  try {
    const { revoked } = await $fetch('/api/pokemon/connection', { method: 'DELETE' });
    leagues.value = null;
    attempt.value = null;
    await refreshPokemonConnection();
    toast.add(
      revoked
        ? { title: 'Pokémon account disconnected' }
        : { color: 'warning', title: 'Disconnected here, but Pokémon could not be reached to revoke the login.' },
    );
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not disconnect.') });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-3">
        <h2 class="font-semibold">Pokémon account</h2>
        <UBadge :color="badge.color" variant="subtle">{{ badge.label }}</UBadge>
      </div>
    </template>

    <div class="space-y-4 text-sm">
      <UAlert
        v-if="status === 'needs_reconnect'"
        color="warning"
        variant="subtle"
        icon="i-lucide-plug-zap"
        title="Pokémon no longer accepts the saved login"
        :description="connection?.reason ?? 'Reconnect to keep submitting attendance.'"
      />

      <dl v-if="status !== 'not_connected'" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">League</dt>
        <dd>
          <template v-if="connection?.league">
            {{ connection.league.name }}<span v-if="connection.league.displayId" class="text-muted"> ({{ connection.league.displayId }})</span>
            <UBadge v-if="!connection.league.canSubmit" color="warning" variant="subtle" class="ml-2">can't record attendance</UBadge>
          </template>
          <span v-else class="text-muted">Not chosen yet</span>
        </dd>
        <dt class="text-muted">Connected</dt>
        <dd>{{ formatDate(connection?.connectedAt) }}</dd>
        <dt class="text-muted">Last refreshed</dt>
        <dd>{{ formatDate(connection?.lastRefreshedAt) }}</dd>
      </dl>
      <p v-else class="text-muted">
        Connect once with your Pokémon Trainer Club login. The app keeps the connection alive on its own; your password is
        only ever typed on Pokémon's page.
      </p>

      <!-- Step 2 of connecting: the organizer has opened Pokémon's login. -->
      <div v-if="attempt" class="space-y-3 rounded-md border border-default p-3">
        <ol class="list-decimal pl-5 space-y-2">
          <li>
            <UButton :to="attempt.authorizeUrl" target="_blank" external size="sm" icon="i-lucide-external-link">Open Pokémon login</UButton>
            and log in.
          </li>
          <li>
            You'll land on <strong>play-tools.pokemon.com</strong>. Copy the <strong>whole address</strong> from that tab's address
            bar and paste it here within 10 minutes.
          </li>
        </ol>
        <form class="flex flex-col sm:flex-row gap-2" @submit.prevent="completeConnect">
          <UInput
            v-model="pasted"
            class="flex-1"
            placeholder="https://play-tools.pokemon.com/loggedIn?code=…"
            aria-label="Address of the play-tools tab after logging in"
            autocomplete="off"
          />
          <UButton type="submit" :loading="busy" :disabled="!pasted.trim()">Finish connecting</UButton>
          <UButton variant="ghost" color="neutral" @click="attempt = null">Cancel</UButton>
        </form>
      </div>

      <div v-if="leagues" class="space-y-2 rounded-md border border-default p-3">
        <p v-if="leagues.length === 0" class="text-muted">This Pokémon account doesn't manage any league in play-tools.</p>
        <template v-else>
          <div class="flex flex-col sm:flex-row gap-2">
            <USelect v-model="chosenId" :items="leagueItems" class="flex-1" aria-label="League" />
            <UButton :loading="busy" :disabled="!chosenId" @click="saveLeague">Save league</UButton>
            <UButton variant="ghost" color="neutral" @click="leagues = null">Cancel</UButton>
          </div>
          <p v-if="chosen && !chosen.canSubmit" class="text-warning">This account can't record attendance for that league.</p>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="!attempt" :loading="busy && !leagues" icon="i-lucide-plug" @click="startConnect">
          {{ status === 'not_connected' ? 'Connect Pokémon account' : 'Reconnect' }}
        </UButton>
        <UButton v-if="status === 'connected' && !leagues" variant="outline" icon="i-lucide-store" :loading="busy" @click="loadLeagues">
          {{ connection?.league ? 'Change league' : 'Choose league' }}
        </UButton>
        <UButton v-if="status !== 'not_connected'" variant="ghost" color="error" icon="i-lucide-unplug" :disabled="busy" @click="disconnect">
          Disconnect
        </UButton>
      </div>
    </template>
  </UCard>
</template>
