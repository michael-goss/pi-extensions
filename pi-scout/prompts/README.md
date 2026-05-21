# pi-scout prompt surfaces

This directory contains the text that controls how the `pi_scout` extension presents itself to the parent model and how the child scout agent behaves.

## `tool-description.md`

**Addressed to:** the parent model, as tool metadata.

**Purpose:** tells the parent model what the `pi_scout` tool does and when it is appropriate to call it. This should be concise but specific enough that the model chooses scout instead of doing broad exploration in the parent context.

## `tool-snippet.md`

**Addressed to:** the parent model, in the short available-tools prompt listing.

**Purpose:** one-line reminder of the tool's capability. Keep this short.

## `tool-guidelines.md`

**Addressed to:** the parent model, as extra tool-specific behavioral guidance.

**Purpose:** nudges the parent toward good orchestration: call scout before broad exploration, provide a concrete brief, and wait for results. Use bullet lines; blank lines and `#` comments are ignored by the extension.

## `parent-turn-injection.md`

**Addressed to:** the parent model, appended to the system prompt at the start of each user turn.

**Purpose:** persistent context-hygiene reminder. This is stronger than the tool description because it appears in the turn instructions even before the model decides what tools to use. Keep it short to avoid prompt bloat.

## `scout-system.md`

**Addressed to:** the child scout model as its system prompt.

**Purpose:** defines the scout's identity and hard role boundary. This should stay stable and high-level: read-only reconnaissance, compact evidence-backed handoff, no implementation.

## `scout-task-template.md`

**Addressed to:** the child scout model as the user prompt for each scout run.

**Purpose:** wraps the parent-provided task, goal, and optional scope into a full scouting assignment and output contract. Supports placeholders:

- `{{task}}` — problem description from the parent
- `{{goal}}` — requested end state, or the default goal
- `{{scope}}` — Markdown bullet list of paths/symbols/areas, or empty text
