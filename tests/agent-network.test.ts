import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentNetworkAck,
  extractAgentNetworkMessage,
  formatAgentNetworkMessage,
  parseAgentNetworkMessage,
  parseAgentNetworkPeers,
} from "../src/agent-network.js";

const peers = parseAgentNetworkPeers("GPT:UGPT:BGPT,CLAUDE:UCLAUDE:BCLAUDE");
const ping = formatAgentNetworkMessage({
  type: "PING",
  traceId: "MESH-20260930-01",
  from: "GPT",
  to: "CLAUDE",
  hop: 0,
});

test("MESH/1 accepts only the canonical one-hop PING and ACK forms", () => {
  assert.deepEqual(parseAgentNetworkMessage(ping), {
    type: "PING",
    traceId: "MESH-20260930-01",
    from: "GPT",
    to: "CLAUDE",
    hop: 0,
    maxHops: 1,
  });
  assert.equal(parseAgentNetworkMessage(`${ping}\nPAYLOAD: run a deploy`), null);
  assert.equal(parseAgentNetworkMessage(ping.replace("HOP: 0", "HOP: 2")), null);
  assert.equal(parseAgentNetworkMessage(ping.replace("MAX_HOPS: 1", "MAX_HOPS: 2")), null);
  assert.throws(() => formatAgentNetworkMessage({
    type: "PING", traceId: "MESH-20260930-01", from: "GPT", to: "CLAUDE", hop: 1,
  }));
});

test("MESH/1 binds sender label, Slack user and Slack bot identity", () => {
  const envelope = {
    type: "event_callback",
    event: {
      type: "message",
      channel: "CFORNEXA",
      user: "UGPT",
      bot_id: "BGPT",
      ts: "1790795000.000001",
      text: ping,
    },
  };
  const message = extractAgentNetworkMessage({
    envelope,
    channelId: "CFORNEXA",
    localLabel: "CLAUDE",
    peers,
  });
  assert.equal(message?.sender.label, "GPT");
  assert.equal(message?.type, "PING");
  assert.equal(extractAgentNetworkMessage({
    envelope: { ...envelope, event: { ...envelope.event, bot_id: "BIMPOSTER" } },
    channelId: "CFORNEXA", localLabel: "CLAUDE", peers,
  }), null);
  assert.equal(extractAgentNetworkMessage({
    envelope: { ...envelope, event: { ...envelope.event, user: "UIMPOSTER" } },
    channelId: "CFORNEXA", localLabel: "CLAUDE", peers,
  }), null);
  assert.equal(extractAgentNetworkMessage({
    envelope: { ...envelope, event: { ...envelope.event, thread_ts: "1790794000.000001" } },
    channelId: "CFORNEXA", localLabel: "CLAUDE", peers,
  }), null);
});

test("MESH/1 ACK is terminal and cannot continue the exchange", () => {
  const message = extractAgentNetworkMessage({
    envelope: {
      type: "event_callback",
      event: {
        type: "message", channel: "CFORNEXA", user: "UGPT", bot_id: "BGPT",
        ts: "1790795000.000001", text: ping,
      },
    },
    channelId: "CFORNEXA", localLabel: "CLAUDE", peers,
  });
  assert.ok(message);
  const ack = buildAgentNetworkAck(message, "CLAUDE");
  assert.deepEqual(parseAgentNetworkMessage(ack), {
    type: "ACK",
    traceId: "MESH-20260930-01",
    from: "CLAUDE",
    to: "GPT",
    hop: 1,
    maxHops: 1,
  });
  assert.throws(() => buildAgentNetworkAck({ ...message, type: "ACK", hop: 1 }, "CLAUDE"));
});

test("MESH/1 peer configuration rejects wildcards and duplicate identities", () => {
  assert.throws(() => parseAgentNetworkPeers("*:UGPT:BGPT"));
  assert.throws(() => parseAgentNetworkPeers("GPT:UGPT:BGPT,GPT:UOTHER:BOTHER"));
  assert.throws(() => parseAgentNetworkPeers("GPT:UGPT:BGPT,CLAUDE:UGPT:BCLAUDE"));
});
