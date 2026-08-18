const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modelingCenter", {
  getStatus: () => ipcRenderer.invoke("app:status"),
  pair: (input) => ipcRenderer.invoke("app:pair", input),
  startRunner: (input) => ipcRenderer.invoke("runner:start", input),
  stopRunner: () => ipcRenderer.invoke("runner:stop"),
  runnerStatus: () => ipcRenderer.invoke("runner:status"),
  onRunnerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:event", listener);
    return () => ipcRenderer.removeListener("runner:event", listener);
  },
});
