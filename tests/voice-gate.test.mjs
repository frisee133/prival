import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";
import test from "node:test";

const code = await readFile(
  new URL("../client/voice-gate.worklet.js", import.meta.url),
  "utf8",
);
function gate() {
  let Processor;
  vm.runInNewContext(code, {
    sampleRate: 48000,
    AudioWorkletProcessor: class {},
    registerProcessor: (_, implementation) => {
      Processor = implementation;
    },
  });
  return new Processor({
    processorOptions: { threshold: -42, holdMs: 250, lookaheadMs: 20 },
  });
}
function block(g, value) {
  const output = new Float32Array(128);
  g.process([[new Float32Array(128).fill(value)]], [[output]]);
  return output;
}
test("look-ahead keeps the complete first speech block", () => {
  const g = gate();
  for (let i = 0; i < 20; i++) block(g, 0);
  const result = [...block(g, 0.2)];
  for (let i = 0; i < 10; i++) result.push(...block(g, 0));
  assert.equal(
    result.findIndex((v) => v > 0.1),
    960,
  );
  assert.equal(result.filter((v) => v > 0.1).length, 128);
});
test("VAD holds through short pauses, fades after 250 ms, closes on low noise", () => {
  const g = gate();
  for (let i = 0; i < 10; i++) block(g, 0.2);
  for (let i = 0; i < 80; i++) block(g, 0.0001);
  assert.equal(g.gain, 1);
  for (let i = 0; i < 40; i++) block(g, 0.0001);
  assert.equal(g.gain, 0);
  assert.ok(block(g, 0.0001).every((v) => v === 0));
});
