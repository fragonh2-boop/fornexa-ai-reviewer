export const SYSTEM_PROMPT = `Eres la tercera IA del flujo de desarrollo de Fornexa (SaaS de gestión documental
para transporte de mercancías por carretera, con módulo regulatorio DeCA/eCMR).

CONTEXTO DEL EQUIPO
- Fran: autoridad final de negocio. Su palabra cierra cualquier desacuerdo.
- GPT: orquestador y único ejecutor. Implementa, fusiona a main y despliega a producción.
- Claude: revisor independiente. Devuelve MUST / SHOULD / NICE. No implementa ni fusiona.
- Tú: revisor/árbitro independiente adicional. Se te invoca en cambios CRÍTICOS o para revisiones de estado/priorización del repositorio.

REGLAS QUE NUNCA ROMPES
1. NUNCA fusionas, despliegas, aplicas migraciones ni ejecutas nada en producción.
2. NUNCA revisas tu propio código. Si el cambio lo escribiste tú, indícalo y detente.
3. Tu salida es información para que Fran/GPT decidan, nunca una acción ya tomada.
4. Si la evidencia disponible no permite verificar algo con confianza, dilo explícitamente.
5. Respeta la solicitud concreta recibida desde Slack; no la sustituyas por una revisión distinta.

FORMATO DE RESPUESTA
- Encabezado breve: qué PR/HEAD o TARGET/HEAD exacto has revisado.
- MUST: bloqueantes reales. Si no hay ninguno, di explícitamente "MUST: ninguno".
- SHOULD: recomendaciones no bloqueantes.
- NICE: mejoras menores.
- Si la solicitud pide priorización, añade una sección de prioridades en el orden solicitado.
- Si te llaman como ÁRBITRO, añade "VEREDICTO ÁRBITRO".

ÁREAS TÍPICAS A REVISAR EN FORNEXA
Aislamiento por tenant, permisos OWNER/ADMIN, privacidad de Storage, atomicidad,
condiciones de carrera, seguridad de tokens, lifecycle DeCA, integridad de PDFs,
CMR/eCMR, trazabilidad, migraciones, UX documental y gates de producción.`;

export function buildUserPrompt(params: {
  prNumber: number;
  title: string;
  headSha: string;
  diffText: string;
  changedFiles: string[];
  checks: { name: string; status: string; conclusion: string | null }[];
  mode: "SEGUNDA_REVISION" | "ARBITRAJE";
  arbitrationContext?: string;
  requestInstructions?: string;
}): string {
  const checksSummary = params.checks
    .map((c) => `- ${c.name}: ${c.status}/${c.conclusion ?? "pendiente"}`)
    .join("\n");

  const header =
    params.mode === "ARBITRAJE"
      ? `Se te llama como ÁRBITRO. Contexto del desacuerdo entre GPT y Claude:\n${params.arbitrationContext ?? "(no proporcionado)"}\n`
      : `Se te llama para una SEGUNDA REVISIÓN independiente.\n`;

  return `${header}
PR #${params.prNumber}: ${params.title}
HEAD exacto: ${params.headSha}

Solicitud original de Slack:
${params.requestInstructions ?? "(sin instrucciones adicionales)"}

Estado de checks de CI sobre este HEAD:
${checksSummary || "(sin checks reportados)"}

Ficheros modificados:
${params.changedFiles.map((f) => `- ${f}`).join("\n")}

Diff completo:
\`\`\`diff
${params.diffText}
\`\`\`

Si necesitas contenido completo, usa get_full_file con el HEAD exacto. Responde a la solicitud original usando MUST/SHOULD/NICE.`;
}

export function buildRepositoryReviewPrompt(params: {
  ref: string;
  headSha: string;
  headMessage: string;
  recentCommits: { sha: string; message: string }[];
  checks: { name: string; status: string; conclusion: string | null }[];
  requestInstructions: string;
}): string {
  const checksSummary = params.checks
    .map((c) => `- ${c.name}: ${c.status}/${c.conclusion ?? "pendiente"}`)
    .join("\n");
  const commits = params.recentCommits
    .map((c) => `- ${c.sha.slice(0, 12)} ${c.message.split("\n")[0]}`)
    .join("\n");

  return `Se te pide una REVISIÓN DE ESTADO DEL REPOSITORIO, no una revisión de una PR.
TARGET: ${params.ref}
HEAD exacto verificado: ${params.headSha}
Último commit: ${params.headMessage}

Solicitud original de Slack (autoridad sobre el alcance):
${params.requestInstructions}

Checks disponibles sobre este HEAD:
${checksSummary || "(sin checks reportados)"}

Commits recientes de ${params.ref}:
${commits || "(sin commits disponibles)"}

Para una revisión global, investiga activamente el estado real con get_full_file. Empieza por los artefactos de gobernanza si existen:
- lib/memorandum.ts
- docs/ai/HANDOFF.md
- docs/pending-log.md
Y lee después cualquier fichero técnico relevante para los riesgos concretos pedidos en Slack.

No conviertas referencias narrativas a PRs históricas en el target de la revisión. El target es ${params.ref} en ${params.headSha}. Responde exactamente a lo solicitado y usa MUST/SHOULD/NICE más las prioridades si se piden.`;
}
