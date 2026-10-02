import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentNetworkMessage } from "../src/agent-network.js";
import { MeshBridge } from "../src/mesh-bridge.js";
import { reconcilePolledMesh } from "../src/mesh-poll.js";

test("polling fallback correlates a signed peer ACK without processing free text", async () => {
  let publishedText = "";
  const bridge = new MeshBridge(
    {
      channelId: "C_FORNEXA",
      localLabel: "CLAUDE",
      peers: [{ label: "GEMINI", userId: "UGEMINI", botId: "BGEMINI" }],
    },
    {
      async postToChannel(text) {
        publishedText = text;
        return { ts: "1700000000.000001" };
      },
      async postToThread() {},
    }
  );
  const ping = await bridge.ping("GEMINI");
  const root = {
    ts: ping.rootTs,
    text: publishedText,
    user: "UCLAUDE",
    botId: "BCLAUDE",
    threadTs: ping.rootTs,
    replyCount: 1,
  };
  const ack = {
    ts: "1700000001.000001",
    botId: "BGEMINI",
    threadTs: ping.rootTs,
    text: publishedText
      .replace("TYPE: PING", "TYPE: ACK")
      .replace("FROM: CLAUDE", "FROM: GEMINI")
      .replace("TO: GEMINI", "TO: CLAUDE")
      .replace("HOP: 0", "HOP: 1"),
  };
  const results: string[] = [];

  await reconcilePolledMesh({
    bridge,
    channelId: "C_FORNEXA",
    localLabel: "CLAUDE",
    localBotId: "BCLAUDE",
    messages: [
      { ts: "free-text", text: "MESH/1 but not a canonical message", replyCount: 1 },
      root,
    ],
    async readThread(threadTs, maxMessages) {
      assert.equal(threadTs, ping.rootTs);
      assert.equal(maxMessages, 20);
      return [root, ack];
    },
    onResult(result) {
      results.push(result);
    },
    nowMs: 1_700_000_010_000,
  });

  assert.deepEqual(results, ["ack_received"]);
  assert.equal(bridge.pendingCount(), 0);
});

test("polling skips a fresh PING with a durable local ACK after a restart", async () => {
  const traceId = "MESH-RESTART-0001";
  const root = {
    ts: "1700000000.000001",
    text: formatAgentNetworkMessage({
      type: "PING", traceId, from: "CLAUDE", to: "GPT", hop: 0,
    }),
    botId: "BCLAUDE",
    threadTs: "1700000000.000001",
  };
  const existingAck = {
    ts: "1700000001.000001",
    text: formatAgentNetworkMessage({
      type: "ACK", traceId, from: "GPT", to: "CLAUDE", hop: 1,
    }),
    botId: "BGPT",
    threadTs: root.ts,
  };
  let posts = 0;
  let reads = 0;
  const restartedBridge = new MeshBridge(
    {
      channelId: "C_FORNEXA",
      localLabel: "GPT",
      peers: [{ label: "CLAUDE", userId: "UCLAUDE", botId: "BCLAUDE" }],
    },
    {
      async postToChannel() { return { ts: "1700000002.000001" }; },
      async postToThread() { posts += 1; },
    }
  );

  await reconcilePolledMesh({
    bridge: restartedBridge,
    channelId: "C_FORNEXA",
    localLabel: "GPT",
    localBotId: "BGPT",
    messages: [root],
    async readThread() {
      reads += 1;
      return [root, existingAck];
    },
    nowMs: 1_700_000_010_000,
  });

  assert.equal(reads, 1);
  assert.equal(posts, 0);
});

test("polling ignores expired roots without reading the Slack thread", async () => {
  let reads = 0;
  let posts = 0;
  const bridge = new MeshBridge(
    {
      channelId: "C_FORNEXA",
      localLabel: "GPT",
      peers: [{ label: "CLAUDE", userId: "UCLAUDE", botId: "BCLAUDE" }],
    },
    {
      async postToChannel() { return { ts: "1700000002.000001" }; },
      async postToThread() { posts += 1; },
    }
  );
  const staleRoot = {
    ts: "1699999000.000001",
    text: formatAgentNetworkMessage({
      type: "PING", traceId: "MESH-STALE-0001", from: "CLAUDE", to: "GPT", hop: 0,
    }),
    botId: "BCLAUDE",
  };

  await reconcilePolledMesh({
    bridge,
    channelId: "C_FORNEXA",
    localLabel: "GPT",
    localBotId: "BGPT",
    messages: [staleRoot],
    async readThread() {
      reads += 1;
      return [staleRoot];
    },
    nowMs: 1_700_000_000_000,
  });

  assert.equal(reads, 0);
  assert.equal(posts, 0);
});

test("polling ACKs a fresh root exactly once when no durable ACK exists", async () => {
  let posts = 0;
  const root = {
    ts: "1700000000.000001",
    text: formatAgentNetworkMessage({
      type: "PING", traceId: "MESH-FRESH-0001", from: "CLAUDE", to: "GPT", hop: 0,
    }),
    botId: "BCLAUDE",
  };
  const bridge = new MeshBridge(
    {
      channelId: "C_FORNEXA",
      localLabel: "GPT",
      peers: [{ label: "CLAUDE", userId: "UCLAUDE", botId: "BCLAUDE" }],
    },
    {
      async postToChannel() { return { ts: "1700000002.000001" }; },
      async postToThread() { posts += 1; },
    }
  );

  await reconcilePolledMesh({
    bridge,
    channelId: "C_FORNEXA",
    localLabel: "GPT",
    localBotId: "BGPT",
    messages: [root],
    async readThread() { return [root]; },
    nowMs: 1_700_000_010_000,
  });

  assert.equal(posts, 1);
});
