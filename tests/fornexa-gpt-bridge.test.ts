import assert from "node:assert/strict";
import test from "node:test";
import { loadFornexaGptBridgeConfig } from "../src/fornexa-gpt-bridge.js";

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
});
