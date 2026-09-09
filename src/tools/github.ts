import { Octokit } from "@octokit/rest";
import { config } from "../config.js";

const octokit = new Octokit({ auth: config.github.token });
const { owner, repo } = config.github;

export interface CheckState {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PRContext {
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  diffText: string;
  changedFiles: string[];
  checks: CheckState[];
}

export interface RefContext {
  ref: string;
  headSha: string;
  headMessage: string;
  recentCommits: { sha: string; message: string }[];
  checks: CheckState[];
}

async function getChecksForRef(ref: string): Promise<CheckState[]> {
  try {
    const checkRuns = await octokit.checks.listForRef({
      owner,
      repo,
      ref,
      per_page: 100,
    });
    return checkRuns.data.check_runs.map((c) => ({
      name: c.name,
      status: c.status,
      conclusion: c.conclusion,
    }));
  } catch (err) {
    console.warn(
      `Aviso: no se pudieron leer los checks del ref ${ref} (posible falta de permiso "Checks" en el token). Se continúa sin ese dato.`,
      (err as Error).message
    );
    return [];
  }
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

  return {
    number: prNumber,
    title: pr.title,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    diffText,
    changedFiles: files.map((f) => f.filename),
    checks: await getChecksForRef(pr.head.sha),
  };
}

/**
 * Contexto de solo lectura para una revisión de estado de una rama/ref, por
 * ejemplo TARGET: main. Verifica el HEAD real y aporta actividad reciente;
 * DeepSeek puede completar la investigación mediante get_full_file.
 */
export async function getRefContext(ref: string): Promise<RefContext> {
  const { data: head } = await octokit.repos.getCommit({ owner, repo, ref });
  const commits = await octokit.repos.listCommits({
    owner,
    repo,
    sha: head.sha,
    per_page: 15,
  });

  return {
    ref,
    headSha: head.sha,
    headMessage: head.commit.message,
    recentCommits: commits.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
    })),
    checks: await getChecksForRef(head.sha),
  };
}

/**
 * Devuelve el contenido completo de un fichero en un ref concreto.
 * Herramienta de solo lectura que el modelo puede pedir cuando necesita
 * verificar el estado real del repositorio y no solo un diff.
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
 */
export async function postPRComment(prNumber: number, body: string): Promise<void> {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}
