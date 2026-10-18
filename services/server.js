// Dummy service: exposes /info and /health, registers itself in Consul on startup.
const http = require('http');
const os = require('os');

const NAME = process.env.SERVICE_NAME || 'service-a';
const DISPLAY_NAME = process.env.SERVICE_DISPLAY_NAME || NAME;
const PORT = Number(process.env.PORT || 3000);
const CONSUL = process.env.CONSUL_HTTP_ADDR || 'http://localhost:8500';
const ADDRESS = process.env.SERVICE_ADDRESS || os.hostname();
const ID = `${NAME}-${ADDRESS}-${PORT}`;

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok' }));
  } else if (req.url === '/info') {
    res.end(JSON.stringify({ service: DISPLAY_NAME, timestamp: new Date().toISOString() }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

async function register() {
  const body = {
    ID,
    Name: NAME,
    Address: ADDRESS,
    Port: PORT,
    Check: {
      HTTP: `http://${ADDRESS}:${PORT}/health`,
      Interval: '5s',
      Timeout: '2s',
      DeregisterCriticalServiceAfter: '30s',
    },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`${CONSUL}/v1/agent/service/register`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`status ${r.status}`);
      console.log(`[${NAME}] registered in Consul as ${ID}`);
      return;
    } catch (err) {
      console.log(`[${NAME}] Consul not ready (attempt ${attempt}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function deregister() {
  try {
    await fetch(`${CONSUL}/v1/agent/service/deregister/${ID}`, { method: 'PUT' });
    console.log(`[${NAME}] deregistered`);
  } catch (_) {}
}

server.listen(PORT, () => {
  console.log(`[${NAME}] listening on ${PORT}`);
  register();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await deregister();
    server.close(() => process.exit(0));
  });
}
