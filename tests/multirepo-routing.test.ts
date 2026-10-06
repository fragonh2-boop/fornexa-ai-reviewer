import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-github-token";

const {
  parseReviewRequest,
  isReviewResponseForRequest,
  isRepositoryAllowed,
  normalizeRepository,
  ALLOWED_REPOSITORIES,
} = await import("../src/review-request.js");

const {
  getPRContext,
  getRefContext,
  getFullFileAtRef,
  parseRepoTarget,
  resolveRepo,
} = await import("../src/tools/github.js");

const {
  dispatchDeepSeekReview,
  getRepositoryStatus,
} = await import("../src/tools/orchestration.js");

const { formatSlackMessageParts } = await import("../src/slack-message-parts.js");
const { findPendingHandoffWithThreadState } = await import("../src/tools/slack.js");

test("allowlist: solo permite repositorios autorizados de forma estricta y normalizada", () => {
  assert.equal(isRepositoryAllowed("fragonh2-boop/fornexa-ai-reviewer"), true);
  assert.equal(isRepositoryAllowed("fragonh2-boop/Fornexa"), true);
  assert.equal(isRepositoryAllowed("FRAGONH2-BOOP/FORNEXA-AI-REVIEWER"), true);
  assert.equal(isRepositoryAllowed("fragonh2-boop/fornexa"), true);

  assert.equal(isRepositoryAllowed("attacker/malicious-repo"), false);
  assert.equal(isRepositoryAllowed("fragonh2-boop/other"), false);
  assert.equal(isRepositoryAllowed(""), false);
});

test("parseReviewRequest: extrae repo explícito tanto para PR como para ref/main", () => {
  const prReviewText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: PR",
    "Repo: fragonh2-boop/fornexa-ai-reviewer",
    "PR #35",
    "HEAD: c3764b9b872871e78fc9ff5f957b865eea6c5e6b",
  ].join("\n");

  const prReq = parseReviewRequest(prReviewText, "DEEPSEEK");
  assert.ok(prReq);
  assert.equal(prReq.target, "pr");
  if (prReq.target === "pr") {
    assert.equal(prReq.prNumber, 35);
  }
  assert.equal(prReq.repository, "fragonh2-boop/fornexa-ai-reviewer");
  assert.equal(prReq.requestedHead, "c3764b9b872871e78fc9ff5f957b865eea6c5e6b");

  const refReviewText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: MAIN",
    "TARGET: main",
    "Repo: fragonh2-boop/Fornexa",
    "HEAD: 573bee8ee05a066bab908baedb1e79b43d455edb",
  ].join("\n");

  const refReq = parseReviewRequest(refReviewText, "DEEPSEEK");
  assert.ok(refReq);
  assert.equal(refReq.target, "ref");
  if (refReq.target === "ref") {
    assert.equal(refReq.ref, "main");
  }
  assert.equal(refReq.repository, "fragonh2-boop/Fornexa");
  assert.equal(refReq.requestedHead, "573bee8ee05a066bab908baedb1e79b43d455edb");
});

test("parseReviewRequest: peticiones con MODE: IMPLEMENT son ignoradas para revisión", () => {
  const text = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: IMPLEMENT",
    "PR #35",
    "HEAD: c3764b9b872871e78fc9ff5f957b865eea6c5e6b",
  ].join("\n");

  const req = parseReviewRequest(text, "DEEPSEEK");
  assert.equal(req, null, "MODE: IMPLEMENT no debe procesarse como revisión de solo lectura");
});

test("1. Mismo número de PR en dos repos distintos: resolución independiente sin colisión", async () => {
  const reviewerPRText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: PR",
    "Repo: fragonh2-boop/fornexa-ai-reviewer",
    "PR #35",
    "HEAD: 1111111111111111111111111111111111111111",
  ].join("\n");

  const productPRText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: PR",
    "Repo: fragonh2-boop/Fornexa",
    "PR #35",
    "HEAD: 2222222222222222222222222222222222222222",
  ].join("\n");

  const req1 = parseReviewRequest(reviewerPRText, "DEEPSEEK");
  const req2 = parseReviewRequest(productPRText, "DEEPSEEK");

  assert.ok(req1 && req2);
  assert.equal(req1.repository, "fragonh2-boop/fornexa-ai-reviewer");
  assert.equal(req2.repository, "fragonh2-boop/Fornexa");
  assert.equal(req1.target === "pr" ? req1.prNumber : 0, 35);
  assert.equal(req2.target === "pr" ? req2.prNumber : 0, 35);
  assert.notEqual(req1.repository, req2.repository);
  assert.notEqual(req1.requestedHead, req2.requestedHead);

  // Verificación de clave única de bloqueo/aislamiento
  const key1 = `pr:${req1.repository}:${req1.target === "pr" ? req1.prNumber : 0}:${req1.requestedHead}`;
  const key2 = `pr:${req2.repository}:${req2.target === "pr" ? req2.prNumber : 0}:${req2.requestedHead}`;
  assert.notEqual(key1, key2, "Los candados para el mismo número de PR en distintos repos deben ser disjuntos");
});

