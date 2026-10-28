import { defaultDatabaseURL } from "../../../packages/storage/src/index.js";
import { createApp } from "./app.js";
import { demoApp } from "../../demo-app/src/app.js";
// Headed replay is opt-in so normal server and CI execution remain headless.
if (process.argv.some((arg) => arg === "--headed" || arg === "--head")) {
  process.env.RUN_HEADLESS = "false";
  process.env.RUN_SLOW_MO_MS ??= "500";
}
process.env.DEMO_PASSWORD ??= "demo-only";
const demo = demoApp();
await demo.listen({ port: 3100, host: "127.0.0.1" });
const app = await createApp();
await app.listen({ port: 3000, host: "127.0.0.1" });
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void Promise.all([app.close(), demo.close()]).then(() => process.exit());
  });
console.log("Platform API :3000; demo :3100. Start web with pnpm web.");

console.log("Persistent database:", defaultDatabaseURL());
console.log(
  process.env.RUN_HEADLESS === "false"
    ? "Replay browser: headed (visible on the backend host)."
    : "Replay browser: headless. Use pnpm dev:headed for visible UI replay.",
);
