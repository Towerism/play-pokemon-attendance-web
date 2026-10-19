<script setup lang="ts">
import type { ProfessorConnectionJson } from '~/utils/pokemon-connections';

const toast = useToast();
const { data } = await usePokemonConnection();
const { data: settings } = await useSettings();

// The owner sees every connection and picks the league; a professor sees and manages only their own (ADR-0015 §2, §8).
const isOwner = computed(() => settings.value?.access.role === 'owner');
const league = computed(() => data.value?.league ?? null);
const connections = computed(() => (data.value?.connections ?? []).filter((c) => isOwner.value || c.mine));
const mine = computed(() => connections.value.filter((c) => c.mine));
const waiting = computed(() =>
  waitingText(settings.value?.access.waiting ?? null, league.value?.displayName ?? null, mine.value[0] ? professorLabel(mine.value[0]) : null),
);
const formatDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
const badge = (c: ProfessorConnectionJson) =>
  c.status === 'connected' ? { label: 'Connected', color: 'success' as const } : { label: 'Needs reconnect', color: 'warning' as const };
const MEMBERSHIP = {
  member: { label: 'In the league', color: 'success' as const },
  outside: { label: 'Not in the league', color: 'warning' as const },
  unknown: { label: 'Checking the league', color: 'neutral' as const },
};
/** A professor holds at most one connection (ADR-0015 §2); the owner may add more. */
const canAdd = computed(() => isOwner.value || mine.value.length === 0);

// Connect (paste-back, architecture §4.2 a): open Pokémon's login, then paste the play-tools address.
// The login decides which account it is: a new one is added, the caller's own is reconnected, and the owner's moves to
// the professor logging in (ADR-0015 §2).
interface ConnectAttempt {
  authorizeUrl: string;
  expiresAt: string;
}
const attempt = ref<ConnectAttempt | null>(null);
/** Whose login the open attempt is meant for; null when adding a new account. */
const attemptFor = ref<string | null>(null);
const pasted = ref('');
const busy = ref(false);
/** Shown after a connect moved the owner's connection to this professor: the owner knew its password. */
const claimed = ref<string | null>(null);

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
    const result = await $fetch<{ connection: ProfessorConnectionJson; outcome: 'added' | 'reconnected' | 'claimed' }>('/api/pokemon/connect/complete', {
      method: 'POST',
      body: { url: pasted.value },
    });
    attempt.value = null;
    await Promise.all([refreshPokemonConnection(), refreshSettings()]);
    const who = professorShortLabel(result.connection);
    if (result.outcome === 'claimed') claimed.value = who;
    toast.add({ color: 'success', title: result.outcome === 'reconnected' ? `${who} reconnected` : `${who} added` });
    if (!league.value && isOwner.value) await openLeaguePicker();
  } catch (err) {
    const code = apiErrorCode(err);
    if (code === 'unknown_attempt' || code === 'expired' || code === 'code_rejected') attempt.value = null;
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not connect.') });
  } finally {
    busy.value = false;
  }
}

// The league (owner only): chosen from the leagues of the owner's own connections (ADR-0015 §3).
const picking = ref(false);
interface UpstreamLeague {
  activityGroupId: string;
  displayName: string;
  displayId: string | null;
}
const leagues = ref<UpstreamLeague[] | null>(null);
/** The owner's connections the picker leaves out until they reconnect. */
const excluded = ref<{ playerId: string | null; name: string | null }[]>([]);
const chosenId = ref<string | undefined>();
const leagueItems = computed(() =>
  (leagues.value ?? []).map((l) => ({ label: l.displayId ? `${l.displayName} (${l.displayId})` : l.displayName, value: l.activityGroupId })),
);

async function openLeaguePicker() {
  picking.value = true;
  leagues.value = null;
  excluded.value = [];
  chosenId.value = undefined;
  busy.value = true;
  try {
    const result = await $fetch<{ leagues: UpstreamLeague[]; selectedId: string | null; excluded: typeof excluded.value }>('/api/leagues/upstream');
    leagues.value = result.leagues;
    excluded.value = result.excluded;
    chosenId.value = result.selectedId ?? result.leagues[0]?.activityGroupId;
  } catch (err) {
    await refreshPokemonConnection();
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not load your leagues from play-tools.') });
  } finally {
    busy.value = false;
  }
}

