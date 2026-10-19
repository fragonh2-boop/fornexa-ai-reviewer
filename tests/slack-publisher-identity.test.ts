import assert from "node:assert/strict";
import test from "node:test";
import { verifySlackPublisherIdentity, verifySlackStartupIdentity } from "../src/slack-publisher-identity.js";

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

test("Grok verifies both identity IDs with MESH disabled and rejects foreign or human tokens", async () => {
  for (const identity of [
    { user_id: "UGROK", bot_id: "BGROK" },
    { user_id: "UDEEPSEEK", bot_id: "BGROK" },
    { user_id: "UGROK", bot_id: "BDEEPSEEK" },
    { user_id: "UFRAN" },
  ]) {
    let calls = 0;
    const startup = verifySlackStartupIdentity({
      client: { auth: { test: async () => { calls++; return identity; } } },
      provider: "grok", meshEnabled: false,
      expectedUserId: "UGROK", expectedBotId: "BGROK",
    });
    if (identity.user_id === "UGROK" && identity.bot_id === "BGROK") await startup;
    else await assert.rejects(startup, /token publicador no coincide/);
    assert.equal(calls, 1);
  }
});

test("Grok refuses missing identity settings and failed auth.test before startup", async () => {
  for (const [expectedUserId, expectedBotId] of [[null, "BGROK"], ["UGROK", null], ["invalid", "BGROK"]]) {
    await assert.rejects(verifySlackStartupIdentity({
      client: { auth: { test: async () => { throw new Error("must not call Slack"); } } },
      provider: "grok", meshEnabled: false, expectedUserId, expectedBotId,
    }), /identidad propia exige/);
  }
  await assert.rejects(verifySlackStartupIdentity({
    client: { auth: { test: async () => { throw new Error("invalid_auth"); } } },
    provider: "grok", meshEnabled: false, expectedUserId: "UGROK", expectedBotId: "BGROK",
  }), /invalid_auth/);
});

test("Startup preserves existing MESH verification and non-MESH provider behavior", async () => {
  let calls = 0;
  const client = { auth: { test: async () => { calls++; return { user_id: "UGPT", bot_id: "BGPT" }; } } };
  await verifySlackStartupIdentity({client, provider: "gpt", meshEnabled: false, expectedUserId: null, expectedBotId: null});
  assert.equal(calls, 0);
  await verifySlackStartupIdentity({client, provider: "gpt", meshEnabled: true, expectedUserId: "UGPT", expectedBotId: "BGPT"});
  assert.equal(calls, 1);
});
