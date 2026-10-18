# Пошаговый гайд: Service Discovery с Consul с нуля

Этот гайд показывает, как собрать проект самому, шаг за шагом, и объясняет, зачем нужен каждый шаг.
Готовый результат уже лежит в репозитории, так что можно сверяться с ним.

## Что мы строим

```
 клиент (curl)
     │
     ▼
 gateway :8080 ──── "где service-a?" ────► Consul :8500
     │                                        ▲   ▲   ▲
     │  проксирует на найденный адрес         │   │   │ регистрация + health check
     ▼                                        │   │   │
 service-a / service-b / service-c :3000 ─────┴───┴───┘
```

Идея: адреса сервисов нигде не прописаны. Каждый сервис сам сообщает Consul, где он живёт, а gateway спрашивает об этом Consul.

## Шаг 0. Подготовка

Нужны Docker и Docker Compose. Node.js на машине нужен только для локальной проверки кода.

```bash
mkdir service-discovery && cd service-discovery
mkdir services gateway
git init
```

Структура, к которой придём:

```
service-discovery/
├── docker-compose.yml
├── services/   (server.js, package.json, Dockerfile)
└── gateway/    (server.js, package.json, Dockerfile)
```

## Шаг 1. Consul

Consul - это реестр сервисов. В `docker-compose.yml` добавляем его первым:

```yaml
services:
  consul:
    image: hashicorp/consul:1.19
    command: agent -dev -client=0.0.0.0 -ui
    ports:
      - "8500:8500"       # HTTP API и веб-интерфейс
      - "8600:8600/udp"   # DNS-интерфейс
```

Разбор:
- `agent -dev` - режим разработки: один узел, данные в памяти, настройки не нужны. Для обучения идеально, для продакшена не подходит.
- `-client=0.0.0.0` - слушать не только localhost, иначе другие контейнеры не достучатся.
- `-ui` - включает веб-интерфейс на http://localhost:8500.
- Порт 8500 - HTTP API, через него сервисы регистрируются, а gateway ищет их. Порт 8600 - DNS: `service-a.service.consul` резолвится в адрес сервиса.

Проверка: `docker compose up consul`, затем откройте http://localhost:8500. Список сервисов пока пустой (там только сам consul).

## Шаг 2. Dummy-сервис

Файл `services/server.js` (полный код с комментариями лежит в репозитории). Что в нём и зачем:

1. **HTTP-сервер** с `/info` (имя и время, по заданию) и `/health`. Эндпоинт `/health` нужен, чтобы Consul мог проверять, жив ли сервис.
2. **Конфигурация через переменные окружения** (`SERVICE_NAME`, `PORT`, `CONSUL_HTTP_ADDR`). Благодаря этому один код запускается как Service A, B и C.
3. **Регистрация при старте**: запрос `PUT /v1/agent/service/register` с именем, адресом, портом и health check. Это ключевая часть задания - сервис сам себя добавляет в реестр.
4. **Retry при регистрации**: Consul может подняться позже сервиса, поэтому пробуем снова каждые 2 секунды.
5. **Удаление при остановке** (`SIGTERM`/`SIGINT`): сервис сообщает Consul, что уходит, чтобы gateway не слал ему запросы. Если контейнер убили жёстко, сработает `DeregisterCriticalServiceAfter: 30s`.

Почему уникальный `ID`: имя `service-a` может принадлежать нескольким экземплярам, а `ID` у каждого свой. Иначе при масштабировании регистрации перезаписывали бы друг друга.

`services/package.json` - минимальный, без зависимостей:

```json
{ "name": "dummy-service", "version": "1.0.0", "private": true, "main": "server.js" }
```

`services/Dockerfile`:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json server.js ./
CMD ["node", "server.js"]
```

Node 20 выбран потому, что в нём есть встроенный `fetch`, и сторонние библиотеки не нужны.

## Шаг 3. API Gateway

Файл `gateway/server.js`. Логика:

1. Берём из URL имя сервиса: `/service-a/info` -> имя `service-a`, путь `/info`.
2. **Discovery**: `GET /v1/health/service/service-a?passing=true`. Параметр `passing=true` - главная деталь: Consul вернёт только экземпляры с пройденным health check. Упавшие сервисы исчезают из выдачи сами.
3. Выбираем экземпляр (round-robin, если их несколько).
4. Проксируем запрос на `http://<address>:<port>/info` и возвращаем ответ клиенту. В заголовке `X-Routed-To` видно, куда ушёл запрос.
5. Если здоровых экземпляров нет - `503`. Если недоступен сам Consul - `502`.

