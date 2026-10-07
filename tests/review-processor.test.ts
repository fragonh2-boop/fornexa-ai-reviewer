import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ModelAdapter } from "../src/providers.js";
import type { ReviewRequest } from "../src/review-request.js";
import type { PRContext, RefContext } from "../src/tools/github.js";
import { createReviewProcessor, type ReviewProcessorDependencies } from "../src/review-processor.js";
import { ReadEvidenceError } from "../src/read-evidence.js";
import type { ReadEvidenceErrorCode } from "../src/read-evidence.js";
import { MAX_READ_BYTES_PER_FILE } from "../src/read-evidence.js";
import { isReviewResponseForRequest } from "../src/review-request.js";

// Fictional values allow import of production adapters; no real I/O is performed.
process.env.DEEPSEEK_API_KEY = "test-processor-provider";
process.env.SLACK_BOT_TOKEN = "xoxb-test-processor";
process.env.GITHUB_TOKEN = "test-processor-github";

const { reviewRepository, reviewPR } = await import("../src/agent.js");
const {
  getEffectiveSlackClient,
  postToThreadSmart,
  postToChannelSmart,
  findPendingHandoffWithThreadState,
} = await import("../src/tools/slack.js");

const repo = "fragonh2-boop/fornexa-ai-reviewer";
const head = "a".repeat(40);
const requestTs = "1791289000.100000";
const source = "export const authenticated = true;\n";
const canary = "SYNTHETIC_PROCESSOR_CANARY";
const refCtx: RefContext = {
  repo, ref: "main", headSha: head, headMessage: "test context",
  recentCommits: [], checks: [],
};
const prCtx: PRContext = {
  repo, number: 37, title: "test context", headSha: head, baseSha: "b".repeat(40),
  diffText: "diff --git a/src/auth.ts b/src/auth.ts\n+export const authenticated = true;",
  changedFiles: ["src/auth.ts"], checks: [],
};
function request(instructions = "Emite la fuente íntegra de `src/auth.ts`", target: "ref" | "pr" = "ref"): ReviewRequest {
  return target === "pr"
    ? { target, prNumber: 37, repository: repo, requestedHead: head, instructions }
    : { target, ref: "main", repository: repo, requestedHead: head, instructions };
}
function rootFor(req: ReviewRequest) {
  return {
    ts: requestTs, user: "UTESTHUMAN",
    text: `CLAUDE — ACCIÓN REQUERIDA\nRepo: ${req.repository}\n` +
      (req.target === "pr" ? `MODE: PR\nPR #${req.prNumber}` : `MODE: MAIN\nTARGET: ${req.ref}`) +
      `\nHEAD: ${req.requestedHead}\n\n${req.instructions}`,
  };
}
function returning(content: string): ModelAdapter {
  return { async complete() { return { role: "assistant", content, refusal: null }; } };
}
function reading(content: string, args = { path: "src/auth.ts", ref: "main" }): ModelAdapter {
  let calls = 0;
  return {
    async complete() {
      return ++calls === 1
        ? { role: "assistant", content: null, refusal: null, tool_calls: [{
          id: "test_read", type: "function", function: { name: "get_full_file", arguments: JSON.stringify(args) },
        }] }
        : { role: "assistant", content, refusal: null };
    },
  };
}
function harness(t: TestContext, adapter: ModelAdapter, options: {
  readError?: Error;
  fileContent?: string;
  cannotReply?: boolean;
  overrides?: Partial<ReviewProcessorDependencies>;
} = {}) {
  const sent: Array<{ ts: string; text: string; threadTs?: string; botId: string }> = [];
  const locks = new Map<string, number>();
  const counts = { model: 0, github: 0, context: 0 };
  const logger = { log() {}, warn() {}, error() {} };
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string; thread_ts?: string }) => {
    if (options.cannotReply && message.thread_ts) throw Object.assign(new Error(canary), { data: { error: "cannot_reply_to_message" } });
    const ts = `1791289010.${String(sent.length + 1).padStart(6, "0")}`;
    sent.push({ ts, text: message.text, threadTs: message.thread_ts, botId: "BTESTREVIEWER" });
    return { ok: true, ts };
  });
  const activeAdapter: ModelAdapter = {
    async complete(messages, tools) { counts.model++; return adapter.complete(messages, tools); },
  };
  const getFile = async (path: string, sha: string, targetRepo?: string) => {
    counts.github++;
    assert.equal(path, "src/auth.ts");
    assert.equal(sha, head);
    assert.equal(targetRepo, repo);
    if (options.readError) throw options.readError;
    return options.fileContent ?? source;
  };
  const processor = createReviewProcessor({
    agentLabel: "CLAUDE", staleLockMs: 1_000, locks, logger,
    async getPRContext() { counts.context++; return prCtx; },
    async getRefContext() { counts.context++; return refCtx; },
    reviewPR: (ctx, instructions) => reviewPR(ctx, "SEGUNDA_REVISION", undefined, instructions, { adapter: activeAdapter, getFile }),
    reviewRepository: (ctx, instructions) => reviewRepository(ctx, instructions, { adapter: activeAdapter, getFile }),
    postToChannel: postToChannelSmart,
    postToThread: postToThreadSmart,
    ...options.overrides,
  });
  return { processor, sent, locks, counts };
}
function terminals(sent: ReturnType<typeof harness>["sent"], req: ReviewRequest) {
  return sent.filter((message) => isReviewResponseForRequest(message, "CLAUDE", req, requestTs));
}
async function assertClosedAfterTwoPolls(h: ReturnType<typeof harness>, req: ReviewRequest) {
  const root = rootFor(req);
  for (let poll = 0; poll < 2; poll++) {
    assert.equal(await findPendingHandoffWithThreadState(
      [root, ...h.sent.filter((message) => !message.threadTs)], "CLAUDE", {},
      async (threadTs) => {
        assert.equal(threadTs, requestTs);
        return [root, ...h.sent.filter((message) => message.threadTs === threadTs)];
      }
    ), null);
  }
  assert.equal(h.locks.size, 0);
  assert.equal(terminals(h.sent, req).length, 1);
  for (const message of h.sent) assert.equal(message.text.split("\n")[1], `SLACK_REQUEST_TS: ${requestTs}`);
}

