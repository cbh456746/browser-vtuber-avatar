// Original code-native mascot; no third-party or personal illustration pixels.
const NS = "http://www.w3.org/2000/svg";
function node(tag, attributes, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes))
    el.setAttribute(key, String(value));
  parent?.append(el);
  return el;
}
export function mascot() {
  const svg = node("svg", {
    viewBox: "0 0 512 512",
    role: "img",
    "aria-label": "기본 샘플 Orbit",
  });
  node(
    "ellipse",
    { cx: 256, cy: 454, rx: 124, ry: 14, fill: "#19213b", opacity: 0.12 },
    svg,
  );
  node(
    "path",
    {
      d: "M174 343 Q130 375 151 410 M338 343 Q382 374 361 410",
      fill: "none",
      stroke: "#5b4f85",
      "stroke-width": 24,
      "stroke-linecap": "round",
    },
    svg,
  );
  node(
    "rect",
    {
      x: 166,
      y: 290,
      width: 180,
      height: 139,
      rx: 63,
      fill: "#aea1df",
      stroke: "#4b426c",
      "stroke-width": 7,
    },
    svg,
  );
  node(
    "rect",
    { x: 190, y: 407, width: 41, height: 41, rx: 18, fill: "#5b4f85" },
    svg,
  );
  node(
    "rect",
    { x: 281, y: 407, width: 41, height: 41, rx: 18, fill: "#5b4f85" },
    svg,
  );
  node("circle", { cx: 256, cy: 355, r: 27, fill: "#f2edff" }, svg);
  node(
    "path",
    {
      d: "M256 338 L261 350 L274 355 L261 360 L256 373 L251 360 L238 355 L251 350 Z",
      fill: "#8c76c5",
    },
    svg,
  );
  const head = node("g", {}, svg);
  node(
    "path",
    {
      d: "M256 112 L256 79",
      stroke: "#4b426c",
      "stroke-width": 9,
      "stroke-linecap": "round",
    },
    head,
  );
  node(
    "circle",
    {
      cx: 256,
      cy: 73,
      r: 17,
      fill: "#bde7dd",
      stroke: "#4b426c",
      "stroke-width": 6,
    },
    head,
  );
  node(
    "rect",
    {
      x: 107,
      y: 132,
      width: 298,
      height: 177,
      rx: 73,
      fill: "#f4efff",
      stroke: "#4b426c",
      "stroke-width": 7,
    },
    head,
  );
  node(
    "rect",
    { x: 132, y: 157, width: 248, height: 124, rx: 45, fill: "#38364e" },
    head,
  );
  const eyes = [185, 327].map((cx) =>
    node("ellipse", { cx, cy: 210, rx: 13, ry: 20, fill: "#bde7dd" }, head),
  );
  const mouth = node(
    "ellipse",
    { cx: 256, cy: 248, rx: 13, ry: 4, fill: "#bde7dd" },
    head,
  );
  return {
    element: svg,
    update(pose, mirror) {
      const x = pose.x * (mirror ? -1 : 1),
        y = pose.y;
      head.setAttribute(
        "transform",
        `translate(${x * 15} ${y * 8}) rotate(${x * 5} 256 230)`,
      );
      for (const eye of eyes) eye.setAttribute("ry", pose.eyes ? "3" : "20");
      mouth.setAttribute("ry", String(3 + pose.mouth * 16));
    },
  };
}
export function stageRenderer(container) {
  const fallback = mascot();
  const image = document.createElement("img");
  image.alt = "캐릭터";
  image.draggable = false;
  image.className = "avatar-frame";
  container.append(fallback.element, image);
  let previous = "",
    failed = false;
  image.onerror = () => {
    failed = true;
    image.hidden = true;
    fallback.element.style.display = "";
    container.dataset.error = "프레임을 읽을 수 없습니다.";
  };
  return (state) => {
    container.style.setProperty("--character-size", `${state.settings.size}%`);
    if (!state.avatar.id) {
      previous = "";
      image.hidden = true;
      fallback.element.style.display = "";
      fallback.update(state.pose, state.settings.mirror);
    } else {
      fallback.element.style.display = "none";
      image.hidden = failed;
      const url = state.frameUrl;
      if (url !== previous) {
        previous = url;
        failed = false;
        image.hidden = false;
        image.src = url;
      }
    }
  };
}
