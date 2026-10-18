// API Gateway: discovers services via the Consul HTTP API and proxies requests.
//   GET /service-a/info  -> service-a /info
//   GET /service-b/info  -> service-b /info
//   GET /service-c/info  -> service-c /info
//   GET /services        -> list of healthy instances known to Consul
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const CONSUL = process.env.CONSUL_HTTP_ADDR || 'http://localhost:8500';

const counters = {}; // round-robin per service

async function discover(name) {
  const r = await fetch(`${CONSUL}/v1/health/service/${encodeURIComponent(name)}?passing=true`);
  if (!r.ok) throw new Error(`Consul responded ${r.status}`);
  const entries = await r.json();
  return entries.map((e) => ({
    id: e.Service.ID,
    address: e.Service.Address || e.Node.Address,
    port: e.Service.Port,
  }));
}

function pick(name, instances) {
  counters[name] = ((counters[name] || 0) + 1) % instances.length;
  return instances[counters[name]];
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { status: 'ok' });

    if (req.url === '/services') {
      const r = await fetch(`${CONSUL}/v1/catalog/services`);
      const catalog = await r.json();
      const result = {};
      for (const name of Object.keys(catalog).filter((n) => n !== 'consul')) {
        result[name] = await discover(name);
      }
      return send(res, 200, result);
    }

    // /<service-name>/<path...>
    const m = req.url.match(/^\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, name, path = '/', query = ''] = m;

    const instances = await discover(name);
    if (instances.length === 0) {
      return send(res, 503, { error: `no healthy instances of "${name}" in Consul` });
    }
    const target = pick(name, instances);
    const url = `http://${target.address}:${target.port}${path}${query}`;
    const upstream = await fetch(url, { method: req.method });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('X-Routed-To', `${target.address}:${target.port}`);
    res.end(await upstream.text());
  } catch (err) {
    send(res, 502, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`[gateway] listening on ${PORT}, consul=${CONSUL}`));
