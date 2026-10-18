// =====================================================================
// API GATEWAY
//
// Единая точка входа. Клиент знает только адрес gateway (localhost:8080),
// а где реально живут сервисы, gateway выясняет через Consul.
//
// Маршруты:
//   GET /service-a/info   -> проксируется на service-a, путь /info
//   GET /service-b/info   -> service-b
//   GET /service-c/info   -> service-c
//   GET /services         -> что сейчас видит Consul (для отладки)
//   GET /health           -> проверка самого gateway
//
// Логика: первая часть пути = имя сервиса в Consul, остальное = путь на сервисе.
// =====================================================================
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const CONSUL = process.env.CONSUL_HTTP_ADDR || 'http://localhost:8500';

// Счётчики для round-robin: если у сервиса несколько экземпляров,
// запросы чередуются между ними (балансировка нагрузки).
const counters = {};

// ---------------------------------------------------------------------
// SERVICE DISCOVERY: спрашиваем Consul, кто сейчас жив под именем `name`.
// Используем HTTP API. (Альтернатива из задания: DNS-интерфейс Consul,
// например `dig @consul -p 8600 service-a.service.consul SRV`.)
//
// ?passing=true  -> только экземпляры, у которых health check проходит.
// Именно это отличает service discovery от статического конфига:
// упавшие сервисы автоматически пропадают из выдачи.
// ---------------------------------------------------------------------
async function discover(name) {
  const r = await fetch(`${CONSUL}/v1/health/service/${encodeURIComponent(name)}?passing=true`);
  if (!r.ok) throw new Error(`Consul responded ${r.status}`);
  const entries = await r.json();
  return entries.map((e) => ({
    id: e.Service.ID,
    // Если у сервиса не задан Address, берём адрес ноды Consul.
    address: e.Service.Address || e.Node.Address,
    port: e.Service.Port,
  }));
}

// Выбор экземпляра по кругу: 0,1,2,0,1,2...
function pick(name, instances) {
  counters[name] = ((counters[name] || 0) + 1) % instances.length;
  return instances[counters[name]];
}

// Маленький хелпер для JSON-ответов.
function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    // --- служебные маршруты ---
    if (req.url === '/health') return send(res, 200, { status: 'ok' });

    if (req.url === '/services') {
      // Каталог Consul: список всех имён сервисов. Себя ("consul") пропускаем.
      const r = await fetch(`${CONSUL}/v1/catalog/services`);
      const catalog = await r.json();
      const result = {};
      for (const name of Object.keys(catalog).filter((n) => n !== 'consul')) {
        result[name] = await discover(name);
      }
      return send(res, 200, result);
    }

    // --- маршрутизация: /<service-name>/<path> ---
    // Регулярка разбирает URL на три части: имя сервиса, путь, query-строку.
    const m = req.url.match(/^\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, name, path = '/', query = ''] = m;

    // 1) узнаём у Consul, где сервис
    const instances = await discover(name);
    if (instances.length === 0) {
      // Сервиса нет или все экземпляры нездоровы -> 503 Service Unavailable
      return send(res, 503, { error: `no healthy instances of "${name}" in Consul` });
    }

    // 2) выбираем экземпляр и формируем целевой URL
    const target = pick(name, instances);
    const url = `http://${target.address}:${target.port}${path}${query}`;

    // 3) проксируем запрос и возвращаем ответ клиенту как есть
    const upstream = await fetch(url, { method: req.method });
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.setHeader('X-Routed-To', `${target.address}:${target.port}`); // видно, куда ушёл запрос
    res.end(await upstream.text());
  } catch (err) {
    // Consul или сервис недоступны -> 502 Bad Gateway
    send(res, 502, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`[gateway] listening on ${PORT}, consul=${CONSUL}`));
