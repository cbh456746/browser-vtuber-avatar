import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewTemplate,
  checkClosedMouthReview,
} from "../scripts/closed-mouth-review.mjs";

const files = Array.from("AD").flatMap((sheet) =>
  Array.from({ length: 25 }, (_, i) => ({
    name: `frames/${sheet}/r${Math.floor(i / 5)}c${i % 5}.png`,
    data: Buffer.from(`review-fixture-${sheet}-${i}`),
  })),
);
const reviewed = () => {
  const value = reviewTemplate(files);
  value.frames.forEach((frame) => {
    frame.visibleAt128 = true;
    frame.visibleAt256 = true;
  });
  return value;
};
test("closed-mouth review is mandatory and templates cannot self-approve", () => {
  assert.ok(checkClosedMouthReview(files).length);
  assert.equal(checkClosedMouthReview(files, reviewTemplate(files)).length, 50);
  assert.deepEqual(checkClosedMouthReview(files, reviewed()), []);
});
test("changed, missing, duplicate and substituted closed-mouth frames invalidate review", () => {
  const changed = files.map((file) => ({ ...file }));
  changed[0].data = Buffer.from("regenerated-image");
  assert.equal(checkClosedMouthReview(changed, reviewed()).length, 1);
  const missing = reviewed();
  missing.frames.pop();
  assert.ok(checkClosedMouthReview(files, missing).length);
  const duplicate = reviewed();
  duplicate.frames[0] = duplicate.frames[1];
  assert.ok(checkClosedMouthReview(files, duplicate).length);
  const substituted = reviewed();
  substituted.frames[0].frame = "frames/B/r0c0.png";
  assert.equal(checkClosedMouthReview(files, substituted).length, 1);
});
test("both actual display sizes need explicit visual review", () => {
  for (const field of ["visibleAt128", "visibleAt256"]) {
    const review = reviewed();
    review.frames[0][field] = "true";
    assert.equal(checkClosedMouthReview(files, review).length, 1);
  }
});
