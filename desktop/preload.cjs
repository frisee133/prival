const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("privalDevice", {
  profile: () => ipcRenderer.invoke("device:profile"),
  create: (nick) => ipcRenderer.invoke("device:create", nick),
  erase: () => ipcRenderer.invoke("device:erase"),
  hotkey: (key) => ipcRenderer.invoke("device:hotkey", key),
  overlaySettings: (change) => ipcRenderer.invoke("device:overlay", change),
  overlayState: (state) => ipcRenderer.send("device:overlay-state", state),
  onKey: (fn) => {
    const listener = (_e, v) => fn(v);
    ipcRenderer.on("device:key", listener);
    return () => ipcRenderer.removeListener("device:key", listener);
  },
});