test("production processor + agent: absent read fails once, releases real lock, and is not polled again", async (t) => {
  const req = request();
  const h = harness(t, returning("He leído src/auth.ts. MERGE: YES."));
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }),
    (err: unknown) => err instanceof ReadEvidenceError && err.code === "MISSING_READ");
  assert.equal(h.counts.model, 1);
  assert.equal(h.counts.github, 0);
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[0].text, /^CLAUDE — REVISIÓN RECIBIDA/);
  assert.match(h.sent[1].text, /^CLAUDE — REVISIÓN FALLIDA/);
  await assertClosedAfterTwoPolls(h, req);
});

test("real GitHub read error becomes a safe terminal, not a verdict or copied raw payload", async (t) => {
  const req = request();
  const h = harness(t, reading("MERGE: YES"), { readError: new Error(`404 ${canary}`) });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.equal(h.counts.github, 1);
  assert.ok(h.sent.every((message) => !message.text.includes(canary)));
  assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN FALLIDA/);
  await assertClosedAfterTwoPolls(h, req);
});

test("authentic read followed by fabricated full source fails through processor + agent", async (t) => {
  const req = request();
  const h = harness(t, reading("### src/auth.ts\n```ts\nexport const authenticated = false;\n```"));
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }),
    (err: unknown) => err instanceof ReadEvidenceError && err.code === "CONTENT_DISCREPANCY");
  assert.equal(h.counts.github, 1);
  await assertClosedAfterTwoPolls(h, req);
});

