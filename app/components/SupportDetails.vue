<script setup lang="ts">
import type { SupportDetails } from '../../server/modules/submission/service';

/**
 * The copyable block for Pokémon support on a refused tournament action (ADR-0010 decision 7): exactly the support
 * fields, never a token, a request body or player data.
 */
const props = defineProps<{ support: SupportDetails }>();
const toast = useToast();
const text = computed(() => supportText(props.support));
const id = useId();
const pre = useTemplateRef<HTMLPreElement>('pre');

async function copy() {
  try {
    await navigator.clipboard.writeText(text.value);
    toast.add({ color: 'success', title: 'Copied' });
  } catch {
    // No clipboard (an insecure context, or permission refused): select the text for the organizer to copy.
    const range = document.createRange();
    if (pre.value) range.selectNodeContents(pre.value);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    toast.add({ color: 'neutral', title: 'Select and copy the text' });
  }
}
</script>

<template>
  <details class="text-sm">
    <summary class="cursor-pointer text-muted">Support details</summary>
    <section :aria-labelledby="id" class="mt-2 space-y-2">
      <h4 :id="id" class="sr-only">Support details</h4>
      <pre ref="pre" class="whitespace-pre-wrap break-words rounded bg-elevated p-2 text-xs">{{ text }}</pre>
      <UButton size="xs" variant="outline" icon="i-lucide-copy" @click="copy">Copy support details</UButton>
    </section>
  </details>
</template>
