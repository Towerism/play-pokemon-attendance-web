<script setup lang="ts">
import type { ProfessorConnectionJson } from '~/utils/pokemon-connections';

const toast = useToast();
const { data } = await usePokemonConnection();

const connections = computed(() => data.value?.connections ?? []);
const league = computed(() => data.value?.league ?? null);
const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
const badge = (c: ProfessorConnectionJson) =>
  c.status === 'connected' ? { label: 'Connected', color: 'success' as const } : { label: 'Needs reconnect', color: 'warning' as const };

// Connect (paste-back, architecture §4.2 a): open Pokémon's login, then paste the play-tools address.
// The login decides which professor it is: a new one is added, a known one is reconnected (ADR-0008).
interface ConnectAttempt {
  authorizeUrl: string;
  expiresAt: string;
}
const attempt = ref<ConnectAttempt | null>(null);
/** Whose login the open attempt is meant for; null when adding a new professor. */
const attemptFor = ref<string | null>(null);
const pasted = ref('');
const busy = ref(false);

async function startConnect(forLabel: string | null = null) {
  busy.value = true;
  try {
    // Explicit type: inferring this route's response trips vue-tsc's recursion limit.
    attempt.value = await $fetch<ConnectAttempt>('/api/pokemon/connect/start', { method: 'POST', body: {} });
    attemptFor.value = forLabel;
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
    const result = await $fetch<{ connection: ProfessorConnectionJson; outcome: 'added' | 'reconnected' }>('/api/pokemon/connect/complete', {
      method: 'POST',
      body: { url: pasted.value },
    });
    attempt.value = null;
    await refreshPokemonConnection();
    const who = professorLabel(result.connection);
    toast.add({ color: 'success', title: result.outcome === 'added' ? `${who} added` : `${who} reconnected` });
    if (!league.value) await openLeaguePicker(result.connection.professorPlayerId);
  } catch (err) {
    const code = apiErrorCode(err);
    if (code === 'unknown_attempt' || code === 'expired' || code === 'code_rejected') attempt.value = null;
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not connect.') });
  } finally {
    busy.value = false;
  }
}

// The league binding: which professor submits, and to which of their play-tools leagues.
const picking = ref(false);
const professorId = ref<string | undefined>();
const leagues = ref<{ activityGroupId: string; displayName: string; displayId: string | null; canSubmit: boolean }[] | null>(null);
const chosenId = ref<string | undefined>();
const professorItems = computed(() =>
  connections.value
    .filter((c) => c.professorPlayerId && c.status === 'connected')
    .map((c) => ({ label: professorLabel(c), value: c.professorPlayerId! })),
);
const leagueItems = computed(() =>
  (leagues.value ?? []).map((l) => ({ label: l.displayId ? `${l.displayName} (${l.displayId})` : l.displayName, value: l.activityGroupId })),
);
const chosen = computed(() => leagues.value?.find((l) => l.activityGroupId === chosenId.value));

async function openLeaguePicker(preferred: string | null = null) {
  picking.value = true;
  professorId.value = preferred ?? league.value?.professorPlayerId ?? professorItems.value[0]?.value;
  await loadLeagues();
}

async function loadLeagues() {
  leagues.value = null;
  chosenId.value = undefined;
  if (!professorId.value) return;
  busy.value = true;
  try {
    const result = await $fetch<{ leagues: NonNullable<typeof leagues.value>; selectedId: string | null }>('/api/leagues/upstream', {
      query: { professor: professorId.value },
    });
    leagues.value = result.leagues;
    chosenId.value = result.selectedId ?? result.leagues[0]?.activityGroupId;
  } catch (err) {
    if (apiErrorCode(err) === 'needs_reconnect') await refreshPokemonConnection();
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not load that professor’s leagues from play-tools.') });
  } finally {
    busy.value = false;
  }
}

async function saveLeague() {
  if (!professorId.value || !chosenId.value) return;
  busy.value = true;
  try {
    await $fetch('/api/settings', { method: 'PUT', body: { professorPlayerId: professorId.value, activityGroupId: chosenId.value } });
    picking.value = false;
    leagues.value = null;
    await refreshPokemonConnection();
    toast.add({ color: 'success', title: 'League saved' });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the league.') });
  } finally {
    busy.value = false;
  }
}

