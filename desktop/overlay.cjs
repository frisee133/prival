const { BrowserWindow, screen } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
function createOverlay(settingsFile) {
  let window;
  let ready = false;
  let prefs = { enabled: false, corner: "top-left", display: "active" };
  let snapshot = { active: false, peers: [] };
  let persistence = Promise.resolve();
  let disposed = false;
  function displays() {
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      name: d.label || "Экран " + (i + 1),
    }));
  }
  function settings() {
    return { ...prefs, displays: displays() };
  }
  function updateWindow() {
    if (!window || disposed) return;
    const selected = screen
      .getAllDisplays()
      .find((d) => String(d.id) === prefs.display);
    const display =
      selected || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const maxPeers = Math.max(
      1,
      Math.min(20, Math.floor((area.height - 110) / 38)),
    );
    const width = Math.min(280, area.width - 24);
    const rows = Math.min(maxPeers, Math.max(1, snapshot.peers.length));
    const height = Math.min(
      area.height - 24,
      80 + rows * 38 + (snapshot.peers.length > maxPeers ? 25 : 0),
    );
    const right = prefs.corner.endsWith("right"),
      bottom = prefs.corner.startsWith("bottom");
    const bounds = {
      width,
      height,
      x: area.x + (right ? area.width - width - 12 : 12),
      y: area.y + (bottom ? area.height - height - 12 : 12),
    };
    const previous = window.getBounds();
    if (Object.keys(bounds).some((k) => bounds[k] !== previous[k]))
      window.setBounds(bounds);
    if (ready)
      window.webContents.send("overlay:state", { ...snapshot, maxPeers });
    if (prefs.enabled && snapshot.active && ready) {
      if (!window.isVisible()) window.showInactive();
    } else window.hide();
  }
  async function initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(settingsFile, "utf8"));
      if (typeof saved.enabled === "boolean") prefs.enabled = saved.enabled;
      if (corners.includes(saved.corner)) prefs.corner = saved.corner;
      if (typeof saved.display === "string") prefs.display = saved.display;
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn("Настройки оверлея восстановлены по умолчанию");
    }
    if (disposed) return;
    window = new BrowserWindow({
      title: "Привал — оверлей",
      width: 280,
      height: 160,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      webPreferences: {
        preload: path.join(__dirname, "overlay-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "prival-overlay",
        backgroundThrottling: false,
      },
    });
    window.setAlwaysOnTop(true, "screen-saver");
    window.setIgnoreMouseEvents(true);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (e) => e.preventDefault());
    window.webContents.session.setPermissionRequestHandler(
      (_wc, _permission, done) => done(false),
    );
    window.webContents.session.setPermissionCheckHandler(() => false);
    window.webContents.on("did-finish-load", () => {
      ready = true;
      updateWindow();
    });
    await window.loadFile(path.join(__dirname, "overlay.html"));
    for (const event of [
      "display-added",
      "display-removed",
      "display-metrics-changed",
    ])
      screen.on(event, updateWindow);
  }
  const initialized = initialize();
  initialized.catch(() => {}); // Settings IPC reports initialization failures to the user.
  return {
    async settings(change) {
      await initialized;
      if (change !== undefined) {
        if (
          !change ||
          typeof change !== "object" ||
          typeof change.enabled !== "boolean" ||
          !corners.includes(change.corner) ||
          typeof change.display !== "string" ||
          !["active", ...displays().map((d) => d.id)].includes(change.display)
        )
          throw Error("Некорректные настройки оверлея");
        prefs = {
          enabled: change.enabled,
          corner: change.corner,
          display: change.display,
        };
        const saved = JSON.stringify(prefs, null, 2);
        persistence = persistence
          .catch(() => {})
          .then(async () => {
            await fs.writeFile(settingsFile + ".new", saved);
            await fs.rename(settingsFile + ".new", settingsFile);
          });
        updateWindow();
        await persistence;
      }
      return settings();
    },
    publish(data) {
      if (
        !data ||
        typeof data.active !== "boolean" ||
        !Array.isArray(data.peers)
      )
        return;
      snapshot = {
        active: data.active,
        mic: data.mic === true,
        deaf: data.deaf === true,
        status: typeof data.status === "string" ? data.status.slice(0, 80) : "",
        peers: data.peers
          .slice(0, 20)
          .filter(
            (p) => p && typeof p.id === "string" && typeof p.name === "string",
          )
          .map((p) => ({
            id: p.id.slice(0, 64),
            name: p.name.slice(0, 32),
            self: p.self === true,
            speaking: p.speaking === true,
          })),
      };
      updateWindow();
    },
    clear() {
      snapshot = { active: false, peers: [] };
      updateWindow();
    },
    async reset() {
      this.clear();
      await initialized;
      await persistence.catch(() => {});
      prefs = { enabled: false, corner: "top-left", display: "active" };
      await fs.rm(settingsFile, { force: true });
    },
    dispose() {
      disposed = true;
      for (const event of [
        "display-added",
        "display-removed",
        "display-metrics-changed",
      ])
        screen.removeListener(event, updateWindow);
      if (window && !window.isDestroyed()) window.destroy();
    },
  };
}
module.exports = { createOverlay };
