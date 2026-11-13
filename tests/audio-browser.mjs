import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { wav } from "./audio-fixture.mjs";

const dir = await mkdtemp(join(tmpdir(), "prival-dfn3-"));
const file = join(dir, "noise.wav"),
  noise = wav(880);
let seed = 17;
for (let i = 0; i < (noise.length - 44) / 2; i++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  noise.writeInt16LE(
    Math.round(
      (((seed / 4294967296) * 2 - 1) * 0.06 +
        Math.sin((i / 48000) * 2 * Math.PI * 45) * 0.06) *
        32767,
    ),
    44 + i * 2,
  );
}
await writeFile(file, noise);
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "18101",
    "--strictPort",
  ],
  { windowsHide: true, stdio: "ignore" },
);
let browser;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch("http://127.0.0.1:18101")).ok) break;
    } catch {}
    if (i > 100) throw Error("Vite did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--use-file-for-fake-audio-capture=" + file,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:18101");
  const result = await page.evaluate(async () => {
    const nodes = [],
      captures = [],
      notices = [];
    const Worklet = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Worklet {
      constructor(context, name, options) {
        super(context, name, options);
        nodes.push({ name, node: this });
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (options) => {
      captures.push(options);
      return getUserMedia(options);
    };
    const { microphone, defaults } = await import("/client/audio.ts");
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const rms = async (analyser) => {
      await delay(1200);
      let sum = 0;
      const values = new Float32Array(analyser.fftSize);
      for (let i = 0; i < 8; i++) {
        analyser.getFloatTimeDomainData(values);
        sum += Math.sqrt(values.reduce((s, v) => s + v * v, 0) / values.length);
        await delay(60);
      }
      return sum / 8;
    };
    const rawCancel = new AbortController();
    const raw = await microphone(
      { ...defaults, noise: "off", echoCancellation: false },
      rawCancel.signal,
    );
    const before = await rms(raw.analyser);
    rawCancel.abort();
    const cancel = new AbortController();
    const graph = await microphone(
      { ...defaults, autoGainControl: true, echoCancellation: false },
      cancel.signal,
      (value) => notices.push(value),
    );
    const after = await rms(graph.analyser);
    const dfn = nodes.find(
      (n) => n.name === "workadventure-deepfilternet",
    ).node;
    const context = new AudioContext({ sampleRate: 48000 });
    await context.resume();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(graph.output).connect(analyser);
    graph.gate(true);
    await delay(100);
    graph.gate(false);
    const muted = await rms(analyser);
    const stillRunning = dfn.context.state;
    dfn.port.dispatchEvent(
      new MessageEvent("message", { data: { type: "overload", load: 0.99 } }),
    );
    for (
      let i = 0;
      i < 40 && !notices.some((n) => n.includes("Включён лёгкий"));
      i++
    )
      await delay(50);
    const fallbackSettings = graph.input.getSettings();
    const mutedAfterFallback = await rms(analyser);
    cancel.abort();
    await context.close();
    return {
      before,
      after,
      muted,
      mutedAfterFallback,
      stillRunning,
      captures,
      notices,
      fallbackSettings,
      inputStopped: graph.input.readyState,
      outputStopped: graph.output.getAudioTracks()[0].readyState,
    };
  });
  assert.ok(result.before > 0.01);
  assert.ok(result.after < result.before * 0.6, JSON.stringify(result));
  assert.equal(result.captures[1].audio.noiseSuppression, false);
  assert.equal(result.captures[1].audio.autoGainControl, false);
  assert.equal(result.captures[1].audio.sampleRate, 48000);
  assert.equal(result.stillRunning, "running");
  assert.ok(result.muted < 0.00001 && result.mutedAfterFallback < 0.00001);
  assert.ok(
    result.notices.includes(""),
    "DFN3 must initialize successfully before forcing overload",
  );
  assert.ok(result.notices.some((n) => n.includes("перегружает")));
  assert.equal(result.fallbackSettings.noiseSuppression, true);
  assert.equal(result.inputStopped, "ended");
  assert.equal(result.outputStopped, "ended");
  console.log(
    "DFN3 48 кГц: шум RMS",
    result.before.toFixed(4),
    "→",
    result.after.toFixed(4),
    "; прогретый PTT, тишина после отпускания, переключение при перегрузке, освобождение устройств — OK.",
  );
  // Failure path in a fresh page avoids the package's successful model cache.
  const failed = await browser.newPage();
  await failed.route("**/df_bg.wasm", (route) => route.abort());
  await failed.goto("http://127.0.0.1:18101");
  const failure = await failed.evaluate(async () => {
    const { microphone, defaults } = await import("/client/audio.ts");
    const cancel = new AbortController(),
      notices = [];
    const graph = await microphone(defaults, cancel.signal, (n) =>
      notices.push(n),
    );
    const settings = graph.input.getSettings();
    cancel.abort();
    return { notices, settings };
  });
  assert.ok(
    failure.notices.some(
      (n) => n.includes("не загрузился") && n.includes("Включён лёгкий"),
    ),
  );
  assert.equal(
    failure.settings.noiseSuppression,
    true,
    JSON.stringify(failure),
  );
  console.log(
    "Недоступная WASM-модель: автоматический переход на WebRTC — OK.",
  );
} finally {
  await browser?.close();
  vite.kill();
  await rm(dir, { recursive: true, force: true });
}
