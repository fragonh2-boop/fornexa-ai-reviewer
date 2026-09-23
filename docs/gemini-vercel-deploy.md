# Gemini / Antigravity: Fornexa Vercel deployment

The product site is `fragonh2-boop/Fornexa` on the Vercel team `Fornexasc`, project `fornexa` (`fornexasc.com`). Its deployment is separate from the Gemini reviewer service on Render. The Slack service cannot inherit a Codex connector's OAuth session or an Antigravity Mac login.

## Activation

1. Complete the separate Slack bot identity migration: GPT, Claude and other agents must lose access to Fran's Slack *user token*. Until then Slack user IDs do not prove a human authorized a deployment. This gate is independent of the message signature.
2. On the Gemini Render service only, configure a dedicated read-only GitHub token scoped to `fragonh2-boop/Fornexa` (`Contents: read`, `Checks: read`) as `VERCEL_DEPLOY_GITHUB_TOKEN`, plus a Vercel access token with access to the `Fornexasc` project as `VERCEL_DEPLOY_API_TOKEN`. Do not paste either value into Slack, source control or the model. The Vercel token may have wider team privileges than this code's fixed-project allowlist; protect and rotate it separately.
3. Set `VERCEL_DEPLOY_SLACK_USER_IDS` to separately authenticated human accounts. Set `VERCEL_DEPLOY_ENABLED=true` only after independent exact-HEAD review, CI, identity and credentials are verified. The feature is disabled by default.

The product's existing Git integration may automatically deploy commits pushed to `main`; this command is useful for an explicit recovery or a missed build. Avoid a redundant deployment when the current production deployment already carries the requested SHA.

## Order

Post a **new root message** in `#fornexa` from an authorized human account:

```text
GEMINI — ACCIÓN REQUERIDA
MODE: DEPLOY_VERCEL
TARGET: fornexa
HEAD: <40 lowercase hex characters of the current main commit of fragonh2-boop/Fornexa>
```

The handler verifies the exact syntax and Slack author, current product `main`, GitHub Actions `validate` success, Vercel team/project/Git source and absence of an active deployment. It sends an explicit SHA to Vercel's Git-source deployment API, and reports the deployment ID. It reports `YA READY` without building if the latest production deployment already uses that SHA. `DEPLOY INICIADO` does not imply success: verify `READY`, source SHA and production alias/domain in Vercel and perform the public health smoke before declaring completion. No model function, arbitrary command, merge, environment-variable mutation or Supabase migration is exposed.

Current activation status is **off** until the identity and server secret checks above pass. Deploying this reviewer code to Render is a separate PR/operation and does not by itself create a Vercel deployment of Fornexa.
