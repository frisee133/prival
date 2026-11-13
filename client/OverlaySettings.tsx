import { useEffect, useState } from "react";
import { errorText } from "./model";

type Settings = OverlayPrefs & { displays: { id: string; name: string }[] };
export function OverlaySettings() {
  const [prefs, setPrefs] = useState<Settings>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const device = window.privalDevice;
  useEffect(() => {
    let mounted = true;
    device
      ?.overlaySettings?.()
      .then((s) => {
        if (mounted) setPrefs(s);
      })
      .catch((e) => {
        if (mounted) setError(errorText(e));
      });
    return () => {
      mounted = false;
    };
  }, [device]);
  if (!device?.overlaySettings) return null;
  async function change(update: Partial<OverlayPrefs>) {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, ...update });
    setBusy(true);
    setError("");
    try {
      setPrefs(await device!.overlaySettings!({ ...prefs, ...update }));
    } catch (e) {
      setPrefs(previous);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel-form" aria-label="Игровой оверлей">
      <h3>Игровой оверлей</h3>
      {prefs && (
        <>
          <div className="checks">
            <label>
              <input
                type="checkbox"
                checked={prefs.enabled}
                disabled={busy}
                onChange={(e) => void change({ enabled: e.target.checked })}
              />
              Показывать оверлей во время звонка
            </label>
          </div>
          {prefs.enabled && (
            <>
              <label>
                Расположение
                <select
                  aria-label="Расположение оверлея"
                  value={prefs.corner}
                  disabled={busy}
                  onChange={(e) =>
                    void change({
                      corner: e.target.value as OverlayPrefs["corner"],
                    })
                  }
                >
                  <option value="top-left">Слева сверху</option>
                  <option value="top-right">Справа сверху</option>
                  <option value="bottom-left">Слева снизу</option>
                  <option value="bottom-right">Справа снизу</option>
                </select>
              </label>
              <label>
                Экран оверлея
                <select
                  aria-label="Экран оверлея"
                  value={prefs.display}
                  disabled={busy}
                  onChange={(e) => void change({ display: e.target.value })}
                >
                  <option value="active">Экран с указателем мыши</option>
                  {prefs.displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                Оверлей показывает участников поверх окон и пропускает нажатия
                мыши в игру.
              </small>
            </>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
