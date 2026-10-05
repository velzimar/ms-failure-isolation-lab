// Three fake internal microservices on ports 4001-4003. Each answers in ~200 ms.
// Make one slow:   curl "localhost:4002/slow?ms=20000"
// Heal it:         curl "localhost:4002/slow?ms=0"
const http = require('http');
const extra = {};
for (const port of [4001, 4002, 4003]) {
  extra[port] = 0;
  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/slow') {
      extra[port] = Number(u.searchParams.get('ms') || 0);
      return res.end(`service ${port} extra latency = ${extra[port]} ms\n`);
    }
    setTimeout(() => res.end(JSON.stringify({ service: port })), 200 + extra[port]);
  }).listen(port, () => console.log(`mock service on :${port}`));
}
