# Diagrams

Last verified: 2026-06-07

Mermaid diagrams are required repo documentation. Keep source diagrams here and rendered PNG outputs under `docs/generated/diagrams/`.

## Scope Rule

Agents must decide the needed diagram set from the repository's real complexity:

- Use one overview diagram only when it honestly captures the repo.
- Add separate diagrams when architecture, data flow, state transitions, deployment, user flows, integrations, memory/rules, or verification paths would otherwise be compressed beyond usefulness.
- Prefer several precise diagrams over one dense diagram.

## Validation Rule

A diagram is valid only after Mermaid CLI renders it to PNG and the PNG bytes are decoded as an image. Syntax-only checks, generated-file existence, and metadata inspection are not enough.

Run:

```bash
python3 /Users/davidmontgomery/.agents/skills/agents-context-bootstrap/scripts/bootstrap_agent_context.py --repo . --validate-mermaid
```

## Current Diagram Set

- `repo-overview.mmd` — repo-local agent context and verification loop.
- `live-data-flow.mmd` — live worker, sidecar, adapter runs, API, and Live page
  data flow.
- `pbp-revision-model.mmd` — replay-safe NBA PBP revision model.
- `docs-refresh-gate.mmd` — commit-time docs/memory/instruction freshness gate.
