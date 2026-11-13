import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  RemoteAudioTrack,
  LocalAudioTrack,
  type RemoteParticipant,
} from "livekit-client";
import { api, errorText } from "./model";
import { defaults, microphone, microphoneGain, type SoundPrefs } from "./audio";
function load(): SoundPrefs {
  try {
    const prefs = {
      ...defaults,
      ...JSON.parse(localStorage.getItem("prival-sound") ?? "{}"),
    };
    prefs.micGain = microphoneGain(prefs.micGain);
    if (["rnnoise", "gtcrn"].includes(prefs.noise)) prefs.noise = "dfn3";
    return prefs;
  } catch {
    return defaults;
  }
}
export function audioError(e: unknown) {
  const name = (e as Error)?.name;
  if (name === "NotAllowedError")
    return "Доступ к микрофону закрыт. Разрешите его в настройках сайта.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "Микрофон не найден. Подключите его и выберите устройство.";
  if (name === "NotReadableError")
    return "Микрофон недоступен. Проверьте гарнитуру и другие приложения.";
  return errorText(e);
}
export type Peer = {
  id: string;
  name: string;
  self: boolean;
  speaking: boolean;
};
type State = {
  channel: string | null;
  status: string;
  connected: boolean;
  mic: boolean;
  deaf: boolean;
  canSpeak: boolean;
  needsPlay: boolean;
  error: string;
  audioNotice: string;
  peers: Peer[];
  prefs: SoundPrefs;
};
type Input = {
  graph: Awaited<ReturnType<typeof microphone>>;
  track: LocalAudioTrack;
};
class Voice {
  state: State = {
    channel: null,
    status: "Вне эфира",
    connected: false,
    mic: false,
    deaf: false,
    canSpeak: false,
    needsPlay: false,
    error: "",
    audioNotice: "",
    peers: [],
    prefs: load(),
  };
  private listeners = new Set<() => void>();
  private room?: Room;
  private lease?: string;
  private generation = 0;
  private queue = Promise.resolve();
  private controller?: AbortController;
  private inputChange: Promise<void> = Promise.resolve();
  private requested = false;
  private input?: Input;
  private testing = false;
  private elements = new Map<
    RemoteAudioTrack,
    { el: HTMLAudioElement; id: string }
  >();
  private volumes = new Map<string, number>();
  private muted = new Set<string>();
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.state;
  private set(p: Partial<State>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn();
  }
  private refresh(room: Room) {
    if (room !== this.room) return;
    const peers = [
      room.localParticipant,
      ...room.remoteParticipants.values(),
    ].map((p) => ({
      id: p.identity,
      name: p.name || p.identity,
      self: p === room.localParticipant,
      speaking: p.isSpeaking,
    }));
    this.set({
      peers,
      canSpeak: !!room.localParticipant.permissions?.canPublish,
      needsPlay: !room.canPlaybackAudio,
    });
    if (!this.state.canSpeak) this.resetInput();
    else if (this.state.connected && this.state.prefs.mode !== "toggle")
      void this.prepare();
  }
  private removeTrack(track: RemoteAudioTrack) {
    const attached = this.elements.get(track)?.el;
    const elements = new Set(track.detach());
    if (attached) elements.add(attached);
    for (const el of elements) {
      el.pause();
      el.srcObject = null;
      el.remove();
      delete el.dataset.peer;
    }
    this.elements.delete(track);
  }
  private listen(room: Room) {
    const refresh = () => this.refresh(room);
    room
      .on(RoomEvent.TrackSubscribed, (t, _pub, p: RemoteParticipant) => {
        if (this.room !== room || !(t instanceof RemoteAudioTrack)) return;
        const el = t.attach();
        el.autoplay = true;
        el.dataset.peer = p.identity;
        document.body.append(el);
        this.elements.set(t, { el, id: p.identity });
        this.applyMix();
        refresh();
      })
      .on(RoomEvent.TrackUnsubscribed, (t) => {
        if (t instanceof RemoteAudioTrack) this.removeTrack(t);
      })
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      .on(RoomEvent.ActiveSpeakersChanged, refresh)
      .on(RoomEvent.ParticipantPermissionsChanged, refresh)
      .on(RoomEvent.AudioPlaybackStatusChanged, refresh)
      .on(RoomEvent.ConnectionStateChanged, (s) => {
        if (this.room !== room) return;
        const connected = s === ConnectionState.Connected;
        if (!connected) this.resetInput();
        this.set({
          connected,
          status: connected
            ? "В эфире"
            : s === ConnectionState.Connecting
              ? "Подключение…"
              : "Восстановление связи…",
        });
      })
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;
        this.leave("Связь завершена");
      });
  }
  private detach() {
    this.resetInput();
    if (this.lease) {
      void api("/voice/leave", "POST", { lease: this.lease }).catch(() => {});
      this.lease = undefined;
    }
    const old = this.room;
    this.room = undefined;
    for (const t of this.elements.keys()) this.removeTrack(t);
    if (!old) return Promise.resolve();
    old.removeAllListeners();
    return old.disconnect(true).catch(() => {});
  }
  leave(status = "Вне эфира") {
    ++this.generation;
    const closed = this.detach();
    this.queue = this.queue.then(() => closed);
    this.set({
      channel: null,
      connected: false,
      canSpeak: false,
      needsPlay: false,
      peers: [],
      status,
    });
  }
  join(id: string) {
    const seq = ++this.generation;
    const closed = this.detach();
    this.set({
      channel: id,
      connected: false,
      canSpeak: false,
      status: "Подключение…",
      peers: [],
      error: "",
      needsPlay: false,
    });
    this.queue = this.queue.then(async () => {
      await closed;
      if (seq !== this.generation) return;
      try {
        const { url, token, lease, iceServer } = await api<{
          url: string;
          token: string;
          lease: string;
          iceServer?: RTCIceServer;
        }>("/calls/" + id + "/token", "POST", {});
        if (seq !== this.generation) {
          void api("/voice/leave", "POST", { lease }).catch(() => {});
          return;
        }
        this.lease = lease;
        const room = new Room({
          publishDefaults: { dtx: true, red: true, forceStereo: false },
          audioOutput: { deviceId: this.state.prefs.output || "default" },
        });
        this.room = room;
        this.listen(room);
        await room.connect(
          url,
          token,
          iceServer
            ? {
                rtcConfig: {
                  iceServers: [iceServer],
                  iceTransportPolicy: "relay",
                },
              }
            : undefined,
        );
        if (seq !== this.generation) {
          await room.disconnect();
          return;
        }
        this.refresh(room);
      } catch (e) {
        if (seq === this.generation) {
          this.leave("Ошибка подключения");
          this.set({ error: errorText(e) });
        }
      }
    });
  }
  private resetInput() {
    this.talk(false);
    this.controller?.abort();
    this.set({ audioNotice: "" });
    this.controller = undefined;
    const i = this.input;
    this.input = undefined;
    if (i) {
      i.graph.close();
      const room = this.room;
      this.inputChange = this.inputChange
        .then(async () => {
          try {
            await room?.localParticipant.unpublishTrack(i.track);
          } finally {
            i.track.stop();
          }
        })
        .catch(() => {});
    }
  }
  private eligible() {
    return (
      !!this.room &&
      this.state.connected &&
      this.state.canSpeak &&
      !this.state.deaf &&
      !this.testing
    );
  }
  private gate() {
    const enabled =
      this.eligible() &&
      !!this.input &&
      (this.requested || this.state.prefs.mode === "vad");
    this.input?.graph.gate(enabled);
    if (enabled !== this.state.mic) this.set({ mic: enabled });
  }
  talk(on: boolean) {
    this.requested = on && this.eligible();
    this.gate();
    if (this.requested && !this.input) void this.prepare();
  }
  toggle() {
    this.talk(!this.requested);
  }
  testMode(enabled: boolean) {
    this.testing = enabled;
    if (enabled) this.resetInput();
    else if (this.state.prefs.mode !== "toggle") void this.prepare();
  }
  private prepare() {
    if (this.controller || this.input || !this.eligible()) return;
    const room = this.room!,
      controller = new AbortController();
    this.controller = controller;
    this.inputChange = this.inputChange.then(() =>
      this.publishInput(room, controller),
    );
  }
  private async publishInput(room: Room, controller: AbortController) {
    let graph: Awaited<ReturnType<typeof microphone>> | undefined,
      track: LocalAudioTrack | undefined;
    try {
      controller.signal.throwIfAborted();
      graph = await microphone(
        this.state.prefs,
        controller.signal,
        (audioNotice) => {
          if (!controller.signal.aborted) this.set({ audioNotice });
        },
      );
      controller.signal.throwIfAborted();
      track = new LocalAudioTrack(
        graph.output.getAudioTracks()[0],
        undefined,
        true,
      );
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Microphone,
        forceStereo: false,
        dtx: true,
      });
      if (controller.signal.aborted) {
        await room.localParticipant.unpublishTrack(track);
        return;
      }
      this.input = { graph, track };
      graph.setGain(this.state.prefs.micGain);

      const current = this.input;
      graph.input.onended = () => {
        if (this.input === current) {
          this.resetInput();
          this.set({
            error: "Гарнитура отключена. Выберите микрофон в настройках.",
          });
        }
      };
      graph = undefined;
      track = undefined;
      this.set({ error: "" });
      this.gate();
    } catch (e) {
      if (!controller.signal.aborted) {
        this.requested = false;
        this.set({ error: audioError(e) });
      }
    } finally {
      graph?.close();
      track?.stop();
      if (this.controller === controller) this.controller = undefined;
    }
  }
  private applyMix() {
    for (const { el, id } of this.elements.values()) {
      el.muted = this.state.deaf || this.muted.has(id);
      el.volume = this.volumes.get(id) ?? 1;
    }
  }
  volume(id: string, value?: number) {
    if (value !== undefined) {
      this.volumes.set(id, value);
      this.applyMix();
      this.set({});
    }
    return this.volumes.get(id) ?? 1;
  }
  localMute(id: string, toggle = false) {
    if (toggle) {
      if (this.muted.has(id)) this.muted.delete(id);
      else this.muted.add(id);
      this.applyMix();
      this.set({});
    }
    return this.muted.has(id);
  }
  deafen() {
    this.talk(false);
    this.set({ deaf: !this.state.deaf });
    if (this.state.deaf) this.resetInput();
    else if (this.state.prefs.mode !== "toggle") void this.prepare();
    this.applyMix();
  }
  async play() {
    try {
      await this.room?.startAudio();
    } catch (e) {
      this.set({ error: audioError(e) });
    }
  }
  prefs(p: Partial<SoundPrefs>) {
    const onlyGain = Object.keys(p).every((key) => key === "micGain");
    if (!onlyGain) this.resetInput();
    const prefs = { ...this.state.prefs, ...p };
    prefs.micGain = microphoneGain(prefs.micGain);
    localStorage.setItem("prival-sound", JSON.stringify(prefs));
    this.set({ prefs });
    this.input?.graph.setGain(prefs.micGain);
    if (prefs.mode !== "toggle") void this.prepare();
    if (p.output !== undefined && this.room)
      void this.room
        .switchActiveDevice("audiooutput", p.output || "default")
        .catch((e) => this.set({ error: audioError(e) }));
  }
  async stats() {
    const rows: string[] = [];
    for (const [track, { id }] of this.elements) {
      const report = await track.getRTCStatsReport();
      if (!report) continue;
      report.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio")
          rows.push(
            (this.state.peers.find((p) => p.id === id)?.name ?? id) +
              " · потери " +
              s.packetsLost +
              " / " +
              s.packetsReceived +
              " · джиттер " +
              Math.round(s.jitter * 1000) +
              " мс",
          );
        if (s.type === "transport" && s.selectedCandidatePairId) {
          const pair = report.get(s.selectedCandidatePairId);
          if (pair) {
            const l = report.get(pair.localCandidateId),
              r = report.get(pair.remoteCandidateId);
            rows.push(
              "ICE " +
                l?.candidateType +
                " → " +
                r?.candidateType +
                " · " +
                (l?.relayProtocol ?? l?.protocol) +
                " · RTT " +
                Math.round((pair.currentRoundTripTime ?? 0) * 1000) +
                " мс",
            );
          }
        }
      });
    }
    return [...new Set(rows)];
  }
}
export const voice = new Voice();
