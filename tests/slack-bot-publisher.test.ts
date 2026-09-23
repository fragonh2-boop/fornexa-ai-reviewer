import test from "node:test";
import assert from "node:assert/strict";

// Variables de entorno mínimas para carga de config en ESM
process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-gh-token";

const { config } = await import("../src/config.js");
const {
  getBotPublisherClient,
  resetBotPublisherClient,
} = await import("../src/tools/slack-bot-publisher.js");
const {
  getEffectiveSlackClient,
} = await import("../src/tools/slack.js");

test("getBotPublisherClient devuelve null si botChannelToken no está configurado", () => {
  const original = config.slack.botChannelToken;
  try {
    config.slack.botChannelToken = null;
    resetBotPublisherClient();
    assert.equal(getBotPublisherClient(), null);
  } finally {
    config.slack.botChannelToken = original;
    resetBotPublisherClient();
  }
});

test("getBotPublisherClient realiza lazy-initialization y cachea la instancia cuando hay token", () => {
  const original = config.slack.botChannelToken;
  try {
    config.slack.botChannelToken = "xoxb-mock-bot-channel-token";
    resetBotPublisherClient();

    const client1 = getBotPublisherClient();
    assert.ok(client1 !== null, "Debe crear una instancia de WebClient");

    const client2 = getBotPublisherClient();
    assert.equal(client1, client2, "Debe reutilizar la misma instancia cacheada");
  } finally {
    config.slack.botChannelToken = original;
    resetBotPublisherClient();
  }
});

test("getEffectiveSlackClient devuelve botPublisher si está configurado, o cliente por defecto", () => {
  const original = config.slack.botChannelToken;
  try {
    // Sin botChannelToken -> fallback al cliente por defecto
    config.slack.botChannelToken = null;
    resetBotPublisherClient();
    const defaultClient = getEffectiveSlackClient();
    assert.ok(defaultClient !== null);

    // Con botChannelToken -> cliente del bot
    config.slack.botChannelToken = "xoxb-mock-bot-channel-token";
    resetBotPublisherClient();
    const botClient = getEffectiveSlackClient();
    assert.ok(botClient !== null);
    assert.notEqual(defaultClient, botClient);
  } finally {
    config.slack.botChannelToken = original;
    resetBotPublisherClient();
  }
});
