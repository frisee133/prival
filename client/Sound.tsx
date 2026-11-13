import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AudioLines } from "lucide-react";
import { voice, audioError } from "./voice";
import { microphone, type SoundPrefs } from "./audio";
import { OverlaySettings } from "./OverlaySettings";
export function Sound() {
  const { prefs, audioNotice } = useSyncExternalStore(
    voice.subscribe,
    voice.snapshot,
  );
  const [monitorNotice, setMonitorNotice] = useState("");
  const currentPrefs = useRef(prefs);
  currentPrefs.current = prefs;
  const graph = useRef<Awaited<ReturnType<typeof microphone>> | undefined>(
    undefined,
  );
  useEffect(() => {
    graph.current?.setGain(prefs.micGain);
  }, [prefs.micGain]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [testing, test] = useState(false),
    [playing, setPlaying] = useState(false),
    [level, setLevel] = useState(0),
    [error, fail] = useState(""),
    [stats, report] = useState<string[]>([]);
  useEffect(() => {
    const read = () =>
      navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    read();
    navigator.mediaDevices?.addEventListener("devicechange", read);
    return () =>
      navigator.mediaDevices?.removeEventListener("devicechange", read);
  }, [testing]);
  useEffect(() => {
    if (!testing) return;
    voice.testMode(true);
    const cancel = new AbortController(),
      monitor = new Audio();
    let frame = 0;
    (async () => {
      setMonitorNotice("");
      const g = await microphone(
        currentPrefs.current,
        cancel.signal,
        (message) => {
          if (!cancel.signal.aborted) setMonitorNotice(message);
        },
      );
      cancel.signal.throwIfAborted();
      graph.current = g;
      g.setGain(currentPrefs.current.micGain);
      if (prefs.output && monitor.setSinkId)
        await monitor.setSinkId(prefs.output);
      cancel.signal.throwIfAborted();
      monitor.srcObject = g.output;
      g.gate(true);
      await monitor.play();
      cancel.signal.throwIfAborted();
      setPlaying(true);
      const buf = new Uint8Array(g.analyser.fftSize);
      const tick = () => {
        g.analyser.getByteTimeDomainData(buf);
        let rms = 0;
        for (const n of buf) rms += ((n - 128) / 128) ** 2;
        setLevel(Math.min(100, Math.sqrt(rms / buf.length) * 300));
        frame = requestAnimationFrame(tick);
      };
      tick();
      g.input.onended = () => {
        fail("Микрофон отключён");
        test(false);
      };
      setDevices(await navigator.mediaDevices.enumerateDevices());
    })().catch((e) => {
      if (!cancel.signal.aborted) {
        fail(audioError(e));
        test(false);
      }
    });
    return () => {
      cancel.abort();
      graph.current = undefined;
      cancelAnimationFrame(frame);
      monitor.pause();
      monitor.srcObject = null;
      setPlaying(false);
      voice.testMode(false);
    };
  }, [
    testing,
    prefs.input,
    prefs.output,
    prefs.noise,
    prefs.echoCancellation,
    prefs.autoGainControl,
    prefs.mode,
    prefs.threshold,
    prefs.key,
  ]);
  return (
    <div className="panel-form">
      {(["input", "output"] as const).map(
        (k) =>
          (k === "input" || "setSinkId" in HTMLMediaElement.prototype) && (
            <label key={k}>
              {k === "input" ? "Микрофон" : "Динамики или наушники"}
              <select
                value={prefs[k]}
                onChange={(e) => voice.prefs({ [k]: e.target.value })}
              >
                <option value="">Системное устройство</option>
                {devices
                  .filter(
                    (d) =>
                      d.kind ===
                        (k === "input" ? "audioinput" : "audiooutput") &&
                      d.deviceId,
                  )
                  .map((d, i) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || "Устройство " + (i + 1)}
                    </option>
                  ))}
              </select>
            </label>
          ),
      )}
      <label>
        Громкость микрофона · {prefs.micGain}%
        <input
          aria-label="Громкость микрофона"
          type="range"
          min="0"
          max="300"
          step="5"
          value={prefs.micGain}
          onChange={(e) => voice.prefs({ micGain: +e.target.value })}
        />
      </label>
      <small>100% — исходный уровень. Усиление передаётся собеседникам.</small>
      <label>
        Шумоподавление
        <select
          value={prefs.noise}
          onChange={(e) =>
            voice.prefs({ noise: e.target.value as SoundPrefs["noise"] })
          }
        >
          <option value="off">Выключено</option>
          <option value="standard">Лёгкое · WebRTC</option>
          <option value="dfn3">Нейросетевое · DeepFilterNet3</option>
        </select>
      </label>
      <small>
        В игре при нагрузке выберите лёгкий WebRTC. При перегрузке DFN3
        переключится на него автоматически.
      </small>
      {(testing ? monitorNotice : audioNotice) && (
        <small role="status">{testing ? monitorNotice : audioNotice}</small>
      )}
      <div className="checks">
        {(
          [
            ["echoCancellation", "Эхоподавление"],
            [
              "autoGainControl",
              prefs.noise === "dfn3"
                ? "Автоуровень после DFN3"
                : "Автоусиление",
            ],
          ] as const
        ).map(([k, label]) => (
          <label key={k}>
            <input
              type="checkbox"
              checked={prefs[k]}
              onChange={(e) => voice.prefs({ [k]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <label>
        Режим передачи
        <select
          value={prefs.mode}
          onChange={(e) =>
            voice.prefs({ mode: e.target.value as SoundPrefs["mode"] })
          }
        >
          <option value="toggle">Вручную</option>
          <option value="ptt">Удерживать клавишу · PTT</option>
          <option value="vad">Активация голосом</option>
        </select>
      </label>
      {prefs.mode === "vad" && (
        <label>
          Порог активации · {prefs.threshold} дБ
          <input
            type="range"
            min="-68"
            max="-16"
            step="1"
            value={prefs.threshold}
            onChange={(e) => voice.prefs({ threshold: +e.target.value })}
          />
        </label>
      )}
      {prefs.mode === "ptt" && (
        <label>
          {window.privalDevice
            ? "Глобальная клавиша"
            : "Клавиша при фокусе вкладки"}
          <select
            value={prefs.key}
            onChange={(e) => voice.prefs({ key: e.target.value })}
          >
            {[
              ...Array.from({ length: 24 }, (_, i) => "F" + (i + 1)),
              "Space",
              "CapsLock",
              "ScrollLock",
              "Insert",
              "Backquote",
              ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ", (c) => "Key" + c),
              ...Array.from("0123456789", (c) => "Digit" + c),
            ].map((k) => (
              <option key={k} value={k}>
                {k === "Space" ? "Пробел" : k.replace(/^Key|^Digit/, "")}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="meter" data-monitor={playing ? "playing" : "idle"}>
        <span style={{ width: (testing ? level : 0) + "%" }} />
      </div>
      <OverlaySettings />
      <button
        className="subtle"
        onClick={() => {
          fail("");
          test(!testing);
        }}
      >
        <AudioLines size={16} />
        {testing ? "Завершить проверку" : "Прослушать свой микрофон"}
      </button>
      {testing && (
        <small>
          Вы слышите обработанный сигнал. Передача в звонок приостановлена.
        </small>
      )}
      <button
        className="text-btn"
        onClick={() =>
          voice
            .stats()
            .then((v) => report(v.length ? v : ["Пока нет входящего аудио."]))
            .catch((e) => fail(audioError(e)))
        }
      >
        Статистика соединения
      </button>
      {stats.map((v) => (
        <small key={v}>{v}</small>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
