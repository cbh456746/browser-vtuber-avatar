import { localVtsUrl } from "./policy.mjs";
export const PARAMETERS = [
  "FaceAngleX",
  "FaceAngleY",
  "EyeOpenLeft",
  "EyeOpenRight",
  "MouthOpen",
];
export class VtsClient {
  constructor({
    WebSocketImpl = globalThis.WebSocket,
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
    this.connect();
  }
  status(text) {
    this.onStatus(text);
  }
  clear() {
    clearTimeout(this.timeout);
    clearInterval(this.poll);
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
    this.tokenRequested = false;
    this.status("VTube Studio에 연결 중");
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    this.count = 0;
    this.window = Date.now();
    this.timeout = setTimeout(() => socket.close(), 8000);
    socket.onopen = () => {
      if (this.socket !== socket) return;
      clearTimeout(this.timeout);
      const token = this.getToken();
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
        this.saveToken(this.pendingToken);
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
      ["auth", "token"].includes(msg.requestID)
    ) {
      this.running = false;
      this.clear();
      this.socket?.close();
      this.forgetToken();
      this.status("인증이 거부됐습니다. 설정을 확인한 뒤 다시 연결하세요.");
    }
  }
}
