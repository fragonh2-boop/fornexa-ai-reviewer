# Grok activation handoff

Updated: 2026-10-19. Activation is pending; this document does not assert a live deployment.

The Grok provider uses the shared reviewer transport with `AI_PROVIDER=grok`,
`GROK_MODEL=grok-4.7` and `SLACK_AGENT_LABEL=GROK`. Grok 4.7 and the fixed xAI
endpoint were checked against https://docs.x.ai/developers/models.

## Dedicated Slack identity

Use `grok-app-manifest.json` to create GrokFornexa in the intended workspace.
The creation manifest deliberately has no Events URL: Slack requires a valid
endpoint when event subscriptions are declared. Configure subscriptions after
the actual Render service URL is known and verified.

- Invite only the Grok app to `#fornexa`.
- Store its dedicated bot token in `~/.dsh/slack/grok.token` with mode `0600`.
- Set the service's `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `SLACK_BOT_USER_ID` and `SLACK_BOT_ID` from that same app.
- Grok now calls `auth.test` before HTTP startup or polling even with MESH/1
  disabled. Missing IDs, authentication errors and either mismatched ID abort
  startup. Existing non-MESH providers retain their prior startup behavior.
- Set the verified Render URL plus `/slack/events` as the Request URL.
- Subscribe to both `app_mention` and `message.channels`. The latter supports
  human follow-ups without a fresh mention, and bot review handoffs. The shared
  handler supports both event types and deduplicates request timestamps.

Never reuse another provider's token or a human account token. Keep all secret
values outside Git, PR text, Slack and logs.

## Render configuration and remaining gates

Use the `fornexa-grok-reviewer` definition in `render.yaml`, one instance, manual
deploys, and the same region as the existing reviewer services. Keep
`IMPLEMENT_ENABLED=false` and `SLACK_AGENT_NETWORK_ENABLED=false` for this
read-only activation. Provision a repository-scoped read-only `GITHUB_TOKEN`;
do not copy a broad Codex/user credential. `GROK_API_KEY` must be a dedicated
xAI API key, not a grok.com OAuth session.

Populate `SLACK_REVIEW_ALLOWED_BOT_IDS` with verified team U/B identities;
never use wildcards. Enable `SLACK_MENTIONS_ENABLED=true` only when credentials,
identity IDs, signing and Events configuration are ready.

Observed during preparation:

- The source provider commit was `a12a144c25d6938cb3d2dd3068244b857e2a74a4`.
- Remote main was `67ef11946f169e1695a9899364e5072d64cc36f7`.
- Render discovery found four existing services and no Grok service.
- Both Slack app management and xAI Console had signed-in browser sessions.
- xAI Console displayed a credit balance of USD 0.00. No credit purchase or
  automatic recharge was authorized during this preparation.
- TypeScript production build passed. All 227 tests passed, including Grok
  identity verification with MESH disabled, mismatched/human tokens, missing
  IDs, failed authentication, and existing MESH/non-MESH behavior.

Independent review of the final exact HEAD and green CI are required before
merge/deploy, per the shared provider activation policy. App installation,
dedicated API credentials, repository-scoped read credentials, usable API
credit, deployment and the live smoke are still separate activation gates.

## Live acceptance evidence to capture

1. `slack-grok whoami` resolves the new Grok user and bot, distinct from peers.
2. Render's live commit matches the independently reviewed deployment SHA;
   its health response reports provider `grok`, model `grok-4.7`.
3. A human mentions the real Grok user ID in `#fornexa` and receives one reply
   in that thread; a human follow-up continues it.
4. An authorized `GROK — ACCIÓN REQUERIDA` with a valid repository/PR and full
   HEAD receives `GROK — REVISIÓN` in its thread, correlated by exact request TS.
5. A controlled identity-mismatch configuration refuses startup before the
   port opens. Do not run this test against another production service.

Record the exact commit, deployment status and smoke request/reply timestamps
when observed. Until then, Grok is not activated.
