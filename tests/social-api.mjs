import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000";
function client(nick) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"),
    pub = publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url");
  let cookie = "";
  async function call(path, method = "GET", body, site = origin) {
    if (method === "POST" && body === undefined) body = {};
    const r = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: site,
        Cookie: cookie,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body && JSON.stringify(body),
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json() };
  }
  async function challenge(purpose) {
    const { data } = await call("/device/challenge", "POST", {
      purpose,
      nick,
      publicKey: pub,
    });
    const nonce = data.nonce;
    return {
      nonce,
      signature: sign(
        null,
        Buffer.from(["PRIVAL-DEVICE-1", origin, purpose, nonce].join("\n")),
        privateKey,
      ).toString("base64url"),
    };
  }
  async function proof(purpose) {
    const msg = await challenge(purpose);
    const r = await call("/device/prove", "POST", msg);
    assert.equal(r.status, 200);
    assert.equal((await call("/device/prove", "POST", msg)).status, 403);
    return r.data;
  }
  return { proof, call };
}
const all = Array.from({ length: 3 }, () =>
  client("API " + randomUUID().slice(0, 6)),
);
const [a, b, c] = all;
const ok = async (p, path, body) => {
  const r = await p.call(path, "POST", body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};
try {
  const [x, y, z] = await Promise.all(all.map((v) => v.proof("register")));
  assert.equal(x.role, "member");
  assert.notEqual(y.id, x.id);
  assert.equal((await a.call("/admin/summary")).status, 403);
  if (process.env.TEST_OWNER_CLI === "1") {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      ["dist/server/cli.js", "owner", x.code],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await a.call("/state")).data.me.role, "owner");
    assert.equal((await a.call("/admin/summary")).status, 200);
    assert.equal((await b.call("/admin/summary")).status, 403);
  }
  assert.equal(
    (await a.call("/status", "POST", { dnd: true }, "https://other.invalid"))
      .status,
    403,
  );
  assert.equal((await a.call("/calls", "POST", { target: y.id })).status, 403);
  for (const [p, u] of [
    [b, y],
    [c, z],
  ]) {
    await ok(a, "/friends/request", { code: u.code });
    await ok(p, "/friends/" + x.id, { action: "accept" });
  }
  await ok(b, "/status", { dnd: true });
  assert.equal((await a.call("/calls", "POST", { target: y.id })).status, 409);
  await ok(b, "/status", { dnd: false });
  const { id } = await ok(a, "/calls", { target: y.id });
  assert.equal((await b.call("/calls/" + id + "/token", "POST")).status, 403);
  await ok(b, "/calls/" + id + "/respond", { accept: true });
  await ok(a, "/calls/" + id + "/invite", { target: z.id });
  await ok(c, "/calls/" + id + "/respond", { accept: true });
  assert.equal((await a.call("/calls", "POST", { target: z.id })).status, 409);
  for (const p of all) {
    const token = (await ok(p, "/calls/" + id + "/token")).token;
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    assert.equal(claims.video.room, "call-" + id);
    assert.equal(claims.video.canPublishData, false);
  }
  await ok(b, "/friends/" + x.id, { action: "block" });
  assert.equal((await b.call("/calls/" + id + "/token", "POST")).status, 403);
  assert.equal(
    (await a.call("/friends/request", "POST", { code: y.code })).status,
    404,
  );
  await c.proof("delete");
  assert.equal((await a.call("/state")).data.calls.length, 0);
  assert.equal((await c.call("/state")).status, 401);
  console.log(
    "API: одноразовая подпись, CSRF, права участника, приватный и групповой звонки, занятость, DND, блок и удаление — успешно.",
  );
} finally {
  await Promise.allSettled(all.map((v) => v.proof("delete")));
}
