# Issue tracker: Beads / bd

Issues and PRDs are tracked with Beads using the `bd` CLI.

Beads stores issues in a local Dolt database under `.beads/`. Cross-machine sync uses `bd dolt push` / `bd dolt pull`. `.beads/issues.jsonl` is a passive export, not the source of truth.

## Commands

- Create an issue: `bd create "Title" -d "Body"`
- Show an issue: `bd show <id>`
- List ready work: `bd ready`
- Claim work: `bd update <id> --claim`
- Close work: `bd close <id>`
- Add a blocking dependency: `bd dep add <issue> <blocker>`
- Sync issues: `bd dolt pull` and `bd dolt push`

## When a skill says "publish to the issue tracker"

Use `bd create`.

For PRDs, create a Beads issue whose body contains the full PRD.

For implementation slices, create one Beads issue per approved vertical slice. Publish blockers first so later issues can reference their IDs.

## Dependencies

When one issue is blocked by another, create the issues first, then run:

```bash
bd dep add <blocked-issue> <blocking-issue>
```

## Triage state

Use the vocabulary in `docs/agents/triage-labels.md`. If Beads labels/tags are unavailable or unclear, include the triage role in the issue body.
