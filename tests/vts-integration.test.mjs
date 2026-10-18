import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { VtsClient, PARAMETERS, HEAD_TRACKING_GAIN } from "../desktop/vts.mjs";
const timeout = (ms) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(Error("timed out")), ms).unref(),
  );
test("head tracking permanently uses 85% gain without changing eyes or mouth", () => {
  assert.equal(HEAD_TRACKING_GAIN, 0.85);
  for (const angle of [0, 15, -15, 30, -30, 90, -90]) {
    let pose;
    const client = new VtsClient({
      onPose: (value) => {
        pose = value;
      },
    });
    client.phase = "tracking";
    client.window = Date.now();
    client.count = 0;
    const values = [angle, angle, 0.1, 0.1, 0.6];
    PARAMETERS.forEach((name, i) =>
      client.receive(
        JSON.stringify({
          apiName: "VTubeStudioPublicAPI",
          apiVersion: "1.0",
          messageType: "ParameterValueResponse",
          requestID: name,
          data: { name, value: values[i] },
        }),
      ),
    );
    const clamp = (n) => Math.max(-1, Math.min(1, n));
    assert.equal(pose.x, clamp((angle / 30) * 0.85));
    assert.equal(pose.y, clamp((-angle / 30) * 0.85));
    assert.equal(pose.eyes, true);
    assert.equal(pose.mouth, 0.6);
    client.stop();
  }
});
async function server() {
  const value = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => value.once("listening", resolve));
  return value;
}
function message(socket, type, id, data) {
  socket.send(
    JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      messageType: type,
      requestID: id,
      data,
    }),
  );
}
test("real loopback WebSocket exchanges only auth, face status and five parameter requests; emits bounded pose", async () => {
  const service = await server(),
    commands = [],
    saved = [];
  let resolvePose;
  const ready = new Promise((resolve) => (resolvePose = resolve));
  service.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw);
      commands.push(msg.messageType);
      if (msg.messageType === "AuthenticationTokenRequest")
        message(socket, "AuthenticationTokenResponse", "token", {
          authenticationToken: "local-test-token",
        });
      if (msg.messageType === "AuthenticationRequest")
        message(socket, "AuthenticationResponse", "auth", {
          authenticated: true,
        });
      if (msg.messageType === "ParameterValueRequest")
        message(socket, "ParameterValueResponse", msg.requestID, {
          name: msg.data.name,
          value: msg.data.name.startsWith("Eye") ? 1 : 0.3,
        });
    }),
  );
  const client = new VtsClient({
    saveToken: (value) => saved.push(value),
    onPose: resolvePose,
  });
  try {
    client.start(service.address().port);
    const result = await Promise.race([ready, timeout(4000)]);
    assert.equal(saved[0], "local-test-token");
    assert.ok(Number.isFinite(result.x));
    assert.ok(
      commands.every((name) =>
        [
          "AuthenticationTokenRequest",
          "AuthenticationRequest",
          "ParameterValueRequest",
          "FaceFoundRequest",
        ].includes(name),
      ),
    );
  } finally {
    client.stop();
    for (const socket of service.clients) socket.terminate();
    await new Promise((resolve) => service.close(resolve));
  }
});
test("forged auth responses cannot grant tracking or store tokens", () => {
  let saved = false,
    tracked = false;
  const client = new VtsClient({
    saveToken: () => (saved = true),
    onPose: () => (tracked = true),
  });
  client.phase = "connecting";
  client.receive(
    JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      messageType: "AuthenticationResponse",
      requestID: "auth",
      data: { authenticated: true },
    }),
  );
  assert.equal(saved, false);
  assert.equal(tracked, false);
  assert.equal(client.phase, "connecting");
});
test("malformed, oversize, invalid-protocol and nonfinite tracking payloads are rejected", () => {
  const client = new VtsClient();
  for (const raw of [
    "{",
    "x".repeat(65537),
    JSON.stringify({ apiName: "evil", apiVersion: "1.0" }),
    123,
  ])
    assert.throws(() => client.receive(raw));
  client.phase = "tracking";
  for (const value of ["0", null, {}, 1000001])
    assert.throws(() =>
      client.receive(
        JSON.stringify({
          apiName: "VTubeStudioPublicAPI",
          apiVersion: "1.0",
          messageType: "ParameterValueResponse",
          requestID: PARAMETERS[0],
          data: { name: PARAMETERS[0], value },
        }),
      ),
    );
});
test("authentication refusal stops automatic reapproval prompts", () => {
  const client = new VtsClient();
  client.running = true;
  client.phase = "auth";
  client.tokenRequested = true;
  client.socket = { readyState: 1, send: () => {}, close: () => {} };
  client.receive(
    JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      requestID: "auth",
      messageType: "AuthenticationResponse",
      data: { authenticated: false },
    }),
  );
  assert.equal(client.running, false);
  client.stop();
});

test("excessive VTS message rate is bounded", () => {
  const client = new VtsClient();
  client.window = Date.now();
  client.count = 220;
  assert.throws(
    () =>
      client.receive(
        JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0" }),
      ),
    /과도/,
  );
});

