export function wav(hz) {
  const rate = 48000,
    n = rate * 3,
    buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF");
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(
      Math.round(13000 * Math.sin((2 * Math.PI * hz * i) / rate)),
      44 + 2 * i,
    );
  return buf;
}
export async function tone(p, hz) {
  await p.waitForFunction(
    (expected) => {
      const el = [...document.querySelectorAll("audio[data-peer]")].find(
        (e) =>
          !e.paused &&
          e.srcObject
            ?.getAudioTracks()
            .some((t) => t.readyState === "live" && !t.muted) &&
          e.readyState >= 2 &&
          e.currentTime > 0 &&
          !e.muted &&
          e.volume > 0,
      );
      if (!el) return false;
      if (
        el.probe?.track !== el.srcObject.getAudioTracks()[0] ||
        el.probe.src.mediaStream.getAudioTracks()[0]?.readyState !== "live"
      ) {
        if (el.probe) void el.probe.ac.close();
        const ac = new AudioContext(),
          an = ac.createAnalyser();
        an.fftSize = 4096;
        const src = ac.createMediaStreamSource(el.captureStream());
        src.connect(an);
        el.probe = { ac, an, src, track: el.srcObject.getAudioTracks()[0] };
        void ac.resume();
      }
      const { ac, an } = el.probe,
        buf = new Float32Array(an.frequencyBinCount);
      an.getFloatFrequencyData(buf);
      let peak = 0;
      for (let i = 1; i < buf.length; i++) if (buf[i] > buf[peak]) peak = i;
      return (
        Math.abs((peak * ac.sampleRate) / an.fftSize - expected) < 25 &&
        buf[peak] > -55
      );
    },
    hz,
    { timeout: 20000 },
  );
}
