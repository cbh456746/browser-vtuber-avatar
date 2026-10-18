import { frameUrl } from "./pose.js";
import { stageRenderer } from "./mascot.js";
const api = window.avatarStudio,
  $ = (id) => document.getElementById(id),
  render = stageRenderer($("preview"));
let current,
  stream,
  context,
  analyser,
  buffer,
  timer,
  lastMic = 0;
function notify(text) {
  $("notice").textContent = text;
}
async function run(action) {
  try {
    return await action();
  } catch (error) {
    notify(
      /^[가-힣]/.test(error.message)
        ? error.message.slice(0, 180)
        : "작업을 완료하지 못했습니다. 파일 형식·권한·장치 연결을 확인해 주세요.",
    );
    return false;
  }
}
function update(state) {
  current = state;
  render({ ...state, frameUrl: state.avatar.id ? frameUrl(state) : null });
  $("avatar-name").textContent = state.avatar.name;
  $("status").textContent = state.status;
  $("mode-badge").textContent = {
    manual: "수동 미리보기",
    mic: "마이크 입력",
    vts: "얼굴 추적",
  }[state.mode];
  $("mode").value = state.mode;
  $("vts-options").hidden = state.mode !== "vts";
  $("mic-options").hidden = state.mode !== "mic";
  $("mirror").checked = state.settings.mirror;
  $("background").value = state.settings.background;
  $("character-size").value = state.settings.size;
  if (document.activeElement !== $("vts-port"))
    $("vts-port").value = state.settings.port;
  if (state.mode !== "mic") stopMic();
}
function manualPose() {
  if (current?.mode === "vts") return;
  run(() =>
    api.pose({
      x: Number($("pose-x").value),
      y: Number($("pose-y").value),
      mouth: current?.mode === "mic" ? lastMic : Number($("pose-mouth").value),
      eyes: $("pose-eyes").checked,
    }),
  );
}
function stopMic() {
  clearInterval(timer);
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  context?.close().catch(() => {});
  context = null;
  lastMic = 0;
}
async function startMic() {
  stopMic();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    context = new AudioContext();
    await context.resume();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    buffer = new Float32Array(analyser.fftSize);
    context.createMediaStreamSource(stream).connect(analyser);
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      const rms = Math.sqrt(
          buffer.reduce((sum, n) => sum + n * n, 0) / buffer.length,
        ),
        threshold = Number($("sensitivity").value);
      lastMic =
        rms > threshold
          ? Math.min(1, (rms - threshold) / Math.max(threshold, 0.02) + 0.2)
          : 0;
      manualPose();
    }, 40);
    notify("마이크 입력 중 · 녹음과 외부 전송 없음");
  } catch {
    stopMic();
    notify("마이크 권한 또는 장치를 확인해 주세요.");
    await api.mode("manual");
  }
}
api.subscribe(update);
run(async () => update(await api.state()));
for (const id of ["pose-x", "pose-y", "pose-mouth", "pose-eyes"])
  $(id).addEventListener("input", manualPose);
$("choose-avatar").addEventListener("click", () =>
  run(async () => {
    notify("캐릭터를 검사하고 있습니다.");
    const loaded = await api.chooseAvatar();
    notify(loaded ? "캐릭터를 불러왔습니다." : "선택을 취소했습니다.");
  }),
);
$("sample").addEventListener("click", () => run(() => api.sample()));
$("mode").addEventListener("change", () =>
  run(async () => {
    const mode = $("mode").value;
    stopMic();
    const accepted = await api.mode(mode);
    if (!accepted) {
      update(await api.state());
      return;
    }
    if (mode === "mic") await startMic();
  }),
);
$("mirror").addEventListener("change", () =>
  run(() => api.settings({ mirror: $("mirror").checked })),
);
$("background").addEventListener("change", () =>
  run(() => api.settings({ background: $("background").value })),
);
$("character-size").addEventListener("input", () =>
  run(() => api.settings({ size: Number($("character-size").value) })),
);
$("vts-port").addEventListener("change", () =>
  run(() => api.settings({ port: Number($("vts-port").value) })),
);
$("connect").addEventListener("click", () =>
  run(async () => {
    await api.settings({ port: Number($("vts-port").value) });
    await api.connect();
  }),
);
$("disconnect").addEventListener("click", () => run(() => api.disconnect()));
$("forget").addEventListener("click", () => run(() => api.forget()));
$("output-open").addEventListener("click", () => run(() => api.openOutput()));
$("output-close").addEventListener("click", () => run(() => api.closeOutput()));
$("help-open").addEventListener("click", () => $("help").showModal());
$("help-close").addEventListener("click", () => $("help").close());
window.addEventListener("beforeunload", stopMic);
