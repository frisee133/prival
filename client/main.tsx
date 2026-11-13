import { identity } from "./identity";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArrowRight, KeyRound } from "lucide-react";
import { Brand } from "./Brand";
import { errorText } from "./model";
import "./style.css";
import "./friends.css";
const Friends = lazy(() => import("./Friends"));
function App() {
  const device = identity,
    [profile, setProfile] = useState<DeviceProfile | null>(null),
    [nick, setNick] = useState(""),
    [busy, wait] = useState(!!device),
    [error, fail] = useState(""),
    [retry, setRetry] = useState(false);
  const sync = useCallback(async () => {
    if (!window.isSecureContext) {
      fail("Для регистрации и микрофона откройте сайт по HTTPS.");
      setRetry(true);
      wait(false);
      return;
    }
    wait(true);
    fail("");
    try {
      setProfile(await device.profile());
      setRetry(false);
    } catch (e) {
      fail(errorText(e));
      setRetry(true);
    } finally {
      wait(false);
    }
  }, [device]);
  const reset = useCallback(() => {
    setProfile(null);
    setNick("");
    fail("");
  }, []);
  useEffect(() => {
    void sync();
  }, [sync]);
  if (profile)
    return (
      <Suspense
        fallback={
          <main className="loading">
            <Brand />
          </main>
        }
      >
        <Friends profile={profile} deleted={reset} />
      </Suspense>
    );
  return (
    <main className="gate">
      <aside className="forest gate-photo">
        <Brand />
        <div className="photo-title">
          <span>Приватные голосовые звонки</span>
          <h1>
            На связи
            <br />
            со своими.
          </h1>
        </div>
      </aside>
      <div className="gate-form">
        <div className="auth">
          <div className="badge-icon">
            <KeyRound size={26} />
          </div>
          <h2>Создать профиль</h2>
          <p>
            Выберите ник. Этот профиль откроется автоматически при следующем
            входе.
          </p>
          {device && (
            <form
              className="panel-form"
              onSubmit={async (e) => {
                e.preventDefault();
                wait(true);
                fail("");
                try {
                  setProfile(await device.create(nick.trim()));
                } catch (e) {
                  fail(errorText(e));
                } finally {
                  wait(false);
                }
              }}
            >
              {!retry && (
                <>
                  <label>
                    Ник
                    <input
                      autoFocus
                      maxLength={32}
                      required
                      value={nick}
                      onChange={(e) => setNick(e.target.value)}
                      placeholder="Как вас зовут в игре?"
                    />
                  </label>
                  <button disabled={busy || !nick.trim()} className="primary">
                    {busy ? "Подключение…" : "Создать профиль"}
                    <ArrowRight size={16} />
                  </button>
                </>
              )}
              {error && <p role="alert">{error}</p>}
              {retry && (
                <button
                  type="button"
                  className="subtle"
                  onClick={() => void sync()}
                >
                  Повторить подключение
                </button>
              )}
            </form>
          )}
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
