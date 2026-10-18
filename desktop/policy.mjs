import path from "node:path";
export const ORIGIN = "avatar://app";
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' avatar:; connect-src 'none'; media-src 'none'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
export const WEB_PREFERENCES = Object.freeze({
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: false,
  navigateOnDragDrop: false,
});
export function trustedFrame(event, control, channel) {
  const frame = event.senderFrame;
  if (
    !frame ||
    frame.parent ||
    event.sender !== control?.webContents ||
    frame.url !== "avatar://app/index.html"
  )
    throw Error("허용되지 않은 요청입니다.");
  if (typeof channel !== "string") throw Error("허용되지 않은 요청입니다.");
}
export function assetRoute(raw) {
  if (
    typeof raw !== "string" ||
    raw.length > 512 ||
    /%(?:2e|2f|5c|00)/i.test(raw) ||
    /[\\\u0000]/.test(raw)
  )
    throw Error("잘못된 자료 주소입니다.");
  const url = new URL(raw);
  if (
    url.protocol !== "avatar:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    throw Error("허용되지 않은 주소입니다.");
  const name = decodeURIComponent(url.pathname).replace(/^\//, "");
  if (
    url.host === "app" &&
    [
      "index.html",
      "output.html",
      "app.js",
      "output.js",
      "styles.css",
      "pose.js",
      "mascot.js",
    ].includes(name)
  )
    return { kind: "app", name };
  const match = name.match(
    /^packs\/([a-f0-9]{64})\/(frames\/[A-F]\/r[0-4]c[0-4]\.(?:png|webp))$/,
  );
  if (url.host === "app" && match)
    return { kind: "pack", id: match[1], name: match[2] };
  throw Error("허용되지 않은 자료입니다.");
}
export function localVtsUrl(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("포트는 1024~65535 사이의 정수여야 합니다.");
  return `ws://127.0.0.1:${port}`;
}
export function settings(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype)
    throw Error("잘못된 설정입니다.");
  const allowed = ["background", "mirror", "size", "port"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw Error("알 수 없는 설정입니다.");
  const out = {};
  if ("background" in input) {
    if (!["green", "magenta", "transparent"].includes(input.background))
      throw Error("배경을 확인하세요.");
    out.background = input.background;
  }
  if ("mirror" in input) {
    if (typeof input.mirror !== "boolean")
      throw Error("방향 설정을 확인하세요.");
    out.mirror = input.mirror;
  }
  if ("size" in input) {
    if (!Number.isInteger(input.size) || input.size < 40 || input.size > 100)
      throw Error("크기를 확인하세요.");
    out.size = input.size;
  }
  if ("port" in input) {
    localVtsUrl(input.port);
    out.port = input.port;
  }
  return out;
}
export function pose(input) {
  if (!input || Object.keys(input).sort().join(",") !== "eyes,mouth,x,y")
    throw Error("잘못된 움직임입니다.");
  for (const key of ["x", "y", "mouth"])
    if (typeof input[key] !== "number" || !Number.isFinite(input[key]))
      throw Error("움직임 값을 확인하세요.");
  if (typeof input.eyes !== "boolean") throw Error("눈 상태를 확인하세요.");
  return {
    x: Math.max(-1, Math.min(1, input.x)),
    y: Math.max(-1, Math.min(1, input.y)),
    mouth: Math.max(0, Math.min(1, input.mouth)),
    eyes: input.eyes,
  };
}
export function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
