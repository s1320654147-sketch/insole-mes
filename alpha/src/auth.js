import { createHmac, timingSafeEqual } from "node:crypto";

const secret = process.env.APP_SECRET || "local-alpha-secret-change-before-production";

function base64url(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function sign(value) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createToken(user) {
  const header = base64url({ alg: "HS256", typ: "JWT" });
  const payload = base64url({ ...user, exp: Date.now() + 1000 * 60 * 60 * 12 });
  const signature = sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (parsed.exp < Date.now()) return null;
  return { id: parsed.id, name: parsed.name, role: parsed.role };
}
