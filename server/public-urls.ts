export function secureOrigins(canonical: string, aliases: string | undefined) {
  const values = [
    canonical,
    ...(aliases ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ];
  return new Set(
    values.map((value) => {
      const u = new URL(value);
      if (
        u.protocol !== "https:" &&
        !(
          u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
        )
      )
        throw Error("Для сетевого адреса требуется HTTPS");
      return u.origin;
    }),
  );
}
export function voiceAddress(setting: string, origin: string) {
  if (setting === "same-origin") {
    const u = new URL(origin);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.origin;
  }
  const u = new URL(setting);
  if (
    !["ws:", "wss:"].includes(u.protocol) ||
    (origin.startsWith("https:") && u.protocol !== "wss:")
  )
    throw Error("Некорректный публичный адрес сигналинга");
  return u.href;
}

export function friendLinkOrigin(canonical: string, configured?: string) {
  const url = new URL(configured || canonical);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("FRIEND_LINK_ORIGIN должен содержать только адрес сайта");
  if (
    url.protocol !== "https:" ||
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return null;
  return url.origin;
}
