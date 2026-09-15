import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Falta la variable de entorno obligatoria: ${name}. Revisa .env / .env.example.`
    );
  }
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} debe ser un número positivo.`);
  }
  return value;
}

export const config = {
  deepseek: {
    apiKey: required("DEEPSEEK_API_KEY"),
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro",
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    requestTimeoutMs: positiveNumber("DEEPSEEK_REQUEST_TIMEOUT_MS", 180_000),
  },
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    channelId: process.env.SLACK_CHANNEL_ID ?? "C0BT661FYLW",
    agentLabel: process.env.SLACK_AGENT_LABEL ?? "DEEPSEEK",
    signingSecret: process.env.SLACK_SIGNING_SECRET?.trim() || null,
  },
  github: {
    token: required("GITHUB_TOKEN"),
    owner: process.env.GITHUB_OWNER ?? "fragonh2-boop",
    repo: process.env.GITHUB_REPO ?? "Fornexa",
  },
  pollIntervalMinutes: positiveNumber("POLL_INTERVAL_MINUTES", 5),
  staleLockMinutes: positiveNumber("STALE_LOCK_MINUTES", 15),
};
