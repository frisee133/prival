import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  copyFile,
  rename,
  writeFile,
  access,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
if (process.platform !== "win32")
  throw Error("Соберите Windows-клиент на Windows");
const csc = join(
  process.env.WINDIR,
  "Microsoft.NET",
  "Framework64",
  "v4.0.30319",
  "csc.exe",
);
const compile = spawnSync(
  csc,
  [
    "/nologo",
    "/optimize+",
    "/target:exe",
    "/reference:System.Windows.Forms.dll",
    "/out:Hotkey.exe",
    "Hotkey.cs",
  ],
  { cwd: "desktop", stdio: "inherit", windowsHide: true },
);
if (compile.status !== 0) throw Error("Не удалось собрать обработчик PTT");
if (process.argv.includes("--package")) {
  const dest = "dist/windows/Привал",
    appDir = join(dest, "resources/app");
  const require = createRequire(import.meta.url);
  const distribution = dirname(require("electron"));
  await mkdir(appDir, { recursive: true });
  await cp(distribution, dest, { recursive: true });
  for (const f of [
    "main.cjs",
    "preload.cjs",
    "package.json",
    "tray.png",
    "Hotkey.exe",
    "overlay.cjs",
    "overlay-preload.cjs",
    "overlay.html",
    "overlay.css",
    "overlay-renderer.js",
  ])
    await copyFile(join("desktop", f), join(appDir, f));
  await rename(join(dest, "electron.exe"), join(dest, "Привал.exe"));
  try {
    await access(join(dest, "server.json"));
  } catch {
    await copyFile("desktop/server.json", join(dest, "server.json"));
  }
  if (process.env.PRIVAL_PACKAGE_SERVER)
    await writeFile(
      join(dest, "server.json"),
      JSON.stringify(
        { server: new URL(process.env.PRIVAL_PACKAGE_SERVER).origin },
        null,
        2,
      ),
    );
  console.log("Готово: " + dest + "/Привал.exe");
}
