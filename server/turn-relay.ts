import { createHash } from "node:crypto";

// LiveKit 1.13.11 uses jxskiss/base62 bit packing for its built-in TURN credentials.
// The number of bits remaining matters for inputs beginning with zero bytes.
function livekitBase62(bytes: Buffer) {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let bits = BigInt("0x" + bytes.toString("hex"));
  let remaining = bytes.length * 8;
  let result = "";
  while (remaining > 0) {
    const value = Number(bits & 63n);
    const compact = (value & 30) === 30;
    const width = compact && (remaining > 6 || value > 31) ? 5 : 6;
    result += alphabet[compact ? value & 31 : value];
    bits >>= BigInt(width);
    remaining -= width;
  }
  return result;
}

export function tunnelIceServer(
  url: string,
  key: string,
  secret: string,
  lease: string,
) {
  if (!/^turn:[a-z0-9.-]+:[1-9][0-9]{0,4}\?transport=tcp$/i.test(url))
    throw Error("Некорректный адрес TCP-ретранслятора");
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const suffix = "|" + lease + "|" + expiry;
  return {
    urls: url,
    username: livekitBase62(Buffer.from(key + suffix)),
    credential: livekitBase62(
      createHash("sha256")
        .update(secret + suffix)
        .digest(),
    ),
  };
}
