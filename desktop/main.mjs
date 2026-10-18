import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  protocol,
  session,
  safeStorage,
} from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ORIGIN,
  CSP,
  WEB_PREFERENCES,
  trustedFrame,
  assetRoute,
  settings,
  pose,
} from "./policy.mjs";
import { installPack } from "./pack.mjs";
import { VtsClient } from "./vts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const diagnostic = process.argv.includes("--self-check");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "avatar",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
app.enableSandbox();
app.setName("Illustration Avatar Studio");
app.setAppUserModelId("studio.illustration.avatar");
if (!app.requestSingleInstanceLock()) app.quit();
let control,
  output,
  dataRoot,
  packsRoot,
  micAllowed = false,
  client,
  token = "",
  lastPose = 0,
  pendingPose,
  poseTimer,
  saveQueue = Promise.resolve(),
  encryptedStorage = false;
const state = {
  avatar: { name: "Orbit · 기본 샘플", id: null },
  settings: { background: "green", mirror: false, size: 85, port: 8001 },
  mode: "manual",
  pose: { x: 0, y: 0, eyes: false, mouth: 0 },
  status: "수동 미리보기",
  outputOpen: false,
};
function emit() {
  for (const win of [control, output])
    if (win && !win.isDestroyed())
      win.webContents.send("state", structuredClone(state));
}
function plainState() {
  return structuredClone(state);
}
function cancelPendingPose() {
  clearTimeout(poseTimer);
  poseTimer = undefined;
  pendingPose = undefined;
}
function flushPose() {
  poseTimer = undefined;
  if (!pendingPose || state.mode === "vts") return;
  state.pose = pendingPose;
  pendingPose = undefined;
  lastPose = Date.now();
  emit();
}
function save() {
  const data = JSON.stringify({
    settings: state.settings,
    avatar: state.avatar,
  });
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      const temporary = path.join(dataRoot, "settings-next.json");
      await fs.writeFile(temporary, data, { mode: 0o600 });
      await fs.rename(temporary, path.join(dataRoot, "settings.json"));
    });
  return saveQueue;
}
async function forgetToken() {
  token = "";
  await fs.unlink(path.join(dataRoot, "vts-token.bin")).catch(() => {});
}
function protect(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.on("page-title-updated", (event) => event.preventDefault());
}
function createOutput() {
  if (output && !output.isDestroyed()) {
    output.show();
    return;
  }
  output = new BrowserWindow({
    width: 640,
    height: 720,
    title: "Illustration Avatar Studio - 방송 화면",
    frame: false,
    transparent: true,
    resizable: true,
    backgroundColor: "#00000000",
    webPreferences: {
      ...WEB_PREFERENCES,
      preload: path.join(root, "desktop/preload.cjs"),
    },
  });
  protect(output);
  output.loadURL(`${ORIGIN}/output.html`);
  output.webContents.on("did-finish-load", emit);
  state.outputOpen = true;
  output.on("closed", () => {
    output = null;
    state.outputOpen = false;
    emit();
  });
  emit();
}
function command(name, handler) {
  ipcMain.handle(name, async (event, ...args) => {
    try {
      trustedFrame(event, control, name);
      const result = await handler(...args);
      return { ok: true, value: result };
    } catch (error) {
      const message = /^[가-힣]/.test(error.message)
        ? error.message
        : "작업을 완료하지 못했습니다. 파일 형식과 접근 권한을 확인해 주세요.";
      return { ok: false, error: message };
    }
  });
}

