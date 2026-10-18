import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { WS_FILES } from "./runtime-files.mjs";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = JSON.parse(
  await fs.readFile(path.join(root, "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(source.version))
  throw Error("Invalid package version");
const stage = path.join(root, ".local/package-stage"),
  out = path.join(root, "dist", source.version);
// This generated staging directory is fixed inside this project, never user supplied.
if (stage !== path.join(root, ".local", "package-stage"))
  throw Error("Unexpected staging path");
await fs.rm(stage, { recursive: true, force: true });
await fs.mkdir(stage, { recursive: true });
const runtime = [
  "main.mjs",
  "preload.cjs",
  "policy.mjs",
  "pack.mjs",
  "vts.mjs",
];
await fs.mkdir(path.join(stage, "desktop"));
for (const file of runtime)
  await fs.copyFile(
    path.join(root, "desktop", file),
    path.join(stage, "desktop", file),
  );
await fs.cp(path.join(root, "app"), path.join(stage, "app"), {
  recursive: true,
});
for (const file of ["LICENSE", "NOTICE.md"])
  await fs.copyFile(path.join(root, file), path.join(stage, file));
for (const file of WS_FILES) {
  const destination = path.join(stage, "node_modules/ws", file);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(path.join(root, "node_modules/ws", file), destination);
}
await fs.writeFile(
  path.join(stage, "package.json"),
  JSON.stringify({
    name: source.name,
    productName: source.productName,
    version: source.version,
    main: source.main,
    type: "module",
    license: source.license,
    dependencies: source.dependencies,
  }),
);
const [target] = await packager({
  dir: stage,
  out,
  platform: "win32",
  arch: "x64",
  name: source.productName,
  appVersion: source.version,
  electronVersion: source.devDependencies.electron,
  asar: true,
  overwrite: true,
  prune: false,
  appCopyright: "Illustration Avatar Studio contributors",
  win32metadata: {
    CompanyName: "Illustration Avatar Studio",
    FileDescription: source.productName,
    ProductName: source.productName,
  },
});
const executable = path.join(target, `${source.productName}.exe`);
await flipFuses(executable, {
  version: FuseVersion.V1,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});
const release = path.join(root, "release");
await fs.mkdir(release, { recursive: true });
await fs.copyFile(
  path.join(root, "docs/BEGINNER_GUIDE.md"),
  path.join(target, "처음 시작하기.md"),
);
await fs.copyFile(
  path.join(root, "docs/OBS_GUIDE.md"),
  path.join(target, "OBS_GUIDE.md"),
);
await fs.writeFile(
  path.join(release, "BUILD-INFO.json"),
  JSON.stringify(
    {
      version: source.version,
      electron: source.devDependencies.electron,
      platform: "win32-x64",
      executableSha256: createHash("sha256")
        .update(await fs.readFile(executable))
        .digest("hex"),
      signed: false,
      userRuntimeRequired: false,
    },
    null,
    2,
  ),
);
if (process.platform === "win32") {
  const zip = path.join(
    release,
    `IllustrationAvatarStudio-${source.version}-win-x64.zip`,
  );
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -LiteralPath $env:AVATAR_PACKAGE_SOURCE -DestinationPath $env:AVATAR_PACKAGE_ZIP -Force",
    ],
    {
      env: {
        ...process.env,
        AVATAR_PACKAGE_SOURCE: target,
        AVATAR_PACKAGE_ZIP: zip,
      },
      windowsHide: true,
      encoding: "utf8",
    },
  );
  if (result.status !== 0)
    throw Error("ZIP 패키징에 실패했습니다. 실행 폴더는 dist에 보존됩니다.");
  await fs.writeFile(
    path.join(release, "SHA256SUMS.txt"),
    `${createHash("sha256")
      .update(await fs.readFile(zip))
      .digest("hex")}  ${path.basename(zip)}\n`,
  );
}
console.log(
  `Windows app ready: dist/${source.version}/${path.basename(target)}/${source.productName}.exe`,
);
console.log(
  "실행 폴더와 ZIP을 만들었습니다. 전달 전 verify:release를 실행하세요. exe만 복사하지 않습니다.",
);
