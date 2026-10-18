import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { within } from "../desktop/policy.mjs";
import { inspectPack, manifest } from "../desktop/pack.mjs";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
  [inputArg, outputArg, name = "My avatar"] = process.argv.slice(2);
if (!inputArg || !outputArg)
  throw Error(
    '사용법: npm run avatar:build -- private/sheets avatars/my-avatar "캐릭터 이름"',
  );
const input = await fs.realpath(path.resolve(root, inputArg)),
  output = path.resolve(root, outputArg),
  avatars = path.join(root, "avatars");
if (
  !within(root, input) ||
  path.dirname(output) !== avatars ||
  !/^[a-z0-9][a-z0-9-]{0,63}$/.test(path.basename(output))
)
  throw Error(
    "입력은 작업 폴더 안, 출력은 avatars 바로 아래 영문·숫자·하이픈 이름의 새 폴더여야 합니다.",
  );
await fs.mkdir(avatars, { recursive: true });
if ((await fs.realpath(avatars)) !== avatars)
  throw Error("출력 폴더의 심볼릭 링크를 허용하지 않습니다.");
const info = manifest({
  format: "illustration-avatar-pack-v1",
  name,
  frameSize: 512,
  imageFormat: "png",
});
await fs.mkdir(output); // Never overwrite an existing character.
try {
  for (const sheet of "ABCDEF") {
    const file = path.join(input, `${sheet}.png`),
      stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024)
      throw Error("시트는 20MiB 이하의 일반 PNG 파일이어야 합니다.");
    const raw = await fs.readFile(file);
    if (raw.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw Error("PNG 시트만 지원합니다.");
    const image = sharp(raw, { limitInputPixels: 40000000 }),
      meta = await image.metadata();
    if (
      !meta.hasAlpha ||
      meta.width < 1000 ||
      meta.height < 1000 ||
      Math.abs(meta.width - meta.height) > 1
    )
      throw Error("투명 배경의 정사각형 5×5 시트가 필요합니다.");
    await fs.mkdir(path.join(output, "frames", sheet), { recursive: true });
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 5; col++) {
        const left = Math.floor((col * meta.width) / 5),
          top = Math.floor((row * meta.height) / 5),
          width = Math.floor(((col + 1) * meta.width) / 5) - left,
          height = Math.floor(((row + 1) * meta.height) / 5) - top;
        await sharp(raw, { limitInputPixels: 40000000 })
          .extract({ left, top, width, height })
          .resize(512, 512, { fit: "contain", background: "#00000000" })
          .png()
          .toFile(path.join(output, "frames", sheet, `r${row}c${col}.png`));
      }
  }
  await fs.writeFile(
    path.join(output, "avatar.json"),
    JSON.stringify(info, null, 2) + "\n",
  );
  await inspectPack(path.join(output, "avatar.json"));
  console.log(
    "150개 프레임 생성 완료. avatar:check와 시각 검수 후 앱에서 불러오세요.",
  );
} catch (error) {
  await fs.rm(output, { recursive: true, force: true });
  throw error;
}
