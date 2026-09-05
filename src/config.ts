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

export const config = {
  deepseek: {
    apiKey: required("DEEPSEEK_API_KEY"),
    model: process.env.DEEPSEEK_MODEL ?? "deepseek-chat",
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
  },
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    channelId: process.env.SLACK_CHANNEL_ID ?? "C0BT661FYLW",
    agentLabel: process.env.SLACK_AGENT_LABEL ?? "DEEPSEEK",
  },
  github: {
    token: required("GITHUB_TOKEN"),
    owner: process.env.GITHUB_OWNER ?? "fragonh2-boop",
    repo: process.env.GITHUB_REPO ?? "Fornexa",
  },
  pollIntervalMinutes: Number(process.env.POLL_INTERVAL_MINUTES ?? "5"),
};
