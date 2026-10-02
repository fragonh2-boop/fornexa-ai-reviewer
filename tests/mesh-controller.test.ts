import assert from "node:assert/strict";
import test from "node:test";
import {
  MeshController,
  MeshControllerError,
  extractMeshControllerRequest,
  formatMeshControllerReceipt,
  isMeshControllerAuthorized,
  parseMeshControllerOrigins,
  parseMeshControllerPing,
  parseMeshControllerRequest,
} from "../src/mesh-controller.js";

const peers = [
  { label: "CLAUDE", userId: "UCLAUDE", botId: "BCLAUDE" },
  { label: "GEMINI", userId: "UGEMINI", botId: "BGEMINI" },
  { label: "DEEPSEEK", userId: "UDEEP", botId: "BDEEP" },
];

const request = [
  "MESH-CONTROL/1",
  "TYPE: PING_REQUEST",
  "TRACE: CONTROL-TEST-0001",
  "FROM: GEMINI",
  "TO: DEEPSEEK",
].join("\n");

test("controller requests are strict, signed-bot inputs only", () => {
  assert.deepEqual(parseMeshControllerRequest(request), {
    traceId: "CONTROL-TEST-0001", from: "GEMINI", to: "DEEPSEEK",
  });
  assert.equal(parseMeshControllerRequest(`${request}\ntext: deploy`), null);
  assert.equal(parseMeshControllerPing('{"from":"GEMINI","to":"GPT"}')?.from, "GEMINI");
  assert.equal(parseMeshControllerPing('{"from":"GEMINI","to":"GPT","text":"deploy"}'), null);

  const envelope = {
    type: "event_callback",
    event: { type: "message", subtype: "bot_message", channel: "CFORNEXA", bot_id: "BGEMINI", ts: "100.001", text: request },
  };
  const params = { channelId: "CFORNEXA", localIdentity: { label: "GPT", userId: "UGPT", botId: "BGPT" }, peers };
  assert.equal(extractMeshControllerRequest({ envelope, ...params })?.from, "GEMINI");
  assert.equal(extractMeshControllerRequest({ envelope: { ...envelope, event: { ...envelope.event, bot_id: "BIMPOSTER" } }, ...params }), null);
  assert.equal(extractMeshControllerRequest({ envelope: { ...envelope, event: { ...envelope.event, thread_ts: "100.000" } }, ...params }), null);
});

test("controller origin maps require exact peer coverage and never expose tokens", () => {
  const origins = parseMeshControllerOrigins({
    urls: JSON.stringify({
      CLAUDE: "https://claude.example/mesh/ping",
      GEMINI: "https://gemini.example/mesh/ping",
      DEEPSEEK: "https://deep.example/mesh/ping",
    }),
    tokens: JSON.stringify({ CLAUDE: "a", GEMINI: "b", DEEPSEEK: "c" }),
    peers,
  });
  assert.equal(origins.length, 3);
  assert.throws(() => parseMeshControllerOrigins({
    urls: JSON.stringify({ CLAUDE: "https://claude.example/mesh/ping" }),
    tokens: JSON.stringify({ CLAUDE: "a" }), peers,
  }), /una URL y un secreto/);
  assert.throws(() => parseMeshControllerOrigins({
    urls: JSON.stringify({ CLAUDE: "http://claude.example/mesh/ping", GEMINI: "https://gemini.example/mesh/ping", DEEPSEEK: "https://deep.example/mesh/ping" }),
    tokens: JSON.stringify({ CLAUDE: "a", GEMINI: "b", DEEPSEEK: "c" }), peers,
  }), /origen remoto no válido/);
});

test("controller invokes only configured origin PINGs and deduplicates request traces", async () => {
  const remoteCalls: Array<{ label: string; to: string }> = [];
  const controller = new MeshController(
    {
      localLabel: "GPT",
      peers,
      origins: [
        { label: "CLAUDE", url: "https://claude.example/mesh/ping", token: "secret" },
        { label: "GEMINI", url: "https://gemini.example/mesh/ping", token: "secret" },
        { label: "DEEPSEEK", url: "https://deep.example/mesh/ping", token: "secret" },
      ],
    },
    async (to) => ({ traceId: "MESH-GPT-0001", rootTs: `200.${to}` }),
    async (origin, to) => {
      remoteCalls.push({ label: origin.label, to });
      return { traceId: "MESH-GEMINI-0001", rootTs: "201.001" };
    }
  );

  const first = await controller.ping({ from: "GEMINI", to: "DEEPSEEK", requestTrace: "CONTROL-TEST-0001" });
  const repeated = await controller.ping({ from: "GEMINI", to: "DEEPSEEK", requestTrace: "CONTROL-TEST-0001" });
  assert.deepEqual(first, repeated);
  assert.deepEqual(remoteCalls, [{ label: "GEMINI", to: "DEEPSEEK" }]);
  await assert.rejects(controller.ping({ from: "GEMINI", to: "UNKNOWN" }), (error: unknown) => error instanceof MeshControllerError && error.code === "invalid_target");
  await assert.rejects(controller.ping({ from: "UNKNOWN", to: "GPT" }), (error: unknown) => error instanceof MeshControllerError && error.code === "invalid_origin");
  assert.match(formatMeshControllerReceipt({
    traceId: "CONTROL-TEST-0001", from: "GEMINI", to: "DEEPSEEK", channel: "CFORNEXA", ts: "100.001",
  }, first, "GPT"), /PING_ACCEPTED/);
  assert.equal(isMeshControllerAuthorized("Bearer controller-token", "controller-token"), true);
  assert.equal(isMeshControllerAuthorized("Bearer other", "controller-token"), false);
});
