import net from "node:net";
import tls from "node:tls";
import { readFileSync } from "node:fs";
import { pipeline } from "node:stream";

// Only the forwarded TCP port is public. The destination is the local SFU's
// authenticated TURN/TLS listener; never accept a destination from a peer.
const { PRIVATE_IP, TURN_CA_FILE } = process.env;
if (!net.isIPv4(PRIVATE_IP) || !TURN_CA_FILE)
  throw Error("Задайте PRIVATE_IP и TURN_CA_FILE");
const ca = readFileSync(TURN_CA_FILE);
net
  .createServer((incoming) => {
    const outgoing = tls.connect({
      host: PRIVATE_IP,
      port: 443,
      ca,
      rejectUnauthorized: true,
    });
    const close = () => {
      incoming.destroy();
      outgoing.destroy();
    };
    incoming.on("error", close).on("close", close);
    outgoing.on("error", (error) => {
      console.error("TURN bridge TLS:", error.code ?? error.message);
      close();
    }).on("close", close);
    outgoing.once("secureConnect", () => {
      console.log("TURN bridge TLS connected");
      pipeline(incoming, outgoing, () => close());
      pipeline(outgoing, incoming, () => close());
    });
  })
  .listen(19444, "127.0.0.1");
