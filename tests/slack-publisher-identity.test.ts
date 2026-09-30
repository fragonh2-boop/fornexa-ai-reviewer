import assert from "node:assert/strict";
import test from "node:test";
import { verifySlackPublisherIdentity } from "../src/slack-publisher-identity.js";

test("MESH/1 accepts only a publisher token bound to the configured bot identity", async () => {
  await verifySlackPublisherIdentity({
    client: { auth: { test: async () => ({ user_id: "UCLAUDE", bot_id: "BCLAUDE" }) } },
    expectedUserId: "UCLAUDE",
    expectedBotId: "BCLAUDE",
  });

  await assert.rejects(
    verifySlackPublisherIdentity({
      client: { auth: { test: async () => ({ user_id: "UFRAN", bot_id: "BCLAUDE" }) } },
      expectedUserId: "UCLAUDE",
      expectedBotId: "BCLAUDE",
    }),
    /token publicador no coincide/
  );
});
