import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const execAsync = promisify(exec);

const RENDER_URL = (
  process.env.RENDER_URL ?? "https://fornexa-ai-reviewer-gemini.onrender.com"
).replace(/\/+$/, "");
const SIDECAR_AUTH_TOKEN = process.env.SIDECAR_AUTH_TOKEN?.trim();
const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR ??
  path.resolve(process.cwd());
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 4000;

if (!SIDECAR_AUTH_TOKEN) {
  console.error(
    "Error: Debes definir la variable de entorno SIDECAR_AUTH_TOKEN para conectar con el servidor."
  );
  process.exit(1);
}

// Comandos o patrones bloqueados por seguridad
const FORBIDDEN_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-f)/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  />\s*\/dev\//i,
  /\/etc\//i,
  /\/System\//i,
  /\/Library\//i,
];

function isSafeCommand(cmd: string): boolean {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(cmd)) return false;
  }
  return true;
}

async function executeTask(taskPrompt: string): Promise<string> {
  const prompt = taskPrompt.trim();
  console.log(`[Sidecar] Ejecutando tarea: "${prompt}"`);

  // 1. Tareas comunes predefinidas
  const lower = prompt.toLowerCase();

  let commandToRun: string | null = null;

  if (
    lower.includes("git status") ||
    lower.includes("estado de git") ||
    lower.includes("estado del repositorio")
  ) {
    commandToRun = "git status -s && git log -n 3 --oneline";
  } else if (lower.includes("git diff") || lower.includes("cambios sin commit")) {
    commandToRun = "git diff --stat";
  } else if (
    lower.includes("npm test") ||
    lower.includes("pasan los tests") ||
    lower.includes("ejecuta los tests")
  ) {
    commandToRun = "npm test";
  } else if (
    lower.includes("npm run build") ||
    lower.includes("compila") ||
    lower.includes("build")
  ) {
    commandToRun = "npm run build";
  } else if (prompt.startsWith("run:") || prompt.startsWith("exec:")) {
    commandToRun = prompt.replace(/^(?:run|exec):\s*/i, "").trim();
  } else {
    // Si es un comando directo tipo "git ...", "ls ...", etc.
    const firstWord = prompt.split(/\s+/)[0];
    const allowedBinaries = ["git", "npm", "node", "ls", "cat", "find", "grep", "head", "tail", "wc"];
    if (allowedBinaries.includes(firstWord)) {
      commandToRun = prompt;
    }
  }

  if (commandToRun) {
    if (!isSafeCommand(commandToRun)) {
      return `Error de seguridad: el comando "${commandToRun}" contiene operaciones no permitidas en el entorno local.`;
    }

    try {
      const { stdout, stderr } = await execAsync(commandToRun, {
        cwd: WORKSPACE_DIR,
        timeout: 25_000,
        maxBuffer: 1024 * 1024 * 2, // 2MB
      });

      const out = stdout.trim();
      const err = stderr.trim();
      let combined = out;
      if (err) {
        combined = combined ? `${combined}\n[stderr]\n${err}` : `[stderr]\n${err}`;
      }

      if (!combined) {
        return `Comando "${commandToRun}" ejecutado con éxito (salida vacía, código 0).`;
      }

      const MAX_LENGTH = 15_000;
      if (combined.length > MAX_LENGTH) {
        return (
          combined.slice(0, MAX_LENGTH) +
          `\n... [Salida truncada a ${MAX_LENGTH} caracteres]`
        );
      }
      return combined;
    } catch (err: any) {
      const msg = err.stdout || err.stderr || err.message;
      return `Fallo ejecutando "${commandToRun}":\n${String(msg).slice(0, 5000)}`;
    }
  }

  // Si no es un comando reconocible, buscar si pide leer un fichero
  const fileMatch = prompt.match(/(?:lee|mostrar|cat|contenido de|ver)\s+([a-zA-Z0-9_\-./]+)/i);
  if (fileMatch) {
    const relativePath = fileMatch[1];
    const resolved = path.resolve(WORKSPACE_DIR, relativePath);
    if (!resolved.startsWith(WORKSPACE_DIR)) {
      return "Error de seguridad: no se permite acceder a ficheros fuera del directorio de trabajo.";
    }
    try {
      const content = await fs.readFile(resolved, "utf8");
      return (
        `Contenido de ${relativePath} (${content.length} bytes):\n` +
        content.slice(0, 15_000)
      );
    } catch (readErr: any) {
      return `No se pudo leer el fichero ${relativePath}: ${readErr.message}`;
    }
  }

  return (
    `Tarea no reconocida o formato no ejecutable: "${prompt}".\n` +
    `Puedes solicitar: estado de git, ejecutar tests, compilar el proyecto, leer un fichero o especificar "run: <comando>".`
  );
}

