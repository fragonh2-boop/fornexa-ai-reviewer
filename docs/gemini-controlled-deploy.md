# Controlled Render deploy for Gemini / Antigravity

The Gemini Slack service can accept an exact, deterministic deployment request. The model does not receive deploy credentials or a deploy tool. This only deploys `fragonh2-boop/fornexa-ai-reviewer` to the Render service `fornexa-ai-reviewer-gemini`. It does not grant access to Fornexa's Vercel or Supabase production resources, change the local Antigravity app's permissions, or enable arbitrary commands on the Mac.

## Activation

1. Enable Slack **Interactivity & Shortcuts** with Request URL `https://fornexa-ai-reviewer-gemini.onrender.com/slack/interactions`. The endpoint verifies Slack's signature and five-minute replay window before accepting a button click.
2. Create a dedicated GitHub credential for this repository with Contents read, Checks read and Metadata read. Set `DEPLOY_GITHUB_TOKEN` only on the Gemini Render service. Do not reuse the Fornexa product token or a broad personal token.
3. Set `DEPLOY_RENDER_API_KEY` only on the Gemini Render service. Render API keys may grant account-wide access; the application hardcodes and rechecks the service name, ID, branch and source repository before each deploy. Prefer a narrower Render credential if available. Do not paste the key in chat or Slack.
4. Generate `APPROVAL_HMAC_SECRET` independently from `SLACK_SIGNING_SECRET`; keep it only on the service. It signs approval payloads and is never shared with Slack.
5. Set `DEPLOY_APPROVER_SLACK_USER_IDS` to the human Slack IDs allowed to press the approval button and `DEPLOY_ENABLED=true` only after steps 1–4, CI and an independent exact-HEAD review. A message sent with Fran's user token cannot emulate the Slack-signed interactive request. This deployment to the same service will restart the running process.
6. Set Render auto-deploy to **off** before enabling this feature. The explicit signed flow is the only permitted deployment path; `commit` or `checksPass` would bypass human approval.

All fields are server configuration. The feature remains disabled by default and missing credentials fail closed.

## Request and outcome

Post as a new root message in `#fornexa`:

```text
GEMINI — ACCIÓN REQUERIDA
MODE: DEPLOY
TARGET: fornexa-ai-reviewer-gemini
HEAD: <full lowercase 40-character SHA of main>
```

The root message only creates a two-hour approval request. The bot posts a Slack button bound by HMAC to the exact mode, SHA and thread. Slack signs the button interaction; the service checks that signature, the approver allowlist and the bound payload before it revalidates exact `main`, one or more completed successful `validate` checks, Render service identity and lack of an in-progress deploy. It then invokes Render's Deploy API with `commitId` and posts the deployment ID. `DEPLOY INICIADO` is not completion: the worker checks the terminal state, and the polling fallback resumes that verification after the self-deploy restarts the service. Only `DEPLOY COMPLETADO` for the same SHA and deployment ID declares success.

Review/implementation commands remain distinct. The implementation lane also needs its own verified identity, write credential, repository ruleset and durable checkpoint. This change does not activate it. It does not confer equality with native Codex or Claude desktop tools.