test("2. Repo desconocido o fuera de allowlist: rechazado en dispatch y herramientas de github", async () => {
  const disallowedRepo = "attacker/evil-repo";

  assert.throws(
    () => resolveRepo(disallowedRepo),
    /Repositorio no permitido/,
    "resolveRepo debe rechazar repos fuera de la allowlist"
  );

  await assert.rejects(
    async () =>
      dispatchDeepSeekReview({
        target: "main",
        repo: disallowedRepo,
      }),
    /Repositorio no permitido para dispatch/,
    "dispatchDeepSeekReview debe rechazar repos no autorizados"
  );

  await assert.rejects(
    async () =>
      getRepositoryStatus("main", disallowedRepo),
    /Repositorio no permitido/,
    "getRepositoryStatus debe rechazar repos no autorizados"
  );
});

test("3. SHA de otro repo o SHA mismatch (TOCTOU guard en dispatchDeepSeekReview)", async () => {
  const mockGetPRContext = async (prNumber: number, repoTarget?: any) => ({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    number: prNumber,
    title: "Feature",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    baseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    diffText: "",
    changedFiles: [],
    checks: [],
  });

  // Si pasamos un expectedHeadSha que no coincide con el HEAD actual de esa PR
  await assert.rejects(
    async () =>
      dispatchDeepSeekReview(
        {
          target: "pr",
          prNumber: 35,
          repo: "fragonh2-boop/fornexa-ai-reviewer",
          expectedHeadSha: "9999999999999999999999999999999999999999", // SHA ajeno o desactualizado
        },
        { getPRContext: mockGetPRContext as any }
      ),
    /HEAD mismatch para PR #35/,
    "dispatchDeepSeekReview debe rechazar si expectedHeadSha no coincide con el HEAD real del repo"
  );
});

test("4. Cambio de HEAD entre despacho y ejecución: validación de coherencia", async () => {
  const mockGetRefContext = async (ref: string, repoTarget?: any) => ({
    repo: "fragonh2-boop/Fornexa",
    ref,
    headSha: "actual-sha-123456789012345678901234567890",
    headMessage: "test",
    recentCommits: [],
    checks: [],
  });

  await assert.rejects(
    async () =>
      dispatchDeepSeekReview(
        {
          target: "main",
          repo: "fragonh2-boop/Fornexa",
          expectedHeadSha: "stale-sha-99999999999999999999999999999999",
        },
        { getRefContext: mockGetRefContext as any }
      ),
    /HEAD mismatch para main/,
    "Debe rechazar si el HEAD cambió"
  );
});

