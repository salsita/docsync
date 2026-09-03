/**
 * The skill file every checkout carries (MANUAL §10).
 *
 * Ticket 11 fills this in: compare the three copies (`.agents/`, `.claude/`,
 * `.cursor/`) with the bundled one and rewrite the ones that differ, excluded
 * from git through `.git/info/exclude`. Until then the helper and the CLI
 * already call it at the start of every run, so that the call site is in
 * place and the refresh lands by changing this one function.
 */

/** Brings the skill files under `worktree` up to date. A no-op for now. */
export async function refreshSkillFiles(worktree: string): Promise<void> {
  void worktree;
}
