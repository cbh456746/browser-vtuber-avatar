import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { frameNames, inspectPack, manifest } from "../desktop/pack.mjs";
const [sourceArg, slug, name = "My avatar"] = process.argv.slice(2);
if (!sourceArg || !slug || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))
  throw Error(
    '사용법: node scripts/import-legacy.mjs 기존-slices2-폴더 새이름 "캐릭터 이름"',
  );
const source = await fs.realpath(sourceArg),
  avatars = path.resolve("avatars");
await fs.mkdir(avatars, { recursive: true });
if ((await fs.realpath(avatars)) !== avatars)
  throw Error("심볼릭 링크 출력 폴더를 허용하지 않습니다.");
const target = path.join(avatars, slug);
await fs.mkdir(target);
try {
  for (const name of frameNames("png")) {
    const relative = name.replace(/^frames\//, "").replace(/\.png$/, ".webp"),
      input = path.join(source, relative),
      stat = await fs.lstat(input);
    if (stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
      throw Error("기존 프레임의 형식과 크기를 확인하세요.");
    const data = await fs.readFile(input);
    if (
      data.toString("ascii", 0, 4) !== "RIFF" ||
      data.toString("ascii", 8, 12) !== "WEBP"
    )
      throw Error("기존 WebP 프레임이 필요합니다.");
    await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
    await sharp(data, { limitInputPixels: 16000000 })
      .resize(512, 512, { fit: "contain", background: "#00000000" })
      .png()
      .toFile(path.join(target, name));
  }
  const info = manifest({
    format: "illustration-avatar-pack-v1",
    name,
    frameSize: 512,
    imageFormat: "png",
  });
  await fs.writeFile(
    path.join(target, "avatar.json"),
    JSON.stringify(info, null, 2),
  );
  await inspectPack(path.join(target, "avatar.json"));
  console.log(`Private character prepared: avatars/${slug}/avatar.json`);
} catch (error) {
  await fs.rm(target, { recursive: true, force: true });
  throw error;
}
