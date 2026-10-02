import assert from "node:assert/strict";
import test from "node:test";
import {
  loadFornexaGptBridgeConfig,
  reconcileFornexaGptBridgePolling,
} from "../src/fornexa-gpt-bridge.js";
import { MeshBridge } from "../src/mesh-bridge.js";

const enabledEnv = {
  SLACK_AGENT_NETWORK_ENABLED: "true",
  SLACK_AGENT_LABEL: "GPT",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_SIGNING_SECRET: "signing-secret",
  SLACK_BOT_USER_ID: "UGPT",
  SLACK_BOT_ID: "BGPT",
  MESH_CONTROL_TOKEN: "control-token",
  SLACK_AGENT_NETWORK_PEERS: "CLAUDE:UCLAUDE:BCLAUDE",
};

test("the FornexaGPT bridge is disabled by default and validates every active identity", () => {
  assert.equal(loadFornexaGptBridgeConfig({}).enabled, false);
  assert.throws(() => loadFornexaGptBridgeConfig({ ...enabledEnv, SLACK_AGENT_LABEL: "GEMINI" }), /SLACK_AGENT_LABEL=GPT/);
  assert.throws(() => loadFornexaGptBridgeConfig({ ...enabledEnv, MESH_CONTROL_TOKEN: "" }), /MESH_CONTROL_TOKEN/);
  assert.throws(() => loadFornexaGptBridgeConfig({ ...enabledEnv, SLACK_AGENT_NETWORK_PEERS: "GPT:UGPT:BGPT" }), /propia identidad/);
  assert.equal(loadFornexaGptBridgeConfig(enabledEnv).peers[0].label, "CLAUDE");
  assert.throws(() => loadFornexaGptBridgeConfig({ ...enabledEnv, POLL_INTERVAL_MINUTES: "0" }), /POLL_INTERVAL_MINUTES/);
});

test("the FornexaGPT fallback polls only bounded canonical MESH/1 messages", async () => {
  let published = "";
  const bridge = new MeshBridge(
    { channelId: "CFORNEXA", localLabel: "GPT", peers: [{ label: "CLAUDE", userId: "UCLAUDE", botId: "BCLAUDE" }] },
    {
      async postToChannel(text) {
        published = text;
        return { ts: "1700000000.000001" };
      },
      async postToThread() {},
    }
  );
  const ping = await bridge.ping("CLAUDE");
  const root = {
    ts: ping.rootTs,
    text: published,
    user: "UGPT",
    bot_id: "BGPT",
    thread_ts: ping.rootTs,
    reply_count: 1,
  };
  const ack = {
    ts: "1700000001.000001",
    text: published
      .replace("TYPE: PING", "TYPE: ACK")
      .replace("FROM: GPT", "FROM: CLAUDE")
      .replace("TO: CLAUDE", "TO: GPT")
      .replace("HOP: 0", "HOP: 1"),
    bot_id: "BCLAUDE",
    thread_ts: ping.rootTs,
  };
  const requests: string[] = [];

  await reconcileFornexaGptBridgePolling({
    client: {
      conversations: {
        async history({ channel, limit }) {
          requests.push(`history:${channel}:${limit}`);
          return { messages: [{ ts: "free", text: "MESH/1 no canónico" }, root] };
        },
        async replies({ channel, ts, limit }) {
          requests.push(`replies:${channel}:${ts}:${limit}`);
          return { messages: [root, ack] };
        },
      },
    },
    bridge,
    config: { channelId: "CFORNEXA", agentLabel: "GPT", botId: "BGPT" },
    nowMs: 1_700_000_010_000,
  });

  assert.deepEqual(requests, ["history:CFORNEXA:20", `replies:CFORNEXA:${ping.rootTs}:20`]);
  assert.equal(bridge.pendingCount(), 0);
});
