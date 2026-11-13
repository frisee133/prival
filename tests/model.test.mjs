import test from "node:test";
import assert from "node:assert/strict";
import {
  secureOrigins,
  voiceAddress,
  friendLinkOrigin,
} from "../server/public-urls.ts";
test("Приглашение с локальной консоли содержит настроенный HTTPS-адрес для друга", () => {
  assert.equal(friendLinkOrigin("http://127.0.0.1:3000"), null);
  assert.equal(
    friendLinkOrigin("http://localhost:3000", "https://vpn.example:18443"),
    "https://vpn.example:18443",
  );
  assert.equal(
    friendLinkOrigin("https://camp.example"),
    "https://camp.example",
  );
  assert.throws(() => friendLinkOrigin("https://user:password@camp.example"));
});
test("Допущены только указанные HTTPS-адреса и локальный HTTP", () => {
  assert.deepEqual(
    [...secureOrigins("http://127.0.0.1:3000", "https://vpn.example:8443")],
    ["http://127.0.0.1:3000", "https://vpn.example:8443"],
  );
  assert.throws(() => secureOrigins("http://192.168.0.4", undefined));
});
test("Внешний клиент получает WSS публичного адреса", () => {
  assert.equal(
    voiceAddress("same-origin", "https://vpn.example:8443"),
    "wss://vpn.example:8443",
  );
  assert.throws(() =>
    voiceAddress("ws://localhost:7880", "https://camp.example"),
  );
});
