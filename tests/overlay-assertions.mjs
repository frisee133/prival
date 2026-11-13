import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {readFile} from "node:fs/promises";
import {join} from "node:path";

export async function verifyOverlay(app, page, expectedIds) {
  const overlay = app.windows().find((p) => p.url().endsWith("/overlay.html"));
  assert.ok(overlay, "Окно оверлея должно существовать");
  const checkbox = page.getByRole("checkbox", {
    name: "Показывать оверлей во время звонка",
  });
  await checkbox.check();
  await overlay.waitForFunction(
    () => document.querySelectorAll(".peer").length === 2,
  );
  assert.deepEqual(
    (
      await overlay
        .locator(".peer")
        .evaluateAll((rows) => rows.map((r) => r.dataset.peer))
    ).sort(),
    expectedIds.sort(),
  );
  await overlay.locator(".peer.speaking").first().waitFor();
  await overlay.getByText("Микрофон включён", { exact: true }).waitFor();
  await page
    .getByLabel("Расположение оверлея", { exact: true })
    .selectOption("bottom-right");
  await page.waitForFunction(
    () => !document.querySelector("input[type=checkbox][disabled]"),
  );
  const windowInfo = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "Привал — оверлей",
    );
    return {
      bounds: w.getBounds(),
      area: screen.getDisplayMatching(w.getBounds()).workArea,
      click: screen.dipToScreenPoint({
        x: w.getBounds().x + 30,
        y: w.getBounds().y + 30,
      }),
      focusable: w.isFocusable(),
      onTop: w.isAlwaysOnTop(),
      visible: w.isVisible(),
    };
  });
  assert.ok(windowInfo.visible && windowInfo.onTop && !windowInfo.focusable);
  assert.equal(
    windowInfo.bounds.x + windowInfo.bounds.width,
    windowInfo.area.x + windowInfo.area.width - 12,
  );
  assert.equal(
    windowInfo.bounds.y + windowInfo.bounds.height,
    windowInfo.area.y + windowInfo.area.height - 12,
  );
  const dataPath = await app.evaluate(({app})=>app.getPath("userData"));
  const persisted = JSON.parse(await readFile(join(dataPath,"overlay.json"),"utf8"));
  assert.equal(persisted.enabled, true);
  assert.equal(persisted.corner, "bottom-right");
  await overlay.screenshot({
    path: ".local/overlay.png",
    omitBackground: true,
  });
  const handle = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === "Привал — оверлей",
    );
    return w.getNativeWindowHandle().readBigUInt64LE().toString(16);
  });
  const command = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class OverlayStyle{[DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")]public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);}';[OverlayStyle]::GetWindowLongPtr([IntPtr]::new([Convert]::ToInt64("${handle}",16)),-20).ToInt64()`;
  const style = await new Promise((resolve, reject) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.once("error", reject);
    p.once("exit", (code) =>
      code === 0 ? resolve(Number(out.trim())) : reject(Error(err)),
    );
  });
  assert.ok(
    (style & 0x20) !== 0,
    "Win32 WS_EX_TRANSPARENT должен пропускать мышь в нижележащее окно",
  );
  await page.bringToFront();
  await checkbox.uncheck();
  assert.equal(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.getTitle() === "Привал — оверлей")
        .isVisible(),
    ),
    false,
  );
  await checkbox.check();
  console.log(
    "Оверлей: речь, микрофон, угол экрана, always-on-top и Win32-прозрачность для мыши — успешно.",
  );
  return overlay;
}
