import { createApp } from "./app.js";
import { demoApp } from "../../demo-app/src/app.js";
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
