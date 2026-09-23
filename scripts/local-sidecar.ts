import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const execFileAsync = promisify(execFile);

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

async function runExecFile(file: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: WORKSPACE_DIR,
      timeout: 25_000,
      maxBuffer: 1024 * 1024 * 2, // 2MB
      shell: false, // Bypasses shell parsing completely (MUST-2)
    });

    const out = stdout.trim();
    const err = stderr.trim();
    let combined = out;
    if (err) {
      combined = combined ? `${combined}\n[stderr]\n${err}` : `[stderr]\n${err}`;
    }

    if (!combined) {
      return `Comando "${file} ${args.join(" ")}" ejecutado con éxito (salida vacía, código 0).`;
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
    return `Fallo ejecutando "${file} ${args.join(" ")}":\n${String(msg).slice(0, 5000)}`;
  }
}

async function executeTask(taskPrompt: string): Promise<string> {
  const prompt = taskPrompt.trim();
  console.log(`[Sidecar] Ejecutando tarea: "${prompt}"`);

  const lower = prompt.toLowerCase();

  // 1. Operaciones seguras con Git (sin shell)
  if (
    lower === "git status" ||
    lower === "git status -s" ||
    lower === "git status --short" ||
    lower.includes("estado de git") ||
    lower.includes("estado del repositorio")
  ) {
    return runExecFile("git", ["status", "-s"]);
  }

  if (
    lower === "git diff" ||
    lower === "git diff --stat" ||
    lower.includes("cambios sin commit")
  ) {
    return runExecFile("git", ["diff", "--stat"]);
  }

  if (
    lower === "git log" ||
    lower.includes("últimos commits") ||
    lower.includes("historial de commits")
  ) {
    return runExecFile("git", ["log", "-n", "5", "--oneline"]);
  }

  if (lower === "git branch" || lower === "git branch -a") {
    return runExecFile("git", ["branch", "-a"]);
  }

  // 2. Operaciones NPM predefinidas y fijas (MUST-2: no se admite node -e ni scripts arbitrarios)
  if (
    lower === "npm test" ||
    lower.includes("pasan los tests") ||
    lower.includes("ejecuta los tests")
  ) {
    return runExecFile("npm", ["test"]);
  }

  if (
    lower === "npm run build" ||
    lower === "compila" ||
    lower.includes("compilar el proyecto")
  ) {
    return runExecFile("npm", ["run", "build"]);
  }

  // 3. Lectura segura de ficheros acotada al WORKSPACE_DIR con validación de separador (MUST-2)
  const fileMatch = prompt.match(/^(?:leer|ver|cat|read|contenido de)\s+([a-zA-Z0-9_\-./]+)$/i);
  if (fileMatch) {
    const relativePath = fileMatch[1];
    const resolved = path.resolve(WORKSPACE_DIR, relativePath);
    // Verificación estricta de límites (evita path traversal y prefijos como .../work-evil)
    if (resolved !== WORKSPACE_DIR && !resolved.startsWith(WORKSPACE_DIR + path.sep)) {
      return "Error de seguridad: la ruta solicitada está fuera del espacio de trabajo permitido.";
    }
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return `Error: "${relativePath}" no es un fichero regular.`;
      }
      const content = await fs.readFile(resolved, "utf8");
      const MAX_LENGTH = 15_000;
      if (content.length > MAX_LENGTH) {
        return (
          `Contenido de ${relativePath} (${content.length} bytes, truncado a ${MAX_LENGTH}):\n` +
          content.slice(0, MAX_LENGTH)
        );
      }
      return `Contenido de ${relativePath} (${content.length} bytes):\n${content}`;
    } catch (readErr: any) {
      return `No se pudo leer el fichero ${relativePath}: ${readErr.message}`;
    }
  }

  // Rechazo de comandos libres o no contemplados en la allowlist estricta
  return (
    `Operación no permitida: por directiva de seguridad local (MUST-2), no se permite la ejecución de comandos arbitrarios en el shell.\n` +
    `Operaciones autorizadas de solo lectura: git status, git diff, git log, git branch, npm test, npm run build, o leer <fichero_relativo>.`
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
