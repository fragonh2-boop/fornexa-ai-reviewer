import { WebClient } from "@slack/web-api";
import { config } from "../config.js";

let botPublisherClient: WebClient | null = null;

/**
 * Devuelve un WebClient inicializado con SLACK_BOT_CHANNEL_TOKEN para publicar
 * con la identidad del bot del canal (ej. FornexaClaude).
 * Si la variable no está configurada, devuelve null (lazy-init y zero breaking changes).
 */
export function getBotPublisherClient(): WebClient | null {
  if (!config.slack.botChannelToken) {
    return null;
  }
  if (!botPublisherClient) {
    botPublisherClient = new WebClient(config.slack.botChannelToken);
  }
  return botPublisherClient;
}

/** Para pruebas unitarias: permite reiniciar la instancia en memoria. */
export function resetBotPublisherClient(): void {
  botPublisherClient = null;
}
