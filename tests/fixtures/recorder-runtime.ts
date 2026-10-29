// Executed in a separate tsx process to exercise the production transform.
import { createServer } from "node:http";
import { Recorder } from "../../packages/recorder/src/index.js";
import { demoEnv } from "../../apps/server/src/demo.js";
import { createGeneration } from "../../packages/planner/src/workflow.js";
import { MockAIProvider } from "../../packages/planner/src/index.js";
const server = createServer((req, res) => {
  const path = req.url ?? "/";
  let body: string;
  if (path.startsWith("/api/")) body = JSON.stringify({ ok: true });
  else if (path === "/frame")
    body =
      "<h1>Frame context</h1><button onclick=\"fetch('/api/frame')\">Frame request</button>";
  else if (path === "/popup")
    body = `<h1>Popup context</h1><script>
        fetch('/api/popup-initial-get');
        fetch('/api/popup-initial-post', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({from:'popup'})});
      </script><iframe src="/popup-frame"></iframe><button onclick="fetch('/api/popup')">Popup request</button>`;
  else if (path === "/popup-frame")
    body = `<script>const xhr = new XMLHttpRequest();xhr.open('GET','/api/popup-frame');xhr.send();</script>`;
  else
    body =
      '<main><h1>Main context</h1><textarea>private-default-value</textarea><button onclick="fetch(\'/api/main\')">Main request</button><a href="/popup" target="_blank">Open popup</a><iframe src="/frame"></iframe></main>';
  res.writeHead(200, {
    "content-type": path.startsWith("/api/") ? "application/json" : "text/html",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const environment = { ...demoEnv, baseURL, allowedOrigins: [baseURL] };
const recorder = new Recorder(
  { caseName: "runtime", scenario: "record context", target: baseURL },
  environment,
);
const errors: string[] = [];
try {
  const page = await recorder.start(true);
  recorder.context!.on("page", (p) =>
    p.on("pageerror", (e) => errors.push(e.message)),
  );
  page.on("pageerror", (e) => errors.push(e.message));
  await page.reload();
  await page.locator("textarea").fill("private-typed-value");
  await page.getByRole("button", { name: "Main request", exact: true }).click();
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "Frame request" })
    .click();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open popup" }).click();
  const popup = await popupPromise;
  await popup.getByRole("button", { name: "Popup request" }).click();
  await popup.frameLocator("iframe").locator("body").waitFor();
  await popup.waitForTimeout(400);
  const recording = await recorder.stop();
  const job = createGeneration(
    { recording, assets: [], environment },
    new MockAIProvider(),
  );
  console.log(
    JSON.stringify({ recording, modelRecording: job.input.recording, errors }),
  );
} finally {
  await recorder.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
