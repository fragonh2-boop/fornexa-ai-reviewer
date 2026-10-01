import assert from "node:assert/strict";
import test from "node:test";
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
  });

  assert.deepEqual(results, ["ack_received"]);
  assert.equal(bridge.pendingCount(), 0);
});
