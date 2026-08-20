const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modelingCenter", {
  getStatus: () => ipcRenderer.invoke("app:status"),
  pair: (input) => ipcRenderer.invoke("app:pair", input),
  prepareEnvironment: () => ipcRenderer.invoke("environment:prepare"),
  openSite: () => ipcRenderer.invoke("site:open"),
  startRunner: (input) => ipcRenderer.invoke("runner:start", input),
  stopRunner: () => ipcRenderer.invoke("runner:stop"),
  runnerStatus: () => ipcRenderer.invoke("runner:status"),
  updateStatus: () => ipcRenderer.invoke("update:status"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  downloadUpdate: () => ipcRenderer.invoke("update:download"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  openUpdateNotes: () => ipcRenderer.invoke("update:notes"),
  onRunnerEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:event", listener);
    return () => ipcRenderer.removeListener("runner:event", listener);
  },
  onEnvironmentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("environment:event", listener);
    return () => ipcRenderer.removeListener("environment:event", listener);
  },
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update:event", listener);
    return () => ipcRenderer.removeListener("update:event", listener);
  },
});
