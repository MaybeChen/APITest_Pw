import { createServer } from "node:http";
import { expect, it } from "vitest";
import { UIRecorder } from "../../packages/recorder/src/ui-recorder";
import { uiAuthenticate } from "../../packages/runner/src/index";
import { demoEnv } from "../../apps/server/src/demo";
import type { AuthProfile } from "../../packages/contracts/src/index";

it.each([
  { reset: false, selector: undefined },
  { reset: false, selector: "  " },
  { reset: true, selector: "#ready" },
])(
  "waits for login initialization and blocks reset fields (reset=$reset, selector=$selector)",
  async ({ reset, selector }) => {
    let submissions = 0;
    let submittedUser: string | null = null;
    const server = createServer((req, res) => {
      if (req.url === "/login") {
        res.setHeader("content-type", "text/html");
        res.end(`<form action="/done"><input id="user" name="user"><input id="password" name="password" type="password"><button id="login">Login</button></form><script>
        fetch('/initialize').then(r=>r.text()).then(()=>{document.querySelector('#user').value='';document.querySelector('#password').value='';document.body.dataset.initialized='true';});
        ${reset ? "document.querySelector('#password').addEventListener('input',()=>setTimeout(()=>document.querySelector('#user').value='',100));" : ""}
      </script>`);
      } else if (req.url === "/initialize") {
        setTimeout(() => res.end("initialized"), 700);
      } else {
        submissions++;
        submittedUser = new URL(req.url!, "http://localhost").searchParams.get(
          "user",
        );
        res.setHeader("content-type", "text/html");
        res.end('<div id="ready">Ready</div>');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const env = { ...demoEnv, baseURL, allowedOrigins: [baseURL] };
    const recorder = new UIRecorder(env, baseURL + "/login");
    try {
      await recorder.start(true);
      await recorder
        .context!.pages()[0]
        .waitForFunction(() => document.body.dataset.initialized === "true");
      const profile: AuthProfile = {
        id: "login-ready",
        actions: [
          { type: "navigate", target: "/login" },
          { type: "fill", target: "#user", value: "private-user" },
          { type: "fill", target: "#password", value: "private-password" },
          { type: "click", target: "#login" },
        ],
        readySelector: selector,
        headers: {},
        tokenSources: {},
        reauthenticateReads: false,
      };
      const authentication = uiAuthenticate(
        recorder.context!,
        recorder.context!.pages()[0],
        profile,
        env,
      );
      if (reset) {
        await expect(authentication).rejects.toThrow(
          "前置 UI 输入校验失败：#user",
        );
        expect(submissions).toBe(0);
      } else {
        await authentication;
        expect(submissions).toBe(1);
        expect(submittedUser).toBe("private-user");
      }
    } finally {
      await recorder.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
