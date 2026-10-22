import Fastify from "fastify";
import { randomUUID } from "node:crypto";
export function demoApp() {
  const app = Fastify();
  const sessions = new Set<string>();
  const orders = new Map<string, { id: string; name: string }>();
  app.get("/", async (_req, reply) =>
    reply.type("text/html")
      .send(`<!doctype html><html lang="zh"><meta charset="UTF-8"><title>订单演示</title><body><h1>订单演示</h1><form id="login"><label>用户名<input name="username" id="username"></label><label>密码<input type="password" name="password" id="password"></label><button>登录</button></form><main id="home" hidden><h2>订单工作台</h2><button id="create">创建测试订单</button><div id="orders"></div></main><script>
 const login=document.querySelector('#login'),home=document.querySelector('#home');
 async function refresh(){const r=await fetch('/api/orders');if(!r.ok)return;const rows=await r.json();document.querySelector('#orders').replaceChildren(...rows.map(o=>{const d=document.createElement('div');d.textContent=o.name+' ';const b=document.createElement('button');b.textContent='删除';b.onclick=async()=>{await fetch('/api/orders/'+o.id,{method:'DELETE'});await refresh()};d.append(b);return d}))}
 login.onsubmit=async e=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:document.querySelector('#username').value,password:document.querySelector('#password').value})});if(r.ok){login.hidden=true;home.hidden=false;await refresh()}};
 document.querySelector('#create').onclick=async()=>{await fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'自动化测试订单'})});await refresh()};
 </script></body></html>`),
  );
  app.post("/login", async (req, reply) => {
    const b = req.body as { username: string; password: string };
    if (b.username !== "tester" || b.password !== "demo-only")
      return reply.code(401).send({ error: "Invalid demo credentials" });
    const sid = randomUUID();
    sessions.add(sid);
    return reply
      .header("set-cookie", `session=${sid}; HttpOnly; SameSite=Strict; Path=/`)
      .send({ ok: true });
  });
  app.addHook("preHandler", async (req, reply) => {
    if (
      req.url.startsWith("/api/") &&
      !sessions.has(req.headers.cookie?.match(/session=([^;]+)/)?.[1] ?? "")
    )
      return reply.code(401).send({ error: "Login required" });
  });
  app.get("/api/orders", async () => [...orders.values()]);
  app.post("/api/orders", async (req, reply) => {
    const body = req.body as { name?: string };
    const o = { id: randomUUID(), name: body?.name ?? "测试订单" };
    orders.set(o.id, o);
    return reply.code(201).send(o);
  });
  app.get<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (req, reply) =>
      orders.get(req.params.id) ?? reply.code(404).send({ error: "Not found" }),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/orders/:id",
    async (req, reply) => {
      orders.delete(req.params.id);
      return reply.code(204).send();
    },
  );
  return app;
}
