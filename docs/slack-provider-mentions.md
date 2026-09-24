# Provider mentions in Slack

Status: implementation proposed in a branch; disabled by default and not deployed.

## User experience

Each provider has a dedicated Slack app identity and an isolated service instance:

```text
@FornexaGPT explain this error
@FornexaClaude challenge the proposed design
@GeminiFornexa summarize the trade-offs
@FornexaDeepSeek look for a missing edge case
```

The first mention opens a Slack thread. Human replies in that thread continue the conversation without repeating the mention. Responses always come from the selected provider's bot identity and include an internal Slack message timestamp so retries can be deduplicated.

Slack identities cannot be aliases for one another. A single router bot could support `@FornexaAI claude ...`, but it cannot publish as `@FornexaClaude`, `@GeminiFornexa` and `@FornexaGPT`. The simple `@provider` experience therefore requires one Slack app and one service instance per provider.

## Shared architecture

All four instances execute the same code:

1. Slack signs a `message.channels` event for the configured channel.
2. The service verifies the HMAC signature and five-minute replay window.
3. Only a human message containing the instance's exact Slack user ID opens a conversation.
4. The response is posted in the same thread. Later human replies are recovered from that thread.
5. The common provider adapter calls GPT, Claude, Gemini or DeepSeek according to `AI_PROVIDER`.
6. A terminal marker ties the response to the exact Slack message timestamp. Event retries and the polling fallback cannot answer that turn twice.

Messages delegated through another desktop AI are ignored when they carry the `Enviado usando` footer. This matters because GPT and Claude can publish through Fran's Slack identity: treating those messages as ordinary human input would allow one AI to mention another and create a loop. A conversation also stops after eight human turns and must continue in a new mention thread.

The mention path is deliberately conversational. It receives no GitHub, Slack, filesystem, deployment or write tools. A request to inspect or change code must use the existing review/implementation protocol with an exact target and HEAD. This preserves `docs/ai/HANDOFF.md` as the authority for risk and independent review.

## Per-instance configuration

Create a dedicated Slack app for each provider. Do not reuse Fran's user token or the ChatGPT/Claude desktop identity.

Required bot scopes:

- `channels:history`
- `channels:read`
- `chat:write`

Invite each app only to `#fornexa`. Subscribe only to `message.channels`; the service already recognizes mentions inside that event and does not require `app_mentions:read`. Use the instance's `/slack/events` URL and signing secret.

Set these values separately on each service:

```text
AI_PROVIDER=gpt|claude|gemini|deepseek
SLACK_AGENT_LABEL=GPT|CLAUDE|GEMINI|DEEPSEEK
SLACK_BOT_TOKEN=<dedicated xoxb token>
SLACK_SIGNING_SECRET=<dedicated signing secret>
APPROVAL_HMAC_SECRET=<different random secret, at least 32 characters, used only for approval buttons>
SLACK_BOT_USER_ID=<the bot's U… identity>
SLACK_MENTIONS_ENABLED=true
SIDECAR_APPROVAL_ENABLED=false
SIDECAR_APPROVER_SLACK_USER_IDS=<comma-separated human U… IDs allowed to press the signed button>
```

Configure only the selected provider's API key and model. Keep the GitHub token read-only. Keep `IMPLEMENT_ENABLED=false` unless the existing independent authorization and durable-checkpoint gates have been satisfied.

## Limits and failure behavior

- Only the configured channel is accepted.
- Bot messages, Slack subtypes and other bot identities are ignored.
- Messages carrying the standard `Enviado usando` delegated-agent footer are ignored even if Slack attributes them to a human account.
- A prompt is limited to 12 KiB; retained conversation is limited to 20 messages and 64 KiB.
- A thread is limited to 8 human turns. The ninth receives a terminal failure and cannot trigger a model call.
- Text matching known secret formats is rejected before a model call.
- The explicit local-bridge phrase creates a signed approval button. A Slack-signed click from the separate approver allowlist is required; an empty list denies every request.
- Model calls keep the existing timeout and provider response validation.
- A failed turn receives a terminal failure marker and is not retried forever. A human can explicitly mention the bot again.
- Polling examines at most 50 recent mention threads per cycle as recovery for missed events.
- State is reconstructed from Slack threads. In-memory event dedupe is an optimization; exact response markers provide restart-safe turn dedupe.
- Configure exactly one replica/instance per provider service; in-memory lock maps and active event deduplication require single-instance deployment per provider.

## Activation order

1. Merge and deploy the shared code only after exact-HEAD review.
2. Enable mentions on the existing Gemini and DeepSeek identities one service at a time.
3. Run a read-only smoke in `#fornexa` and verify the reply stays in its thread.
4. Create dedicated FornexaGPT and FornexaClaude Slack apps and services with the same minimum scopes.
5. Confirm one provider cannot answer another provider's mention.
6. Record the live service commit and smoke evidence in the operational handoff.

No app creation, token change, merge or deployment is part of this code change.
