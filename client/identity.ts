import { api, HttpError } from "./model";
type Saved = {
  privateKey: CryptoKey;
  publicKey: string;
  nick: string;
  pending: "register" | "delete" | null;
};
const encoding = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function storage<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("prival-identity", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("device");
    r.onerror = () => reject(r.error);
    r.onsuccess = () => resolve(r.result);
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction("device", mode),
      op = fn(tx.objectStore("device"));
    tx.oncomplete = () => {
      db.close();
      resolve(op.result);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? op.error);
    };
  });
}
const read = () =>
  storage<Saved | undefined>("readonly", (s) => s.get("current"));
const save = (r: Saved) => storage("readwrite", (s) => s.put(r, "current"));
const clear = async () => {
  await storage("readwrite", (s) => s.delete("current"));
  localStorage.removeItem("prival-sound");
};
async function prove<T>(r: Saved, purpose: "login" | "register" | "delete") {
  const { nonce } = await api<{ nonce: string }>("/device/challenge", "POST", {
    publicKey: r.publicKey,
    nick: r.nick,
    purpose,
  });
  const bytes = new TextEncoder().encode(
    ["PRIVAL-DEVICE-1", location.origin, purpose, nonce].join("\n"),
  );
  const signature = encoding(
    await crypto.subtle.sign("Ed25519", r.privateKey, bytes),
  );
  return api<T>("/device/prove", "POST", { nonce, signature });
}
async function erase(r: Saved) {
  r.pending = "delete";
  await save(r);
  try {
    const data = await prove<{ deleted: boolean }>(r, "delete");
    if (!data.deleted) throw Error();
  } catch {
    throw Error(
      "Удаление ещё не завершено. Проверьте подключение и повторите.",
    );
  }
  await clear();
  return null;
}
async function resume(r: Saved) {
  if (r.pending === "delete") return erase(r);
  try {
    const p = await prove<DeviceProfile>(r, r.pending ?? "login");
    if (r.pending) {
      r.pending = null;
      await save(r);
    }
    return p;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404 && !r.pending) {
      await clear();
      return null;
    }
    throw e;
  }
}
const locked = <T>(fn: () => Promise<T>) =>
  navigator.locks.request("prival-profile", fn);
export const identity = window.privalDevice ?? {
  profile: () =>
    locked(async () => {
      const r = await read();
      return r ? resume(r) : null;
    }),
  create: (nick: string) =>
    locked(async () => {
      let r = await read();
      if (!r) {
        const pair = (await crypto.subtle.generateKey(
          { name: "Ed25519" },
          false,
          ["sign", "verify"],
        )) as CryptoKeyPair;
        r = {
          nick,
          privateKey: pair.privateKey,
          publicKey: encoding(
            await crypto.subtle.exportKey("spki", pair.publicKey),
          ),
          pending: "register",
        };
        await save(r);
      }
      const result = await resume(r);
      if (!result) throw Error("Профиль удалён. Повторите создание.");
      return result;
    }),
  erase: () =>
    locked(async () => {
      const r = await read();
      return r ? erase(r) : null;
    }),
};
