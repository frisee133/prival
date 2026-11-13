import { identity } from "./identity";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Users,
  UserRoundPlus,
  Inbox,
  ShieldBan,
  Phone,
  PhoneOff,
  Headphones,
  Mic,
  MicOff,
  Settings2,
  Copy,
  Trash2,
  Volume2,
  AudioLines,
} from "lucide-react";
import { api, errorText, HttpError } from "./model";
import { Brand } from "./Brand";
import { Dialog } from "./Dialog";
import { Sound } from "./Sound";
import { voice } from "./voice";
type Person = {
  id: string;
  nick: string;
  relation: "friend" | "in" | "out" | "blocked";
  online: boolean;
  dnd: boolean;
};
type Call = {
  id: string;
  joined: boolean;
  inviter: string;
  members: { id: string; nick: string; joined: boolean }[];
};
type State = {
  me: DeviceProfile;
  people: Person[];
  calls: Call[];
  inviteOrigin?: string | null;
};
const sections = {
  friends: "Друзья",
  requests: "Заявки",
  blocked: "Заблокированные",
};
export default function Friends({
  profile,
  deleted,
}: {
  profile: DeviceProfile;
  deleted: () => void;
}) {
  const [invitedBy] = useState(() => {
    const code = new URLSearchParams(location.search)
      .get("friend")
      ?.toUpperCase();
    return code && /^[0-9A-F]{12}$/.test(code) && code !== profile.code
      ? code
      : "";
  });
  const [data, set] = useState<State>({ me: profile, people: [], calls: [] }),
    [section, tab] = useState<keyof typeof sections>("friends"),
    [modal, open] = useState<"add" | "sound" | "erase" | "share" | null>(
      invitedBy ? "add" : null,
    ),
    [code, input] = useState(invitedBy),
    [error, fail] = useState(""),
    [busy, wait] = useState(false),
    [copied, copy] = useState(false);
  const [summary, setSummary] = useState("");
  const inviteLink = data.inviteOrigin
    ? data.inviteOrigin + "/?friend=" + profile.code
    : "";
  useEffect(() => {
    if (invitedBy) {
      const url = new URL(location.href);
      url.searchParams.delete("friend");
      history.replaceState(null, "", url);
    }
  }, [invitedBy]);
  const alive = useRef(true),
    revision = useRef(0);
  const v = useSyncExternalStore(voice.subscribe, voice.snapshot);
  const refresh = useCallback(async () => {
    const version = ++revision.current;
    let state: State;
    try {
      state = await api<State>("/state");
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      const p = await identity.profile();
      if (!p) {
        deleted();
        return;
      }
      state = await api<State>("/state");
    }
    if (alive.current && version === revision.current) set(state);
  }, [deleted]);
  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh();
      } catch (e) {
        if (alive.current) fail(errorText(e));
      }
      if (alive.current) timer = setTimeout(poll, 1750);
    };
    void poll();
    return () => {
      alive.current = false;
      clearTimeout(timer);
      voice.leave();
    };
  }, [refresh]);
  const active = data.calls.find((c) => c.joined),
    incoming = data.calls.filter((c) => !c.joined);
  useEffect(() => {
    window.privalDevice?.overlayState?.({
      active: !!active,
      mic: v.mic,
      deaf: v.deaf,
      status: v.status,
      peers: (active?.members ?? [])
        .filter((m) => m.joined)
        .map((m) => ({
          id: m.id,
          name: m.nick,
          self: m.id === profile.id,
          speaking: v.peers.some((p) => p.id === m.id && p.speaking),
        })),
    });
  }, [active, v.mic, v.deaf, v.status, v.peers, profile.id]);
  useEffect(
    () => () => {
      window.privalDevice?.overlayState?.({ active: false, peers: [] });
    },
    [],
  );
  useEffect(() => {
    if (active) voice.join(active.id);
    else voice.leave();
    return () => voice.leave();
  }, [active?.id]);
  useEffect(() => {
    if (!active || !v.connected || v.prefs.mode !== "ptt" || modal) return;
    if (!window.privalDevice) {
      const release = () => voice.talk(false);
      const down = (e: KeyboardEvent) => {
        if (
          e.code !== v.prefs.key ||
          e.repeat ||
          !document.hasFocus() ||
          document.hidden ||
          (e.target as HTMLElement)?.closest(
            "input,select,textarea,[contenteditable=true]",
          )
        )
          return;
        e.preventDefault();
        voice.talk(true);
      };
      const up = (e: KeyboardEvent) => {
        if (e.code === v.prefs.key) release();
      };
      window.addEventListener("keydown", down);
      window.addEventListener("keyup", up);
      window.addEventListener("blur", release);
      document.addEventListener("visibilitychange", release);
      return () => {
        release();
        window.removeEventListener("keydown", down);
        window.removeEventListener("keyup", up);
        window.removeEventListener("blur", release);
        document.removeEventListener("visibilitychange", release);
      };
    }
    const d = window.privalDevice;
    let mounted = true;
    const unsub = d.onKey((pressed) => voice.talk(pressed));
    void d.hotkey(v.prefs.key).catch((e) => {
      if (mounted) fail(errorText(e));
    });
    return () => {
      mounted = false;
      voice.talk(false);
      unsub();
      void d.hotkey(null).catch(() => {});
    };
  }, [active?.id, v.connected, v.prefs.key, v.prefs.mode, modal]);
  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    wait(true);
    fail("");
    try {
      await fn();
      if (alive.current) await refresh();
    } catch (e) {
      fail(errorText(e));
    } finally {
      if (alive.current) wait(false);
    }
  }
  const friends = data.people.filter((p) => p.relation === "friend"),
    requests = data.people.filter((p) => ["in", "out"].includes(p.relation)),
    blocked = data.people.filter((p) => p.relation === "blocked");
  const people = { friends, requests, blocked }[section];
  const command = (p: Person, action: string) =>
    act(() => api("/friends/" + p.id, "POST", { action }));
  const answer = (c: Call, accept: boolean) =>
    act(async () => {
      if (!accept && c.joined) voice.leave();
      await api("/calls/" + c.id + "/respond", "POST", { accept });
    });
  const status = (p: Person) =>
    p.dnd ? "Не беспокоить" : p.online ? "В сети" : "Не в сети";
  return (
    <main className="app friends-app">
      <aside className="sidebar">
        <Brand />
        <nav className="friend-nav">
          {(Object.keys(sections) as (keyof typeof sections)[]).map((k, i) => {
            const Icon = [Users, Inbox, ShieldBan][i];
            return (
              <button
                key={k}
                className={"channel " + (k === section ? "selected" : "")}
                onClick={() => tab(k)}
              >
                <Icon size={18} />
                {sections[k]}
                <span>{[friends, requests, blocked][i].length}</span>
              </button>
            );
          })}
        </nav>
        <div className="side-tools">
          {data.me.role === "owner" && (
            <button
              onClick={() =>
                void act(async () => {
                  const r = await api<{ profiles: number; calls: number }>(
                    "/admin/summary",
                  );
                  setSummary(
                    "Профилей: " +
                      r.profiles +
                      " · активных разговоров: " +
                      r.calls,
                  );
                })
              }
            >
              Состояние сервера
            </button>
          )}
          <button onClick={() => open("sound")}>
            <Settings2 size={17} />
            Настройки звука
          </button>
          <button onClick={() => open("erase")}>
            <Trash2 size={17} />
            Удалить профиль
          </button>
        </div>
        <div className="profile">
          <span className="avatar">{data.me.nick[0]}</span>
          <div>
            <b>{data.me.nick}</b>
            {data.me.role === "owner" && <small>Владелец</small>}
            <select
              aria-label="Мой статус"
              value={data.me.dnd ? "dnd" : "online"}
              onChange={(e) =>
                void act(() =>
                  api("/status", "POST", { dnd: e.target.value === "dnd" }),
                )
              }
            >
              <option value="online">В сети</option>
              <option value="dnd">Не беспокоить</option>
            </select>
          </div>
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <span>
            <Headphones size={17} />
            Приватные звонки
          </span>
          <button
            className="code-copy"
            title="Скопировать код друга"
            onClick={() =>
              navigator.clipboard
                .writeText(data.me.code)
                .then(() => copy(true))
                .catch(() => fail("Скопируйте код вручную."))
            }
          >
            {copied ? "Скопировано" : "Мой код"}{" "}
            <b data-code={data.me.code}>{data.me.code}</b>
            <Copy size={14} />
          </button>
          {inviteLink && (
            <button
              className="subtle"
              onClick={() => {
                copy(false);
                open("share");
              }}
            >
              Пригласить по ссылке
            </button>
          )}
        </header>
        <div className="room-content">
          {summary && data.me.role === "owner" && (
            <small role="status">{summary}</small>
          )}
          {error && <p role="alert">{error}</p>}
          {incoming.map((c) => (
            <div className="ring" key={c.id}>
              <Phone size={20} />
              <div>
                <b>{c.members.find((p) => p.id === c.inviter)?.nick}</b>
                <small>Входящий звонок</small>
              </div>
              <button
                disabled={busy || !!active}
                className="primary"
                onClick={() => void answer(c, true)}
              >
                Принять звонок
              </button>
              <button
                className="subtle"
                disabled={busy}
                onClick={() => void answer(c, false)}
              >
                Отклонить
              </button>
            </div>
          ))}
          <div className="hero forest">
            <div className="hero-text">
              <div className="eyebrow">
                {active ? "Приватный звонок" : "Контакты"}
              </div>
              <h1>{active ? "На связи" : sections[section]}</h1>
              <span>
                {active
                  ? active.members.map((p) => p.nick).join(" · ")
                  : "Ваш код для друзей · " + data.me.code}
              </span>
            </div>
            <button
              className="primary"
              onClick={() => {
                open("add");
                fail("");
              }}
            >
              <UserRoundPlus size={17} />
              Добавить друга
            </button>
          </div>
          {active && (
            <section className="participants">
              <div className="sectionhead">
                <AudioLines size={19} />
                <h2>{v.status}</h2>
                <button
                  className="hangup"
                  onClick={() => void answer(active, false)}
                  disabled={busy}
                >
                  <PhoneOff size={16} />
                  Завершить звонок
                </button>
              </div>
              {active.members.map((m) => (
                <div className="friend-row" key={m.id}>
                  <span className="avatar">{m.nick[0]}</span>
                  <div>
                    <b>{m.nick}</b>
                    <small>
                      {!m.joined
                        ? "Вызов…"
                        : v.peers.find((p) => p.id === m.id)?.speaking
                          ? "Говорит"
                          : m.id === profile.id
                            ? "Вы"
                            : "В разговоре"}
                    </small>
                  </div>
                  {m.joined && m.id !== profile.id && (
                    <label className="peer-volume">
                      <Volume2 size={17} />
                      <input
                        aria-label={"Громкость " + m.nick}
                        type="range"
                        min="0"
                        max="1"
                        step=".05"
                        value={voice.volume(m.id)}
                        onChange={(e) => voice.volume(m.id, +e.target.value)}
                      />
                    </label>
                  )}
                </div>
              ))}
              <div className="call-buttons">
                <button
                  className="subtle"
                  aria-pressed={v.mic}
                  disabled={!v.connected || v.prefs.mode !== "toggle" || v.deaf}
                  onClick={() => voice.toggle()}
                >
                  {v.mic ? <Mic size={16} /> : <MicOff size={16} />}{" "}
                  {v.prefs.mode === "ptt"
                    ? "PTT · " + v.prefs.key
                    : v.prefs.mode === "vad"
                      ? "Активация голосом"
                      : v.mic
                        ? "Выключить микрофон"
                        : "Включить микрофон"}
                </button>
                <button
                  className="subtle"
                  aria-pressed={v.deaf}
                  onClick={() => voice.deafen()}
                >
                  {v.deaf ? "Вернуть звук" : "Не слышу и не говорю"}
                </button>
                {v.needsPlay && (
                  <button onClick={() => void voice.play()}>
                    Включить звук
                  </button>
                )}
                {!v.channel && (
                  <button onClick={() => voice.join(active.id)}>
                    Повторить подключение
                  </button>
                )}
              </div>
              {v.audioNotice && <p role="status">{v.audioNotice}</p>}
              {v.error && <p role="alert">{v.error}</p>}
            </section>
          )}
          <section className="participants">
            <div className="sectionhead">
              <Users size={18} />
              <h2>{sections[section]}</h2>
              <span className="count">{people.length}</span>
            </div>
            {!people.length && (
              <div className="empty">
                <Users size={24} />
                <p>
                  {section === "friends"
                    ? "Добавьте друга по коду, чтобы позвонить."
                    : section === "requests"
                      ? "Входящих и исходящих заявок пока нет."
                      : "Заблокированных профилей нет."}
                </p>
              </div>
            )}
            {people.map((p) => (
              <div className="friend-row" key={p.id}>
                <span className="avatar">{p.nick[0]}</span>
                <div>
                  <b>{p.nick}</b>
                  <small>
                    {p.relation === "friend"
                      ? status(p)
                      : p.relation === "in"
                        ? "Входящая заявка"
                        : p.relation === "out"
                          ? "Исходящая заявка"
                          : "Заблокирован"}
                  </small>
                </div>
                <div className="row-actions">
                  {p.relation === "friend" &&
                    !active?.members.some((m) => m.id === p.id) && (
                      <button
                        className="primary"
                        disabled={busy || p.dnd}
                        onClick={() =>
                          void act(() =>
                            api(
                              active
                                ? "/calls/" + active.id + "/invite"
                                : "/calls",
                              "POST",
                              { target: p.id },
                            ),
                          )
                        }
                      >
                        <Phone size={15} />
                        {active ? "Пригласить в звонок" : "Позвонить"}
                      </button>
                    )}
                  {p.relation === "in" && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => void command(p, "accept")}
                    >
                      Принять заявку
                    </button>
                  )}
                  {p.relation !== "blocked" && (
                    <>
                      <button
                        className="subtle"
                        disabled={busy}
                        onClick={() => void command(p, "remove")}
                      >
                        {p.relation === "friend"
                          ? "Удалить"
                          : p.relation === "in"
                            ? "Отклонить"
                            : "Отменить"}
                      </button>
                      <button
                        className="icon"
                        title="Заблокировать"
                        disabled={busy}
                        onClick={() => void command(p, "block")}
                      >
                        <ShieldBan size={16} />
                      </button>
                    </>
                  )}
                  {p.relation === "blocked" && (
                    <button
                      className="subtle"
                      disabled={busy}
                      onClick={() => void command(p, "unblock")}
                    >
                      Разблокировать
                    </button>
                  )}
                </div>
              </div>
            ))}
          </section>
        </div>
      </section>
      {modal && (
        <Dialog
          title={
            {
              sound: "Настройки звука",
              add: "Добавить друга",
              erase: "Удалить профиль?",
              share: "Пригласить друга",
            }[modal]
          }
          close={() => open(null)}
        >
          {modal === "sound" ? (
            <Sound />
          ) : modal === "share" ? (
            <div className="panel-form">
              <label>
                Ссылка для друга
                <input
                  readOnly
                  value={inviteLink}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <button
                className="primary"
                onClick={() =>
                  navigator.clipboard
                    .writeText(inviteLink)
                    .then(() => copy(true))
                    .catch(() =>
                      fail("Выделите ссылку и скопируйте её вручную."),
                    )
                }
              >
                <Copy size={16} />
                {copied ? "Ссылка скопирована" : "Скопировать ссылку"}
              </button>
              <small>
                Друг откроет свой профиль и сможет отправить вам заявку.
              </small>
              {error && <p role="alert">{error}</p>}
            </div>
          ) : modal === "add" ? (
            <form
              className="panel-form"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("/friends/request", "POST", { code: code.trim() });
                  input("");
                  open(null);
                  tab("requests");
                });
              }}
            >
              <label>
                Код друга
                <input
                  autoFocus
                  maxLength={12}
                  required
                  value={code}
                  onChange={(e) => input(e.target.value.toUpperCase())}
                />
              </label>
              <button className="primary" disabled={busy}>
                Отправить заявку
              </button>
              {error && <p role="alert">{error}</p>}
            </form>
          ) : (
            <div className="panel-form">
              <p>
                Звонок завершится, ваши друзья потеряют связь с этим профилем, а
                ключ будет удалён с устройства.
              </p>
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
                  wait(true);
                  voice.leave();
                  try {
                    await identity.erase();
                    localStorage.removeItem("prival-sound");
                    deleted();
                  } catch (e) {
                    fail(errorText(e));
                  } finally {
                    wait(false);
                  }
                }}
              >
                Подтвердить удаление
              </button>
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </Dialog>
      )}
    </main>
  );
}
