import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { within } from "./policy.mjs";
export const MAX_FRAME = 2 * 1024 * 1024,
  MAX_TOTAL = 192 * 1024 * 1024;
export const frameNames = (extension) =>
  Array.from("ABCDEF").flatMap((sheet) =>
    Array.from(
      { length: 25 },
      (_, i) => `frames/${sheet}/r${Math.floor(i / 5)}c${i % 5}.${extension}`,
    ),
  );
export function manifest(value) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "format,frameSize,imageFormat,name"
  )
    throw Error("허용되지 않은 캐릭터 정보입니다.");
  if (
    value.format !== "illustration-avatar-pack-v1" ||
    typeof value.name !== "string" ||
    value.name.length < 1 ||
    value.name.length > 40 ||
    /[\u0000-\u001f\u007f<>]/.test(value.name)
  )
    throw Error("캐릭터 이름과 형식을 확인하세요.");
  if (
    ![256, 512, 768, 1024].includes(value.frameSize) ||
    !["png", "webp"].includes(value.imageFormat)
  )
    throw Error("프레임 규격을 확인하세요.");
  return { ...value };
}
function imageSize(data, extension) {
  if (extension === "png") {
    if (
      data.length < 33 ||
      data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      data.toString("ascii", 12, 16) !== "IHDR"
    )
      throw Error("PNG 파일이 아닙니다.");
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }
  if (
    data.length < 30 ||
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WEBP"
  )
    throw Error("WebP 파일이 아닙니다.");
  if (data.readUInt32LE(4) + 8 !== data.length)
    throw Error("WebP 크기가 맞지 않습니다.");
  const type = data.toString("ascii", 12, 16);
  if (type === "VP8X")
    return [1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3)];
  if (type === "VP8 " && data.toString("hex", 23, 26) === "9d012a")
    return [data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff];
  if (type === "VP8L" && data[20] === 47) {
    const bits = data.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  throw Error("지원하지 않는 WebP 헤더입니다.");
}
async function safeRead(root, relative, limit) {
  const candidate = path.resolve(root, relative),
    resolved = await fs.realpath(candidate);
  if (!within(root, resolved))
    throw Error("캐릭터 폴더 밖의 파일은 읽지 않습니다.");
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink())
      throw Error("바로가기·심볼릭 링크를 허용하지 않습니다.");
  }
  const handle = await fs.open(candidate, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > limit)
      throw Error("파일 크기 제한을 초과했습니다.");
    const data = await handle.readFile();
    if (data.length > limit) throw Error("파일 크기가 변경됐습니다.");
    return data;
  } finally {
    await handle.close();
  }
}
export async function inspectPack(input) {
  const selected = path.resolve(input);
  if (path.basename(selected) !== "avatar.json")
    throw Error("캐릭터 폴더의 avatar.json을 선택하세요.");
  if ((await fs.lstat(path.dirname(selected))).isSymbolicLink())
    throw Error("심볼릭 링크 폴더는 허용하지 않습니다.");
  const root = await fs.realpath(path.dirname(selected));
  const raw = await safeRead(root, "avatar.json", 4096),
    info = manifest(JSON.parse(raw.toString("utf8")));
  const entries = await fs.readdir(root);
  if (entries.some((name) => !["avatar.json", "frames"].includes(name)))
    throw Error("캐릭터팩에는 avatar.json과 frames 폴더만 넣으세요.");
  for (const relative of ["frames", ..."ABCDEF"].map((value, index) =>
    index === 0 ? value : `frames/${value}`,
  )) {
    const folder = path.join(root, relative),
      stat = await fs.lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      !within(root, await fs.realpath(folder))
    )
      throw Error("캐릭터팩의 연결 폴더를 허용하지 않습니다.");
  }
  const sheets = await fs.readdir(path.join(root, "frames"));
  if (sheets.sort().join("") !== "ABCDEF")
    throw Error("표정 폴더 A~F 여섯 개가 필요합니다.");
  const hash = createHash("sha256").update(JSON.stringify(info)),
    files = [];
  let total = 0;
  for (const sheet of "ABCDEF") {
    const actual = (await fs.readdir(path.join(root, "frames", sheet))).sort();
    const expected = frameNames(info.imageFormat)
      .filter((name) => name.split("/")[1] === sheet)
      .map((name) => path.basename(name))
      .sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error("각 표정에 정확히 25개 프레임이 필요합니다.");
  }
  for (const name of frameNames(info.imageFormat)) {
    const data = await safeRead(root, name, MAX_FRAME);
    total += data.length;
    if (total > MAX_TOTAL) throw Error("캐릭터팩 용량 제한을 초과했습니다.");
    const size = imageSize(data, info.imageFormat);
    if (size.some((value) => value !== info.frameSize))
      throw Error("모든 프레임은 동일한 정사각형 규격이어야 합니다.");
    hash.update(name).update(data);
    files.push({ name, data });
  }
  return { info, files, total, id: hash.digest("hex") };
}
export async function installPack(input, packsRoot) {
  const checked = await inspectPack(input),
    target = path.join(packsRoot, checked.id);
  await fs.mkdir(packsRoot, { recursive: true });
  try {
    await fs.mkdir(target);
  } catch (error) {
    if (error.code === "EEXIST") {
      if ((await fs.lstat(target)).isSymbolicLink())
        throw Error("연결된 캐릭터 저장 폴더를 허용하지 않습니다.");
      const cached = await inspectPack(path.join(target, "avatar.json"));
      if (cached.id !== checked.id)
        throw Error("저장된 캐릭터 무결성을 확인할 수 없습니다.");
      return { id: checked.id, ...checked.info };
    }
    throw error;
  }
  try {
    for (const file of checked.files) {
      await fs.mkdir(path.dirname(path.join(target, file.name)), {
        recursive: true,
      });
      await fs.writeFile(path.join(target, file.name), file.data, {
        flag: "wx",
      });
    }
    await fs.writeFile(
      path.join(target, "avatar.json"),
      JSON.stringify(checked.info),
      { flag: "wx" },
    );
  } catch (error) {
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return { id: checked.id, ...checked.info };
}
