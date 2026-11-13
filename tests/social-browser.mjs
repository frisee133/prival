import assert from "node:assert/strict";
import { chromium, _electron as electron } from "playwright-core";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { wav, tone } from "./audio-fixture.mjs";
import { verifyOverlay } from "./overlay-assertions.mjs";
const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000",
  desktop = process.env.TEST_DESKTOP === "1";
const dir = await mkdtemp(join(tmpdir(), "prival-friends-")),
  clients = [];
async function client(hz) {
  const file = join(dir, hz + ".wav");
  await writeFile(file, wav(hz));
  const args = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--use-file-for-fake-audio-capture=" + file,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  if (process.env.TEST_CERT_SPKI)
    args.push(
      "--ignore-certificate-errors-spki-list=" + process.env.TEST_CERT_SPKI,
    );
  let page;
  if (desktop) {
    const e = await electron.launch({
      executablePath:
        process.env.TEST_DESKTOP_EXE ||
        createRequire(import.meta.url)("electron"),
      args: [
        ...args,
        "--user-data-dir=" + join(dir, "profile" + hz),
        ...(process.env.TEST_DESKTOP_EXE ? [] : [resolve("desktop")]),
        "--server=" + origin,
      ],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    });
    clients.push(e);
    await e.firstWindow();
    page = await Promise.any(
      e.windows().map(async (p) => {
        await p.waitForURL((url) => url.origin === origin);
        return p;
      }),
    );
  } else {
    const b = await chromium.launch({
      channel: "chrome",
      headless: true,
      args,
    });
    clients.push(b);
    const c = await b.newContext({ permissions: ["microphone"] });
    if (process.env.TEST_MIC_GAIN === "1") {
      await c.addInitScript(() => {
        if (!localStorage.getItem("prival-sound"))
          localStorage.setItem(
            "prival-sound",
            JSON.stringify({
              noise: "off",
              echoCancellation: false,
              autoGainControl: false,
              micGain: 25,
            }),
          );
      });
    }
    if (
      process.env.TEST_TURN_TLS === "1" ||
      process.env.TEST_PUBLIC_RELAY === "1"
    ) {
      await c.addInitScript(
        ({ tlsOnly }) => {
          const Native = window.RTCPeerConnection;
          const peers = new Set();
          const relayOnly = (config = {}) => ({
            ...config,
            iceTransportPolicy: "relay",
            iceServers: (config.iceServers ?? []).flatMap((s) => {
              const urls = [s.urls]
                .flat()
                .filter((url) => /^turns:.*:443\?transport=tcp$/i.test(url));
              return urls.length ? [{ ...s, urls }] : [];
            }),
          });
          window.RTCPeerConnection = class extends Native {
            constructor(config) {
              super(tlsOnly ? relayOnly(config) : config);
              peers.add(this);
            }
            setConfiguration(config) {
              super.setConfiguration(tlsOnly ? relayOnly(config) : config);
            }
            close() {
              peers.delete(this);
              super.close();
            }
          };
          window.selectedAudioRoutes = async () => {
            const routes = [];
            for (const pc of peers) {
              const stats = await pc.getStats();
              for (const s of stats.values()) {
                if (
                  s.type !== "inbound-rtp" ||
                  s.kind !== "audio" ||
                  !s.bytesReceived
                )
                  continue;
                const pair = stats.get(
                  stats.get(s.transportId)?.selectedCandidatePairId,
                );
                const candidate = stats.get(pair?.localCandidateId);
                routes.push({
                  type: candidate?.candidateType,
                  url: candidate?.url,
                  relayProtocol: candidate?.relayProtocol,
                  bytes: s.bytesReceived,
                  lost: s.packetsLost,
                  rttMs: Math.round(pair?.currentRoundTripTime * 1000),
                });
              }
            }
            return routes;
          };
        },
        { tlsOnly: process.env.TEST_TURN_TLS === "1" },
      );
    }
    page = await c.newPage();
    await page.goto(origin);
  }
  page.setDefaultTimeout(16000);
  return page;
}
const state = (p) =>
  p.evaluate(() => fetch("/api/state").then((r) => r.json()));