async function disconnect(c: ProfessorConnectionJson) {
  const who = professorLabel(c);
  const warning = c.submitsForLeague ? ' Attendance won’t go in until another professor is chosen for the league.' : '';
  if (!window.confirm(`Disconnect ${who}?${warning}`)) return;
  busy.value = true;
  try {
    const { revoked } = await $fetch<{ revoked: boolean }>(`/api/pokemon/connections/${c.professorPlayerId}`, { method: 'DELETE' });
    await refreshPokemonConnection();
    toast.add(
      revoked ? { title: `${who} disconnected` } : { color: 'warning', title: `${who} disconnected here, but Pokémon could not be reached to revoke the login.` },
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
        <h2 class="font-semibold">Pokémon accounts</h2>
        <UBadge v-if="connections.length" color="neutral" variant="subtle">{{ connections.length }} connected</UBadge>
        <UBadge v-else color="neutral" variant="subtle">Not connected</UBadge>
      </div>
    </template>

    <div class="space-y-4 text-sm">
      <p v-if="connections.length === 0" class="text-muted">
        Connect each professor once with their Pokémon Trainer Club login. The app keeps every connection alive on its own; passwords
        are only ever typed on Pokémon's page.
      </p>

      <ul v-else class="divide-y divide-default rounded-md border border-default" aria-label="Connected professors">
        <li v-for="c in connections" :key="c.professorPlayerId ?? 'identifying'" class="space-y-2 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ professorLabel(c) }}</span>
            <UBadge :color="badge(c).color" variant="subtle">{{ badge(c).label }}</UBadge>
            <UBadge v-if="c.submitsForLeague" color="primary" variant="subtle">Submits attendance</UBadge>
          </div>
          <p v-if="c.status === 'needs_reconnect'" class="text-warning">{{ c.reason ?? 'Pokémon no longer accepts this login.' }}</p>
          <p class="text-muted">Last refreshed {{ formatDate(c.lastRefreshedAt) }}</p>
          <div class="flex flex-wrap gap-2">
            <UButton
              size="sm"
              variant="outline"
              icon="i-lucide-plug"
              :aria-label="`Reconnect ${professorLabel(c)}`"
              :disabled="busy || !!attempt"
              @click="startConnect(professorLabel(c))"
            >
              Reconnect
            </UButton>
            <UButton
              v-if="c.professorPlayerId"
              size="sm"
              variant="ghost"
              color="error"
              icon="i-lucide-unplug"
              :aria-label="`Disconnect ${professorLabel(c)}`"
              :disabled="busy"
              @click="disconnect(c)"
            >
              Disconnect
            </UButton>
          </div>
        </li>
      </ul>

      <dl v-if="connections.length" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">League</dt>
        <dd>
          <template v-if="league">
            {{ league.displayName }}<span v-if="league.displayId" class="text-muted"> ({{ league.displayId }})</span>
            <UBadge v-if="!league.canSubmit" color="warning" variant="subtle" class="ml-2">can't record attendance</UBadge>
          </template>
          <span v-else class="text-muted">Not chosen yet</span>
        </dd>
      </dl>

      <!-- Step 2 of connecting: the organizer has opened Pokémon's login. -->
      <div v-if="attempt" class="space-y-3 rounded-md border border-default p-3">
        <ol class="list-decimal pl-5 space-y-2">
          <li>
            <UButton :to="attempt.authorizeUrl" target="_blank" external size="sm" icon="i-lucide-external-link">Open Pokémon login</UButton>
            and log in{{ attemptFor ? ` as ${attemptFor}` : ' as the professor to add' }}.
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

      <div v-if="picking" class="space-y-2 rounded-md border border-default p-3">
        <div class="flex flex-col sm:flex-row gap-2">
          <USelect v-model="professorId" :items="professorItems" class="flex-1" aria-label="Professor who submits attendance" @update:model-value="loadLeagues" />
          <USelect v-if="leagues?.length" v-model="chosenId" :items="leagueItems" class="flex-1" aria-label="League" />
        </div>
        <p v-if="leagues && leagues.length === 0" class="text-muted">This professor doesn't manage any league in play-tools.</p>
        <p v-if="chosen && !chosen.canSubmit" class="text-warning">This professor can't record attendance for that league.</p>
        <div class="flex gap-2">
          <UButton :loading="busy" :disabled="!professorId || !chosenId" @click="saveLeague">Save league</UButton>
          <UButton variant="ghost" color="neutral" @click="picking = false">Cancel</UButton>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="!attempt" :loading="busy && !picking" icon="i-lucide-user-plus" @click="startConnect(null)">
          {{ connections.length ? 'Add Pokémon account' : 'Connect Pokémon account' }}
        </UButton>
        <UButton v-if="professorItems.length && !picking" variant="outline" icon="i-lucide-store" :disabled="busy" @click="openLeaguePicker()">
          {{ league ? 'Change league' : 'Choose league' }}
        </UButton>
      </div>
    </template>
  </UCard>
</template>
