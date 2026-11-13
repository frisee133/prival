export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch("/api" + path, {
    method,
    signal,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new HttpError(r.status, data.error ?? "Ошибка запроса");
  return data;
}
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Не удалось выполнить действие";
export const time = (s: string) =>
  new Date(s).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
