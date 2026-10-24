import fs from "node:fs";
import { InstanceLock } from "./lock.js";

const sock = process.argv[2];
const mode = process.argv[3] || "hold";
const holdMs = Number(process.argv[4] || 800);
if (!sock) {
  console.error("missing lock path");
  process.exit(2);
}

const lock = new InstanceLock(sock);
const result = await lock.acquire();
console.log(result);
if (result !== "acquired") process.exit(0);
  if (mode === "exit-without-release") process.exit(0);
  if (mode === "hold-file") {
    const ready = process.argv[4];
    const release = `${ready}.release`;
    fs.writeFileSync(ready, "acquired");
    while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 15));
    await lock.release();
    process.exit(0);
  }
  if (mode === "release-now") {
  await lock.release();
  process.exit(0);
}
await new Promise((resolve) => setTimeout(resolve, holdMs));
await lock.release();