Дополнительно `/services` показывает, что gateway видит в Consul. Это удобно для отладки.

Про DNS: задание допускает и DNS-интерфейс Consul. Мы используем HTTP API, потому что он отдаёт порт и статус health check в удобном JSON. DNS проще, но менее гибкий. Работу DNS можно проверить командой:

```bash
dig @127.0.0.1 -p 8600 service-a.service.consul SRV
```

`package.json` и `Dockerfile` для gateway аналогичны сервисным, плюс `EXPOSE 8080`.

## Шаг 4. docker-compose.yml

Добавляем три сервиса и gateway:

```yaml
  service-a:
    build: ./services
    environment:
      SERVICE_NAME: service-a
      SERVICE_DISPLAY_NAME: "Service A"
      PORT: 3000
      CONSUL_HTTP_ADDR: http://consul:8500
    depends_on: [consul]
    networks: [mesh]
```

Ещё два сервиса (`service-b`, `service-c`) отличаются только именами. Остальное:
- `build: ./services` - все три собираются из одного кода.
- `CONSUL_HTTP_ADDR: http://consul:8500` - Docker-сеть сама резолвит имя `consul` в адрес контейнера.
- `networks: mesh` - общая сеть, в которой контейнеры видят друг друга по hostname. Именно по этому hostname сервисы регистрируются в Consul.
- Наружу публикуются только `8500` (Consul UI) и `8080` (gateway). Сами сервисы снаружи недоступны, к ним ходят только через gateway.
- `depends_on` гарантирует лишь порядок запуска контейнеров, а не готовность Consul. Поэтому нужен retry из шага 2.

## Шаг 5. Запуск и проверка

```bash
docker compose up --build
```

```bash
curl http://localhost:8080/service-a/info   # {"service":"Service A","timestamp":"..."}
curl http://localhost:8080/service-b/info
curl http://localhost:8080/service-c/info
curl http://localhost:8080/services         # что видит Consul
```

Откройте http://localhost:8500 и посмотрите на три зелёных сервиса.

## Шаг 6. Эксперименты

Это самая полезная часть: так видно, зачем нужен service discovery.

```bash
# 1. Останавливаем один сервис
docker compose stop service-b
sleep 10
curl http://localhost:8080/service-b/info   # 503: Consul убрал его из выдачи
curl http://localhost:8080/service-a/info   # остальные работают

# 2. Возвращаем
docker compose start service-b
curl http://localhost:8080/service-b/info   # снова работает, без изменений в gateway

# 3. Масштабирование: несколько экземпляров одного сервиса
docker compose up -d --scale service-a=3
# Для этого у service-a в compose нужно убрать container_name (у нас его и нет).
for i in 1 2 3 4 5 6; do curl -si http://localhost:8080/service-a/info | grep X-Routed-To; done
```

В третьем эксперименте заголовок `X-Routed-To` покажет разные адреса: gateway сам нашёл новые экземпляры и распределяет между ними нагрузку, хотя мы ничего в нём не меняли.

## Шаг 7. Отправка на GitHub

```bash
git add -A
git commit -m "Service discovery with Consul"
git remote add origin https://github.com/<логин>/service-discovery.git
git branch -M main
git push -u origin main
```

## Что мы изучили (цели задания)

| Цель | Где в проекте |
|------|---------------|
| Как сервисы регистрируются в Consul | `register()` в `services/server.js` |
| Как запрашивать информацию у Consul | `discover()` в `gateway/server.js`, `/v1/health/service/...` |
| Базовый механизм service discovery | gateway ищет адреса по имени, а не из конфига |
| Связь сервис-сервис в микросервисах | gateway находит и проксирует запросы к сервисам |
