const { contextBridge, ipcRenderer } = require("electron");
const call = async (channel, ...args) => {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};
contextBridge.exposeInMainWorld(
  "avatarStudio",
  Object.freeze({
    state: () => call("state-get"),
    settings: (value) => call("settings", value),
    chooseAvatar: () => call("choose-avatar"),
    sample: () => call("sample"),
    openOutput: () => call("output-open"),
    closeOutput: () => call("output-close"),
    mode: (value) => call("mode", value),
    connect: () => call("vts-connect"),
    disconnect: () => call("vts-disconnect"),
    forget: () => call("vts-forget"),
    pose: (value) => call("pose", value),
    quit: () => call("quit"),
    subscribe: (callback) => {
      if (typeof callback !== "function") throw new Error("콜백이 필요합니다.");
      const listener = (_event, value) => callback(value);
      ipcRenderer.on("state", listener);
      return () => ipcRenderer.removeListener("state", listener);
    },
  }),
);