test("5. dispatchDeepSeekReview incluye línea Repo: para target 'pr' y target 'main'", async () => {
  let postedPRText = "";
  let postedMainText = "";

  const mockGetPRContext = async (prNumber: number, repoTarget?: any) => ({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    number: prNumber,
    title: "Reviewer PR",
    headSha: "1111111111111111111111111111111111111111",
    baseSha: "2222222222222222222222222222222222222222",
    diffText: "",
    changedFiles: [],
    checks: [],
  });

  const mockGetRefContext = async (ref: string, repoTarget?: any) => ({
    repo: "fragonh2-boop/Fornexa",
    ref,
    headSha: "3333333333333333333333333333333333333333",
    headMessage: "test",
    recentCommits: [],
    checks: [],
  });

  const mockPostToChannel = async (text: string) => {
    if (text.includes("MODE: PR")) postedPRText = text;
    if (text.includes("MODE: MAIN")) postedMainText = text;
  };

  await dispatchDeepSeekReview(
    {
      target: "pr",
      prNumber: 35,
      repo: "fragonh2-boop/fornexa-ai-reviewer",
      expectedHeadSha: "1111111111111111111111111111111111111111",
    },
    {
      getPRContext: mockGetPRContext as any,
      postToChannelSmart: mockPostToChannel as any,
    }
  );

  assert.ok(postedPRText.includes("Repo: fragonh2-boop/fornexa-ai-reviewer"));
  assert.ok(postedPRText.includes("PR #35"));
  assert.ok(postedPRText.includes("HEAD: 1111111111111111111111111111111111111111"));

  await dispatchDeepSeekReview(
    {
      target: "main",
      repo: "fragonh2-boop/Fornexa",
      expectedHeadSha: "3333333333333333333333333333333333333333",
    },
    {
      getRefContext: mockGetRefContext as any,
      postToChannelSmart: mockPostToChannel as any,
    }
  );

  assert.ok(postedMainText.includes("Repo: fragonh2-boop/Fornexa"));
  assert.ok(postedMainText.includes("TARGET: main"));
  assert.ok(postedMainText.includes("HEAD: 3333333333333333333333333333333333333333"));
});

test("6. isReviewResponseForRequest: valida correspondencia exacta de Repo cuando está presente", () => {
  const req = {
    repository: "fragonh2-boop/fornexa-ai-reviewer",
    target: "pr" as const,
    prNumber: 35,
    requestedHead: "c3764b9b872871e78fc9ff5f957b865eea6c5e6b",
    instructions: "",
  };

  const matchingResponse = {
    botId: "BDEEPSEEK",
    text: [
      "DEEPSEEK — REVISIÓN",
      "SLACK_REQUEST_TS: 1234567890.123456",
      "",
      "Repo: fragonh2-boop/fornexa-ai-reviewer",
      "PR #35: Fix routing",
      "HEAD revisado: `c3764b9b872871e78fc9ff5f957b865eea6c5e6b`",
      "",
      "APTO: SÍ",
    ].join("\n"),
  };

  const mismatchedRepoResponse = {
    botId: "BDEEPSEEK",
    text: [
      "DEEPSEEK — REVISIÓN",
      "SLACK_REQUEST_TS: 1234567890.123456",
      "",
      "Repo: fragonh2-boop/Fornexa", // Repositorio distinto!
      "PR #35: Producto Feature",
      "HEAD revisado: `c3764b9b872871e78fc9ff5f957b865eea6c5e6b`",
      "",
      "APTO: SÍ",
    ].join("\n"),
  };

  assert.equal(
    isReviewResponseForRequest(matchingResponse, "DEEPSEEK", req, "1234567890.123456"),
    true,
    "Debe reconocer la respuesta cuando coincide el repositorio"
  );

  assert.equal(
    isReviewResponseForRequest(mismatchedRepoResponse, "DEEPSEEK", req, "1234567890.123456"),
    false,
    "Debe rechazar la respuesta si pertenece a otro repositorio a pesar de compartir número de PR y SHA"
  );
});

test("7. formatSlackMessageParts: conserva encabezado Repo en cada fragmento dividido", () => {
  const headSha = "c3764b9b872871e78fc9ff5f957b865eea6c5e6b";
  const requestTs = "1234567890.111111";
  const longContent = "A".repeat(5000);

  const fullText = [
    "DEEPSEEK — REVISIÓN",
    `SLACK_REQUEST_TS: ${requestTs}`,
    "",
    "Repo: fragonh2-boop/fornexa-ai-reviewer",
    "PR #35: Corrección multirrepo",
    `HEAD revisado: \`${headSha}\``,
    "",
    longContent,
  ].join("\n");

  const parts = formatSlackMessageParts(fullText, 3800);
  assert.ok(parts.length > 1, "El mensaje debe haberse dividido en varias partes");

  for (const [index, part] of parts.entries()) {
    assert.ok(
      part.includes("Repo: fragonh2-boop/fornexa-ai-reviewer"),
      `La parte ${index + 1} debe conservar el encabezado Repo`
    );
    assert.ok(
      part.includes(`HEAD revisado: \`${headSha}\``),
      `La parte ${index + 1} debe conservar el HEAD revisado`
    );
    assert.ok(
      part.includes(`SLACK_REQUEST_TS: ${requestTs}`),
      `La parte ${index + 1} debe conservar el SLACK_REQUEST_TS`
    );
  }
});

