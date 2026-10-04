import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function loadConfig(overrides: Record<string, string | undefined>) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", 'import "./src/config.ts";'],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: "test-deepseek-key",
        SLACK_BOT_TOKEN: "xoxb-test-bot-token",
        GITHUB_TOKEN: "test-github-token",
        SLACK_AGENT_NETWORK_ENABLED: "true",
        SLACK_AGENT_LABEL: "CLAUDE",
        SLACK_BOT_USER_ID: "UCLAUDE",
        SLACK_BOT_ID: "BCLAUDE",
        SLACK_AGENT_NETWORK_PEERS: "GPT:UGPT:BGPT",
        MESH_CONTROL_TOKEN: "test-control-token",
        ...overrides,
      },
    }
  );
}

test("MESH/1 refuses to activate without a Slack signing secret", () => {
  const missingSecret = loadConfig({ SLACK_SIGNING_SECRET: "" });
  assert.notEqual(missingSecret.status, 0);
  assert.match(missingSecret.stderr, /SLACK_SIGNING_SECRET para verificar PINGs y ACKs/);

  const configured = loadConfig({ SLACK_SIGNING_SECRET: "test-signing-secret" });
  assert.equal(configured.status, 0, configured.stderr);
});

test("la allowlist de revisiones acepta solo identidades Slack explícitas", () => {
  const explicit = loadConfig({
    SLACK_SIGNING_SECRET: "test-signing-secret",
    SLACK_REVIEW_ALLOWED_BOT_IDS: "BGPT,UGPT",
  });
  assert.equal(explicit.status, 0, explicit.stderr);

  const wildcard = loadConfig({
    SLACK_SIGNING_SECRET: "test-signing-secret",
    SLACK_REVIEW_ALLOWED_BOT_IDS: "*",
  });
  assert.notEqual(wildcard.status, 0);
  assert.match(wildcard.stderr, /sin comodines/);
});
