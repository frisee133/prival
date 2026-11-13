import tls from "node:tls";
import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

const [host, certificateFile, caFile] = process.argv.slice(2);
const certificate = new X509Certificate(readFileSync(certificateFile));
const socket = tls.connect({
  host,
  port: 443,
  ca: readFileSync(caFile),
  rejectUnauthorized: true,
});
socket.setTimeout(5000, () => socket.destroy(new Error("TURN TLS timeout")));
socket.once("secureConnect", () => {
  if (socket.getPeerCertificate().fingerprint256 !== certificate.fingerprint256) process.exitCode = 3;
  socket.end();
});
socket.once("error", (error) => {
  process.exitCode = error.code === "CERT_HAS_EXPIRED" ? 3 : 1;
  console.log(error.code ?? error.message);
});
