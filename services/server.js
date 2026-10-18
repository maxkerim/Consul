// =====================================================================
// DUMMY SERVICE (Service A / B / C)
//
// Один и тот же код запускается три раза с разными переменными окружения.
// Что делает сервис:
//   1. Поднимает HTTP-сервер с эндпоинтами /info и /health
//   2. При старте РЕГИСТРИРУЕТ себя в Consul (это и есть "service discovery")
//   3. При остановке УДАЛЯЕТ себя из Consul
//
// Внешних библиотек нет: используем только встроенные модули Node.js 20+
// (http, os) и глобальный fetch.
// =====================================================================
const http = require('http');
const os = require('os');

// ---- Конфигурация берётся из переменных окружения (см. docker-compose.yml) ----
// Так один образ можно запустить как service-a, service-b, service-c.
const NAME = process.env.SERVICE_NAME || 'service-a';           // имя в Consul (по нему ищет gateway)
const DISPLAY_NAME = process.env.SERVICE_DISPLAY_NAME || NAME;  // красивое имя для ответа: "Service A"
const PORT = Number(process.env.PORT || 3000);                  // порт HTTP-сервера
const CONSUL = process.env.CONSUL_HTTP_ADDR || 'http://localhost:8500'; // адрес Consul API

// Адрес, по которому ДРУГИЕ контейнеры смогут достучаться до этого сервиса.
// В Docker hostname контейнера резолвится во внутренней сети в его IP.
const ADDRESS = process.env.SERVICE_ADDRESS || os.hostname();

// Уникальный ID экземпляра. Имя (NAME) у всех копий одного сервиса одинаковое,
// а ID должен быть разным, иначе Consul перепишет одну регистрацию другой.
const ID = `${NAME}-${ADDRESS}-${PORT}`;

// ---------------------------------------------------------------------
// ШАГ 1. HTTP-сервер
// ---------------------------------------------------------------------
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.url === '/health') {
    // Consul будет дёргать этот URL каждые 5 секунд.
    // Ответ 200 = "я жив". Нет ответа или ошибка = Consul перестанет отдавать нас gateway.
    res.end(JSON.stringify({ status: 'ok' }));
  } else if (req.url === '/info') {
    // Тот самый "dummy endpoint" из задания: имя сервиса + текущее время.
    res.end(JSON.stringify({ service: DISPLAY_NAME, timestamp: new Date().toISOString() }));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

// ---------------------------------------------------------------------
// ШАГ 2. Регистрация в Consul
// Документация: PUT /v1/agent/service/register
// ---------------------------------------------------------------------
async function register() {
  const body = {
    ID,               // уникальный id экземпляра
    Name: NAME,       // имя сервиса, по которому его будут искать
    Address: ADDRESS, // куда слать запросы
    Port: PORT,
    // Health check: Consul сам ходит на этот URL и решает, жив ли сервис.
    Check: {
      HTTP: `http://${ADDRESS}:${PORT}/health`,
      Interval: '5s',  // как часто проверять
      Timeout: '2s',   // сколько ждать ответа
      // Если сервис "критичен" дольше 30с (например, контейнер убили без
      // корректного завершения), Consul сам удалит запись из реестра.
      DeregisterCriticalServiceAfter: '30s',
    },
  };

  // Retry-цикл: при docker compose up Consul может стартовать позже сервиса
  // (depends_on ждёт только запуск контейнера, а не готовность Consul).
  // Поэтому пробуем, пока не получится.
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
      await new Promise((resolve) => setTimeout(resolve, 2000)); // пауза 2с
    }
  }
}

// ---------------------------------------------------------------------
// ШАГ 3. Удаление из Consul при остановке
// ---------------------------------------------------------------------
async function deregister() {
  try {
    await fetch(`${CONSUL}/v1/agent/service/deregister/${ID}`, { method: 'PUT' });
    console.log(`[${NAME}] deregistered`);
  } catch (_) {
    // Если Consul недоступен, ничего страшного: DeregisterCriticalServiceAfter подчистит.
  }
}

// Старт: сначала слушаем порт, потом регистрируемся
// (чтобы к моменту первой проверки /health сервер уже отвечал).
server.listen(PORT, () => {
  console.log(`[${NAME}] listening on ${PORT}`);
  register();
});

// `docker compose stop` шлёт SIGTERM, Ctrl+C шлёт SIGINT.
// Перехватываем их, чтобы успеть сказать Consul "я ухожу".
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await deregister();
    server.close(() => process.exit(0));
  });
}
