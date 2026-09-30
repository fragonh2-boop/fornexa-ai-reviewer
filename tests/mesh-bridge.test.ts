import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentNetworkMessage, parseAgentNetworkPeers } from "../src/agent-network.js";
import { MeshBridge, type MeshBridgePublisher } from "../src/mesh-bridge.js";

const peers = parseAgentNetworkPeers("CLAUDE:UCLAUDE:BCLAUDE,GEMINI:UGEMINI:BGEMINI");

function inboundPing(from = "CLAUDE", botId = "BCLAUDE") {
  return {
    type: "event_callback",
    event: {
      type: "message",
      subtype: "bot_message",
      channel: "CFORNEXA",
      bot_id: botId,
      ts: "100.001",
      text: formatAgentNetworkMessage({ type: "PING", traceId: "MESH-TEST-0001", from, to: "GPT", hop: 0 }),
    },
  };
}

test("the bridge replies once to a signed peer PING and never opens an operational route", async () => {
  const replies: Array<{ text: string; threadTs: string }> = [];
  const publisher: MeshBridgePublisher = {
    postToChannel: async () => ({ ts: "200.001" }),
    postToThread: async (text, threadTs) => { replies.push({ text, threadTs }); },
  };
  const bridge = new MeshBridge({ channelId: "CFORNEXA", localLabel: "GPT", peers }, publisher);

  assert.equal(await bridge.receive(inboundPing()), "acknowledged");
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /TYPE: ACK/);
  assert.equal(replies[0].threadTs, "100.001");
  assert.equal(await bridge.receive(inboundPing()), "ignored");
  assert.equal(replies.length, 1);
  assert.equal(await bridge.receive(inboundPing("CLAUDE", "BIMPOSTER")), "ignored");
});

test("the bridge emits only a canonical PING to declared peers and correlates its ACK", async () => {
  const sent: string[] = [];
  const publisher: MeshBridgePublisher = {
    postToChannel: async (text) => { sent.push(text); return { ts: "200.001" }; },
    postToThread: async () => undefined,
  };
  const bridge = new MeshBridge({ channelId: "CFORNEXA", localLabel: "GPT", peers }, publisher);
  const ping = await bridge.ping("CLAUDE");
  assert.match(sent[0], /^MESH\/1\nTYPE: PING\n/);
  assert.equal(bridge.pendingCount(), 1);

  const ack = formatAgentNetworkMessage({
    type: "ACK", traceId: ping.traceId, from: "CLAUDE", to: "GPT", hop: 1,
  });
  assert.equal(await bridge.receive({
    type: "event_callback",
    event: {
      type: "message", subtype: "bot_message", channel: "CFORNEXA", bot_id: "BCLAUDE",
      ts: "200.002", thread_ts: ping.rootTs, text: ack,
    },
  }), "ack_received");
  assert.equal(bridge.pendingCount(), 0);
  await assert.rejects(bridge.ping("DEEPSEEK"), /par declarado/);
});

test("concurrent Slack retries share an ACK outcome instead of confirming before delivery", async () => {
  let started!: () => void;
  let failDelivery!: (error: Error) => void;
  const deliveryStarted = new Promise<void>((resolve) => { started = resolve; });
  const delivery = new Promise<void>((_resolve, reject) => { failDelivery = reject; });
  const publisher: MeshBridgePublisher = {
    postToChannel: async () => ({ ts: "200.001" }),
    postToThread: async () => {
      started();
      await delivery;
    },
  };
  const bridge = new MeshBridge({ channelId: "CFORNEXA", localLabel: "GPT", peers }, publisher);
  const first = bridge.receive(inboundPing());
  await deliveryStarted;
  const retry = bridge.receive(inboundPing());
  failDelivery(new Error("slack_down"));
  await assert.rejects(first, /slack_down/);
  await assert.rejects(retry, /slack_down/);
});

test("outbound PINGs are bounded per peer while preserving a retryable ACK correlation", async () => {
  let clock = 1_000;
  let sequence = 0;
  const publisher: MeshBridgePublisher = {
    postToChannel: async () => ({ ts: `300.${++sequence}` }),
    postToThread: async () => undefined,
  };
  const bridge = new MeshBridge(
    { channelId: "CFORNEXA", localLabel: "GPT", peers }, publisher, () => clock
  );
  const first = await bridge.ping("CLAUDE");
  await assert.rejects(bridge.ping("CLAUDE"), /pendiente/);
  const ack = formatAgentNetworkMessage({
    type: "ACK", traceId: first.traceId, from: "CLAUDE", to: "GPT", hop: 1,
  });
  await bridge.receive({
    type: "event_callback",
    event: {
      type: "message", subtype: "bot_message", channel: "CFORNEXA", bot_id: "BCLAUDE",
      ts: "300.010", thread_ts: first.rootTs, text: ack,
    },
  });
  await assert.rejects(bridge.ping("CLAUDE"), /límite/);
  clock += 60_000;
  await bridge.ping("CLAUDE");
});
