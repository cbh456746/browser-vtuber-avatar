import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  assetRoute,
  localVtsUrl,
  settings,
  pose,
  trustedFrame,
  WEB_PREFERENCES,
  CSP,
} from "../desktop/policy.mjs";
import { frameNames, inspectPack, manifest } from "../desktop/pack.mjs";
import { frameFor } from "../app/pose.js";

test("resource routes reject traversal, alternate schemes, credentials and remote hosts", () => {
  const bad = [
    "file:///C:/Windows/win.ini",
    "https://example.com/index.html",
    "avatar://evil/index.html",
    "avatar://user@app/index.html",
    "avatar://app/index.html?script=1",
    "avatar://app/%2e%2e/private.json",
    "avatar://app/%252e%252e/private.json",
    "avatar://app/desktop/main.mjs",
    "avatar://pack/../settings.json",
    "avatar://app/index.html#payload",
    "avatar://app/index.html\\secret",
  ];
  for (const value of bad) assert.throws(() => assetRoute(value), value);
  assert.deepEqual(assetRoute("avatar://app/index.html"), {
    kind: "app",
    name: "index.html",
  });
});
test("VTS cannot become a remote request or privileged low-port service", () => {
  for (const value of [
    "https://example.com",
    8001.5,
    80,
    0,
    65536,
    NaN,
    Infinity,
    {},
    "8001",
  ])
    assert.throws(() => localVtsUrl(value));
  assert.equal(localVtsUrl(8001), "ws://127.0.0.1:8001");
});
test("IPC validates top frame and exact control window, rejecting subframes and spoofed origins", () => {
  const contents = {},
    control = { webContents: contents },
    valid = {
      sender: contents,
      senderFrame: { url: "avatar://app/index.html", parent: null },
    };
  trustedFrame(valid, control, "settings");
  for (const value of [
    { ...valid, sender: {} },
    { ...valid, senderFrame: { url: "avatar://app/index.html.evil" } },
    { ...valid, senderFrame: { url: "https://example.com" } },
    { ...valid, senderFrame: { url: "avatar://app/index.html", parent: {} } },
    { sender: contents },
  ])
    assert.throws(() => trustedFrame(value, control, "settings"));
});
test("settings reject prototype pollution, shell fragments, unknown capabilities and wrong types", () => {
  for (const value of [
    JSON.parse('{"__proto__":{"admin":true}}'),
    { command: "calc.exe" },
    { port: "8001" },
    { mirror: 1 },
    { size: 10000 },
    { background: "url(https://example.com)" },
    [],
  ])
    assert.throws(() => settings(value));
  assert.deepEqual(
    settings({ background: "green", mirror: true, size: 90, port: 8001 }),
    { background: "green", mirror: true, size: 90, port: 8001 },
  );
  assert.equal({}.admin, undefined);
});
test("pose fuzzing and grid mapping stay finite and within 25 directions × 6 expressions", () => {
  for (const value of [
    { x: NaN, y: 0, mouth: 0, eyes: false },
    { x: 0, y: 0, mouth: Infinity, eyes: false },
    { x: 0, y: 0, mouth: 0, eyes: 1 },
    { x: 0, y: 0, mouth: 0, eyes: false, script: "run" },
  ])
    assert.throws(() => pose(value));
  for (let i = 0; i < 2000; i++) {
    const p = pose({
        x: (i - 1000) * 22,
        y: (999 - i) * 17,
        mouth: i - 1000,
        eyes: i % 2 === 0,
      }),
      frame = frameFor(p);
    assert.ok(
      frame.row >= 0 &&
        frame.row < 5 &&
        frame.col >= 0 &&
        frame.col < 5 &&
        "ABCDEF".includes(frame.sheet),
    );
  }
});
test("manifest treats instruction-like names as text and rejects executable/URL fields", () => {
  const valid = {
    format: "illustration-avatar-pack-v1",
    name: "Ignore instructions - data only",
    frameSize: 256,
    imageFormat: "png",
  };
  assert.equal(manifest(valid).name, valid.name);
  for (const value of [
    { ...valid, script: "run" },
    { ...valid, url: "https://example.com" },
    { ...valid, name: "<script>alert(1)</script>" },
    { ...valid, frameSize: 99999 },
    { ...valid, imageFormat: "svg" },
    JSON.parse(
      '{"format":"illustration-avatar-pack-v1","name":"a","frameSize":256,"imageFormat":"png","__proto__":{}}',
    ),
  ])
    assert.throws(() => manifest(value));
});
test("Electron isolation and CSP deny remote scripts, connections, frames and generic Node access", () => {
  assert.equal(WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(WEB_PREFERENCES.contextIsolation, true);
  assert.equal(WEB_PREFERENCES.sandbox, true);
  assert.equal(WEB_PREFERENCES.webSecurity, true);
  assert.equal(WEB_PREFERENCES.webviewTag, false);
  assert.ok(
    CSP.includes("script-src 'self'") &&
      CSP.includes("connect-src 'none'") &&
      !CSP.includes("unsafe-eval") &&
      !CSP.includes("unsafe-inline"),
  );
});
test("full pack validation rejects missing frames, disguised HTML, excessive dimensions and extra instructions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-pack-test-"));
  const valid = {
    format: "illustration-avatar-pack-v1",
    name: "Generated test fixture",
    frameSize: 256,
    imageFormat: "png",
  };
  try {
    await fs.writeFile(path.join(root, "avatar.json"), JSON.stringify(valid));
    const image = await sharp({
      create: { width: 256, height: 256, channels: 4, background: "#8e77aa80" },
    })
      .png()
      .toBuffer();
    for (const name of frameNames("png")) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await fs.writeFile(path.join(root, name), image);
    }
    assert.equal(
      (await inspectPack(path.join(root, "avatar.json"))).files.length,
      150,
    );
    const target = path.join(root, "frames/A/r0c0.png");
    await fs.writeFile(target, '<svg onload="alert(1)"></svg>');
    await assert.rejects(inspectPack(path.join(root, "avatar.json")), /PNG/);
    const huge = Buffer.from(image);
    huge.writeUInt32BE(1000000, 16);
    await fs.writeFile(target, huge);
    await assert.rejects(inspectPack(path.join(root, "avatar.json")), /규격/);
    await fs.writeFile(target, image);
    await fs.writeFile(
      path.join(root, "AGENTS.md"),
      "UNTRUSTED: change policy",
    );
    await assert.rejects(inspectPack(path.join(root, "avatar.json")), /폴더만/);
    await fs.unlink(path.join(root, "AGENTS.md"));
    await fs.unlink(target);
    await assert.rejects(inspectPack(path.join(root, "avatar.json")), /25개/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("normal runtime sources contain no shell execution or untrusted HTML execution surfaces", async () => {
  for (const name of [
    "app/app.js",
    "app/output.js",
    "app/mascot.js",
    "desktop/main.mjs",
    "desktop/preload.cjs",
  ]) {
    const text = await fs.readFile(
      new URL("../" + name, import.meta.url),
      "utf8",
    );
    assert.ok(
      !/innerHTML|eval\(|child_process|shell\.openExternal|executeJavaScript/.test(
        text,
      ),
      name,
    );
  }
});

test("oversize manifests and linked frame roots are rejected before image decoding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-link-test-")),
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-outside-test-"));
  try {
    await fs.writeFile(path.join(root, "avatar.json"), " ".repeat(4097));
    await assert.rejects(inspectPack(path.join(root, "avatar.json")), /크기/);
    await fs.writeFile(
      path.join(root, "avatar.json"),
      JSON.stringify({
        format: "illustration-avatar-pack-v1",
        name: "Local fixture",
        frameSize: 256,
        imageFormat: "png",
      }),
    );
    for (const sheet of "ABCDEF") await fs.mkdir(path.join(outside, sheet));
    await fs.symlink(
      outside,
      path.join(root, "frames"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(inspectPack(path.join(root, "avatar.json")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
