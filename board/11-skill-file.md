# 11 — Skill file

Phase 1. Manual §10.

## Goal

`SKILL.md` that makes Claude Code, Codex and Cursor behave correctly in a
checkout.

## Scope

- Write the skill: pull first, branch, commit, never edit frontmatter, index or
  placeholders, never push unless asked, how to read `docsync status`.
- Write it to `.agents/skills/docsync/`, `.claude/skills/docsync/`,
  `.cursor/skills/docsync/`; exclude via `info/exclude`; refresh on every
  command and helper run when content differs.
- Try it with each of the three agents on a sample checkout and fix what they
  get wrong.

## Done when

All three agents, given "update the Auth spec to say X", pull, edit the right
file, commit on a branch, and stop before pushing.