test("oversized authentic read cannot escape the runtime budget at the publisher boundary", async (t) => {
  const req = request();
  const h = harness(t, reading("MERGE: YES"), { fileContent: "x".repeat(MAX_READ_BYTES_PER_FILE + 1) });
  // runCapabilities enforces its response byte budget before final validation.
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }), /File budget exceeded/);
  assert.equal(h.counts.github, 1);
  assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN FALLIDA/);
  await assertClosedAfterTwoPolls(h, req);
});

test("truncated requested full source cannot become a successful processor verdict", async (t) => {
  const req = request();
  const h = harness(t, reading("### src/auth.ts\n```ts\nexport const\n```"));
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }),
    (err: unknown) => err instanceof ReadEvidenceError && err.code === "CONTENT_DISCREPANCY");
  await assertClosedAfterTwoPolls(h, req);
});

test("raw provider exceptions never enter public terminal text", async (t) => {
  const req = request();
  const h = harness(t, { async complete() { throw new Error(`provider payload ${canary}`); } });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.ok(h.sent.every((message) => !message.text.includes(canary)));
  assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN FALLIDA/);
  await assertClosedAfterTwoPolls(h, req);
});

test("successful pinned source uses real fragment publisher and final part alone closes polling", async (t) => {
  const req = request();
  const verdict = `### src/auth.ts\n\`\`\`ts\n${source}\`\`\`\n\n` +
    Array.from({ length: 6 }, (_, i) => `Evidence ${i}: ${"conclusion ".repeat(100)}`).join("\n\n");
  const h = harness(t, reading(verdict));
  await h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
  assert.equal(h.counts.github, 1);
  assert.equal(h.counts.model, 2);
  const reviewParts = h.sent.filter((message) => message.text.startsWith("CLAUDE — REVISIÓN\n"));
  assert.ok(reviewParts.length > 1);
  for (const [index, part] of reviewParts.entries()) {
    assert.equal(part.threadTs, requestTs);
    assert.ok(part.text.includes(`Repo: ${repo}\nTARGET: main\nHEAD revisado: \`${head}\``));
    assert.ok(part.text.length <= 3800);
    assert.ok(part.text.endsWith(`_Respuesta ${index + 1}/${reviewParts.length}_`));
  }
  const root = rootFor(req);
  assert.ok(await findPendingHandoffWithThreadState([root], "CLAUDE", {}, async () => h.sent.slice(0, -1)));
  await assertClosedAfterTwoPolls(h, req);
});

test("cannot_reply_to_message uses real channel publisher fallback and durably closes the request", async (t) => {
  const req = request();
  const h = harness(t, returning("unread verdict"), { cannotReply: true });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every((message) => !message.threadTs && message.text.includes(`THREAD_TS: ${requestTs}`)));
  assert.ok(h.sent.every((message) => !message.text.includes(canary)));
  await assertClosedAfterTwoPolls(h, req);
});

test("incompatible ref or repo is stopped before GitHub and never reflected by actual publisher", async (t) => {
  for (const incompatible of [{ ref: canary }, { repo: canary }]) {
    await t.test(Object.keys(incompatible)[0], async (sub) => {
      const req = request();
      const h = harness(sub, reading("ignored", { path: "src/auth.ts", ref: "main", ...incompatible }));
      await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }),
        (err: unknown) => err instanceof ReadEvidenceError && err.code === "CROSS_REQUEST_CONTAMINATION");
      assert.equal(h.counts.github, 0);
      assert.equal(h.counts.model, 1);
      assert.ok(h.sent.every((message) => !message.text.includes(canary)));
      await assertClosedAfterTwoPolls(h, req);
    });
  }
});

test("processor public failure rejects even an arbitrary ReadEvidenceError safeMessage/path", async (t) => {
  const req = request();
  const h = harness(t, returning("ignored"), { overrides: {
    async reviewRepository() { throw new ReadEvidenceError("READ_FAILED", canary, `src/${canary}.ts`); },
  } });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.ok(h.sent.every((message) => !message.text.includes(canary)));
  assert.match(h.sent.at(-1)!.text, /READ_FAILED/);
  await assertClosedAfterTwoPolls(h, req);
});