test("empty text frames are ignored during authentication but remain rate limited", () => {
  const client = new VtsClient();
  client.window = Date.now();
  client.count = 0;
  client.phase = "auth";
  for (const raw of ["", " \t\r\n", "\uFEFF"])
    assert.doesNotThrow(() => client.receive(raw));
  assert.equal(client.phase, "auth");
  assert.equal(client.count, 3);
  assert.throws(() => client.receive("{"));
  assert.throws(() => client.receive(" ".repeat(65537)), /응답 크기/);
  client.count = 220;
  assert.throws(() => client.receive(""), /과도/);
});

for (const disconnectAt of ["before-auth-response", "after-auth-response"]) {
  test(`reconnect reuses issued token without another permission prompt: ${disconnectAt}`, async () => {
    const service = await server();
    let connections = 0,
      prompts = 0,
      auths = 0,
      saved = 0,
      complete;
    const ready = new Promise((resolve) => (complete = resolve));
    service.on("connection", (socket) => {
      const connection = ++connections;
      socket.on("message", (raw) => {
        const request = JSON.parse(raw);
        socket.send("");
        if (request.messageType === "AuthenticationTokenRequest") {
          prompts++;
          message(socket, "AuthenticationTokenResponse", request.requestID, {
            authenticationToken: "issued-local-fixture",
          });
        } else if (request.messageType === "AuthenticationRequest") {
          auths++;
          assert.equal(
            request.data.authenticationToken,
            "issued-local-fixture",
          );
          if (connection === 1 && disconnectAt === "before-auth-response") {
            socket.close();
            return;
          }
          message(socket, "AuthenticationResponse", request.requestID, {
            authenticated: true,
          });
          if (connection === 1 && disconnectAt === "after-auth-response")
            socket.close();
        } else if (
          request.messageType === "ParameterValueRequest" &&
          connection > 1
        ) {
          message(socket, "ParameterValueResponse", request.requestID, {
            name: request.data.name,
            value: request.data.name.startsWith("Eye") ? 1 : 0.2,
          });
        }
      });
    });
    const client = new VtsClient({
      retryBase: 5,
      saveToken: () => saved++,
      onPose: () => complete(),
    });
    try {
      client.start(service.address().port);
      await Promise.race([ready, timeout(4000)]);
      assert.equal(prompts, 1);
      assert.equal(auths, 2);
      assert.equal(saved, 1);
      assert.equal(connections, 2);
      assert.equal(client.phase, "tracking");
    } finally {
      client.stop();
      for (const socket of service.clients) socket.terminate();
      await new Promise((resolve) => service.close(resolve));
    }
  });
}

test("disconnect while approval is pending stops instead of reopening the permission dialog", async () => {
  const service = await server();
  let prompts = 0,
    connections = 0,
    closed;
  const stopped = new Promise((resolve) => (closed = resolve));
  service.on("connection", (socket) => {
    connections++;
    socket.on("message", (raw) => {
      if (JSON.parse(raw).messageType === "AuthenticationTokenRequest") {
        prompts++;
        socket.close();
      }
    });
  });
  const client = new VtsClient({
    retryBase: 1,
    onStatus: (text) => {
      if (text.startsWith("승인 중 연결")) closed();
    },
  });
  try {
    client.start(service.address().port);
    await Promise.race([stopped, timeout(4000)]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(prompts, 1);
    assert.equal(connections, 1);
    assert.equal(client.running, false);
  } finally {
    client.stop();
    for (const socket of service.clients) socket.terminate();
    await new Promise((resolve) => service.close(resolve));
  }
});

test("tracking API denial clears authorization and stops without requesting another token", () => {
  let forgotten = 0,
    sent = 0;
  const client = new VtsClient({ forgetToken: () => forgotten++ });
  client.running = true;
  client.phase = "tracking";
  client.sessionToken = "old-local-fixture";
  client.socket = { readyState: 1, send: () => sent++, close: () => {} };
  client.receive(
    JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      messageType: "APIError",
      requestID: "FaceAngleX",
      data: { errorID: 50 },
    }),
  );
  assert.equal(client.running, false);
  assert.equal(client.sessionToken, "");
  assert.equal(forgotten, 1);
  assert.equal(sent, 0);
});

test("face detection is distinct from API authentication and recovers when tracking returns", () => {
  const statuses = [];
  const client = new VtsClient({ onStatus: (value) => statuses.push(value) });
  client.phase = "tracking";
  client.window = Date.now();
  client.count = 0;
  const response = (found) =>
    JSON.stringify({
      apiName: "VTubeStudioPublicAPI",
      apiVersion: "1.0",
      messageType: "FaceFoundResponse",
      requestID: "face",
      data: { found },
    });
  client.receive(response(false));
  assert.match(statuses.at(-1), /얼굴 미감지/);
  client.receive(response(true));
  assert.equal(statuses.at(-1), "얼굴 추적 연결됨");
  assert.throws(() => client.receive(response("true")), /얼굴 감지/);
});
