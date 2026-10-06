import { Octokit } from "@octokit/rest";
import { config } from "../config.js";
import {
  isRepositoryAllowed,
  normalizeRepository,
  DEFAULT_REPOSITORY,
} from "../review-request.js";

const octokit = new Octokit({ auth: config.github.token });

export interface RepoTarget {
  owner: string;
  repo: string;
}

export function parseRepoTarget(target?: string | RepoTarget): RepoTarget {
  if (!target) {
    const defaultParts = (config.github.owner && config.github.repo)
      ? { owner: config.github.owner, repo: config.github.repo }
      : { owner: "fragonh2-boop", repo: "Fornexa" };
    return defaultParts;
  }
  if (typeof target === "object") {
    return target;
  }
  const parts = target.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Formato de repositorio inválido: '${target}'. Debe ser 'owner/repo'.`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export function resolveRepo(target?: string | RepoTarget): { owner: string; repo: string; fullRepo: string } {
  const parsed = parseRepoTarget(target);
  const normalized = normalizeRepository(`${parsed.owner}/${parsed.repo}`);
  if (!isRepositoryAllowed(normalized)) {
    throw new Error(`Repositorio no permitido: '${normalized}'. Solo se admiten repositorios en la allowlist.`);
  }
  const [owner, repo] = normalized.split("/");
  return { owner, repo, fullRepo: normalized };
}

export interface CheckState {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PRContext {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  baseSha: string;
  diffText: string;
  changedFiles: string[];
  checks: CheckState[];
}

export interface RefContext {
  repo: string;
  ref: string;
  headSha: string;
  headMessage: string;
  recentCommits: { sha: string; message: string }[];
  checks: CheckState[];
}

async function getChecksForRef(ref: string, repoTarget?: string | RepoTarget): Promise<CheckState[]> {
  const { owner, repo } = resolveRepo(repoTarget);
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
      `Aviso: no se pudieron leer los checks del ref ${ref} en ${owner}/${repo} (posible falta de permiso "Checks" en el token). Se continúa sin ese dato.`,
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
export async function getPRContext(prNumber: number, repoTarget?: string | RepoTarget): Promise<PRContext> {
  const { owner, repo, fullRepo } = resolveRepo(repoTarget);
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

  const current = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  if (current.data.head.sha !== pr.head.sha || current.data.base.sha !== pr.base.sha) {
    throw new Error('PR changed during context capture');
  }
  return {
    repo: fullRepo,
    number: prNumber,
    title: pr.title,
    headSha: pr.head.sha,
    baseSha: pr.base.sha,
    diffText,
    changedFiles: files.map((f) => f.filename),
    checks: await getChecksForRef(pr.head.sha, { owner, repo }),
  };
}

/**
 * Contexto de solo lectura para una revisión de estado de una rama/ref, por
 * ejemplo TARGET: main. Verifica el HEAD real y aporta actividad reciente;
 * DeepSeek puede completar la investigación mediante get_full_file.
 */
export async function getRefContext(ref: string, repoTarget?: string | RepoTarget): Promise<RefContext> {
  const { owner, repo, fullRepo } = resolveRepo(repoTarget);
  const { data: head } = await octokit.repos.getCommit({ owner, repo, ref });
  const commits = await octokit.repos.listCommits({
    owner,
    repo,
    sha: head.sha,
    per_page: 15,
  });

  return {
    repo: fullRepo,
    ref,
    headSha: head.sha,
    headMessage: head.commit.message,
    recentCommits: commits.data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
    })),
    checks: await getChecksForRef(head.sha, { owner, repo }),
  };
}

/**
 * Devuelve el contenido completo de un fichero en un ref concreto.
 * Herramienta de solo lectura que el modelo puede pedir cuando necesita
 * verificar el estado real del repositorio y no solo un diff.
 */
export async function getFullFileAtRef(path: string, ref: string, repoTarget?: string | RepoTarget): Promise<string> {
  const { owner, repo } = resolveRepo(repoTarget);
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
export async function postPRComment(prNumber: number, body: string, repoTarget?: string | RepoTarget): Promise<void> {
  const { owner, repo } = resolveRepo(repoTarget);
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}
