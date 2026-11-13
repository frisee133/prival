/// <reference types="vite/client" />
import {
  createDeepFilterNetAudioWorklet,
  type DeepFilterNetAudioWorkletHandle,
} from "@workadventure/noise-suppression/deepfilternet";
import vadProcessor from "./voice-gate.worklet.js?url";
import { publicDfnAssets } from "./dfn-assets";

export type SoundPrefs = {
  input: string;
  output: string;
  echoCancellation: boolean;
  autoGainControl: boolean;
  noise: "off" | "standard" | "dfn3";
  micGain: number;
  mode: "toggle" | "ptt" | "vad";
  key: string;
  threshold: number;
};
export const defaults: SoundPrefs = {
  input: "",
  output: "",
  echoCancellation: true,
  autoGainControl: false,
  noise: "dfn3",
  micGain: 100,
  mode: "toggle",
  key: "F8",
  threshold: -42,
};
export const microphoneGain = (value: number) =>
  Number.isFinite(value) ? Math.min(300, Math.max(0, value)) : 100;

function bounded<T>(pending: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => finish(() => reject(signal.reason));
    const timer = setTimeout(
      () => finish(() => reject(new Error("DFN3 initialization timeout"))),
      120000,
    );
    function finish(done: () => void) {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      done();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function microphone(
  p: SoundPrefs,
  signal: AbortSignal,
  notice: (message: string) => void = () => {},
) {
  signal.throwIfAborted();
  const ctx = new AudioContext({ sampleRate: 48000 });
  let stream: MediaStream | undefined,
    denoiser: DeepFilterNetAudioWorkletHandle | undefined,
    dest: MediaStreamAudioDestinationNode | undefined,
    closed = false,
    fallback = false;
  function close() {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    stream?.getTracks().forEach((t) => t.stop());
    dest?.stream.getTracks().forEach((t) => t.stop());
    denoiser?.dispose();
    void ctx.close().catch(() => {});
  }
  signal.addEventListener("abort", close, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        ...(p.input ? { deviceId: { exact: p.input } } : {}),
        autoGainControl: p.noise === "dfn3" ? false : p.autoGainControl,
        echoCancellation: p.echoCancellation,
        noiseSuppression: p.noise === "standard",
      },
    });
    signal.throwIfAborted();
    await ctx.resume();
    signal.throwIfAborted();
    let source = ctx.createMediaStreamSource(stream);
    const processed = ctx.createGain();
    // Keep this route live with PTT released: only the final gain gates
    // transmission, preserving the model's recurrent state and warm buffers.
    const useStandard = async (reason: string) => {
      if (closed || fallback) return;
      fallback = true;
      source.disconnect();
      denoiser?.dispose();
      try {
        // Chromium may resolve applyConstraints while retaining the original
        // audio processing configuration. Re-capture to really enable WebRTC.
        const oldStream = stream!;
        const onended = oldStream.getAudioTracks()[0].onended;
        // Release the shared Chromium capture source before changing effects.
        oldStream.getTracks().forEach((t) => t.stop());
        const replacement = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            sampleRate: 48000,
            ...(p.input ? { deviceId: { exact: p.input } } : {}),
            noiseSuppression: true,
            autoGainControl: false,
            echoCancellation: p.echoCancellation,
          },
        });
        if (closed) {
          replacement.getTracks().forEach((t) => t.stop());
          return;
        }
        replacement.getAudioTracks()[0].onended = onended;
        stream = replacement;
        source = ctx.createMediaStreamSource(stream);
        source.connect(processed);
        notice(
          reason + " Включён лёгкий режим WebRTC. DFN3 можно выбрать заново.",
        );
      } catch {
        if (!closed)
          notice(
            "Не удалось включить лёгкий шумодав. Выберите другой микрофон или режим звука.",
          );
      }
    };
    if (p.noise === "dfn3") {
      notice(
        "Загружается DeepFilterNet3… При первом запуске через временную ссылку подождите до двух минут.",
      );
      try {
        const loading = publicDfnAssets()
          .then((assets) =>
            createDeepFilterNetAudioWorklet(ctx, {
              ...assets,
              bypassUntilReady: false,
              speechAttenuationDb: 25,
              pauseAttenuationDb: 45,
              pauseGateLookaheadFrames: 3,
              minSpeechFrames: 1,
              postGain: p.autoGainControl,
              maxLoad: 0.7,
              onOverload: () =>
                void useStandard(
                  "DeepFilterNet3 перегружает звуковой процессор.",
                ),
            }),
          )
          .then((handle) => {
            // A cancelled or timed-out download can finish much later.
            if (closed || fallback) handle.dispose();
            else denoiser = handle;
            // dispose does not settle ready; consume its eventual rejection too.
            void handle.ready.catch(() => {});
            return handle;
          });
        const handle = await bounded(loading, signal);
        if (closed) {
          handle.dispose();
          signal.throwIfAborted();
        }
        await bounded(handle.ready, signal);
        signal.throwIfAborted();
        source.connect(handle.node).connect(processed);
        handle.node.addEventListener(
          "processorerror",
          () => void useStandard("Сбой DeepFilterNet3."),
        );
        handle.node.port.addEventListener("message", (event) => {
          if (event.data.type === "error")
            void useStandard("Сбой DeepFilterNet3.");
        });
        notice("");
      } catch {
        signal.throwIfAborted();
        await useStandard("DeepFilterNet3 не загрузился.");
      }
    } else source.connect(processed);

    let tail: AudioNode = processed;
    if (p.mode === "vad") {
      await ctx.audioWorklet.addModule(vadProcessor);
      signal.throwIfAborted();
      tail = tail.connect(
        new AudioWorkletNode(ctx, "prival-voice-gate", {
          channelCount: 1,
          channelCountMode: "explicit",
          outputChannelCount: [1],
          processorOptions: {
            threshold: p.threshold,
            holdMs: 250,
            lookaheadMs: 20,
          },
        }),
      );
    }
    // Amplify after denoising and detection so gain does not open VAD on noise.
    const amplification = ctx.createGain();
    amplification.gain.value = microphoneGain(p.micGain) / 100;
    tail.connect(amplification);
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -3;
    compressor.knee.value = 3;
    compressor.ratio.value = 12;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.12;
    amplification.connect(compressor);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    compressor.connect(analyser);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    compressor.connect(gain);
    dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    dest.channelCountMode = "explicit";
    gain.connect(dest);
    return {
      get input() {
        return stream!.getAudioTracks()[0];
      },
      output: dest.stream,
      analyser,
      setGain: (value: number) => {
        if (!closed)
          amplification.gain.setTargetAtTime(
            microphoneGain(value) / 100,
            ctx.currentTime,
            0.015,
          );
      },
      gate: (enabled: boolean) => {
        // Explicit mute / PTT release wins over the soft speech gate; no
        // hangover may transmit after the user releases the key.
        if (!closed) gain.gain.setValueAtTime(enabled ? 1 : 0, ctx.currentTime);
      },
      close,
    };
  } catch (e) {
    // Capture can resolve after cancellation; stop that late stream as well.
    stream?.getTracks().forEach((t) => t.stop());
    close();
    throw e;
  }
}
