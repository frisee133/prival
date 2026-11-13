import Fastify, { LogController } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import serve from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { migrate, pool, ApiError } from "./db.js";
import { deviceRoutes } from "./device.js";
import { callVoiceRoutes } from "./call-voice.js";
import { friendRoutes } from "./friends.js";
await migrate();
const app = Fastify({
  logger: { level: "warn" },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 16384,
  trustProxy:
    process.env.TRUST_PROXY === "1"
      ? (_address: string, hop: number) => hop === 0
      : false,
});
await app.register(cookie);
await app.register(rateLimit, { global: false });
app.setErrorHandler(
  (err: Error & { code?: string; statusCode?: number }, _req, reply) => {
    if (err instanceof ZodError)
      return reply.code(400).send({
        error: "Проверьте введённые данные",
        field: err.issues[0]?.path.join("."),
      });
    if (err instanceof ApiError)
      return reply.code(err.statusCode).send({ error: err.message });
    if (err.code === "23505")
      return reply.code(409).send({ error: "Запись уже существует" });
    if (err.code === "23503")
      return reply.code(400).send({ error: "Запись недоступна" });
    const code = err.statusCode ?? 500;
    if (code >= 500)
      app.log.error(
        { code: err.code ?? "INTERNAL" },
        "Ошибка обработки запроса",
      );
    return reply.code(code).send({
      error:
        code === 429
          ? "Слишком часто. Попробуйте через минуту."
          : code < 500
            ? "Некорректный запрос"
            : "Ошибка сервера",
    });
  },
);
await deviceRoutes(app);
friendRoutes(app);
callVoiceRoutes(app);
app.get("/api/health", async () => {
  await pool.query("SELECT 1");
  return { ok: true };
});
if (existsSync("dist/web/index.html"))
  await app.register(serve, { root: resolve("dist/web"), preCompressed: true });
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
await app.listen({
  port: Number(process.env.PORT ?? 3000),
  host: process.env.BIND_HOST ?? "127.0.0.1",
});
