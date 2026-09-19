# Provider parity and recovery — 2026-09-19

Status: implementation proposed in a branch; not deployed. Risk HIGH.

## Architecture and actual capability boundary

`providers.ts` adapts GPT, Claude, Gemini and legacy DeepSeek using their documented OpenAI-compatible function-calling interfaces. `capabilities.ts` owns the one tool loop, dispatch, argument validation and budgets. `agent.ts` performs MAIN/PR review using that loop; `implementation.ts` uses it to read pinned files and produce complete UTF-8 file changes. Adapters never receive GitHub or Slack credentials.

GPT/Claude/Gemini have the same read/review/propose/branch/commit/draft-PR capabilities, same budgets and authorization gates. Deploy separate instances with AI_PROVIDER and the corresponding API key and explicit model; each has its own Slack bot identity. DeepSeek remains read-only at the implementation entry point. This is parity of service capabilities, not of model intelligence or the native Codex/Claude desktop tools. No arbitrary shell, deletion, binary editing, streaming or native provider-only tools are exposed. The service does not execute generated code: tests/build must run in trusted isolated CI before approval, and generated PRs explicitly say they are unverified.

Official transport references: https://ai.google.dev/gemini-api/docs/openai and https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk . Only the common text/function-calling subset is used. Model identifiers must be configured explicitly for new providers. Contract tests use fake HTTP responses; live provider compatibility and credentials still need a controlled staging smoke before activation. Legacy DeepSeek base URL overrides are removed: credentials only go to the fixed provider endpoint. The legacy phase-0 onboarding marker remains DeepSeek-specific; it is not part of the implementation/review parity contract.

## GitHub and Slack authorization

GITHUB_TOKEN: fine-grained, only the configured repository, Contents read, Pull requests read, Checks read, implicit Metadata read. No write fallback.
GITHUB_WRITE_TOKEN: separate repository-scoped GitHub App installation token or fine-grained PAT, Contents write and Pull requests write only. No Administration, Actions write, Workflows write, secrets or deployment permissions. Installation tokens must be renewed externally; this service does not mint them. Never copy the broad Codex/user PAT into the reviewer.

Contents write alone is not branch-scoped: configure repository rulesets to reject this identity's writes to main/protected branches, without bypass. GitHub Pull requests write can permit merging; repository protections and separate identities remain essential even though this code exposes no merge API. Use the exact target repo, not account-wide installation access. Review-only instances must not receive the write credential.

IMPLEMENT additionally requires IMPLEMENT_ENABLED=true, an explicit IMPLEMENT_SLACK_USER_IDS allowlist and IMPLEMENT_CHECKPOINT_DIR on durable storage. Slack Events signatures and timestamp replay validation remain in place. Polling revalidates root message author and ignores bot messages for writes. There is no trust escalation based on the provider's text or repository content. PATHS is an exact caller-supplied allowlist; traversal, .env, .git, .github, invalid tree entries and >200 KB changes are rejected. Each task creates only its deterministic ai/implement-* branch. No update-ref, force push, merge or deploy operation exists in the writer.

## Protocol

Root message from an authorized human in the configured channel:

```
GEMINI — ACCIÓN REQUERIDA
MODE: IMPLEMENT
HEAD: <40 lowercase hex characters of current main>
TASK: Concrete bounded change
PATHS: docs/example.md,src/example.ts
ACCEPTANCE: Expected behavior, validation and edge cases
```

Use GPT or CLAUDE as label for those instances. Fields are single-line, unique and mandatory. At most 20 paths, 8 model rounds, 20 calls per round, 100 KB/read and 500 KB context. Empty/malformed/truncated/refused responses or budget exhaustion fail, never become success. The request hash is the durable task identity; replay the identical text to resume. New scope/base requires a new task.

Review protocol stays MODE: PR + standalone PR #N + HEAD: full SHA, or MODE: MAIN + TARGET: main + full HEAD. Historical mentions remain accepted. Short SHAs now fail closed. File reads are pinned by the host; PR HEAD/base are checked around context capture and HEAD checked before publication. The verdict records the reviewed full SHA; a subsequent push invalidates approval. No silence, error, timeout or incomplete output counts as approval. Polling correlates a terminal response to target and SHA, not just a later bot message.

## Checkpoints and restart

The checkpoint stores proposed files atomically before GitHub writes, then the PR URL, then notification state, with restrictive file permissions. Treat it as private source code; do not commit it. One exclusive file lock serializes delivery across polling/events. Configure a single durable volume and one replica. Render's currently observed free service has no configured durable checkpoint volume; leave implementation disabled until approved infrastructure exists. No volume or paid service was provisioned.

Graceful failures release locks. A hard crash leaves a lock intentionally: stop/verify no worker is running before removing only that task's .lock, preserve .json, restart, and resend identical text. An existing matching branch resumes draft-PR creation without force-push; differing content stops for reconciliation. Existing PRs (including closed ones) are not duplicated. A crash after Slack delivery but before save may duplicate the notice, never the PR. A lost durable volume loses proposal recovery: do not automatically regenerate against an existing branch without reconciliation. Model calls before proposal persistence may be repeated after a failure.

## Acceptance evidence / remaining gates

Local build and 37 tests pass (provider contract, malformed responses, budget exhaustion, scope rejection, GitHub stale base, recovery collision, durable checkpoint and existing regression suite). No live model call or real implementation job was submitted. No credentials were configured. Independent exact-HEAD review and staged end-to-end Slack → provider → isolated repository → CI verification remain activation gates. The risk policy in Fornexa docs/ai/HANDOFF.md remains authoritative and its pending ratification is preserved.
