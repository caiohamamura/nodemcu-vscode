# Agent Skills Index

This directory contains custom Agent Skills that extend the capabilities of any
agent working on the `nodemcu-vscode` repository. Each skill lives in its own
subdirectory with a `SKILL.md` frontmatter file and (optionally) helper scripts
in `scripts/`.

> Skills are loaded on demand. If your host supports the `skill` tool, call
> `load_skill` with the skill's directory name. Otherwise, read the
> `SKILL.md` directly — they are written to be useful as standalone documents.

## Available skills

| Skill | Use it for |
| --- | --- |
| [`devtools-automation`](./devtools-automation/SKILL.md) | Drive a running VS Code Extension Development Host via Chrome DevTools Protocol. Inspect tree-view state, toggle module checkboxes, run command-palette commands, capture console logs. **The primary way to validate the NodeMCU sidebar UI end-to-end without a human in the loop.** |

## How to add a new skill

1. Create a new subdirectory under `.claude/SKILLS/`, e.g.
   `.claude/SKILLS/my-new-skill/`.
2. Add a `SKILL.md` with the YAML frontmatter `name` and `description` fields
   (the description is what the host uses to decide when to load the skill).
3. Add helper scripts under `scripts/` if the skill needs bundled assets.
4. Add a row to the table above so future agents know it exists.

Keep each `SKILL.md` focused: short rationale, clear preconditions, an
executable command list, and a "how it works under the hood" section for
debugging. Link to `AGENTS.md` for repo-wide context instead of duplicating it.
