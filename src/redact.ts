const SECRET_KEY = /token|secret|password|cookie|authorization|refresh|api[_-]?key|jwt|csrf/i;

export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return value;
  return `${value.slice(0, 1)}***${value.slice(at)}`;
}

export function maskId(value: string): string {
  if (value.length <= 10) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export function redactText(input: string): string {
  return input
    .replace(/[\w.+-]+@[\w.-]+/g, (email) => maskEmail(email))
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, "sk-<redacted>")
    .replace(/\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "<jwt>");
}

export function redactValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) {
    if (typeof value === "string") return `<redacted len=${value.length}>`;
    return "<redacted>";
  }
  if (typeof value === "string") {
    if (value.includes("@")) return maskEmail(value);
    return value.length > 240 ? `${value.slice(0, 80)}…<len=${value.length}>` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactValue(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = redactValue(child, childKey);
    }
    return out;
  }
  return value;
}

export function redactJson(value: unknown): string {
  return JSON.stringify(redactValue(value));
}
