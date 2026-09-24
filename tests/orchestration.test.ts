import test from "node:test";
import assert from "node:assert/strict";

// Variables de entorno mínimas para carga de config en ESM
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-gh-token";

const { conversationTools } = await import("../src/agent.js");
const {
  dispatchDeepSeekReview,
  dispatchAgentMessage,
  CLAUDE_SLACK_USER_ID,
  GPT_SLACK_USER_ID,
} = await import("../src/tools/orchestration.js");

test("conversationTools incluye las herramientas de orquestación registradas", () => {
  const toolNames = conversationTools.map((t) => t.function.name);
  assert.ok(toolNames.includes("dispatch_deepseek_review"), "Debe incluir dispatch_deepseek_review");
  assert.ok(toolNames.includes("dispatch_agent_message"), "Debe incluir dispatch_agent_message");
  assert.ok(toolNames.includes("get_repository_status"), "Debe incluir get_repository_status");
  assert.equal(toolNames.length, 6, "Debe haber exactamente 6 herramientas de conversación");
});

test("dispatchDeepSeekReview para 'main' formatea el protocolo exacto y publica en Slack", async () => {
  let postedText = "";

  const mockGetRefContext = async (ref: string) => ({
    ref,
    headSha: "844a2ef45641fe2194dc4226baee3478ab36752c",
    headMessage: "docs: reconcile current main handoff",
    recentCommits: [],
    checks: [],
  });

  const mockPostToChannelSmart = async (text: string) => {
    postedText = text;
  };

  const result = await dispatchDeepSeekReview(
    {
      target: "main",
      instructions: "Verificación de gobernanza y dependencias",
    },
    {
      getRefContext: mockGetRefContext as any,
      postToChannelSmart: mockPostToChannelSmart as any,
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.target, "main");
  assert.equal(result.headSha, "844a2ef45641fe2194dc4226baee3478ab36752c");
  assert.ok(postedText.includes("DEEPSEEK — ACCIÓN REQUERIDA"));
  assert.ok(postedText.includes("MODE: MAIN"));
  assert.ok(postedText.includes("TARGET: main"));
  assert.ok(postedText.includes("HEAD: 844a2ef45641fe2194dc4226baee3478ab36752c"));
  assert.ok(postedText.includes("Verificación de gobernanza y dependencias"));
});

test("dispatchDeepSeekReview para 'pr' valida prNumber y formatea el protocolo exacto", async () => {
  let postedText = "";

  // 1. Error si falta prNumber
  await assert.rejects(
    async () => dispatchDeepSeekReview({ target: "pr" }),
    /Se requiere un número de PR válido/
  );

  const mockGetPRContext = async (prNumber: number) => ({
    number: prNumber,
    title: "Feature test",
    headSha: "1111222233334444555566667777888899990000",
    baseSha: "aaaabbbbccccddddeeeeffff0000111122223333",
    diffText: "mock diff",
    changedFiles: ["file.ts"],
    checks: [],
  });

  const mockPostToChannelSmart = async (text: string) => {
    postedText = text;
  };

  const result = await dispatchDeepSeekReview(
    {
      target: "pr",
      prNumber: 42,
      instructions: "Revisar arquitectura de seguridad",
    },
    {
      getPRContext: mockGetPRContext as any,
      postToChannelSmart: mockPostToChannelSmart as any,
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.target, "pr");
  assert.equal(result.prNumber, 42);
  assert.equal(result.headSha, "1111222233334444555566667777888899990000");
  assert.ok(postedText.includes("DEEPSEEK — ACCIÓN REQUERIDA"));
  assert.ok(postedText.includes("MODE: PR"));
  assert.ok(postedText.includes("PR #42"));
  assert.ok(postedText.includes("HEAD: 1111222233334444555566667777888899990000"));
  assert.ok(postedText.includes("Revisar arquitectura de seguridad"));
});

test("dispatchAgentMessage envía mención a Claude o ChatGPT correctamente", async () => {
  let postedChannelText = "";
  let postedThreadText = "";
  let postedThreadTs = "";

  const mockPostToChannelSmart = async (text: string) => {
    postedChannelText = text;
  };
  const mockPostToThreadSmart = async (text: string, ts: string) => {
    postedThreadText = text;
    postedThreadTs = ts;
  };

  const deps = {
    postToChannelSmart: mockPostToChannelSmart as any,
    postToThreadSmart: mockPostToThreadSmart as any,
  };

  // 1. Mensaje a Claude en canal
  const claudeResult = await dispatchAgentMessage(
    {
      agent: "claude",
      message: "¿Podrías revisar el diseño de este endpoint?",
    },
    deps
  );
  assert.equal(claudeResult.ok, true);
  assert.equal(claudeResult.postedTo, "channel");
  assert.ok(postedChannelText.includes(`<@${CLAUDE_SLACK_USER_ID}>`));
  assert.ok(postedChannelText.includes("¿Podrías revisar el diseño de este endpoint?"));

  // 2. Mensaje a ChatGPT en hilo
  const gptResult = await dispatchAgentMessage(
    {
      agent: "chatgpt",
      message: "¿Qué opinas del balance de carga?",
      threadTs: "1234567890.123456",
    },
    deps
  );
  assert.equal(gptResult.ok, true);
  assert.equal(gptResult.postedTo, "thread");
  assert.equal(postedThreadTs, "1234567890.123456");
  assert.ok(postedThreadText.includes(`<@${GPT_SLACK_USER_ID}>`));
  assert.ok(postedThreadText.includes("¿Qué opinas del balance de carga?"));

  // 3. Error si mensaje vacío
  await assert.rejects(
    async () => dispatchAgentMessage({ agent: "claude", message: "   " }, deps),
    /El mensaje a enviar no puede estar vacío/
  );

  // 4. Error si agente no soportado
  await assert.rejects(
    async () => dispatchAgentMessage({ agent: "unknown" as any, message: "hola" }, deps),
    /Agente no soportado/
  );
});
