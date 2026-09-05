import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

const octokit = new Octokit({ auth: config.github.token });
const { owner, repo } = config.github;

export interface PRContext {
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  diffText: string;
  changedFiles: string[];
  checks: { name: string; status: string; conclusion: string | null }[];
}

/**
 * Recoge TODO el contexto de solo-lectura necesario para revisar una PR:
 * diff completo, lista de ficheros tocados y estado de los checks de CI
 * sobre el HEAD exacto. No escribe nada.
 */
export async function getPRContext(prNumber: number): Promise<PRContext> {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: prNumber });

  const diffResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  const diffText = diffResponse.data as unknown as string;

  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  // La API de Checks requiere el permiso "Checks" del token, que los tokens
  // fine-grained de GitHub no siempre exponen como ámbito seleccionable (solo
  // "Commit statuses"). Si el token no tiene acceso, no debe tumbar toda la
  // revisión: simplemente se informa de que no hay checks disponibles.
  let checks: PRContext["checks"] = [];
  try {
    const checkRuns = await octokit.checks.listForRef({
      owner,
      repo,
      ref: pr.head.sha,
      per_page: 100,
    });
    checks = checkRuns.data.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    }));
  } catch (err) {
    console.warn(
      `Aviso: no se pudieron leer los checks del HEAD ${pr.head.sha} (posible falta de permiso "Checks" en el token). Se continúa sin ese dato.`,
      (err as Error).message
    );
  }

  return {
    number: prNumber,
    title: pr.title,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    diffText,
    changedFiles: files.map((f) => f.filename),
    checks,
  };
}

/**
 * Devuelve el contenido completo de un fichero en el HEAD de la PR.
 * Herramienta de solo lectura que el modelo puede pedir cuando el diff
 * (que solo trae hunks) no le basta para razonar con seguridad.
 */
export async function getFullFileAtRef(path: string, ref: string): Promise<string> {
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
    throw new Error(`${path} no es un fichero de texto en ${ref}`);
  }
  return Buffer.from(data.content, "base64").toString("utf-8");
}

/**
 * Publica el veredicto como comentario en la PR.
 *
 * IMPORTANTE — límite de seguridad real, no solo de prompt:
 * este módulo NUNCA implementa merge, push a main, ni gestión de checks/deploys.
 * El token de GitHub que usa este proceso debe tener permiso de
 * "Pull requests: Read + Write" únicamente para poder llamar a esta función
 * (comentar), y NADA de "Contents: Write" en main ni "Administration".
 */
export async function postPRComment(prNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}