app
  .whenReady()
  .then(async () => {
    dataRoot = app.getPath("userData");
    packsRoot = path.join(dataRoot, "packs");
    await fs.mkdir(dataRoot, { recursive: true });
    try {
      const saved = JSON.parse(
        await fs.readFile(path.join(dataRoot, "settings.json"), "utf8"),
      );
      state.settings = { ...state.settings, ...settings(saved.settings) };
      if (/^[a-f0-9]{64}$/.test(saved.avatar?.id)) {
        const info = JSON.parse(
          await fs.readFile(
            path.join(packsRoot, saved.avatar.id, "avatar.json"),
            "utf8",
          ),
        );
        const { manifest } = await import("./pack.mjs");
        state.avatar = { id: saved.avatar.id, ...manifest(info) };
      }
    } catch {}
    encryptedStorage =
      safeStorage.isEncryptionAvailable() &&
      !(
        process.platform === "linux" &&
        safeStorage.getSelectedStorageBackend() === "basic_text"
      );
    if (encryptedStorage) {
      try {
        const data = await fs.readFile(path.join(dataRoot, "vts-token.bin"));
        if (data.length <= 16384) token = safeStorage.decryptString(data);
      } catch {}
    }
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, origin, details) =>
        permission === "media" &&
        contents === control?.webContents &&
        origin === ORIGIN &&
        micAllowed &&
        details.mediaType === "audio",
    );
    session.defaultSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          permission === "media" &&
            contents === control?.webContents &&
            contents.getURL() === `${ORIGIN}/index.html` &&
            micAllowed &&
            details.mediaTypes?.length === 1 &&
            details.mediaTypes[0] === "audio",
        ),
    );
    session.defaultSession.on("will-download", (event) =>
      event.preventDefault(),
    );
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith("avatar://") }),
    );
    protocol.handle("avatar", async (request) => {
      try {
        if (request.method !== "GET") return new Response("", { status: 405 });
        const route = assetRoute(request.url);
        let file;
        if (route.kind === "app") file = path.join(root, "app", route.name);
        else {
          if (route.id !== state.avatar.id)
            return new Response("", { status: 403 });
          file = path.join(packsRoot, route.id, route.name);
        }
        const data = await fs.readFile(file),
          extension = path.extname(file),
          type = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".png": "image/png",
            ".webp": "image/webp",
          }[extension];
        return new Response(data, {
          headers: {
            "Content-Type": type,
            "Content-Security-Policy": CSP,
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Resource-Policy": "same-site",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": ORIGIN,
          },
        });
      } catch {
        return new Response("", { status: 404 });
      }
    });
    client = new VtsClient({
      getToken: () => token,
      saveToken: (value) => {
        token = value;
        if (encryptedStorage)
          fs.writeFile(
            path.join(dataRoot, "vts-token.bin"),
            safeStorage.encryptString(value),
            { mode: 0o600 },
          ).catch(() => {});
      },
      forgetToken: () => {
        forgetToken();
      },
      onStatus: (value) => {
        state.status = value;
        emit();
      },
      onPose: (value) => {
        if (state.mode === "vts") {
          state.pose = pose(value);
          emit();
        }
      },
    });
    command("state-get", () => plainState());
    command("settings", async (value) => {
      state.settings = { ...state.settings, ...settings(value) };
      await save();
      emit();
    });
    command("choose-avatar", async () => {
      const selection = await dialog.showOpenDialog(control, {
        title: "캐릭터 폴더의 avatar.json 선택",
        properties: ["openFile"],
        filters: [{ name: "캐릭터 정보", extensions: ["json"] }],
      });
      if (selection.canceled) return false;
      state.avatar = await installPack(selection.filePaths[0], packsRoot);
      await save();
      emit();
      return true;
    });
    command("sample", async () => {
      state.avatar = { name: "Orbit · 기본 샘플", id: null };
      await save();
      emit();
    });
    command("output-open", createOutput);
    command("output-close", () => output?.close());
    command("mode", async (mode) => {
      if (!["manual", "mic", "vts"].includes(mode))
        throw Error("지원하지 않는 입력입니다.");
      cancelPendingPose();
      client.stop();
      micAllowed = false;
      if (mode === "mic") {
        const answer = await dialog.showMessageBox(control, {
          type: "question",
          buttons: ["허용", "취소"],
          defaultId: 1,
          cancelId: 1,
          title: "마이크 사용",
          message: "입 모양에 마이크를 사용할까요?",
          detail:
            "소리는 녹음하거나 전송하지 않습니다. 다른 입력 모드로 바꾸면 마이크를 종료합니다.",
        });
        if (answer.response !== 0) return false;
        micAllowed = true;
      }
      state.mode = mode;
      state.pose = { x: 0, y: 0, eyes: false, mouth: 0 };
      state.status =
        mode === "mic"
          ? "마이크 준비 중"
          : mode === "vts"
            ? "연결 버튼을 눌러 주세요."
            : "수동 미리보기";
      emit();
      return true;
    });
    command("vts-connect", () => {
      if (state.mode !== "vts")
        throw Error("얼굴 추적 모드를 먼저 선택하세요.");
      client.start(state.settings.port);
    });
    command("vts-disconnect", () => client.stop());
    command("vts-forget", async () => {
      client.stop();
      await forgetToken();
      emit();
    });
    command("pose", (value) => {
      if (state.mode === "vts") return;
      pendingPose = pose(value);
      if (poseTimer) return;
      const delay = Math.max(0, 20 - (Date.now() - lastPose));
      if (delay) poseTimer = setTimeout(flushPose, delay);
      else flushPose();
    });
    command("quit", () => app.quit());
    Menu.setApplicationMenu(null);
    control = new BrowserWindow({
      show: !diagnostic,
      width: 1180,
      height: 860,
      minWidth: 900,
      minHeight: 700,
      title: "Illustration Avatar Studio",
      backgroundColor: "#f7f5fa",
      webPreferences: {
        ...WEB_PREFERENCES,
        preload: path.join(root, "desktop/preload.cjs"),
      },
    });
    protect(control);
    control.on("closed", () => app.quit());
    control.webContents.on("did-finish-load", emit);
    await control.loadURL(`${ORIGIN}/index.html`);
    if (diagnostic) {
      const preferences = control.webContents.getLastWebPreferences();
      console.log(
        JSON.stringify({
          name: app.getName(),
          version: app.getVersion(),
          title: control.webContents.getTitle(),
          sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation,
          nodeIntegration: preferences.nodeIntegration,
          network: "loopback-vts-only",
          rendererLoaded: true,
        }),
      );
      app.quit();
    }
  })
  .catch(() => {
    dialog.showErrorBox(
      "실행 오류",
      "앱 파일을 확인할 수 없습니다. ZIP을 새 폴더에 모두 풀어 다시 실행해 주세요.",
    );
    app.quit();
  });
app.on("before-quit", () => {
  cancelPendingPose();
  micAllowed = false;
  client?.stop();
});
app.on("window-all-closed", () => app.quit());
