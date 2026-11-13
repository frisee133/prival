const {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
  powerMonitor,
  session,
  dialog,
} = require("electron");
const {
  generateKeyPairSync,
  createPublicKey,
  sign,
  createHash,
} = require("node:crypto");
const fs = require("node:fs/promises"),
  { existsSync, readFileSync } = require("node:fs");
const path = require("node:path"),
  { spawn } = require("node:child_process"),
  { createInterface } = require("node:readline");
const { createOverlay } = require("./overlay.cjs");
app.setName("Привал");
const cliServer = process.argv.find((v) => v.startsWith("--server="))?.slice(9);
const configFile = path.join(
  app.isPackaged ? path.dirname(process.execPath) : __dirname,
  "server.json",
);
const origin = new URL(
  cliServer ||
    process.env.PRIVAL_SERVER ||
    (existsSync(configFile)
      ? JSON.parse(readFileSync(configFile, "utf8")).server
      : "http://localhost:3000"),
).origin;
if (
  !origin.startsWith("https://") &&
  !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
)
  throw Error("Для удалённого сервера нужен HTTPS");
if (!app.commandLine.hasSwitch("user-data-dir"))
  app.setPath(
    "userData",
    path.join(
      app.getPath("appData"),
      "Prival Friends",
      createHash("sha256").update(origin).digest("hex").slice(0, 16),
    ),
  );
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win,
    overlay,
    tray,
    helper,
    quitting = false;
  const keyFile = path.join(app.getPath("userData"), "device.dpapi");
  let serial = Promise.resolve();
  function exclusive(fn) {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  }
  async function save(record) {
    const tmp = keyFile + ".new";
    await fs.writeFile(
      tmp,
      await safeStorage.encryptStringAsync(JSON.stringify(record)),
    );
    await fs.rename(tmp, keyFile);
  }
  async function load() {
    try {
      return JSON.parse(
        (await safeStorage.decryptStringAsync(await fs.readFile(keyFile)))
          .result,
      );
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw Error("Ключ устройства недоступен");
    }
  }
  async function request(route, body) {
    const r = await win.webContents.session.fetch(
      origin + "/api/device/" + route,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(body),
        credentials: "include",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await r.json();
    if (!r.ok) {
      const e = Error(data.error || "Ошибка сервера");
      e.status = r.status;
      throw e;
    }
    return data;
  }
  async function proof(record, purpose) {
    const publicKey = createPublicKey(record.privateKey)
      .export({ format: "der", type: "spki" })
      .toString("base64url");
    const { nonce } = await request("challenge", {
      publicKey,
      purpose,
      nick: record.nick,
    });
    if (!/^[\w-]{43}$/.test(nonce)) throw Error("Некорректный запрос сервера");
    const signature = sign(
      null,
      Buffer.from(["PRIVAL-DEVICE-1", origin, purpose, nonce].join("\n")),
      record.privateKey,
    ).toString("base64url");
    return request("prove", { nonce, signature });
  }
  async function erase(record) {
    record.pending = "delete";
    await save(record);
    try {
      const result = await proof(record, "delete");
      if (result.deleted !== true) throw Error();
    } catch {
      throw Error(
        "Удаление ещё не завершено. Подключитесь к серверу и повторите.",
      );
    }
    stopHelper();
    await overlay?.reset();
    await win.webContents.session.clearStorageData();
    await win.webContents.session.clearCache();
    await fs.unlink(keyFile);
    return null;
  }
  function openWindow() {
    if (!win) return;
    win.show();
    win.restore();
    win.focus();
  }
  function notifyKey(value) {
    if (win && !win.isDestroyed()) win.webContents.send("device:key", value);
  }
  function stopHelper() {
    const p = helper;
    helper = undefined;
    if (p) {
      p.stdin.end();
      notifyKey(false);
    }
  }
  function vk(code) {
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return 111 + Number(code.slice(1));
    if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
    if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
    return {
      Space: 32,
      Backquote: 192,
      CapsLock: 20,
      ScrollLock: 145,
      Pause: 19,
      Insert: 45,
    }[code];
  }
  function isMainFrame(e) {
    return (
      e.sender === win?.webContents &&
      e.senderFrame === e.sender.mainFrame &&
      e.senderFrame?.url.startsWith(origin + "/")
    );
  }
  const bind = (name, fn) =>
    ipcMain.handle("device:" + name, async (e, ...args) => {
      if (!isMainFrame(e)) throw Error("Недоступно");
      return fn(...args);
    });
  app
    .whenReady()
    .then(async () => {
      if (
        process.platform !== "win32" ||
        !(await safeStorage.isAsyncEncryptionAvailable())
      )
        throw Error("Для локального профиля требуется Windows DPAPI");
      const ses = session.defaultSession;
      ses.setPermissionRequestHandler((wc, perm, done, details) =>
        done(
          wc === win?.webContents &&
            new URL(wc.getURL()).origin === origin &&
            ((perm === "media" && !details.mediaTypes?.includes("video")) ||
              perm === "clipboard-sanitized-write"),
        ),
      );
      ses.setPermissionCheckHandler(
        (wc, perm, requestOrigin, details) =>
          wc === win?.webContents &&
          requestOrigin === origin &&
          ((perm === "media" && details.mediaType !== "video") ||
            perm === "clipboard-sanitized-write"),
      );
      win = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 730,
        minHeight: 530,
        show: false,
        backgroundColor: "#f5f6f0",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (e, url) => {
        if (new URL(url).origin !== origin) e.preventDefault();
      });
      win.webContents.on("did-start-navigation", (_e, _url, inPlace, main) => {
        if (main && !inPlace) {
          stopHelper();
          overlay?.clear();
        }
      });
      win.webContents.on("render-process-gone", () => {
        stopHelper();
        overlay?.clear();
      });
      overlay = createOverlay(
        path.join(app.getPath("userData"), "overlay.json"),
      );
      bind("overlay", (change) => overlay.settings(change));
      ipcMain.on("device:overlay-state", (e, data) => {
        if (isMainFrame(e)) overlay.publish(data);
      });
      const icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
      win.setIcon(icon);
      tray = new Tray(icon);
      tray.setToolTip("Привал");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Открыть Привал", click: openWindow },
          { label: "Выйти", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", openWindow);
      win.on("close", (e) => {
        if (!quitting) {
          e.preventDefault();
          win.hide();
        }
      });
      app.on("second-instance", openWindow);
      bind("profile", () =>
        exclusive(async () => {
          const record = await load();
          if (!record) return null;
          if (record.pending === "delete") return erase(record);
          if (record.pending === "register") {
            const p = await proof(record, "register");
            record.pending = null;
            await save(record);
            return p;
          }
          try {
            return await proof(record, "login");
          } catch (e) {
            if (e.status === 404) return erase(record);
            throw e;
          }
        }),
      );
      bind("create", (nick) =>
        exclusive(async () => {
          if (
            typeof nick !== "string" ||
            !nick.trim() ||
            nick.trim().length > 32
          )
            throw Error("Введите ник длиной до 32 символов");
          let record = await load();
          if (record && record.pending !== "register")
            throw Error("На устройстве уже есть профиль");
          if (!record) {
            const keys = generateKeyPairSync("ed25519");
            record = {
              privateKey: keys.privateKey.export({
                format: "pem",
                type: "pkcs8",
              }),
              nick: nick.trim(),
              pending: "register",
            };
            await save(record);
          }
          const p = await proof(record, "register");
          record.pending = null;
          await save(record);
          return p;
        }),
      );
      bind("erase", () =>
        exclusive(async () => {
          const record = await load();
          return record ? erase(record) : null;
        }),
      );
      bind("hotkey", async (code) => {
        stopHelper();
        if (code === null) return;
        const key = typeof code === "string" && vk(code);
        if (!key) throw Error("Выберите F1–F24, букву, цифру или пробел");
        const p = spawn(path.join(__dirname, "Hotkey.exe"), [String(key)], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "ignore"],
        });
        helper = p;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (helper === p) stopHelper();
            reject(Error("PTT недоступен"));
          }, 4000);
          p.once("error", () => {
            clearTimeout(timer);
            reject(Error("Не удалось запустить PTT"));
          });
          createInterface({ input: p.stdout }).on("line", (s) => {
            if (helper !== p) return;
            if (s === "ready") {
              clearTimeout(timer);
              resolve();
            } else if (s === "up" || s === "down") notifyKey(s === "down");
          });
          p.once("exit", () => {
            clearTimeout(timer);
            if (helper === p) {
              helper = undefined;
              notifyKey(false);
            }
            reject(Error("PTT остановлен"));
          });
        });
      });
      powerMonitor.on("suspend", () => notifyKey(false));
      powerMonitor.on("lock-screen", () => notifyKey(false));
      win.once("ready-to-show", () => win.show());
      await win.loadURL(origin);
    })
    .catch((e) => {
      dialog.showErrorBox(
        "Привал",
        /ERR_CONNECTION/.test(String(e))
          ? "Сервер недоступен. Запустите сервер или проверьте адрес в server.json."
          : e.message,
      );
      app.quit();
    });
  app.on("before-quit", () => {
    quitting = true;
    stopHelper();
    overlay?.dispose();
  });
}
