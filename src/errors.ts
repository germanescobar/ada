export interface SerializableError {
  message: string;
  name?: string;
  status?: number;
  requestId?: string;
  code?: string | null;
  type?: string;
  param?: string | null;
  body?: unknown;
}

export function serializeError(err: unknown): SerializableError {
  const message = err instanceof Error ? err.message : String(err);
  const result: SerializableError = { message };

  if (err instanceof Error && err.name) {
    result.name = err.name;
  }

  if (!isRecord(err)) {
    return result;
  }

  const status = err.status;
  if (typeof status === "number") {
    result.status = status;
  }

  const requestId = err.request_id ?? err.requestId;
  if (typeof requestId === "string") {
    result.requestId = requestId;
  }

  const code = err.code;
  if (typeof code === "string" || code === null) {
    result.code = code;
  }

  const type = err.type;
  if (typeof type === "string") {
    result.type = type;
  }

  const param = err.param;
  if (typeof param === "string" || param === null) {
    result.param = param;
  }

  if ("error" in err && err.error !== undefined) {
    result.body = err.error;
  } else {
    const bodyFromMessage = extractStatusBodyFromMessage(message, result.status);
    if (bodyFromMessage) {
      result.body = bodyFromMessage;
    }
  }

  return result;
}

function extractStatusBodyFromMessage(
  message: string,
  status: number | undefined
): string | undefined {
  if (status === undefined) return undefined;

  const prefix = `${status} `;
  if (!message.startsWith(prefix)) return undefined;

  const body = message.slice(prefix.length).trim();
  if (!body || body === "status code (no body)") return undefined;

  return stripBalancedQuotes(body);
}

function stripBalancedQuotes(value: string): string {
  if (value.length < 2) return value;

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
