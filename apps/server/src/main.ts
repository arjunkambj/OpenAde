/**
 * Entry point of the OpenAde server.
 *
 * W10 composes the real Layers here and prints the handshake
 * `{ url, token, serverInstanceId }` on fd 3 (decision D3). Until then this
 * prints one placeholder JSON line so the dev and build scripts are exercised
 * end to end.
 */

const line = JSON.stringify({
  name: "server",
  status: "placeholder",
  pid: process.pid,
});

process.stdout.write(`${line}\n`);
