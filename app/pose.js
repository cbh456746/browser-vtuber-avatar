export function frameFor(pose, mirror = false) {
  const x = (mirror ? -1 : 1) * Math.max(-1, Math.min(1, pose.x)),
    y = Math.max(-1, Math.min(1, pose.y));
  return {
    sheet: "ABCDEF"[
      (pose.eyes ? 3 : 0) + (pose.mouth > 0.45 ? 2 : pose.mouth > 0.14 ? 1 : 0)
    ],
    row: Math.round((y + 1) * 2),
    col: Math.round((x + 1) * 2),
  };
}
export function frameUrl(state) {
  const f = frameFor(state.pose, state.settings.mirror);
  return `avatar://app/packs/${state.avatar.id}/frames/${f.sheet}/r${f.row}c${f.col}.${state.avatar.imageFormat}`;
}
