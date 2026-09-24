import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type DeploymentMode = "render" | "vercel";
export type ApprovalMode = DeploymentMode | "sidecar";

export const APPROVAL_ACTION_IDS: Record<ApprovalMode, string> = {
  render: "approve_render_deploy",
  vercel: "approve_vercel_deploy",
  sidecar: "approve_local_sidecar_task",
};

export interface DeploymentApproval {
  mode: DeploymentMode;
  head: string;
  threadTs: string;
  expiresAt: number;
}

export interface SidecarApproval {
  mode: "sidecar";
  threadTs: string;
  requestTs: string;
  taskHash: string;
  expiresAt: number;
}

export type SignedApproval = DeploymentApproval | SidecarApproval;

export interface SlackDeploymentInteraction {
  userId: string;
  channelId: string;
  actionId: string;
  token: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SLACK_TS = /^\d{1,20}\.\d{1,20}$/;

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createDeploymentApprovalToken(
  approval: SignedApproval,
  secret: string
): string {
  if (!secret || !SLACK_TS.test(approval.threadTs) ||
      (approval.mode === "sidecar"
        ? !SLACK_TS.test(approval.requestTs) || !SHA256.test(approval.taskHash)
        : !FULL_SHA.test(approval.head))) {
    throw new Error("Invalid deployment approval parameters");
  }
  const values = approval.mode === "sidecar"
    ? { v: 1, m: approval.mode, t: approval.threadTs, r: approval.requestTs, x: approval.taskHash, e: approval.expiresAt }
    : { v: 1, m: approval.mode, h: approval.head, t: approval.threadTs, e: approval.expiresAt };
  const payload = Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function parseDeploymentApprovalToken(
  token: string,
  secret: string,
  nowMs = Date.now()
): SignedApproval | null {
  const [payload, received, extra] = token.split(".");
  if (!payload || !received || extra || !secret) return null;
  const expected = signature(payload, secret);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length ||
      !timingSafeEqual(expectedBuffer, receivedBuffer)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      v?: number; m?: string; h?: string; t?: string; r?: string; x?: string; e?: number;
    };
    if (parsed.v !== 1 || typeof parsed.t !== "string" || !SLACK_TS.test(parsed.t) ||
        typeof parsed.e !== "number" || !Number.isSafeInteger(parsed.e) || parsed.e < nowMs) {
      return null;
    }
    if (parsed.m === "sidecar") {
      if (typeof parsed.r !== "string" || !SLACK_TS.test(parsed.r) ||
          typeof parsed.x !== "string" || !SHA256.test(parsed.x)) return null;
      return { mode: "sidecar", threadTs: parsed.t, requestTs: parsed.r,
        taskHash: parsed.x, expiresAt: parsed.e };
    }
    if ((parsed.m !== "render" && parsed.m !== "vercel") ||
        typeof parsed.h !== "string" || !FULL_SHA.test(parsed.h)) return null;
    return { mode: parsed.m, head: parsed.h, threadTs: parsed.t, expiresAt: parsed.e };
  } catch {
    return null;
  }
}

export function parseSignedApprovalToken(
  token: string,
  secret: string,
  nowMs = Date.now()
): SignedApproval | null {
  return parseDeploymentApprovalToken(token, secret, nowMs);
}

export function hashSidecarTask(task: string): string {
  return createHash("sha256").update(task, "utf8").digest("hex");
}

export function parseSlackDeploymentInteraction(rawBody: string): SlackDeploymentInteraction | null {
  try {
    const encoded = new URLSearchParams(rawBody).get("payload");
    if (!encoded) return null;
    const payload = JSON.parse(encoded) as {
      type?: string;
      user?: { id?: string };
      channel?: { id?: string };
      actions?: Array<{ action_id?: string; value?: string }>;
    };
    const action = payload.actions?.length === 1 ? payload.actions[0] : undefined;
    if (payload.type !== "block_actions" || !/^U[A-Z0-9]+$/.test(payload.user?.id ?? "") ||
        !/^C[A-Z0-9]+$/.test(payload.channel?.id ?? "") || !action?.action_id || !action.value) {
      return null;
    }
    return {
      userId: payload.user!.id!,
      channelId: payload.channel!.id!,
      actionId: action.action_id,
      token: action.value,
    };
  } catch {
    return null;
  }
}

export function deploymentApprovalBlocks(params: {
  mode: DeploymentMode;
  token: string;
  target: string;
  head: string;
}): object[] {
  const label = params.mode === "render" ? "Aprobar despliegue en Render" : "Aprobar despliegue en Vercel";
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Target:* \`${params.target}\`\n*HEAD exacto:* \`${params.head}\`` },
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        action_id: APPROVAL_ACTION_IDS[params.mode],
        text: { type: "plain_text", text: label },
        style: "primary",
        value: params.token,
        confirm: {
          title: { type: "plain_text", text: "Confirmar despliegue" },
          text: { type: "mrkdwn", text: `Se desplegará únicamente el commit \`${params.head}\` tras volver a validar HEAD y CI.` },
          confirm: { type: "plain_text", text: "Aprobar" },
          deny: { type: "plain_text", text: "Cancelar" },
        },
      }],
    },
  ];
}

export function sidecarApprovalBlocks(params: { token: string; task: string }): object[] {
  const summary = params.task.length > 180 ? `${params.task.slice(0, 177)}…` : params.task;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Operación local solicitada:*\n\`${summary.replace(/`/g, "'")}\`` },
    },
    {
      type: "actions",
      elements: [{
        type: "button",
        action_id: APPROVAL_ACTION_IDS.sidecar,
        text: { type: "plain_text", text: "Aprobar operación local" },
        style: "primary",
        value: params.token,
        confirm: {
          title: { type: "plain_text", text: "Confirmar operación local" },
          text: { type: "mrkdwn", text: "Antigravity ejecutará únicamente esta operación dentro de la lista local permitida." },
          confirm: { type: "plain_text", text: "Aprobar" },
          deny: { type: "plain_text", text: "Cancelar" },
        },
      }],
    },
  ];
}
