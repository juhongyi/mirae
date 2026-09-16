Keep code, names, and responsibilities clear; modules focused; boundaries and dependencies explicit.\
Apply OOP, modular design, SRP, DRY, KISS, and YAGNI; maintain high cohesion and low coupling.\
Use TDD for behavior changes; cover meaningful success, failure, boundary, and edge cases.\
Run focused tests and the full suite; fix regressions; report unrelated failures.\
Make atomic, reviewable commits.

Development environment: all development runs in the Compose environment defined in compose.yaml.\
If a port conflicts, override it with a temporary port so other containers and resources are not disturbed and work does not collide.

Before editing: `git fetch origin`; ask the user for a base branch; work only in a new Git worktree.\
`git worktree add -b <new-branch> "$HOME/.local/share/opencode/worktree/<project-id>/<hash>" <base-branch>`; use the project directory name and a random 6-digit hex.

PRs: English titles; clear, concise Korean bodies that respect reviewers' time by providing enough context.\
Commit and PR titles must be natural English sentences, not prefixed with tags such as `feat:` or `docs:`.
---

## n8n workflow development

Workflow orchestration runs in the `n8n` Compose service; the instance-level MCP server is enabled via `N8N_MCP_MANAGED_BY_ENV`/`N8N_MCP_ACCESS_ENABLED` in compose.yaml. Build workflows through the n8n MCP builder path (not raw JSON), in this order: `get_workflow_sdk_reference` → `search_nodes`/`get_node_types` → write SDK code → `create_workflow_from_code` → `test_workflow` (pin data) / `execute_workflow` (real HTTP calls) → `publish_workflow` → `get_workflow_execution`. Commit workflow SDK sources under `n8n/workflows/` as plain TypeScript with imports; they are the source of truth.

Local harness (pnpm, runs on the host): `pnpm install` registers the lefthook pre-commit hook and installs the pinned SDK deps (`@n8n/workflow-sdk`/`n8n-nodes-base` versions match the n8n image). `pnpm validate` runs workflow-sdk validation over `n8n/workflows/*.ts`; `pnpm check` runs Biome (format + lint + import). The pre-commit hook runs `pnpm check` then `pnpm validate`.

Bootstrap (manual, once per instance): create the MCP bearer token and the REST API key in the n8n UI. Notes: HTTP Request nodes are pinned in `test_workflow`, so verify real calls with `execute_workflow`; `validate_workflow` is permissive, so confirm wiring with `get_workflow_details`; runtime MCP (exposing workflows as tools to external agents) is out of scope.