async function saveLeague() {
  if (!chosenId.value) return;
  busy.value = true;
  try {
    const result = await $fetch<{ league?: { unchecked: number } }>('/api/settings', { method: 'PUT', body: { activityGroupId: chosenId.value } });
    picking.value = false;
    leagues.value = null;
    await refreshPokemonConnection();
    const unchecked = result.league?.unchecked ?? 0;
    toast.add(
      unchecked
        ? {
            color: 'warning',
            title: 'League saved',
            description: `${unchecked} Pokémon ${unchecked === 1 ? 'account' : 'accounts'} couldn't be checked yet. The app tries again within the hour.`,
          }
        : { color: 'success', title: 'League saved' },
    );
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the league.') });
  } finally {
    busy.value = false;
  }
}

// The display name (ADR-0008): display only, never sent to Pokémon; its holder or the owner sets it. Beside it, the full
// name, written into a TDF only when the app replaces the file's organizer (ADR-0011 decision 8); only its holder.
const renaming = ref<ProfessorConnectionJson | null>(null);
const nameDraft = ref('');
const fullNameDraft = ref('');

function startRename(c: ProfessorConnectionJson) {
  renaming.value = c;
  nameDraft.value = c.professorName ?? '';
  fullNameDraft.value = c.professorFullName ?? '';
}

async function saveName() {
  const c = renaming.value;
  if (!c) return;
  busy.value = true;
  try {
    const saved = await $fetch<ProfessorConnectionJson>(`/api/pokemon/connections/${c.professorPlayerId}`, {
      method: 'PATCH',
      body: c.mine ? { name: nameDraft.value, fullName: fullNameDraft.value } : { name: nameDraft.value },
    });
    renaming.value = null;
    await refreshPokemonConnection();
    toast.add({ color: 'success', title: saved.professorName || saved.professorFullName ? 'Names saved' : 'Names cleared' });
  } catch (err) {
    toast.add({ color: 'error', title: apiErrorMessage(err, 'Could not save the names.') });
  } finally {
    busy.value = false;
  }
}

