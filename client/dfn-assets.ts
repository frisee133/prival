/// <reference types="vite/client" />
import wasmUrl from "../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/df_bg.wasm?url";
import modelUrl from "../node_modules/@workadventure/noise-suppression/dist/assets/deepfilternet/DeepFilterNet3_onnx.tar.gz?url";

const chunkSize = 256 * 1024;
const maxSize = 32 * 1024 * 1024;
let cached: Promise<{ wasmUrl: string; modelUrl: string }> | undefined;

async function range(url: string, start: number, end: number) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status !== 206)
        throw new Error("Model server must support byte ranges");
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
        response.headers.get("Content-Range") ?? "",
      );
      if (!match || Number(match[1]) !== start || Number(match[3]) > maxSize)
        throw new Error("Invalid model range response");
      const total = Number(match[3]);
      if (Number(match[2]) !== Math.min(end, total - 1))
        throw new Error("Unexpected model range");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== Math.min(end + 1, total) - start)
        throw new Error("Incomplete model range");
      return { total, bytes };
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

async function download(url: string) {
  const first = await range(url, 0, chunkSize - 1);
  const bytes = new Uint8Array(first.total);
  bytes.set(first.bytes);
  let next = chunkSize;
  // Bound concurrency and check each response. The free relay can truncate a
  // multi-megabyte response near its end; these small HTTP ranges avoid that.
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < bytes.length) {
        const start = next;
        next += chunkSize;
        const part = await range(
          url,
          start,
          Math.min(start + chunkSize, bytes.length) - 1,
        );
        if (part.total !== bytes.length)
          throw new Error("Model changed while downloading");
        bytes.set(part.bytes, start);
      }
    }),
  );
  return bytes;
}

export function publicDfnAssets(): Promise<{
  wasmUrl?: string;
  modelUrl?: string;
}> {
  if (!/(\.pinggy-free\.link|\.free\.pinggy\.net)$/.test(location.hostname))
    return Promise.resolve({});
  cached ??= Promise.all([download(wasmUrl + ".gz"), download(modelUrl)])
    .then(async ([wasm, model]) => {
      const decoded = await new Response(
        new Blob([wasm]).stream().pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
      // Stable URLs let the library reuse its compiled module and model cache.
      // The browser releases these document-scoped objects on tab shutdown.
      return {
        wasmUrl: URL.createObjectURL(
          new Blob([decoded], { type: "application/wasm" }),
        ),
        modelUrl: URL.createObjectURL(
          new Blob([model], { type: "application/gzip" }),
        ),
      };
    })
    .catch((error) => {
      cached = undefined;
      throw error;
    });
  return cached;
}