let running = true;

async function pollLoop() {
  console.log(`[Sidecar Antigravity] Iniciado y conectado.`);
  console.log(`[Sidecar] Servidor Render: ${RENDER_URL}`);
  console.log(`[Sidecar] Directorio de trabajo: ${WORKSPACE_DIR}`);
  console.log(`[Sidecar] Frecuencia de sondeo: ${POLL_INTERVAL_MS}ms`);

  while (running) {
    try {
      const pollRes = await fetch(`${RENDER_URL}/sidecar/poll`, {
        method: "POST",
        headers: {
          "x-sidecar-token": SIDECAR_AUTH_TOKEN!,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!pollRes.ok) {
        const text = await pollRes.text().catch(() => "");
        if (pollRes.status === 401) {
          console.error(
            `[Sidecar] Error 401: SIDECAR_AUTH_TOKEN no coincide con el servidor en Render.`
          );
        } else if (pollRes.status === 503) {
          console.warn(
            `[Sidecar] Servidor en Render aún no tiene SIDECAR_AUTH_TOKEN configurado (503). Reintentando...`
          );
        } else {
          console.warn(`[Sidecar] Respuesta inesperada del servidor (${pollRes.status}): ${text}`);
        }
        await new Promise((r) => setTimeout(r, Math.max(POLL_INTERVAL_MS, 5000)));
        continue;
      }

      const data = (await pollRes.json()) as {
        ok: boolean;
        task?: { id: string; task: string; payload?: Record<string, unknown> };
      };

      if (data.ok && data.task) {
        const { id, task: taskPrompt } = data.task;
        console.log(`[Sidecar] >> Tarea recibida [${id}]: ${taskPrompt}`);

        let result: string;
        let errorMsg: string | undefined;

        try {
          result = await executeTask(taskPrompt);
        } catch (err: any) {
          result = "";
          errorMsg = err.message || "Error desconocido al ejecutar la tarea.";
        }

        console.log(`[Sidecar] << Enviando respuesta para [${id}]...`);
        const respRes = await fetch(`${RENDER_URL}/sidecar/response`, {
          method: "POST",
          headers: {
            "x-sidecar-token": SIDECAR_AUTH_TOKEN!,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id,
            result,
            error: errorMsg,
          }),
          signal: AbortSignal.timeout(10_000),
        });

        if (respRes.ok) {
          console.log(`[Sidecar] Tarea [${id}] completada y entregada con éxito.`);
        } else {
          console.error(
            `[Sidecar] Error enviando respuesta para [${id}] (${respRes.status}).`
          );
        }
      }
    } catch (err: any) {
      if (err.name !== "AbortError") {
        console.warn(`[Sidecar] Error de conexión: ${err.message}. Reintentando...`);
      }
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`[Sidecar] Detenido.`);
}

process.on("SIGINT", () => {
  console.log("\n[Sidecar] Recibida señal de parada (SIGINT)...");
  running = false;
});

process.on("SIGTERM", () => {
  console.log("\n[Sidecar] Recibida señal de parada (SIGTERM)...");
  running = false;
});

pollLoop().catch((err) => {
  console.error("[Sidecar] Error fatal en pollLoop:", err);
  process.exit(1);
});