const nick = "Тест-" + randomUUID().slice(0, 6);
async function register(p) {
  if (
    /(\.pinggy-free\.link|\.free\.pinggy\.net)$/.test(new URL(origin).hostname)
  ) {
    const enter = p.getByRole("button", { name: "Enter site" });
    await enter
      .or(p.getByLabel("Ник", { exact: true }))
      .first()
      .waitFor();
    if (await enter.isVisible()) {
      await enter.click();
      await p.getByLabel("Ник", { exact: true }).waitFor({ timeout: 30000 });
    }
  }
  await p.getByLabel("Ник", { exact: true }).fill(nick);
  await p.getByRole("button", { name: "Создать профиль", exact: true }).click();
  await p.locator("[data-code]").waitFor();
  return (await state(p)).me;
}
async function erase(p) {
  await p.getByRole("button", { name: "Удалить профиль", exact: true }).click();
  await p.getByRole("button", { name: "Подтвердить удаление" }).click();
  await p.getByLabel("Ник", { exact: true }).waitFor();
}
try {
  const a = await client(440),
    b = await client(880);
  const bob = await register(b);
  const inviteOrigin = (await state(b)).inviteOrigin;
  const useLink = !desktop && inviteOrigin === origin;
  if (useLink) {
    await b.getByRole("button", { name: "Пригласить по ссылке" }).click();
    const link = await b.getByLabel("Ссылка для друга").inputValue();
    assert.equal(link, origin + "/?friend=" + bob.code);
    await b.getByRole("button", { name: "Закрыть", exact: true }).click();
    await a.goto(link);
  }
  const alice = await register(a);
  assert.notEqual(alice.id, bob.id);
  assert.equal(alice.nick, bob.nick);
  await b.reload();
  await b.locator("[data-code]").waitFor();
  assert.equal((await state(b)).me.id, bob.id);
  if (!desktop)
    assert.equal(
      await b.evaluate(async () => {
        const db = await new Promise((res) => {
          const r = indexedDB.open("prival-identity");
          r.onsuccess = () => res(r.result);
        });
        const row = await new Promise((res) => {
          const r = db
            .transaction("device")
            .objectStore("device")
            .get("current");
          r.onsuccess = () => res(r.result);
        });
        db.close();
        return row.privateKey.extractable;
      }),
      false,
    );
  if (useLink) {
    assert.equal(await a.getByLabel("Код друга").inputValue(), bob.code);
  } else {
    await a
      .getByRole("button", { name: "Добавить друга", exact: true })
      .click();
    await a.getByLabel("Код друга").fill(bob.code);
  }
  await a.getByRole("button", { name: "Отправить заявку" }).click();
  await b.getByRole("button", { name: /^Заявки/ }).click();
  await b.getByRole("button", { name: "Принять заявку" }).click();
  for (const p of [a, b])
    await p.getByRole("button", { name: /^Друзья/ }).click();
  // RTC frequency assertions use an unprocessed tone; speech models are
  // checked separately because a correct denoiser may remove a pure sine.
  for (const page of [a, b]) {
    await page.getByRole("button", { name: "Настройки звука" }).click();
    await page.getByLabel(/^Шумоподавление/).selectOption("off");
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  }
  await a.getByRole("button", { name: "Позвонить" }).click();
  await b.getByRole("button", { name: "Принять звонок" }).click();
  for (const p of [a, b])
    await p
      .getByRole("button", { name: "Включить микрофон", exact: true })
      .click();
  await Promise.all([tone(a, 880), tone(b, 440)]);
  if (
    process.env.TEST_TURN_TLS === "1" ||
    process.env.TEST_PUBLIC_RELAY === "1"
  ) {
    for (const page of [a, b]) {
      const routes = await page.evaluate(() => window.selectedAudioRoutes());
      assert.ok(routes.length > 0, "Нет статистики воспроизводимого аудио");
      for (const route of routes) {
        assert.equal(route.type, "relay");
        if (process.env.TEST_TURN_TLS === "1") {
          assert.equal(route.relayProtocol, "tls");
          assert.match(route.url, /^turns:.*:443\?transport=tcp$/i);
        } else {
          assert.equal(route.relayProtocol, "tcp");
          assert.match(route.url, /^turn:[a-z0-9.-]+:\d+\?transport=tcp$/i);
        }
      }
      console.log("Выбранный путь входящего звука", routes);
    }
    console.log(
      "Звук подтверждён в обе стороны при запрете прямых ICE-кандидатов.",
    );
  }
  console.log(
    "Два профиля, автологин, заявка и двусторонний Opus: 880 / 440 Гц.",
  );
  await b.getByRole("button", { name: "Настройки звука" }).click();
  let testedOverlay;
  if (desktop)
    testedOverlay = await verifyOverlay(clients[1], b, [alice.id, bob.id]);
  if (process.env.TEST_MIC_GAIN === "1") {
    const rms = async () =>
      a.evaluate(async () => {
        const analyser = document.querySelector("audio[data-peer]").probe.an;
        const values = new Float32Array(analyser.fftSize);
        let sum = 0;
        for (let i = 0; i < 5; i++) {
          analyser.getFloatTimeDomainData(values);
          sum += Math.sqrt(
            values.reduce((s, v) => s + v * v, 0) / values.length,
          );
          await new Promise((r) => setTimeout(r, 80));
        }
        return sum / 5;
      });
    const before = await rms();
    const slider = b.getByRole("slider", {
      name: "Громкость микрофона",
      exact: true,
    });
    await slider.focus();
    await slider.press("Home");
    for (let i = 0; i < 20; i++) await slider.press("ArrowRight");
    await b
      .getByRole("button", { name: "Выключить микрофон", exact: true })
      .waitFor();
    await b.waitForTimeout(600);
    const after = await rms();
    assert.ok(
      before > 0.01 && after / before > 2.5 && after / before < 5.5,
      "Усиление должно увеличить принятый сигнал примерно в 4 раза: " +
        after / before,
    );
    console.log(
      "Усиление 25 → 100%: амплитуда у собеседника выросла в " +
        (after / before).toFixed(2) +
        " раза.",
    );
    assert.equal(
      await b.evaluate(
        () => JSON.parse(localStorage.getItem("prival-sound")).micGain,
      ),
      100,
    );
  }
  await b.getByLabel(/^Шумоподавление/).selectOption("dfn3");
  await b.getByRole("button", { name: "Прослушать свой микрофон" }).click();
  await b.locator(".meter[data-monitor=playing]").waitFor({ timeout: 150000 });
  assert.equal(await b.getByText(/Включён лёгкий режим WebRTC/).count(), 0);
  await b.getByRole("button", { name: "Завершить проверку" }).click();
  await b.getByLabel(/^Шумоподавление/).selectOption("standard");
  await b.getByRole("button", { name: "Прослушать свой микрофон" }).click();
  await b.locator(".meter[data-monitor=playing]").waitFor();
  await b.getByRole("button", { name: "Завершить проверку" }).click();
  await b.getByLabel(/^Шумоподавление/).selectOption("off");
  await b.getByLabel("Режим передачи").selectOption("ptt");
  await b.getByRole("button", { name: "Закрыть", exact: true }).click();
  await b.bringToFront();
  await b.locator("h1").click();
  if (desktop) {
    const { spawn } = await import("node:child_process");
    await clients[0].evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        /^https?:/.test(w.webContents.getURL()),
      );
      w.show();
      w.focus();
    });
    await clients[1].evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => /^https?:/.test(w.webContents.getURL()))
        .hide(),
    );
    await b.waitForTimeout(600);
    const native = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class PrivalTestKey{[DllImport("user32.dll")]public static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);}';[PrivalTestKey]::keybd_event(119,0,0,[UIntPtr]::Zero);try{Start-Sleep -Seconds 3}finally{[PrivalTestKey]::keybd_event(119,0,2,[UIntPtr]::Zero)}`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    const end = new Promise((res, rej) =>
      native.once("exit", (code) =>
        code === 0 ? res() : rej(Error("Native key test failed")),
      ),
    );
    await tone(a, 880);
    if (testedOverlay)
      await testedOverlay
        .getByText("Микрофон включён", { exact: true })
        .waitFor();
    await end;
    if (testedOverlay)
      await testedOverlay
        .getByText("Микрофон выключен", { exact: true })
        .waitFor();
    await a.waitForFunction(
      () => {
        const probe = document.querySelector("audio[data-peer]")?.probe;
        if (!probe) return false;
        const f = new Float32Array(probe.an.frequencyBinCount);
        probe.an.getFloatFrequencyData(f);
        return Math.max(...f) < -65;
      },
      undefined,
      { timeout: 8000 },
    );
    assert.ok(
      await clients[1].evaluate(
        ({ BrowserWindow }) =>
          !BrowserWindow.getAllWindows()
            .find((w) => /^https?:/.test(w.webContents.getURL()))
            .isVisible(),
      ),
    );
    console.log(
      "Electron в трее: глобальное нажатие F8 передало 880 Гц, после отпускания измерена тишина.",
    );
    await clients[1].evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) =>
        /^https?:/.test(w.webContents.getURL()),
      );
      w.restore();
      w.show();
    });
  }
  if (!desktop) {
    await b.keyboard.down("F8");
    await b.waitForFunction(
      () =>
        document
          .querySelector(".call-buttons button")
          ?.getAttribute("aria-pressed") === "true",
    );
    await tone(a, 880);
    await b.keyboard.up("F8");
    await a.waitForFunction(
      () => {
        const e = document.querySelector("audio[data-peer]");
        if (!e?.probe) return false;
        const f = new Float32Array(e.probe.an.frequencyBinCount);
        e.probe.an.getFloatFrequencyData(f);
        return Math.max(...f) < -65;
      },
      undefined,
      { timeout: 8000 },
    );
    await b.getByRole("button", { name: "Настройки звука" }).click();
    await b.getByLabel("Режим передачи").selectOption("vad");
    await b.getByRole("button", { name: "Закрыть", exact: true }).click();
    await tone(a, 880);
    console.log(
      "Голосовая активация с look-ahead проверена в собранном клиенте.",
    );
  }
  if (process.env.TEST_MIC_GAIN === "1" && !desktop) {
    await b.getByRole("button", { name: "Настройки звука" }).click();
    // A deterministic fan-like noise fixture checks that both local models
    // process samples, beyond merely creating a playing audio element.
    const noise = wav(880);
    let seed = 17;
    for (let i = 0; i < (noise.length - 44) / 2; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const sample =
        ((seed / 4294967296) * 2 - 1) * 0.06 +
        Math.sin((i / 48000) * 2 * Math.PI * 45) * 0.06;
      noise.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    }
    await writeFile(join(dir, "880.wav"), noise);
    const levels = {};
    for (const mode of ["off", "dfn3"]) {
      await b.getByLabel(/^Шумоподавление/).selectOption(mode);
      await b.getByRole("button", { name: "Прослушать свой микрофон" }).click();
      await b.locator(".meter[data-monitor=playing]").waitFor();
      await b.waitForTimeout(1800);
      let sum = 0;
      for (let i = 0; i < 5; i++) {
        sum += await b
          .locator(".meter span")
          .evaluate((e) => parseFloat(e.style.width));
        await b.waitForTimeout(80);
      }
      levels[mode] = sum / 5;
      await b.getByRole("button", { name: "Завершить проверку" }).click();
    }
    assert.ok(levels.off > 5, "Шумовой тест должен захватывать входной сигнал");
    assert.ok(
      levels.dfn3 < levels.off * 0.6,
      "DeepFilterNet3 должен ослаблять синтетический шум",
    );
    console.log("Индикатор синтетического шума, %:", levels);
    await writeFile(join(dir, "880.wav"), wav(880));
    await b.getByRole("button", { name: "Закрыть", exact: true }).click();
  }
  await erase(b);
  if (testedOverlay) {
    await testedOverlay.waitForFunction(
      () => document.querySelectorAll(".peer").length === 0,
    );
    assert.equal(
      (await b.evaluate(() => window.privalDevice.overlaySettings())).enabled,
      false,
    );
  }
  if (desktop)
    assert.equal(
      await clients[1].evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle() === "Привал — оверлей")
          .isVisible(),
      ),
      false,
    );
  await a.waitForFunction(() => !document.querySelector(".friend-row"));
  assert.equal((await state(a)).calls.length, 0);
  if (!desktop) {
    const second = await register(b);
    await a
      .getByRole("button", { name: "Добавить друга", exact: true })
      .click();
    await a.getByLabel("Код друга").fill(second.code);
    await a.getByRole("button", { name: "Отправить заявку" }).click();
    await b.getByRole("button", { name: /^Заявки/ }).click();
    await b.getByRole("button", { name: "Принять заявку" }).click();
    const cdp = await b.context().newCDPSession(b);
    await cdp.send("Storage.clearDataForOrigin", {
      origin,
      storageTypes: "all",
    });
    await b.reload();
    const third = await register(b);
    assert.notEqual(second.id, third.id);
    assert.equal((await state(b)).people.length, 0);
    assert.ok((await state(a)).people.some((p) => p.id === second.id));
    await erase(b);
  }
  await erase(a);
  console.log(
    "Удаление профиля удаляет дружбу и звонок. " +
      (desktop
        ? "Проверено в Electron."
        : "Очистка сайта создаёт новый ID с тем же ником без переноса друзей."),
  );
} catch (e) {
  for (const c of clients) {
    const p = c.windows?.()[0] ?? c.contexts?.()[0]?.pages()[0];
    if (p)
      console.error(
        "Аудио:",
        await p
          .evaluate(() =>
            [...document.querySelectorAll("audio[data-peer]")].map((el) => {
              const probe = el.probe;
              if (!probe) return { probe: false };
              const bins = new Float32Array(probe.an.frequencyBinCount);
              probe.an.getFloatFrequencyData(bins);
              let peak = 0;
              for (let i = 1; i < bins.length; i++)
                if (bins[i] > bins[peak]) peak = i;
              return {
                paused: el.paused,
                muted: el.muted,
                volume: el.volume,
                context: probe.ac.state,
                tracks: el.srcObject
                  ?.getAudioTracks()
                  .map((t) => ({
                    state: t.readyState,
                    muted: t.muted,
                    enabled: t.enabled,
                  })),
                ready: el.readyState,
                peak: (peak * probe.ac.sampleRate) / probe.an.fftSize,
                db: bins[peak],
                prefs: localStorage.getItem("prival-sound"),
              };
            }),
          )
          .catch(() => []),
      );
    if (p)
      console.error(
        "Экран:",
        (
          await p
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-500),
      );
  }
  throw e;
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(
    () => {},
  );
}
