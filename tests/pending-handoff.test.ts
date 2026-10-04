import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-github-token";

const { findPendingHandoffWithThreadState } = await import("../src/tools/slack.js");

const requestText = [
  "DEEPSEEK — ACCIÓN REQUERIDA",
  "MODE: PR",
  "PR #89",
  "HEAD: 91e8009244c17c113291fccc7c91848e49e02220",
].join("\n");

const request = {
  ts: "1791148276.582509",
  text: requestText,
  user: "UFORNEXAGPT",
  botId: "BFORNEXAGPT",
};

test("un resultado terminal correlacionado en el hilo evita reabrir una revisión tras reinicio", async () => {
  const pending = await findPendingHandoffWithThreadState(
    [request],
    "DEEPSEEK",
    { allowedBotIds: ["BFORNEXAGPT"] },
    async (threadTs) => [
      request,
      {
        ts: "1791148300.323569",
        threadTs,
        botId: "BDEEPSEEK",
        text:
          "DEEPSEEK — REVISIÓN\n" +
          "SLACK_REQUEST_TS: 1791148276.582509\n\n" +
          "PR #89: review\nHEAD revisado: `91e8009244c17c113291fccc7c91848e49e02220`",
      },
    ]
  );

  assert.equal(pending, null);
});

test("un hilo sin resultado terminal sigue siendo recuperable por el sondeo", async () => {
  const pending = await findPendingHandoffWithThreadState(
    [request],
    "DEEPSEEK",
    { allowedBotIds: ["BFORNEXAGPT"] },
    async () => [request]
  );

  assert.equal(pending?.raw.ts, request.ts);
});