test("8. Terminal de rechazo para repo fuera de allowlist (target PR): correlaciona exactamente y valida correspondencia", () => {
  const req = {
    repository: "unauthorized-org/unauthorized-repo",
    target: "pr" as const,
    prNumber: 99,
    requestedHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    instructions: "",
  };

  const requestTs = "1791254100.123456";

  const targetScope = `PR #${req.prNumber}: HEAD solicitado \`${req.requestedHead}\``;
  const rejectionText = [
    "DEEPSEEK — REVISIÓN NO INICIADA",
    `SLACK_REQUEST_TS: ${requestTs}`,
    "",
    `Repo: ${req.repository}`,
    `${targetScope}: repositorio no autorizado: \`${req.repository}\`.`,
    "",
    "_Solo se admiten repositorios autorizados en la allowlist cerrada._",
  ].join("\n");

  const matchingResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText,
  };

  // Positivo: correlación exacta
  assert.equal(
    isReviewResponseForRequest(matchingResponse, "DEEPSEEK", req, requestTs),
    true,
    "El mensaje terminal de rechazo debe correlacionar con la solicitud PR no autorizada"
  );

  // Negativo: diferente SHA
  const mismatchShaResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replace(req.requestedHead, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchShaResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con SHA distinto"
  );

  // Negativo: diferente Repo en el mensaje
  const mismatchRepoResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replaceAll(req.repository, "other-org/other-repo"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchRepoResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con repositorio distinto"
  );

  // Negativo: diferente PR number
  const mismatchPrResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replace(`PR #${req.prNumber}:`, "PR #100:"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchPrResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con PR number distinto"
  );

  // Negativo: diferente requestTs
  assert.equal(
    isReviewResponseForRequest(matchingResponse, "DEEPSEEK", req, "1791254999.999999"),
    false,
    "No debe aceptar rechazo con SLACK_REQUEST_TS distinto"
  );
});

test("9. Terminal de rechazo para repo fuera de allowlist (target REF): correlaciona exactamente y valida correspondencia", () => {
  const req = {
    repository: "unauthorized-org/unauthorized-repo",
    target: "ref" as const,
    ref: "experimental-branch",
    requestedHead: "1111222233334444555566667777888899990000",
    instructions: "",
  };

  const requestTs = "1791254200.654321";

  const targetScope = `TARGET: ${req.ref}\nHEAD \`${req.requestedHead}\``;
  const rejectionText = [
    "DEEPSEEK — REVISIÓN NO INICIADA",
    `SLACK_REQUEST_TS: ${requestTs}`,
    "",
    `Repo: ${req.repository}`,
    `${targetScope}: repositorio no autorizado: \`${req.repository}\`.`,
    "",
    "_Solo se admiten repositorios autorizados en la allowlist cerrada._",
  ].join("\n");

  const matchingResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText,
  };

  // Positivo: correlación exacta
  assert.equal(
    isReviewResponseForRequest(matchingResponse, "DEEPSEEK", req, requestTs),
    true,
    "El mensaje terminal de rechazo debe correlacionar con la solicitud TARGET ref no autorizada"
  );

  // Negativo: diferente SHA
  const mismatchShaResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replace(req.requestedHead, "ffffffffffffffffffffffffffffffffffffffff"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchShaResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con SHA distinto"
  );

  // Negativo: diferente TARGET ref
  const mismatchRefResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replace(`TARGET: ${req.ref}`, "TARGET: other-branch"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchRefResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con ref distinto"
  );

  // Negativo: diferente Repo
  const mismatchRepoResponse = {
    botId: "BDEEPSEEK",
    text: rejectionText.replaceAll(req.repository, "other-org/other-repo"),
  };
  assert.equal(
    isReviewResponseForRequest(mismatchRepoResponse, "DEEPSEEK", req, requestTs),
    false,
    "No debe aceptar rechazo con repositorio distinto"
  );

  // Negativo: diferente requestTs
  assert.equal(
    isReviewResponseForRequest(matchingResponse, "DEEPSEEK", req, "1791254999.000000"),
    false,
    "No debe aceptar rechazo con SLACK_REQUEST_TS distinto"
  );
});

