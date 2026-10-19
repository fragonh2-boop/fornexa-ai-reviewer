export interface SlackPublisherIdentityClient {
  auth: {
    test(): Promise<{ user_id?: string; bot_id?: string }>;
  };
}

/**
 * Fails closed when the publisher token is not the configured bot identity.
 * Call before starting any service that requires a dedicated identity.
 */
export async function verifySlackPublisherIdentity(params: {
  client: SlackPublisherIdentityClient;
  expectedUserId: string;
  expectedBotId: string;
}): Promise<void> {
  const identity = await params.client.auth.test();
  if (identity.user_id !== params.expectedUserId || identity.bot_id !== params.expectedBotId) {
    throw new Error(
      "Publicación deshabilitada: el token publicador no coincide con SLACK_BOT_USER_ID y SLACK_BOT_ID."
    );
  }
}

/** Verify dedicated Grok credentials even when MESH/1 is disabled. */
export async function verifySlackStartupIdentity(params: {
  client: SlackPublisherIdentityClient;
  provider: string;
  meshEnabled: boolean;
  expectedUserId: string | null;
  expectedBotId: string | null;
}): Promise<void> {
  if (params.provider !== "grok" && !params.meshEnabled) return;
  if (!/^U[A-Z0-9]+$/.test(params.expectedUserId ?? "") ||
      !/^B[A-Z0-9]+$/.test(params.expectedBotId ?? "")) {
    throw new Error("La identidad propia exige SLACK_BOT_USER_ID y SLACK_BOT_ID válidos.");
  }
  await verifySlackPublisherIdentity({
    client: params.client,
    expectedUserId: params.expectedUserId!,
    expectedBotId: params.expectedBotId!,
  });
}