test("publisher outage still releases lock and does not log raw Slack payload", async (t) => {
  const req = request();
  const logs: unknown[][] = [];
  const h = harness(t, returning("must not run"), { overrides: {
    logger: { log() {}, warn() {}, error(...args) { logs.push(args); } },
    async postToThread() { throw new Error(`Slack payload ${canary}`); },
  } });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.equal(h.locks.size, 0);
  assert.equal(h.counts.model, 0);
  assert.equal(h.sent.length, 0, "an unavailable publisher cannot manufacture a delivered terminal");
  assert.equal(logs.length, 1);
  assert.ok(!JSON.stringify(logs).includes(canary));
});

test("forged runtime evidence code cannot be copied into a public terminal", async (t) => {
  const req = request();
  // The public class's TS union does not reject this runtime value.
  const forged = new ReadEvidenceError(canary as ReadEvidenceErrorCode, canary);
  assert.equal(forged.code, canary);
  const h = harness(t, returning("ignored"), { overrides: {
    async reviewRepository() { throw forged; },
  } });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }));
  assert.ok(h.sent.every((message) => !message.text.includes(canary)));
  assert.match(h.sent.at(-1)!.text, /READ_EVIDENCE_ERROR/);
  await assertClosedAfterTwoPolls(h, req);
});

test("PR exact-HEAD is captured and revalidated using the same real processor as runtime", async (t) => {
  const req = request("Review the supplied diff only", "pr");
  const h = harness(t, returning("MUST: none. MERGE: YES."));
  await h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
  assert.equal(h.counts.context, 2);
  assert.equal(h.counts.github, 0);
  assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN\n/);
  await assertClosedAfterTwoPolls(h, req);
});

test("changed PR HEAD after model completion cannot publish the old verdict", async (t) => {
  const req = request("Review the supplied diff only", "pr");
  let reads = 0;
  const h = harness(t, returning("MERGE: YES"), { overrides: {
    async getPRContext() { return ++reads === 1 ? prCtx : { ...prCtx, headSha: "c".repeat(40) }; },
  } });
  await assert.rejects(h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs }), /HEAD changed/);
  assert.equal(reads, 2);
  assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN FALLIDA/);
  assert.ok(h.sent.every((message) => !message.text.includes("MERGE: YES")));
  await assertClosedAfterTwoPolls(h, req);
});

test("repository allowlist and initial stale HEAD refuse before invoking model", async (t) => {
  for (const mode of ["allowlist", "head"]) {
    await t.test(mode, async (sub) => {
      const req = mode === "allowlist" ? { ...request(), repository: "outside/repo" } : request();
      const h = harness(sub, returning("must not run"), { overrides: mode === "head" ? {
        async getRefContext() { return { ...refCtx, headSha: "c".repeat(40) }; },
      } : undefined });
      await h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
      assert.equal(h.counts.model, 0);
      assert.equal(h.counts.github, 0);
      assert.match(h.sent.at(-1)!.text, /^CLAUDE — REVISIÓN NO INICIADA/);
      await assertClosedAfterTwoPolls(h, req);
    });
  }
});

test("concurrent delivery cannot duplicate a review; stale retry owns final publication and lock", async (t) => {
  const req = request();
  let now = 1_000;
  let releaseFirst!: () => void;
  const firstWaiting = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let reviews = 0;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => { enteredFirst = resolve; });
  const h = harness(t, returning("unused"), { overrides: {
    now: () => now,
    async reviewRepository() {
      if (++reviews === 1) { enteredFirst(); await firstWaiting; return "superseded result"; }
      return "new owner result";
    },
  } });
  const first = h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
  await firstEntered;
  await h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
  assert.equal(reviews, 1);
  assert.equal(h.locks.size, 1);
  now = 2_000;
  await h.processor.processReviewRequest(req, { requestTs, threadTs: requestTs });
  assert.equal(reviews, 2);
  releaseFirst();
  await first;
  assert.ok(h.sent.every((message) => !message.text.includes("superseded result")));
  await assertClosedAfterTwoPolls(h, req);
});
