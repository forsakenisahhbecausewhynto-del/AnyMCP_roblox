import { timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 100_000;
export const MAX_STRING_LENGTH = 1_000;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function jsonHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
}

export function safeTokenEqual(supplied, expected) {
  if (typeof supplied !== "string" || typeof expected !== "string") {
    return false;
  }

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(suppliedBuffer, expectedBuffer);
}

export function clientKey(req) {
  return req.socket.remoteAddress || "unknown";
}

export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  allow(key) {
    const now = Date.now();
    const entry = this.entries.get(key) || { start: now, count: 0 };

    if (now - entry.start >= this.windowMs) {
      entry.start = now;
      entry.count = 0;
    }

    entry.count += 1;
    this.entries.set(key, entry);
    this.prune(now);
    return entry.count <= this.limit;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.start >= this.windowMs) this.entries.delete(key);
    }
  }
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_content_type", "Content-Type must be application/json.");
  }

  let raw = "";
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) {
      throw new HttpError(413, "request_too_large", "Request body is too large.");
    }
    raw += chunk;
  }

  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Object required");
    }
    return value;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function boundedString(value, field, max = MAX_STRING_LENGTH) {
  if (typeof value !== "string" || value.length > max) {
    throw new HttpError(400, "invalid_field", `${field} is invalid.`);
  }
  return value;
}

export function validateHeartbeat(data) {
  return {
    placeName: boundedString(data.placeName || "", "placeName", 200),
    gameId: boundedString(data.gameId || "", "gameId", 100)
  };
}

export function validateResult(data) {
  const id = boundedString(data.id || "", "id", 100);
  if (data.error !== undefined) boundedString(data.error, "error", 1_000);
  return { id };
}

export function publicError(error) {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: { error: "Internal server error", code: "internal_error" }
  };
}
