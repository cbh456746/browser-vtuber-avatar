import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";
const require = createRequire(import.meta.url),
  root = path.resolve(".");
await fs.mkdir(path.join(root, ".local"), { recursive: true });
const profile = await fs.mkdtemp(path.join(root, ".local/desktop-test-"));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.NODE_OPTIONS;
const application = await electron.launch({
  executablePath: require("electron"),
  args: [root, `--user-data-dir=${profile}`],
  env: environment,
  timeout: 30000,
});
const failures = [],
  consoleErrors = [];
let service;
try {
  const page = await application.firstWindow();
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  await page.waitForSelector("#avatar-name");
  await page.waitForFunction(() =>
    document.getElementById("avatar-name").textContent.includes("Orbit"),
  );
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(await page.evaluate(() => typeof window.process), "undefined");
  assert.equal(await page.evaluate(() => window.isSecureContext), true);
  assert.equal(
    await page.evaluate(() => typeof window.avatarStudio.send),
    "undefined",
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.avatarStudio.settings({ command: "calc.exe" });
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("https://example.com");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch("file:///C:/Windows/win.ini");
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.evaluate(() => window.open("https://example.com"));
  assert.equal(application.windows().length, 1);
  await page.locator("#pose-mouth").fill("0.8");
  await page.locator("#pose-x").fill("0.5");
  await page.waitForTimeout(100);
  await page.evaluate(async () => {
    await window.avatarStudio.pose({ x: 1, y: 0, eyes: false, mouth: 1 });
    await window.avatarStudio.pose({ x: 0, y: 0, eyes: true, mouth: 0 });
  });
  await page.waitForFunction(async () => {
    const { pose } = await window.avatarStudio.state();
    return pose.x === 0 && pose.eyes === true && pose.mouth === 0;
  });
  await page.evaluate(async () => {
    await window.avatarStudio.pose({ x: 1, y: 0, eyes: true, mouth: 1 });
    await window.avatarStudio.pose({ x: -1, y: 0, eyes: true, mouth: 1 });
    await window.avatarStudio.mode("manual");
  });
  await page.waitForTimeout(50);
  assert.deepEqual(
    await page.evaluate(async () => (await window.avatarStudio.state()).pose),
    {
      x: 0,
      y: 0,
      eyes: false,
      mouth: 0,
    },
  );
  await page.locator("#help-open").click();
  assert.equal(await page.locator("#help").isVisible(), true);
  await page.locator("#help-close").click();
  const newWindow = application.waitForEvent("window");
  await page.locator("#output-open").click();
  const output = await newWindow;
  await output.waitForSelector("#output-stage svg");
  assert.equal(await output.title(), "Illustration Avatar Studio - 방송 화면");
  assert.equal(
    await output.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    ),
    "rgb(0, 255, 0)",
  );
  await page.selectOption("#background", "magenta");
  await output.waitForFunction(
    () => document.body.dataset.background === "magenta",
  );
  const unauthorized = await output.evaluate(async () => {
    try {
      await window.avatarStudio.settings({ size: 70 });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(unauthorized, true);
  service = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => service.once("listening", resolve));
  service.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw),
        reply = (messageType, data) =>
          socket.send(
            JSON.stringify({
              apiName: "VTubeStudioPublicAPI",
              apiVersion: "1.0",
              messageType,
              requestID: msg.requestID,
              data,
            }),
          );
      if (msg.messageType === "AuthenticationTokenRequest")
        reply("AuthenticationTokenResponse", {
          authenticationToken: "desktop-integration-fixture",
        });
      if (msg.messageType === "AuthenticationRequest")
        reply("AuthenticationResponse", { authenticated: true });
      if (msg.messageType === "ParameterValueRequest")
        reply("ParameterValueResponse", {
          name: msg.data.name,
          value: msg.data.name.startsWith("Eye") ? 1 : 0.8,
        });
    }),
  );
  await page.selectOption("#mode", "vts");
  await page.locator("#vts-port").fill(String(service.address().port));
  await page.locator("#connect").click();
  await page.waitForFunction(
    () => document.getElementById("status").textContent === "얼굴 추적 연결됨",
    { timeout: 10000 },
  );
  await page.locator("#disconnect").click();
  await page.selectOption("#mode", "manual");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(root, ".local/desktop-preview.png"),
    fullPage: true,
  });
  await output.screenshot({
    path: path.join(root, ".local/broadcast-preview.png"),
  });
  if (process.env.AVATAR_TEST_PACK) {
    const selected = path.resolve(process.env.AVATAR_TEST_PACK);
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, selected);
    await page.locator("#choose-avatar").click();
    await page.waitForFunction(() => {
      const img = document.querySelector("#preview img");
      return img && !img.hidden && img.naturalWidth === 512;
    });
    await output.waitForFunction(() => {
      const img = document.querySelector("#output-stage img");
      return img && !img.hidden && img.naturalWidth === 512;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: path.join(root, ".local/private-character-preview.png"),
      fullPage: true,
    });
  }
  await page.locator("#output-close").click();
  await page.waitForTimeout(100);
  assert.equal(application.windows().length, 1);
  assert.deepEqual(consoleErrors, []);
  console.log(
    JSON.stringify({
      desktop: "passed",
      runtime: "Electron",
      isolation: true,
      remoteFetchBlocked: true,
      fileFetchBlocked: true,
      popupsBlocked: true,
      outputWindow: true,
      unauthorizedOutputIPCBlocked: true,
      mockVtsConnected: true,
      screenshots: ".local/",
    }),
  );
} catch (error) {
  failures.push(error.message);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (service) {
    for (const socket of service.clients) socket.terminate();
    await new Promise((resolve) => service.close(resolve));
  }
  await application.close();
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
  await fs.writeFile(
    path.join(root, ".local/desktop-test.json"),
    JSON.stringify(
      { passed: !failures.length, failures, consoleErrors },
      null,
      2,
    ),
  );
}
