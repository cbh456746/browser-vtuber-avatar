import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { inspectPack } from "../desktop/pack.mjs";
import {
  reviewTemplate,
  checkClosedMouthReview,
} from "./closed-mouth-review.mjs";
const selected = process.argv[2];
if (!selected)
  throw Error(
    "사용법: npm run avatar:check -- avatars/my-avatar/avatar.json [--mouth-review private/closed-mouth-review.json] [--qa-dir .local/qa]",
  );
const options = process.argv.slice(3),
  allowed = new Set(["--mouth-review", "--qa-dir"]),
  args = new Map();
for (let i = 0; i < options.length; i += 2) {
  if (!allowed.has(options[i]) || !options[i + 1] || args.has(options[i]))
    throw Error("검사 옵션을 확인하세요.");
  args.set(options[i], options[i + 1]);
}
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
const qa = path.resolve(args.get("--qa-dir") || ".local/qa");
await fs.mkdir(qa, { recursive: true });
await sharp({
  create: { width: 2400, height: 576, channels: 4, background: "#e8e4ef" },
})
  .composite(tiles)
  .png()
  .toFile(path.join(qa, "contact-sheet.png"));
// Render all 50 closed-mouth states at actual display sizes on two backgrounds.
// Full-frame contact sheets alone are too small to establish mouth visibility.
const closed = checked.files.filter((file) =>
  /^frames\/[AD]\//.test(file.name),
);
for (const size of [128, 256]) {
  for (const background of ["#eeeeee", "#25212c"]) {
    const composites = await Promise.all(
      closed.map(async (file, index) => ({
        input: await sharp(file.data).resize(size, size).png().toBuffer(),
        left: (index % 5) * size,
        top: Math.floor(index / 5) * size,
      })),
    );
    await sharp({
      create: { width: size * 5, height: size * 10, channels: 4, background },
    })
      .composite(composites)
      .png()
      .toFile(
        path.join(
          qa,
          `closed-mouth-${size}-${background === "#eeeeee" ? "light" : "dark"}.png`,
        ),
      );
  }
}
await fs.writeFile(
  path.join(qa, "closed-mouth-review.template.json"),
  JSON.stringify(reviewTemplate(checked.files), null, 2),
);
let review;
if (args.has("--mouth-review")) {
  const filename = args.get("--mouth-review");
  if ((await fs.stat(filename)).size > 65536)
    throw Error("검수 기록 크기 제한 초과");
  review = JSON.parse(await fs.readFile(filename, "utf8"));
}
const mouthIssues = checkClosedMouthReview(checked.files, review);
issues.push(...mouthIssues);
await fs.writeFile(
  path.join(qa, "avatar-check.json"),
  JSON.stringify(
    {
      frames: 150,
      unique: unique.size,
      closedMouthReviewed: mouthIssues.length ? 0 : 50,
      issues,
      visualReviewRequired: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    frames: 150,
    unique: unique.size,
    closedMouthReviewed: mouthIssues.length ? 0 : 50,
    issues,
    contactSheet: path.join(qa, "contact-sheet.png"),
    visualReviewRequired: true,
  }),
);
if (issues.length) process.exitCode = 1;
