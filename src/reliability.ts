type CompletionEnvelope<T> = {
  choices?: readonly T[];
  error?: { message?: unknown };
};

export function extractFirstChoice<T>(completion: CompletionEnvelope<T>): T {
  const choice = completion.choices?.[0];
  if (choice) return choice;

  const upstreamMessage = completion.error?.message;
  const detail =
    typeof upstreamMessage === "string" && upstreamMessage.trim()
      ? `: ${upstreamMessage.trim()}`
      : "";
  throw new Error(`DeepSeek no devolvió ninguna opción${detail}`);
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} superó el timeout de ${timeoutMs} ms.`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isLockStale(startedAt: number, now: number, staleMs: number): boolean {
  return now - startedAt >= staleMs;
}

export function acquireLock(
  locks: Map<string, number>,
  key: string,
  staleMs: number,
  now = Date.now()
): { acquired: true; startedAt: number; recoveredStaleLock: boolean } | { acquired: false } {
  const existing = locks.get(key);
  if (existing !== undefined && !isLockStale(existing, now, staleMs)) {
    return { acquired: false };
  }

  locks.set(key, now);
  return {
    acquired: true,
    startedAt: now,
    recoveredStaleLock: existing !== undefined,
  };
}

export function releaseLock(
  locks: Map<string, number>,
  key: string,
  startedAt: number
): void {
  // Una operación antigua no debe borrar el candado de un reintento posterior.
  if (locks.get(key) === startedAt) locks.delete(key);
}

export function ownsLock(
  locks: Map<string, number>,
  key: string,
  startedAt: number
): boolean {
  return locks.get(key) === startedAt;
}
