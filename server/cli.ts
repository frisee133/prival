import { pool, migrate, transaction } from "./db.js";
try {
  await migrate();
  const [command, code] = process.argv.slice(2);
  if (command === "owner") {
    if (!/^[0-9A-F]{12}$/i.test(code ?? ""))
      throw Error("Укажите личный код уже созданного профиля");
    await transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(817002)");
      const p = (
        await c.query("SELECT id FROM profiles WHERE code=$1", [
          code.toUpperCase(),
        ])
      ).rows[0];
      if (!p) throw Error("Профиль не найден");
      await c.query("UPDATE profiles SET role='owner' WHERE id=$1", [p.id]);
    });
    console.log("Профилю присвоена роль владельца.");
  } else if (command !== "migrate")
    throw Error("Команды: migrate, owner <код>");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
