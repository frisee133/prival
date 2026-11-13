import { readdir, readFile, writeFile } from "node:fs/promises";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip);
const dir = new URL("../dist/web/assets/", import.meta.url);
for (const name of await readdir(dir)) {
  if (!name.endsWith(".wasm")) continue;
  const bytes = await readFile(new URL(name, dir));
  await writeFile(
    new URL(name + ".gz", dir),
    await compress(bytes, { level: 9 }),
  );
}
