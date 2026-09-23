# Controlled Render deploy for Gemini / Antigravity

The Gemini Slack service can accept an exact, deterministic deployment request. The model does not receive deploy credentials or a deploy tool. This only deploys `fragonh2-boop/fornexa-ai-reviewer` to the Render service `fornexa-ai-reviewer-gemini`. It does not grant access to Fornexa's Vercel or Supabase production resources, change the local Antigravity app's permissions, or enable arbitrary commands on the Mac.

## Activation

1. Remove agent access to Fran's Slack **user token**. Separate bot identities are necessary so a message with Fran's Slack user ID is attributable to Fran. Audit the workspace before enabling writes; a textual footer is not proof of identity.
2. Create a dedicated GitHub credential for this repository with Contents read, Checks read and Metadata read. Set `DEPLOY_GITHUB_TOKEN` only on the Gemini Render service. Do not reuse the Fornexa product token or a broad personal token.
3. Set `DEPLOY_RENDER_API_KEY` only on the Gemini Render service. Render API keys may grant account-wide access; the application hardcodes and rechecks the service name, ID, branch and source repository before each deploy. Prefer a narrower Render credential if available. Do not paste the key in chat or Slack.
4. Set `DEPLOY_SLACK_USER_IDS` to verified human Slack IDs and `DEPLOY_ENABLED=true` only after steps 1–3, CI and an independent review of this change. This deployment to the same service will restart the running process.
5. Check the service's `autoDeployTrigger`: it currently says `commit`. If automatic deployment must wait for CI, set it to `checksPass` or `off` in Render. The explicit API deploy below does not disable autodeploys.

All four fields are server configuration. The feature remains disabled by default and missing credentials fail closed.

## Request and outcome

Post as a new root message in `#fornexa`, from an authorized human account:

```text
GEMINI — ACCIÓN REQUERIDA
MODE: DEPLOY
TARGET: fornexa-ai-reviewer-gemini
HEAD: <full lowercase 40-character SHA of main>
```

The handler verifies the signed Slack event (or rechecks the message via the existing authenticated Slack polling), the Slack user allowlist, exact syntax, exact `main` HEAD, a single successful `validate` check for that commit, the Render service identity and lack of an in-progress deploy. It invokes Render's Deploy API with `commitId`, then posts the deploy ID in the request thread. A duplicate request for an already live commit does not trigger another deploy. Recheck the returned deployment's `Live` status and service health in Render; a `DEPLOY INICIADO` response is **not** completion. The bot may restart while deploying itself.

Review/implementation commands remain distinct. The implementation lane also needs its own verified identity, write credential, repository ruleset and durable checkpoint. This change does not activate it. It does not confer equality with native Codex or Claude desktop tools.
