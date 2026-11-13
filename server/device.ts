import { secureOrigins } from "./public-urls.js";
import { createPublicKey, verify, randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ApiError,
  deny,
  digest,
  env,
  pool,
  secret,
  transaction,
} from "./db.js";
export type Person = {
  id: string;
  nick: string;
  code: string;
  dnd: boolean;
  role: "owner" | "member";
};
declare module "fastify" {
  interface FastifyRequest {
    person: Person;
    deviceSession: string;
  }
}
export const rate = (max: number) => ({
  config: { rateLimit: { max, timeWindow: "1 minute" } },
});
const prod = process.env.NODE_ENV === "production",
  cookie = prod ? "__Host-prival-device" : "prival-device";
const options = {
  path: "/",
  httpOnly: true,
  secure: prod,
  sameSite: "strict" as const,
};
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{59}$/);
export function challengeText(origin: string, purpose: string, nonce: string) {
  return ["PRIVAL-DEVICE-1", origin, purpose, nonce].join("\n");
}
export function deviceRoutes(app: FastifyInstance) {
  const origin = new URL(env("APP_ORIGIN")).origin;
  const origins = secureOrigins(origin, process.env.APP_EXTRA_ORIGINS);
  if (prod && !origin.startsWith("https://")) throw Error("Требуется HTTPS");
  app.addHook("onRequest", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !origins.has(req.headers.origin ?? "")
    )
      throw deny();
    if (
      ["/api/health", "/api/device/challenge", "/api/device/prove"].includes(
        req.url.split("?")[0],
      )
    )
      return;
    const sid = digest(req.cookies[cookie] ?? "");
    const person = (
      await pool.query<Person>(
        "SELECT p.id,p.nick,p.code,p.dnd,p.role FROM profiles p JOIN device_sessions s ON s.profile=p.id WHERE s.digest=$1 AND s.expires_at>now()",
        [sid],
      )
    ).rows[0];
    if (!person) throw new ApiError(401, "Нужно подтвердить профиль");
    req.person = person;
    req.deviceSession = sid;
  });
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/"))
      reply.header("Cache-Control", "no-store");
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer");
    return payload;
  });
  app.get("/api/admin/summary", async (req) => {
    if (req.person.role !== "owner") throw deny();
    return (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM profiles) profiles,(SELECT count(*)::int FROM calls) calls",
      )
    ).rows[0];
  });
  app.post("/api/device/challenge", rate(60), async (req) => {
    const { publicKey, purpose, nick } = z
      .object({
        publicKey: keySchema,
        purpose: z.enum(["register", "login", "delete"]),
        nick: z.string().trim().min(1).max(32).optional(),
      })
      .parse(req.body);
    try {
      const key = createPublicKey({
        key: Buffer.from(publicKey, "base64url"),
        format: "der",
        type: "spki",
      });
      if (key.asymmetricKeyType !== "ed25519") throw Error();
    } catch {
      throw new ApiError(400, "Некорректный ключ");
    }
    if (purpose === "register" && !nick) throw new ApiError(400, "Введите ник");
    const nonce = secret();
    await pool.query(
      "INSERT INTO challenges VALUES($1,$2,$3,$4,now()+interval '60 seconds')",
      [nonce, publicKey, purpose, nick ?? null],
    );
    return { nonce };
  });
  app.post("/api/device/prove", rate(60), async (req, reply) => {
    const { nonce, signature } = z
      .object({
        nonce: z.string().length(43),
        signature: z.string().regex(/^[\w-]{86}$/),
      })
      .parse(req.body);
    const token = secret();
    const user = await transaction(async (c) => {
      const ch = (
        await c.query(
          "DELETE FROM challenges WHERE nonce=$1 AND expires_at>now() RETURNING *",
          [nonce],
        )
      ).rows[0];
      if (
        !ch ||
        !verify(
          null,
          Buffer.from(challengeText(req.headers.origin!, ch.purpose, nonce)),
          createPublicKey({
            key: Buffer.from(ch.public_key, "base64url"),
            format: "der",
            type: "spki",
          }),
          Buffer.from(signature, "base64url"),
        )
      )
        throw deny();
      // Serialize deletion with call mutations and registration on this device.
      await c.query("SELECT pg_advisory_xact_lock(817002)");
      if (ch.purpose === "delete") {
        await c.query("DELETE FROM profiles WHERE public_key=$1", [
          ch.public_key,
        ]);
        await c.query("DELETE FROM challenges WHERE public_key=$1", [
          ch.public_key,
        ]);
        await c.query(
          "DELETE FROM calls c WHERE (SELECT count(*) FROM call_members m WHERE m.call_id=c.id)<2 OR NOT EXISTS(SELECT FROM call_members m WHERE m.call_id=c.id AND joined)",
        );
        return null;
      }
      if (ch.purpose === "register")
        await c.query(
          "INSERT INTO profiles(nick,code,public_key) VALUES ($1,$2,$3) ON CONFLICT(public_key) DO NOTHING",
          [
            ch.nick,
            randomBytes(6).toString("hex").toUpperCase(),
            ch.public_key,
          ],
        );
      const p = (
        await c.query<Person>(
          "UPDATE profiles SET last_seen=now() WHERE public_key=$1 RETURNING id,nick,code,dnd,role",
          [ch.public_key],
        )
      ).rows[0];
      if (!p) throw new ApiError(404, "Профиль на сервере отсутствует");
      await c.query(
        "INSERT INTO device_sessions VALUES($1,$2,now()+interval '7 days')",
        [digest(token), p.id],
      );
      return p;
    });
    if (!user) {
      reply.clearCookie(cookie, options);
      return { deleted: true };
    }
    reply.setCookie(cookie, token, { ...options, maxAge: 604800 });
    return user;
  });
}
