export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) { super(message); }
}

export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const value = headers.get("retry-after");
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 && Number.isSafeInteger(Math.ceil(seconds * 1000)) ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
