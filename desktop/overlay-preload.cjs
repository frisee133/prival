const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("overlayDisplay", {
  onState(fn) {
    const listener = (_event, state) => fn(state);
    ipcRenderer.on("overlay:state", listener);
    return () => ipcRenderer.removeListener("overlay:state", listener);
  },
});
