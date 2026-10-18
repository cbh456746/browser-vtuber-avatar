import test from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { VtsClient, PARAMETERS } from "../desktop/vts.mjs";
const timeout = (ms) =>
  new Promise((_, reject) =>
    setTimeout(() => reject(Error("timed out")), ms).unref(),
  );
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
test("real loopback WebSocket exchanges only auth and five parameter requests; emits bounded pose", async () => {
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
