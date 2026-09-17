import { createServer } from 'node:http';
export const fixtureAccount = { username: 'tester@example.test', password: 'Test-only-4862' };
export async function fixtureWebsite(options: { loginDelayMs?: number } = {}) {
  const page = (body: string) =>
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>通用网站接入验收</title><style>body{font:18px Arial;margin:60px auto;max-width:850px;background:#f5f7fa;color:#173042}main{padding:35px;background:white;border-radius:14px}input,button{display:block;font:inherit;padding:12px;margin:14px 0}button{background:#146851;color:white;border:0;border-radius:6px}label{display:block;margin-top:20px}#result{padding:20px;background:#eaf3ed}li{margin:18px 0}</style><main>${body}</main></html>`;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: 'http://127.0.0.1:3101/health' });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const p = new URLSearchParams(body);
      if (p.get('email') === fixtureAccount.username && p.get('password') === fixtureAccount.password) {
        if (options.loginDelayMs) {
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': 'test_session=authorized; Path=/; HttpOnly; SameSite=Lax',
          });
          res.end(
            page(
              `<h1>Logging in...</h1><script>setTimeout(()=>location.href='/app',${options.loginDelayMs})</script>`,
            ),
          );
          return;
        }
        res.writeHead(302, {
          'set-cookie': 'test_session=authorized; Path=/; HttpOnly; SameSite=Lax',
          location: '/app',
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('<h1>登录失败</h1><p>账号或密码错误</p>'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/already-logged-in') {
      res.end(page('<h1>Dashboard</h1><p>欢迎，测试用户。您已登录。</p>'));
      return;
    }
    if (url.pathname === '/local-session' || url.pathname === '/local-session/check') {
      res.end(
        page(`<h1 id="status">正在验证登录</h1><script>
        const token=localStorage.getItem('auth-token');
        const checking=location.pathname.endsWith('/check');
        const valid=checking?token==='rotated':token==='initial';
        document.getElementById('status').textContent=valid?(checking?'会话已刷新，测试用户':'欢迎，测试用户'):'旧会话已失效';
        if(valid&&!checking)localStorage.setItem('auth-token','rotated');
      </script>`),
      );
      return;
    }
    if (url.pathname === '/login') {
      res.end(
        page(
          '<h1>登录测试商店</h1><form action="/login" method="post"><label>邮箱<input name="email" type="email"></label><label>密码<input name="password" type="password"></label><button>登录</button></form>',
        ),
      );
      return;
    }
    if (url.pathname === '/app' && !req.headers.cookie?.includes('test_session=authorized')) {
      res.writeHead(302, { location: '/login' });
      res.end();
      return;
    }
    if (url.pathname === '/storage' && !req.headers.cookie?.includes('test_session=authorized')) {
      res.end(page('<h1>会话失效</h1>'));
      return;
    }
    res.end(
      page(
        `<h1>${url.pathname === '/' ? '测试商店' : '欢迎，测试用户'}</h1><p>商品查询功能 · 不连接审批样例适配器</p><label>商品名称<input id="query" placeholder="输入商品名称"></label><button onclick="document.querySelector('#result').textContent='搜索结果：'+document.querySelector('#query').value">查询商品</button><button onclick="document.querySelector('#result').textContent='尚未查询'">清空结果</button><div id="result">尚未查询</div><p><a href="/redirect">离开测试网站</a></p>`,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
