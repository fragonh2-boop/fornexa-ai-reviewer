# Gemini / Antigravity: Fornexa Vercel deployment

The product site is `fragonh2-boop/Fornexa` on the Vercel team `Fornexasc`, project `fornexa` (`fornexasc.com`). Its deployment is separate from the Gemini reviewer service on Render. The Slack service cannot inherit a Codex connector's OAuth session or an Antigravity Mac login.

## Activation

1. Enable Slack **Interactivity & Shortcuts** with Request URL `https://fornexa-ai-reviewer-gemini.onrender.com/slack/interactions`. Slack signs the human button click; messages sent through a shared user token cannot forge that request.
2. On the Gemini Render service only, configure a dedicated read-only GitHub token scoped to `fragonh2-boop/Fornexa` (`Contents: read`, `Checks: read`) as `VERCEL_DEPLOY_GITHUB_TOKEN`, plus a Vercel access token with access to the `Fornexasc` project as `VERCEL_DEPLOY_API_TOKEN`. Do not paste either value into Slack, source control or the model. The Vercel token may have wider team privileges than this code's fixed-project allowlist; protect and rotate it separately.
3. Set `VERCEL_DEPLOY_APPROVER_SLACK_USER_IDS` to the human accounts allowed to press the approval button. Set `VERCEL_DEPLOY_ENABLED=true` only after independent exact-HEAD review, CI, identity and credentials are verified. The feature is disabled by default.

The product's existing Git integration may automatically deploy commits pushed to `main`; this command is useful for an explicit recovery or a missed build. Avoid a redundant deployment when the current production deployment already carries the requested SHA.

## Order

Post a **new root message** in `#fornexa`:

```text
GEMINI — ACCIÓN REQUERIDA
MODE: DEPLOY_VERCEL
TARGET: fornexa
HEAD: <40 lowercase hex characters of the current main commit of fragonh2-boop/Fornexa>
```

The exact root message creates an approval button valid for two hours. The service accepts only a Slack-signed click by an allowlisted approver, bound to the same mode, SHA and thread. It then revalidates current product `main`, GitHub Actions `validate`, Vercel team/project/Git source and absence of an active deployment. Both Vercel Git-link response shapes (`owner/repo` or separate `org` and `repo`) are accepted only when the pinned repository ID, owner, repository and production branch all match. The bot reports `YA READY` when appropriate; otherwise it reports `DEPLOY INICIADO` and later a terminal `COMPLETADO` or `FALLIDO`, with polling recovery after restarts. No model function, arbitrary command, merge, environment-variable mutation or Supabase migration is exposed.

Current activation status is **off** until the identity and server secret checks above pass. Deploying this reviewer code to Render is a separate PR/operation and does not by itself create a Vercel deployment of Fornexa.