async function disconnect(c: ProfessorConnectionJson) {
  const who = professorShortLabel(c);
  if (!window.confirm(`Disconnect ${who}?`)) return;
  busy.value = true;
  try {
    const { revoked } = await $fetch<{ revoked: boolean }>(`/api/pokemon/connections/${c.professorPlayerId}`, { method: 'DELETE' });
    await Promise.all([refreshPokemonConnection(), refreshSettings()]);
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
      <UAlert v-if="waiting" color="info" variant="subtle" icon="i-lucide-info" :title="waiting" data-testid="waiting" />
      <UAlert
        v-if="claimed"
        color="warning"
        variant="subtle"
        icon="i-lucide-key-round"
        :title="`${claimed} is yours now.`"
        description="Change its Pokémon password: someone else in this app had it."
        data-testid="claimed"
      />

      <p v-if="connections.length === 0" class="text-muted">
        {{
          isOwner
            ? 'Connect each of your Pokémon accounts once with its Pokémon Trainer Club login. The app keeps every connection alive on its own; passwords are only ever typed on Pokémon’s page.'
            : 'Connect your Pokémon account once with its Pokémon Trainer Club login. Your password is only ever typed on Pokémon’s page.'
        }}
      </p>

      <ul v-else class="divide-y divide-default rounded-md border border-default" aria-label="Connected professors">
        <li v-for="c in connections" :key="c.professorPlayerId ?? 'identifying'" class="space-y-2 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium">{{ professorLabel(c) }}</span>
            <UBadge :color="badge(c).color" variant="subtle">{{ badge(c).label }}</UBadge>
            <UBadge v-if="league" :color="MEMBERSHIP[c.membership].color" variant="subtle">{{ MEMBERSHIP[c.membership].label }}</UBadge>
            <UBadge v-if="c.membership === 'member' && !c.canSubmit" color="warning" variant="subtle">can't record attendance</UBadge>
            <UBadge v-if="isOwner && !c.mine" color="neutral" variant="outline">A professor's</UBadge>
          </div>
          <p v-if="c.status === 'needs_reconnect' && c.mine" class="text-warning">{{ c.reason ?? 'Pokémon no longer accepts this login.' }}</p>
          <p class="text-muted">Last refreshed {{ formatDate(c.lastRefreshedAt) }}</p>
          <p v-if="c.professorFullName" class="text-muted">Full name in TDFs: {{ c.professorFullName }}</p>
          <form v-if="renaming && renaming.professorPlayerId === c.professorPlayerId" class="space-y-2" @submit.prevent="saveName">
            <UFormField label="Display name" help="Shown in this app only; Pokémon never sees it. Leave empty to show the player ID.">
              <UInput
                v-model="nameDraft"
                class="w-full"
                maxlength="60"
                :placeholder="`Professor ${c.professorPlayerId}`"
                :aria-label="`Display name for ${professorLabel(c)}`"
                autocomplete="off"
              />
            </UFormField>
            <UFormField
              v-if="c.mine"
              label="Full name for TDFs"
              help="As play-tools has it. Written into a TDF only when the app replaces the file's organizer; that's the only way Pokémon gets it."
            >
              <UInput
                v-model="fullNameDraft"
                class="w-full"
                maxlength="100"
                :aria-label="`Full name for ${professorLabel(c)}`"
                autocomplete="off"
              />
            </UFormField>
            <div class="flex gap-2">
              <UButton type="submit" size="sm" :loading="busy">Save names</UButton>
              <UButton size="sm" variant="ghost" color="neutral" @click="renaming = null">Cancel</UButton>
            </div>
          </form>
          <div class="flex flex-wrap gap-2">
            <UButton
              v-if="c.mine"
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
              v-if="c.professorPlayerId && (c.mine || isOwner)"
              size="sm"
              variant="ghost"
              color="neutral"
              icon="i-lucide-pencil"
              :aria-label="`Rename ${professorLabel(c)}`"
              :disabled="busy"
              @click="startRename(c)"
            >
              Rename
            </UButton>
            <UButton
              v-if="c.professorPlayerId && c.mine"
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

      <dl v-if="connections.length && isOwner" class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt class="text-muted">League</dt>
        <dd>
          <template v-if="league">
            {{ league.displayName }}<span v-if="league.displayId" class="text-muted"> ({{ league.displayId }})</span>
          </template>
          <span v-else class="text-muted">Not chosen yet</span>
        </dd>
      </dl>

      <!-- Step 2 of connecting: the Pokémon login is open. -->
      <div v-if="attempt" class="space-y-3 rounded-md border border-default p-3">
        <ol class="list-decimal pl-5 space-y-2">
          <li>
            <UButton :to="attempt.authorizeUrl" target="_blank" external size="sm" icon="i-lucide-external-link">Open Pokémon login</UButton>
            and log in{{ attemptFor ? ` as ${attemptFor}` : isOwner ? ' as the account to add' : ' as yourself' }}.
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
        <USelect v-if="leagues?.length" v-model="chosenId" :items="leagueItems" class="w-full" aria-label="League" />
        <p v-if="leagues && leagues.length === 0" class="text-muted">{{ NO_LEAGUE }}</p>
        <p v-if="excludedText(excluded)" class="text-sm text-muted">{{ excludedText(excluded) }}</p>
        <div class="flex gap-2">
          <UButton v-if="!leagues || leagues.length" :loading="busy" :disabled="!chosenId" @click="saveLeague">Save league</UButton>
          <UButton variant="ghost" color="neutral" @click="picking = false">Cancel</UButton>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="!attempt && canAdd" :loading="busy && !picking" icon="i-lucide-user-plus" @click="startConnect(null)">
          {{ isOwner && connections.length ? 'Add Pokémon account' : 'Connect Pokémon account' }}
        </UButton>
        <UButton v-if="isOwner && mine.length && !picking" variant="outline" icon="i-lucide-store" :disabled="busy" @click="openLeaguePicker()">
          {{ league ? 'Change league' : 'Choose league' }}
        </UButton>
      </div>
    </template>
  </UCard>
</template>
