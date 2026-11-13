import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { ApiError, deny, env, pool, transaction } from "./db.js";
import { friendLinkOrigin, secureOrigins } from "./public-urls.js";
import { rate } from "./device.js";
export const callId = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id;
const targetSchema = z.object({ target: z.uuid() });
const friendship =
  "((sender=$1 AND recipient=$2) OR (sender=$2 AND recipient=$1))";
const blocked = "((actor=$1 AND target=$2) OR (actor=$2 AND target=$1))";
export async function pruneCalls(c: pg.PoolClient) {
  await c.query(
    "DELETE FROM call_members WHERE touched<now()-interval '75 seconds'",
  );
  await c.query(
    "DELETE FROM calls c WHERE (SELECT count(*) FROM call_members m WHERE m.call_id=c.id)<2 OR NOT EXISTS(SELECT 1 FROM call_members m WHERE m.call_id=c.id AND joined)",
  );
}
export const socialWrite = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(817002)");
    const result = await fn(c);
    await pruneCalls(c);
    return result;
  });
const conflict = (message: string) => new ApiError(409, message);
async function invite(c: pg.PoolClient, from: string, to: string, id: string) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM friendships WHERE accepted AND " + friendship,
        [from, to],
      )
    ).rowCount
  )
    throw deny();
  if (
    !(await c.query("SELECT FROM profiles WHERE id=$1 AND NOT dnd", [to]))
      .rowCount
  )
    throw conflict("Друг включил «Не беспокоить»");
  if (
    (
      await c.query("SELECT FROM call_members WHERE profile=$1 AND joined", [
        to,
      ])
    ).rowCount
  )
    throw conflict("Друг уже в разговоре");
  const veto = await c.query(
    "SELECT FROM blocks b JOIN call_members m ON (b.actor=m.profile AND b.target=$2 OR b.target=m.profile AND b.actor=$2) WHERE m.call_id=$1",
    [id, to],
  );
  if (veto.rowCount) throw deny();
  await c.query(
    "INSERT INTO call_members(call_id,profile,inviter) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
    [id, to, from],
  );
}
export function friendRoutes(app: FastifyInstance) {
  const canonical = env("APP_ORIGIN");
  const inviteOrigin = friendLinkOrigin(
    canonical,
    process.env.FRIEND_LINK_ORIGIN,
  );
  if (
    inviteOrigin &&
    !secureOrigins(canonical, process.env.APP_EXTRA_ORIGINS).has(inviteOrigin)
  )
    throw Error(
      "Адрес для друга должен быть разрешён в APP_ORIGIN или APP_EXTRA_ORIGINS",
    );
  app.get("/api/state", async (req) => {
    const me = req.person.id;
    return transaction(async (c) => {
      await c.query("UPDATE profiles SET last_seen=now() WHERE id=$1", [me]);
      await c.query(
        "UPDATE call_members SET touched=now() WHERE profile=$1 AND joined",
        [me],
      );
      const people = (
        await c.query(
          `SELECT p.id,p.nick,p.dnd,(p.last_seen>now()-interval '18 seconds') online,
       CASE WHEN f.accepted THEN 'friend' WHEN f.sender=$1 THEN 'out' ELSE 'in' END relation
       FROM friendships f JOIN profiles p ON p.id=CASE WHEN f.sender=$1 THEN f.recipient ELSE f.sender END
       WHERE f.sender=$1 OR f.recipient=$1 ORDER BY p.nick,p.id`,
          [me],
        )
      ).rows;
      const bans = (
        await c.query(
          "SELECT p.id,p.nick,'blocked' relation FROM blocks b JOIN profiles p ON p.id=b.target WHERE b.actor=$1 ORDER BY p.nick",
          [me],
        )
      ).rows;
      const rooms = (
        await c.query(
          `SELECT m.call_id id,m.joined,m.inviter, json_agg(json_build_object('id',p.id,'nick',p.nick,'joined',a.joined) ORDER BY p.nick) members
       FROM call_members m JOIN call_members a ON m.call_id=a.call_id JOIN profiles p ON p.id=a.profile
       WHERE m.profile=$1 GROUP BY m.call_id,m.joined,m.inviter ORDER BY m.call_id`,
          [me],
        )
      ).rows;
      return {
        me: req.person,
        people: [...people, ...bans],
        calls: rooms,
        inviteOrigin,
      };
    });
  });
  app.post("/api/status", async (req) => {
    const { dnd } = z.object({ dnd: z.boolean() }).parse(req.body);
    await socialWrite(async (c) => {
      await c.query("UPDATE profiles SET dnd=$1 WHERE id=$2", [
        dnd,
        req.person.id,
      ]);
      if (dnd)
        await c.query(
          "DELETE FROM call_members WHERE profile=$1 AND NOT joined",
          [req.person.id],
        );
    });
    return { ok: true };
  });
  app.post("/api/friends/request", rate(30), async (req) => {
    const { code } = z
      .object({
        code: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-F0-9]{12}$/),
      })
      .parse(req.body);
    await socialWrite(async (c) => {
      const other = (
          await c.query("SELECT id FROM profiles WHERE code=$1", [code])
        ).rows[0]?.id,
        me = req.person.id;
      if (
        !other ||
        me === other ||
        (await c.query("SELECT FROM blocks WHERE " + blocked, [me, other]))
          .rowCount
      )
        throw new ApiError(404, "Профиль недоступен");
      if (
        !(
          await c.query(
            "INSERT INTO friendships(sender,recipient) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING sender",
            [me, other],
          )
        ).rowCount
      )
        throw conflict("Заявка или дружба уже существует");
    });
    return { ok: true };
  });
  app.post("/api/friends/:id", async (req) => {
    const me = req.person.id,
      id = callId(req.params),
      { action } = z
        .object({ action: z.enum(["accept", "remove", "block", "unblock"]) })
        .parse(req.body);
    if (id === me) throw deny();
    await socialWrite(async (c) => {
      if (action === "accept") {
        if (
          !(
            await c.query(
              "UPDATE friendships SET accepted=true WHERE sender=$2 AND recipient=$1 AND NOT accepted",
              [me, id],
            )
          ).rowCount
        )
          throw deny();
        return;
      }
      if (action === "unblock") {
        await c.query("DELETE FROM blocks WHERE actor=$1 AND target=$2", [
          me,
          id,
        ]);
        return;
      }
      if (
        !(
          await c.query("DELETE FROM friendships WHERE " + friendship, [me, id])
        ).rowCount
      )
        throw deny();
      if (action === "block") {
        await c.query(
          "INSERT INTO blocks VALUES($1,$2) ON CONFLICT DO NOTHING",
          [me, id],
        );
        // The blocker leaves all shared rooms, even when another friend issued the invitation.
        await c.query(
          "DELETE FROM call_members a USING call_members b WHERE a.profile=$1 AND b.profile=$2 AND a.call_id=b.call_id",
          [me, id],
        );
      }
      await c.query(
        "DELETE FROM call_members WHERE NOT joined AND ((profile=$1 AND inviter=$2) OR (profile=$2 AND inviter=$1))",
        [me, id],
      );
    });
    return { ok: true };
  });
  app.post("/api/calls", rate(30), async (req) => {
    const { target } = targetSchema.parse(req.body);
    return socialWrite(async (c) => {
      const me = req.person.id;
      if (
        (
          await c.query(
            "SELECT FROM call_members WHERE profile=$1 AND joined",
            [me],
          )
        ).rowCount
      )
        throw conflict("Сначала завершите разговор");
      const id = (
        await c.query("INSERT INTO calls DEFAULT VALUES RETURNING id")
      ).rows[0].id;
      await c.query(
        "INSERT INTO call_members(call_id,profile,joined) VALUES($1,$2,true)",
        [id, me],
      );
      await invite(c, me, target, id);
      return { id };
    });
  });
  app.post("/api/calls/:id/invite", rate(40), async (req) => {
    const id = callId(req.params),
      { target } = targetSchema.parse(req.body);
    await socialWrite(async (c) => {
      if (
        !(
          await c.query(
            "SELECT FROM call_members WHERE call_id=$1 AND profile=$2 AND joined",
            [id, req.person.id],
          )
        ).rowCount
      )
        throw deny();
      await invite(c, req.person.id, target, id);
    });
    return { ok: true };
  });
  app.post("/api/calls/:id/respond", async (req) => {
    const id = callId(req.params),
      me = req.person.id,
      { accept } = z.object({ accept: z.boolean() }).parse(req.body);
    await socialWrite(async (c) => {
      if (!accept) {
        await c.query(
          "DELETE FROM call_members WHERE call_id=$1 AND profile=$2",
          [id, me],
        );
        await c.query(
          "DELETE FROM call_members WHERE call_id=$1 AND inviter=$2 AND NOT joined",
          [id, me],
        );
        return;
      }
      const invitation = (
        await c.query(
          "SELECT inviter FROM call_members WHERE call_id=$1 AND profile=$2 AND NOT joined AND touched>now()-interval '75 seconds'",
          [id, me],
        )
      ).rows[0];
      if (
        !invitation ||
        !(
          await c.query(
            "SELECT FROM friendships WHERE accepted AND " + friendship,
            [me, invitation.inviter],
          )
        ).rowCount
      )
        throw deny();
      if (
        (
          await c.query(
            "SELECT FROM call_members WHERE profile=$1 AND joined",
            [me],
          )
        ).rowCount
      )
        throw conflict("Вы уже в разговоре");
      await c.query(
        "UPDATE call_members SET joined=true,touched=now() WHERE call_id=$1 AND profile=$2",
        [id, me],
      );
      await c.query(
        "DELETE FROM call_members WHERE profile=$1 AND NOT joined",
        [me],
      );
    });
    return { ok: true };
  });
  const days = z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .parse(process.env.PROFILE_RETENTION_DAYS ?? 180);
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await socialWrite(async (c) => {
        await c.query(
          "DELETE FROM profiles WHERE last_seen<now()-$1*interval '1 day'",
          [days],
        );
        await c.query("DELETE FROM challenges WHERE expires_at<=now()");
        await c.query("DELETE FROM device_sessions WHERE expires_at<=now()");
      });
    } catch {
      app.log.warn("Очистка временных данных будет повторена");
    } finally {
      sweeping = false;
    }
  };
  const timer = setInterval(sweep, 10000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