test("10. Sondeo con mocks (findPendingHandoffWithThreadState): el rechazo correlacionado cierra la raíz y evita reprocesamiento continuo", async () => {
  const unauthorizedRepo = "attacker/malicious-repo";
  const requestedHead = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
  const rootTs = "1791254300.000100";

  const requestText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: PR",
    `Repo: ${unauthorizedRepo}`,
    "PR #77",
    `HEAD: ${requestedHead}`,
  ].join("\n");

  const rootMessage = {
    ts: rootTs,
    text: requestText,
    user: "UFORNEXAGPT",
    botId: "BFORNEXAGPT",
  };

  const allowedOptions = { allowedBotIds: ["BFORNEXAGPT"] };

  // 10a: Hilo antes de emitir respuesta terminal -> debe ser detectado como pendiente
  const pendingBefore = await findPendingHandoffWithThreadState(
    [rootMessage],
    "DEEPSEEK",
    allowedOptions,
    async () => [rootMessage]
  );
  assert.ok(pendingBefore, "La solicitud debe ser detectada como pendiente antes de la respuesta");
  assert.equal(pendingBefore.raw.ts, rootTs);
  assert.equal(pendingBefore.repository, unauthorizedRepo);

  // 10b: Comportamiento antiguo defectuoso (sin SHA / PR) -> sigue pendiente y causaría bucle de rechazo
  const uncorrelatedRejection = {
    ts: "1791254305.000100",
    threadTs: rootTs,
    botId: "BDEEPSEEK",
    text: [
      "DEEPSEEK — REVISIÓN NO INICIADA",
      `SLACK_REQUEST_TS: ${rootTs}`,
      "",
      `Repositorio no autorizado: \`${unauthorizedRepo}\`.`,
      "",
      "_Solo se admiten repositorios autorizados en la allowlist cerrada._",
    ].join("\n"),
  };
  const pendingWithUncorrelated = await findPendingHandoffWithThreadState(
    [rootMessage],
    "DEEPSEEK",
    allowedOptions,
    async () => [rootMessage, uncorrelatedRejection]
  );
  assert.ok(
    pendingWithUncorrelated,
    "El rechazo no correlacionado fallaba en cerrar la raíz (defecto confirmado que causaba repetición)"
  );

  // 10c: Nuevo rechazo correlacionado -> cierra la raíz de forma definitiva (retorna null)
  const targetScope = `PR #77: HEAD solicitado \`${requestedHead}\``;
  const correlatedRejection = {
    ts: "1791254305.000100",
    threadTs: rootTs,
    botId: "BDEEPSEEK",
    text: [
      "DEEPSEEK — REVISIÓN NO INICIADA",
      `SLACK_REQUEST_TS: ${rootTs}`,
      "",
      `Repo: ${unauthorizedRepo}`,
      `${targetScope}: repositorio no autorizado: \`${unauthorizedRepo}\`.`,
      "",
      "_Solo se admiten repositorios autorizados en la allowlist cerrada._",
    ].join("\n"),
  };
  const pendingAfterCorrelated = await findPendingHandoffWithThreadState(
    [rootMessage],
    "DEEPSEEK",
    allowedOptions,
    async () => [rootMessage, correlatedRejection]
  );
  assert.equal(
    pendingAfterCorrelated,
    null,
    "El rechazo correlacionado debe cerrar el hilo y evitar reprocesamiento continuo en sondeos futuros"
  );

  // 10d: Una solicitud válida posterior no queda bloqueada por la solicitud rechazada y cerrada
  const validRootTs = "1791254310.000200";
  const validRequestText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: PR",
    "Repo: fragonh2-boop/fornexa-ai-reviewer",
    "PR #36",
    "HEAD: be52fb50b7f9219ae2fdb8ef8d6bb90436561b21",
  ].join("\n");
  const validRootMessage = {
    ts: validRootTs,
    text: validRequestText,
    user: "UFORNEXAGPT",
    botId: "BFORNEXAGPT",
  };

  const nextPending = await findPendingHandoffWithThreadState(
    [rootMessage, validRootMessage],
    "DEEPSEEK",
    allowedOptions,
    async (threadTs) => {
      if (threadTs === rootTs) {
        return [rootMessage, correlatedRejection];
      }
      return [validRootMessage];
    }
  );
  assert.ok(nextPending, "La siguiente solicitud autorizada debe procesarse sin ser bloqueada");
  assert.equal(nextPending.raw.ts, validRootTs);
  assert.equal(nextPending.repository, "fragonh2-boop/fornexa-ai-reviewer");
});
