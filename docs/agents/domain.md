# Domain Docs

Use single-context domain docs by default.

When working in a repo, first look for:

- `CONTEXT.md` at the repo root
- `docs/adr/` at the repo root

If these files do not exist, proceed silently.

The global Pi config may also contain domain guidance, but repo-local docs take precedence.

Use vocabulary from `CONTEXT.md` when writing PRDs, issue titles, acceptance criteria, tests, and architecture notes.

If your output contradicts an ADR, call that out explicitly.
