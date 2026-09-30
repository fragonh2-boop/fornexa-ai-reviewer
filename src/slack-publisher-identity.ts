export interface SlackPublisherIdentityClient {
  auth: {
    test(): Promise<{ user_id?: string; bot_id?: string }>;
  };
}

/**
 * Fails closed before MESH/1 is enabled when the token that will publish ACKs
 * is not the explicitly configured bot identity. This prevents a shared or
 * human token from being used as a bot presence responder.
 */
export async function verifySlackPublisherIdentity(params: {
  client: SlackPublisherIdentityClient;
  expectedUserId: string;
  expectedBotId: string;
}): Promise<void> {
  const identity = await params.client.auth.test();
  if (identity.user_id !== params.expectedUserId || identity.bot_id !== params.expectedBotId) {
    throw new Error(
      "MESH/1 deshabilitado: el token publicador no coincide con SLACK_BOT_USER_ID y SLACK_BOT_ID."
    );
  }
}
