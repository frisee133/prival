import { voiceAddress } from "./public-urls.js";
import { tunnelIceServer } from "./turn-relay.js";
import {
  AccessToken,
  RoomServiceClient,
  TokenVerifier,
  TrackSource,
} from "livekit-server-sdk";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deny, env, pool } from "./db.js";
import { callId } from "./friends.js";
import { rate } from "./device.js";
const key = env("LIVEKIT_API_KEY"),
  secret = env("LIVEKIT_API_SECRET");
const rooms = new RoomServiceClient(env("LIVEKIT_HTTP_URL"), key, secret, {
  requestTimeout: 4,
});
const prefix = "call-";
async function permitted(
  call: string,
  profile: string,
  lease: string | undefined,
) {
  if (![call, profile, lease].every((v) => z.uuid().safeParse(v).success))
    return false;
  return !!(
    await pool.query(
      "SELECT FROM call_members m JOIN device_sessions s ON s.digest=m.session_digest AND s.profile=m.profile WHERE m.call_id=$1 AND m.profile=$2 AND m.lease=$3 AND m.joined AND s.expires_at>now()",
      [call, profile, lease],
    )
  ).rowCount;
}
export function callVoiceRoutes(app: FastifyInstance) {
  const verifier = new TokenVerifier(key, secret);
  app.get("/internal/rtc-auth", async (req, reply) => {
    const uri = req.headers["x-forwarded-uri"];
    if (typeof uri !== "string") throw deny();
    const token = new URL(uri, "http://internal").searchParams.get(
      "access_token",
    );
    if (!token) throw deny();
    const claims = await verifier.verify(token, 0).catch(() => {
      throw deny();
    });
    const room = claims.video?.room;
    if (
      !claims.video?.roomJoin ||
      !room?.startsWith(prefix) ||
      !(await permitted(
        room.slice(prefix.length),
        claims.sub ?? "",
        claims.attributes?.privalLease,
      ))
    )
      throw deny();
    return reply.code(204).send();
  });
  app.post("/api/calls/:id/token", rate(40), async (req) => {
    const id = callId(req.params),
      lease = randomUUID();
    if (
      !(
        await pool.query(
          "UPDATE call_members SET lease=$3,session_digest=$4,touched=now() WHERE call_id=$1 AND profile=$2 AND joined RETURNING 1",
          [id, req.person.id, lease, req.deviceSession],
        )
      ).rowCount
    )
      throw deny();
    const jwt = new AccessToken(key, secret, {
      identity: req.person.id,
      name: req.person.nick,
      ttl: 60,
      attributes: { privalLease: lease },
    });
    jwt.addGrant({
      room: prefix + id,
      roomJoin: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canSubscribe: true,
      canPublishData: false,
    });
    return {
      url: voiceAddress(
        req.headers.origin === new URL(env("APP_ORIGIN")).origin
          ? env("LIVEKIT_PUBLIC_URL")
          : "same-origin",
        req.headers.origin!,
      ),
      token: await jwt.toJwt(),
      ...(process.env.TUNNEL_TURN_URL &&
      req.headers.origin === process.env.TUNNEL_ORIGIN
        ? {
            iceServer: tunnelIceServer(
              process.env.TUNNEL_TURN_URL,
              key,
              secret,
              lease,
            ),
          }
        : {}),
      lease,
    };
  });
  app.post("/api/voice/leave", async (req) => {
    const { lease } = z.object({ lease: z.uuid() }).parse(req.body);
    await pool.query(
      "UPDATE call_members SET lease=NULL,session_digest=NULL WHERE profile=$1 AND lease=$2 AND session_digest=$3",
      [req.person.id, lease, req.deviceSession],
    );
    return { ok: true };
  });
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      for (const room of await rooms.listRooms()) {
        if (!room.name.startsWith(prefix)) continue;
        const id = room.name.slice(prefix.length);
        if (!z.uuid().safeParse(id).success) continue;
        if (
          !(await pool.query("SELECT FROM calls WHERE id=$1", [id])).rowCount
        ) {
          await rooms.deleteRoom(room.name);
          continue;
        }
        for (const p of await rooms.listParticipants(room.name))
          if (!(await permitted(id, p.identity, p.attributes.privalLease)))
            await rooms.removeParticipant(room.name, p.identity);
      }
    } catch {
      app.log.warn("Повторная синхронизация звонков через 2 секунды");
    } finally {
      running = false;
    }
  }, 2000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
