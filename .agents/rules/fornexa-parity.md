# Fornexa AI parity rules

Apply these rules to every change in this repository, including work initiated from Antigravity.

1. Treat `docs/provider-parity.md` as the capability boundary and `fragonh2-boop/Fornexa/docs/ai/HANDOFF.md` as the authority for risk and exact-HEAD review policy.
2. Record the full 40-character target SHA. Any new commit invalidates an earlier review. Never treat silence, timeout or a verdict for another SHA as approval.
3. Classify authentication, authorization, credentials, implementation writes, CI and deployment changes as HIGH risk. They require green checks and an independent reviewer before activation.
4. Never expose secrets to a model, Slack, logs or source control. Provider adapters receive only bounded prompts and tool results; host code owns credentials and authorization.
5. Use the common capability layer for GPT, Claude and Gemini. Add provider-specific code only for transport or response normalization.
6. Do not merge or deploy from an implementation task. Controlled deployments must use the exact Slack protocol and a signed interactive approval; revalidate HEAD and CI immediately before the fixed-target operation.
7. Leave a recoverable checkpoint: branch, exact SHA, PR, checks run, risk, open findings and next authorized action. Mirror material status in `#fornexa` without credentials.
