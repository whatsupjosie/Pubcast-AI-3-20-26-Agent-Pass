const path = require("path");

module.exports = {
  app: {
    getPath: (p) => {
      const root = path.join(__dirname, "tmp_docs");
      if (p === "documents") return root;
      if (p === "home") return root;
      if (p === "downloads") return root;
      return root;
    },
    setLoginItemSettings: () => {},
    whenReady: () => ({ then: () => {} }),
    on: () => {},
    getVersion: () => "1.0.0",
  },
  BrowserWindow: class {},
  Tray: class { setImage() {} setToolTip() {} setContextMenu() {} },
  Menu: { buildFromTemplate: () => [] },
  nativeImage: { createFromPath: () => ({}) },
  ipcMain: { handle: () => {}, on: () => {}, emit: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => "" },
};
