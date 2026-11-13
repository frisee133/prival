import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const password = randomBytes(24).toString("hex");
const values = {
  POSTGRES_PASSWORD: password,
  DATABASE_URL: "postgresql://prival:" + password + "@127.0.0.1:5432/prival",
  LIVEKIT_API_KEY: "prival" + randomBytes(9).toString("hex"),
  LIVEKIT_API_SECRET: randomBytes(32).toString("hex"),
};
let example = readFileSync(".env.example", "utf8");
for (const [key, value] of Object.entries(values))
  example = example.replace(
    new RegExp("^" + key + "=$", "m"),
    key + "=" + value,
  );
try {
  writeFileSync(".env", example, { flag: "wx", mode: 0o600 });
  console.log("Создан .env с локальными настройками.");
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  console.log("Файл .env уже существует.");
}
