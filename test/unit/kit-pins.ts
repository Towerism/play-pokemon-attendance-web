/**
 * A kit reusable-workflow reference: `uses: Towerism/selfhost-kit/.github/workflows/<file>@<ref><rest of line>`,
 * quoted or not, with the owner in any case (GitHub accepts both), so a restyled line can't slip past the check.
 */
const KIT_USE = /^\s*(?:-\s+)?uses:\s*['"]?towerism\/selfhost-kit\/\.github\/workflows\/([^\s'"]+?)@([^\s'"]+)['"]?(.*)$/gim;
const PINNED = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s+#\s+v(\d+\.\d+\.\d+)\s*$/;

/**
 * Why the kit pins disagree, or `[]` when package.json's exact version and every kit `uses:` line in the given
 * workflows (one commit SHA, commented with that same version) move together.
 */
export function kitPinProblems({ kitVersion, workflows }: { kitVersion: string | undefined; workflows: Record<string, string> }): string[] {
  const problems: string[] = [];
  if (!kitVersion || !/^\d+\.\d+\.\d+$/.test(kitVersion)) {
    problems.push(`package.json's @towerism/selfhost-kit "${kitVersion}" is not an exact version`);
  }

  const shas = new Set<string>();
  let uses = 0;
  for (const [file, text] of Object.entries(workflows)) {
    for (const [, workflow, ref, rest] of text.matchAll(KIT_USE)) {
      uses++;
      const where = `${file}: ${workflow}`;
      const version = rest!.match(VERSION_COMMENT)?.[1];
      if (!PINNED.test(ref!) || !version) {
        problems.push(`${where} is not pinned by a full commit SHA with a "# vX.Y.Z" comment (@${ref}${rest})`);
        continue;
      }
      shas.add(ref!);
      if (version !== kitVersion) problems.push(`${where} is commented v${version}, but package.json has ${kitVersion}`);
    }
  }
  if (uses === 0) problems.push('no workflow uses a Towerism/selfhost-kit reusable workflow');
  if (shas.size > 1) problems.push(`kit workflows are pinned to different commits: ${[...shas].join(', ')}`);
  return problems;
}
