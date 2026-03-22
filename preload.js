"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  pickDirectory: (key) => ipcRenderer.invoke("pick-directory", key),
  getServerStatus: () => ipcRenderer.invoke("get-server-status"),
  toggleServer: () => ipcRenderer.invoke("toggle-server"),
});
