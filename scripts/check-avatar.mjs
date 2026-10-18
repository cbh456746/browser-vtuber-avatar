import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { inspectPack } from "../desktop/pack.mjs";
const selected = process.argv[2];
if (!selected)
  throw Error("사용법: npm run avatar:check -- avatars/my-avatar/avatar.json");
const checked = await inspectPack(selected),
  unique = new Set(),
  issues = [],
  tiles = [];
for (const file of checked.files) {
  const image = sharp(file.data, { limitInputPixels: 1048576 }),
    meta = await image.metadata();
  if (!meta.hasAlpha) issues.push(`${file.name}: 알파 채널 없음`);
  if (meta.exif || meta.xmp || meta.iptc)
    issues.push(`${file.name}: 원본 메타데이터 포함`);
  const pixels = await image.ensureAlpha().raw().toBuffer();
  let clear = 0,
    solid = 0,
    borderSolid = 0,
    border = 0;
  const size = checked.info.frameSize;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const alpha = pixels[(y * size + x) * 4 + 3];
      if (alpha < 10) clear++;
      else solid++;
      if (x < 4 || y < 4 || x >= size - 4 || y >= size - 4) {
        border++;
        if (alpha > 32) borderSolid++;
      }
    }
  if (clear < size * size * 0.05 || solid < size * size * 0.03)
    issues.push(`${file.name}: 투명 여백 또는 캐릭터 영역 부족`);
  if (borderSolid / border > 0.05) issues.push(`${file.name}: 경계 잘림 의심`);
  unique.add(createHash("sha256").update(pixels).digest("hex"));
  tiles.push({
    input: await sharp(file.data).resize(96, 96).png().toBuffer(),
    left: (tiles.length % 25) * 96,
    top: Math.floor(tiles.length / 25) * 96,
  });
}
if (unique.size < 140)
  issues.push("동일 프레임 반복: 방향·표정 차이를 다시 검수하세요.");
const qa = path.resolve(".local/qa");
await fs.mkdir(qa, { recursive: true });
await sharp({
  create: { width: 2400, height: 576, channels: 4, background: "#e8e4ef" },
})
  .composite(tiles)
  .png()
  .toFile(path.join(qa, "contact-sheet.png"));
await fs.writeFile(
  path.join(qa, "avatar-check.json"),
  JSON.stringify(
    { frames: 150, unique: unique.size, issues, visualReviewRequired: true },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    frames: 150,
    unique: unique.size,
    issues,
    contactSheet: ".local/qa/contact-sheet.png",
    visualReviewRequired: true,
  }),
);
if (issues.length) process.exitCode = 1;
