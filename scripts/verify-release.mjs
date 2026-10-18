import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getCurrentFuseWire, FuseV1Options } from "@electron/fuses";
import { listPackage, extractFile } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { APP_FILES } from "./runtime-files.mjs";
const folder = path.resolve("dist/Illustration Avatar Studio-win32-x64"),
  exe = path.join(folder, "Illustration Avatar Studio.exe");
const fuses = await getCurrentFuseWire(exe),
  info = JSON.parse(await fs.readFile("release/BUILD-INFO.json", "utf8"));
if (
  info.executableSha256 !==
  createHash("sha256")
    .update(await fs.readFile(exe))
    .digest("hex")
)
  throw Error("Executable hash changed");
for (const key of [
  FuseV1Options.RunAsNode,
  FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  FuseV1Options.EnableNodeCliInspectArguments,
  FuseV1Options.GrantFileProtocolExtraPrivileges,
])
  if (fuses[key] !== 48) throw Error("Unsafe fuse");
for (const key of [
  FuseV1Options.OnlyLoadAppFromAsar,
  FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
])
  if (fuses[key] !== 49) throw Error("Missing integrity fuse");
const entries = listPackage(path.join(folder, "resources/app.asar"));
const allowedFiles = new Set(APP_FILES);
const allowedEntries = new Set(
  APP_FILES.flatMap((name) => {
    const parts = name.split("/");
    return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
  }),
);
const actualEntries = new Set(
  entries.map((name) => name.replaceAll("\\", "/").replace(/^\//, "")),
);
if (
  [...actualEntries].some((name) => !allowedEntries.has(name)) ||
  [...allowedFiles].some((name) => !actualEntries.has(name))
)
  throw Error("Unreviewed or missing files in packaged app");
const wsPackage = JSON.parse(
  extractFile(
    path.join(folder, "resources/app.asar"),
    path.join("node_modules", "ws", "package.json"),
  ).toString(),
);
const sourcePackage = JSON.parse(await fs.readFile("package.json", "utf8"));
if (wsPackage.version !== sourcePackage.dependencies.ws)
  throw Error("Unexpected WebSocket dependency version");
const probe = spawnSync(exe, ["--self-check"], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--require=__avatar_fuse_probe_missing_module__",
  },
  encoding: "utf8",
  windowsHide: true,
  timeout: 30000,
});
if (probe.status !== 0) throw Error("Packaged app self-check failed");
const diagnosticLine = probe.stdout
  .split(/\r?\n/)
  .find((line) => line.startsWith('{"name":'));
if (!diagnosticLine) throw Error("Packaged renderer did not report readiness");
const diagnostic = JSON.parse(diagnosticLine);
if (
  !diagnostic.rendererLoaded ||
  !diagnostic.sandbox ||
  !diagnostic.contextIsolation ||
  diagnostic.nodeIntegration
)
  throw Error("Packaged renderer isolation failed");
const report = {
  verified: true,
  asarEntries: entries.length,
  embeddedIntegrity: true,
  runAsNode: false,
  nodeOptions: false,
  debugArguments: false,
  packagedRendererLoaded: true,
  hostileEnvironmentIgnored: true,
  signed: false,
  websocketVersion: wsPackage.version,
};
await fs.writeFile(
  "release/RELEASE-CHECK.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
