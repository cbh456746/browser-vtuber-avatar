import { localVtsUrl } from "./policy.mjs";
import { createRequire } from "node:module";
// Load the audited JS transport without optional native-addon lookup outside ASAR.
process.env.WS_NO_BUFFER_UTIL = "1";
process.env.WS_NO_UTF_8_VALIDATE = "1";
const { WebSocket } = createRequire(import.meta.url)("ws");
export const PARAMETERS = [
  "FaceAngleX",
  "FaceAngleY",
  "EyeOpenLeft",
  "EyeOpenRight",
  "MouthOpen",
];
export class VtsClient {
  constructor({
    WebSocketImpl = WebSocket,
    onStatus = () => {},
    onPose = () => {},
    getToken = () => "",
    saveToken = () => {},
    forgetToken = () => {},
    retryBase = 1000,
  } = {}) {
    Object.assign(this, {
      WebSocketImpl,
      onStatus,
      onPose,
      getToken,
      saveToken,
      forgetToken,
      retryBase,
    });
    this.running = false;
    this.values = {
      FaceAngleX: 0,
      FaceAngleY: 0,
      EyeOpenLeft: 1,
      EyeOpenRight: 1,
      MouthOpen: 0,
    };
  }
  start(port = 8001) {
    const url = localVtsUrl(port);
    this.stop();
    this.url = url;
    this.running = true;
    this.attempt = 0;
    this.tokenRequested = false;
    this.pendingToken = null;
    this.sessionToken = this.getToken();
    this.connect();
  }
  status(text) {
    this.onStatus(text);
  }
  clear() {
    clearTimeout(this.timeout);
    clearInterval(this.poll);
    clearInterval(this.facePoll);
    clearTimeout(this.reconnect);
  }
  stop() {
    this.running = false;
    this.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.status("연결 안 됨");
  }
  connect() {
    if (!this.running) return;
    this.clear();
    this.phase = "connecting";
    this.status("VTube Studio에 연결 중");
    const socket = new this.WebSocketImpl(this.url, {
      perMessageDeflate: false,
      maxPayload: 65536,
      followRedirects: false,
      handshakeTimeout: 8000,
    });
    this.socket = socket;
    this.count = 0;
    this.window = Date.now();
    this.timeout = setTimeout(() => socket.close(), 8000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.timeout);
      const token = this.pendingToken || this.sessionToken;
      if (token) this.authenticate(token);
      else this.requestToken();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket || !this.running) return;
      try {
        this.receive(event.data);
      } catch {
        this.status("안전하지 않은 응답을 차단했습니다.");
        socket.close();
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.clear();
      this.socket = null;
      if (!this.running) return;
      if (this.phase === "token") {
        this.running = false;
        this.status(
          "승인 중 연결이 끊겼습니다. 확인 후 연결 버튼을 다시 눌러 주세요.",
        );
        return;
      }
      this.status("추적 연결이 끊겼습니다. 다시 연결합니다.");
      const delay = Math.min(
        30000,
        this.retryBase * 2 ** Math.min(this.attempt++, 5),
      );
      this.reconnect = setTimeout(() => this.connect(), delay);
    };
  }
  send(type, id, data) {
    if (this.socket?.readyState === 1)
      this.socket.send(
        JSON.stringify({
          apiName: "VTubeStudioPublicAPI",
          apiVersion: "1.0",
          requestID: id,
          messageType: type,
          data,
        }),
      );
  }
  arm() {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      this.running = false;
      this.socket?.close();
      this.status(
        "VTube Studio 승인이 필요합니다. 연결 버튼을 다시 눌러 주세요.",
      );
    }, 30000);
  }
  requestToken() {
    if (this.tokenRequested) {
      this.running = false;
      this.clear();
      this.socket?.close();
      this.status("인증이 거부됐습니다. VTube Studio 설정을 확인하세요.");
      return;
    }
    this.tokenRequested = true;
    this.sessionToken = "";
    this.pendingToken = null;
    this.forgetToken();
    this.phase = "token";
    this.send("AuthenticationTokenRequest", "token", {
      pluginName: "Illustration Avatar Studio",
      pluginDeveloper: "Illustration Avatar Studio",
    });
    this.status("VTube Studio의 플러그인 승인 창에서 허용해 주세요.");
    this.arm();
  }
  authenticate(token) {
    if (typeof token !== "string" || token.length < 1 || token.length > 4096)
      throw Error("잘못된 토큰");
    this.phase = "auth";
    this.send("AuthenticationRequest", "auth", {
      pluginName: "Illustration Avatar Studio",
      pluginDeveloper: "Illustration Avatar Studio",
      authenticationToken: token,
    });
    this.arm();
  }
  receive(raw) {
    if (typeof raw !== "string" || raw.length > 65536) throw Error("응답 크기");
    if (Date.now() - this.window > 1000) {
      this.window = Date.now();
      this.count = 0;
    }
    if (++this.count > 220) throw Error("과도한 응답");
    // Some VTS versions send empty text messages between JSON responses.
    // Count them toward the rate limit, but do not treat them as authentication failure.
    if (raw.trim() === "") return;
    const msg = JSON.parse(raw);
    if (
      !msg ||
      msg.apiName !== "VTubeStudioPublicAPI" ||
      msg.apiVersion !== "1.0"
    )
      throw Error("프로토콜");
    if (
      msg.messageType === "AuthenticationTokenResponse" &&
      msg.requestID === "token" &&
      this.phase === "token"
    ) {
      this.pendingToken = msg.data?.authenticationToken;
      this.authenticate(this.pendingToken);
    } else if (
      msg.messageType === "AuthenticationResponse" &&
      msg.requestID === "auth" &&
      this.phase === "auth"
    ) {
      if (msg.data?.authenticated !== true) {
        this.requestToken();
        return;
      }
      clearTimeout(this.timeout);
      if (this.pendingToken) {
        this.sessionToken = this.pendingToken;
        try {
          this.saveToken(this.pendingToken);
        } catch {
          // OS storage failure must not discard an already approved session.
          // Retain the token in main-process memory only.
        }
        this.pendingToken = null;
      }
      this.phase = "tracking";
      this.attempt = 0;
      this.status("얼굴 추적 연결됨");
      const poll = () =>
        PARAMETERS.forEach((name) =>
          this.send("ParameterValueRequest", name, { name }),
        );
      poll();
      this.poll = setInterval(poll, 50);
      const checkFace = () => this.send("FaceFoundRequest", "face", {});
      checkFace();
      this.facePoll = setInterval(checkFace, 1000);
    } else if (
      msg.messageType === "FaceFoundResponse" &&
      msg.requestID === "face" &&
      this.phase === "tracking"
    ) {
      if (typeof msg.data?.found !== "boolean") throw Error("얼굴 감지 값");
      this.status(
        msg.data.found
          ? "얼굴 추적 연결됨"
          : "VTS 연결됨 · 얼굴 미감지: VTS의 카메라·휴대폰 추적을 확인해 주세요.",
      );
    } else if (
      msg.messageType === "ParameterValueResponse" &&
      this.phase === "tracking" &&
      PARAMETERS.includes(msg.requestID) &&
      msg.data?.name === msg.requestID
    ) {
      const { name, value } = msg.data;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        Math.abs(value) > 10000
      )
        throw Error("추적 값");
      this.values[name] = value;
      const p = this.values;
      this.onPose({
        x: Math.max(-1, Math.min(1, p.FaceAngleX / 30)),
        y: Math.max(-1, Math.min(1, -p.FaceAngleY / 30)),
        eyes: (p.EyeOpenLeft + p.EyeOpenRight) / 2 < 0.2,
        mouth: Math.max(0, Math.min(1, p.MouthOpen)),
      });
    } else if (
      msg.messageType === "APIError" &&
      (["auth", "token"].includes(msg.requestID) ||
        (this.phase === "tracking" && PARAMETERS.includes(msg.requestID)))
    ) {
      this.running = false;
      this.clear();
      this.socket?.close();
      if (
        ["auth", "token"].includes(msg.requestID) ||
        [8, 50].includes(msg.data?.errorID)
      ) {
        this.sessionToken = "";
        this.pendingToken = null;
        this.forgetToken();
        this.status("인증이 거부됐습니다. 설정을 확인한 뒤 다시 연결하세요.");
      } else {
        const code = Number.isInteger(msg.data?.errorID)
          ? msg.data.errorID
          : "알 수 없음";
        this.status(
          `VTube Studio 추적 응답 오류 (${code}). 설정을 확인한 뒤 다시 연결하세요.`,
        );
      }
    }
  }
}
