interface SlackPlatformErrorLike {
  data?: {
    error?: unknown;
  };
}

export function slackPlatformErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as SlackPlatformErrorLike).data?.error;
  return typeof code === "string" ? code : null;
}

export function isCannotReplyToMessageError(error: unknown): boolean {
  return slackPlatformErrorCode(error) === "cannot_reply_to_message";
}
