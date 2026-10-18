# Пошаговый гайд: Service Discovery с Consul на Python

Этот гайд показывает, как собрать проект самому, шаг за шагом, и объясняет, зачем нужен каждый шаг.
Готовый результат лежит в репозитории, можно сверяться с ним.

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

Нужны Docker и Docker Compose. Python на машине нужен только для запуска без Docker.

```bash
mkdir service-discovery && cd service-discovery
mkdir services gateway
git init
```

Структура, к которой придём:

```
service-discovery/
├── docker-compose.yml
├── services/   (app.py, requirements.txt, Dockerfile)
└── gateway/    (app.py, requirements.txt, Dockerfile)
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

Проверка: `docker compose up consul`, затем откройте http://localhost:8500. Пока там только сам consul.

## Шаг 2. Dummy-сервис (`services/app.py`)

Используем Flask для HTTP-сервера и requests для обращений к Consul. Файл `services/requirements.txt`:

```
flask==3.0.3
requests==2.32.3
```

Что в `app.py` и зачем:

1. **Конфигурация через переменные окружения** (`SERVICE_NAME`, `PORT`, `CONSUL_HTTP_ADDR`). Благодаря этому один код запускается как Service A, B и C.
2. **Эндпоинты** `/info` (имя и время, по заданию) и `/health`. Эндпоинт `/health` нужен, чтобы Consul мог проверять, жив ли сервис.
3. **Регистрация при старте** (`register()`): запрос `PUT /v1/agent/service/register` с именем, адресом, портом и health check. Это ключевая часть задания: сервис сам себя добавляет в реестр.
4. **Retry при регистрации**: Consul может подняться позже сервиса, поэтому пробуем снова каждые 2 секунды.
5. **Фоновый поток**: `app.run()` блокирует главный поток, поэтому регистрация идёт в отдельном потоке (`threading.Thread`).
6. **Удаление при остановке** (`SIGTERM`/`SIGINT`): сервис сообщает Consul, что уходит, чтобы gateway не слал ему запросы. Если контейнер убили жёстко, сработает `DeregisterCriticalServiceAfter: 30s`.

Почему уникальный `SERVICE_ID`: имя `service-a` может принадлежать нескольким экземплярам, а ID у каждого свой. Иначе при масштабировании регистрации перезаписывали бы друг друга.

`services/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
CMD ["python", "app.py"]
```

Зависимости копируются и ставятся отдельным слоем до копирования кода: пока `requirements.txt` не менялся, Docker берёт этот слой из кэша, и пересборка идёт быстро.

## Шаг 3. API Gateway (`gateway/app.py`)

Логика:

1. Берём из URL имя сервиса: `/service-a/info` -> имя `service-a`, путь `info`.
2. **Discovery** (`discover()`): `GET /v1/health/service/service-a?passing=true`. Параметр `passing=true` - главная деталь: Consul вернёт только экземпляры с пройденным health check. Упавшие сервисы исчезают из выдачи сами.
3. Выбираем экземпляр (`pick()`, round-robin, если их несколько).
4. Проксируем запрос на `http://<address>:<port>/info` и возвращаем ответ клиенту. В заголовке `X-Routed-To` видно, куда ушёл запрос.
5. Если здоровых экземпляров нет - `503`. Если недоступен сам Consul или сервис - `502`.

Дополнительно `/services` показывает, что gateway видит в Consul. Это удобно для отладки.

Про DNS: задание допускает и DNS-интерфейс Consul. Мы используем HTTP API, потому что он отдаёт порт и статус health check в удобном JSON. DNS проще, но менее гибкий. Работу DNS можно проверить командой:

```bash
dig @127.0.0.1 -p 8600 service-a.service.consul SRV
```

`requirements.txt` и `Dockerfile` для gateway такие же, как у сервисов, плюс `EXPOSE 8080`.

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

`service-b` и `service-c` отличаются только именами. Остальное:
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
for i in 1 2 3 4 5 6; do curl -si http://localhost:8080/service-a/info | grep X-Routed-To; done
```

В третьем эксперименте заголовок `X-Routed-To` покажет разные адреса: gateway сам нашёл новые экземпляры и распределяет между ними нагрузку, хотя мы ничего в нём не меняли.

## Шаг 7. Запуск без Docker (по желанию)

Если у вас есть Consul локально (`consul agent -dev`), можно запустить всё напрямую:

```bash
pip install -r services/requirements.txt
SERVICE_NAME=service-a SERVICE_DISPLAY_NAME="Service A" PORT=3001 SERVICE_ADDRESS=127.0.0.1 python services/app.py
PORT=8080 python gateway/app.py
```

## Шаг 8. Отправка на GitHub

```bash
git add -A
git commit -m "Service discovery with Consul"
git remote add origin https://github.com/<логин>/<репозиторий>.git
git branch -M main
git push -u origin main
```

## Что мы изучили (цели задания)

| Цель | Где в проекте |
|------|---------------|
| Как сервисы регистрируются в Consul | `register()` в `services/app.py` |
| Как запрашивать информацию у Consul | `discover()` в `gateway/app.py`, `/v1/health/service/...` |
| Базовый механизм service discovery | gateway ищет адреса по имени, а не из конфига |
| Связь сервис-сервис в микросервисах | gateway находит и проксирует запросы к сервисам |
