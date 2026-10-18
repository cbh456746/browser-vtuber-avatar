import { createHash } from "node:crypto";

// This is a visual-review gate, not a semantic mouth detector. Bind each
// attestation to the exact image so a later regeneration requires a new review.
export function reviewTemplate(files) {
  return {
    format: "closed-mouth-review-v1",
    frames: files
      .filter((file) => /^frames\/[AD]\//.test(file.name))
      .map((file) => ({
        frame: file.name,
        sha256: createHash("sha256").update(file.data).digest("hex"),
        visibleAt128: false,
        visibleAt256: false,
      })),
  };
}

export function checkClosedMouthReview(files, review) {
  const expected = reviewTemplate(files).frames;
  if (
    !review ||
    review.format !== "closed-mouth-review-v1" ||
    !Array.isArray(review.frames) ||
    review.frames.length !== 50 ||
    expected.length !== 50
  )
    return ["닫힌 입 검수: A·D 각 25개, 총 50개 기록이 필요합니다."];
  const records = new Map(review.frames.map((item) => [item?.frame, item]));
  if (records.size !== 50)
    return ["닫힌 입 검수: 중복 프레임 기록을 허용하지 않습니다."];
  const issues = [];
  for (const file of expected) {
    const record = records.get(file.frame);
    if (!record || record.sha256 !== file.sha256)
      issues.push(`${file.frame}: 현재 이미지와 검수 기록이 다릅니다.`);
    else if (record.visibleAt128 !== true || record.visibleAt256 !== true)
      issues.push(
        `${file.frame}: 128·256px에서 입선의 시각 검수가 필요합니다.`,
      );
  }
  return issues;
}
