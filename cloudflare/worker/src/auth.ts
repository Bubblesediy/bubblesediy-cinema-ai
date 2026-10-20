import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { Context } from "hono";
import type { Env, User } from "./types";

// bcryptjs is pure JS (no native bindings), so it works on the Workers runtime,
// unlike Node's native bcrypt.
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

function secretKey(env: Env): Uint8Array {
  if (!env.JWT_SECRET) {
    // Fail loudly rather than silently signing tokens with an empty key.
    throw new Error("JWT_SECRET is not configured. Set it with: wrangler secret put JWT_SECRET");
  }
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function createAccessToken(env: Env, userId: string): Promise<string> {
  const expireMinutes = Number(env.ACCESS_TOKEN_EXPIRE_MINUTES || "10080");
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${expireMinutes}m`)
    .sign(secretKey(env));
}

export async function verifyAccessToken(env: Env, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export function publicUser(user: User) {
  return { id: user.id, email: user.email, display_name: user.display_name };
}

/** Hono middleware-style helper: resolves the current user or throws a 401-shaped error. */
export async function requireUser(c: Context<{ Bindings: Env }>): Promise<User> {
  const authHeader = c.req.header("authorization") || c.req.header("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    throw jsonError(401, "Missing or malformed Authorization header.");
  }
  const token = authHeader.slice(7).trim();
  const userId = await verifyAccessToken(c.env, token);
  if (!userId) {
    throw jsonError(401, "Invalid or expired session token.");
  }
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<User>();
  if (!user) {
    throw jsonError(401, "User no longer exists.");
  }
  return user;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function jsonError(status: number, detail: string): HttpError {
  return new HttpError(status, detail);
}
