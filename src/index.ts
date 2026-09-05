import http from "node:http";
import { config } from "./config.js";
import { readRecentHistory, findPendingHandoff, postToChannel } from "./tools/slack.js";
import { getPRContext } from "./tools/github.js";
import { reviewPR } from "./deepseek.js";

/**
 * Este proceso no necesita recibir tráfico de nadie: solo sondea Slack por su
 * cuenta. Pero al desplegarlo como "web service" en Render (para poder usar
 * el plan gratuito, que los "background workers" no ofrecen) Render espera
 * que abra un puerto; si no lo hace, marca el despliegue como fallido tras
 * un rato aunque el proceso siga vivo. Este servidor HTTP mínimo solo existe
 * para satisfacer esa comprobación de plataforma — no expone ninguna acción.
 */
function startHealthServer(): void {
  const port = Number(process.env.PORT) || 10000;
  http
    .createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fornexa-ai-reviewer: vivo, sondeando Slack en segundo plano.\n");
    })
    .listen(port, () => {
      console.log(`Servidor de health-check escuchando en el puerto ${port} (solo para Render).`);
    });
}

async function tick(): Promise<void> {
  const messages = await readRecentHistory();
  const pending = findPendingHandoff(messages, config.slack.agentLabel);

  if (!pending) {
    console.log(`[${new Date().toISOString()}] Sin handoffs pendientes para ${config.slack.agentLabel}.`);
    return;
  }

  console.log(
    `[${new Date().toISOString()}] Handoff pendiente detectado: PR #${pending.prNumber}. Revisando...`
  );

  const ctx = await getPRContext(pending.prNumber);

  // MVP: modo segunda revisión. El modo ARBITRAJE se activa igual, pero
  // requiere que el handoff incluya el contexto del desacuerdo (a añadir
  // cuando GPT/Claude adopten esa convención de mensaje).
  const verdict = await reviewPR(ctx, "SEGUNDA_REVISION");

  const body = `${config.slack.agentLabel} — REVISIÓN\n\nPR #${ctx.number}: ${ctx.title}\nHEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._`;

  await postToChannel(body);
  console.log(`[${new Date().toISOString()}] Veredicto publicado en Slack para PR #${pending.prNumber}.`);
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes("--once");

  if (!runOnce) {
    startHealthServer();
  }

  await tick();

  if (runOnce) return;

  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  console.log(`Sondeando #fornexa cada ${config.pollIntervalMinutes} minuto(s)...`);
  setInterval(() => {
    tick().catch((err) => console.error("Error en el ciclo de sondeo:", err));
  }, intervalMs);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
