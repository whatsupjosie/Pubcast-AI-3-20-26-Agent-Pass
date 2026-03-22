"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  pickDirectory: (key) => ipcRenderer.invoke("pick-directory", key),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  scanFile: (path) => ipcRenderer.invoke("scan-file", path),
  scanFolder: (path) => ipcRenderer.invoke("scan-folder", path),
  getServerStatus: () => ipcRenderer.invoke("get-server-status"),
  toggleServer: () => ipcRenderer.invoke("toggle-server"),
});
