"""
API GATEWAY

Единая точка входа. Клиент знает только адрес gateway (localhost:8080),
а где реально живут сервисы, gateway выясняет через Consul.

Маршруты:
  GET /service-a/info   -> проксируется на service-a, путь /info
  GET /service-b/info   -> service-b
  GET /service-c/info   -> service-c
  GET /services         -> что сейчас видит Consul (для отладки)
  GET /health           -> проверка самого gateway

Логика: первая часть пути = имя сервиса в Consul, остальное = путь на сервисе.
"""
import os
from collections import defaultdict
from itertools import count

import requests
from flask import Flask, Response, jsonify, request

PORT = int(os.getenv("PORT", "8080"))
CONSUL = os.getenv("CONSUL_HTTP_ADDR", "http://localhost:8500")

app = Flask(__name__)

# Счётчики для round-robin: если у сервиса несколько экземпляров,
# запросы чередуются между ними (балансировка нагрузки).
counters = defaultdict(count)


# ---------------------------------------------------------------------
# SERVICE DISCOVERY: спрашиваем Consul, кто сейчас жив под именем `name`.
# Используем HTTP API. (Альтернатива из задания: DNS-интерфейс Consul,
# например `dig @consul -p 8600 service-a.service.consul SRV`.)
#
# passing=true -> только экземпляры, у которых health check проходит.
# Именно это отличает service discovery от статического конфига:
# упавшие сервисы автоматически пропадают из выдачи.
# ---------------------------------------------------------------------
def discover(name):
    r = requests.get(
        f"{CONSUL}/v1/health/service/{name}", params={"passing": "true"}, timeout=3
    )
    r.raise_for_status()
    return [
        {
            "id": e["Service"]["ID"],
            # Если у сервиса не задан Address, берём адрес ноды Consul.
            "address": e["Service"]["Address"] or e["Node"]["Address"],
            "port": e["Service"]["Port"],
        }
        for e in r.json()
    ]


def pick(name, instances):
    # Выбор экземпляра по кругу: 0, 1, 2, 0, 1, 2...
    return instances[next(counters[name]) % len(instances)]


# --- служебные маршруты ---
@app.get("/health")
def health():
    return jsonify(status="ok")


@app.get("/services")
def services():
    # Каталог Consul: список всех имён сервисов. Себя ("consul") пропускаем.
    r = requests.get(f"{CONSUL}/v1/catalog/services", timeout=3)
    r.raise_for_status()
    return jsonify({n: discover(n) for n in r.json() if n != "consul"})


# --- маршрутизация: /<service-name>/<path> ---
@app.route("/<service>", defaults={"path": ""})
@app.route("/<service>/<path:path>")
def proxy(service, path):
    # 1) узнаём у Consul, где сервис
    instances = discover(service)
    if not instances:
        # Сервиса нет или все экземпляры нездоровы -> 503 Service Unavailable
        return jsonify(error=f'no healthy instances of "{service}" in Consul'), 503

    # 2) выбираем экземпляр и формируем целевой URL
    target = pick(service, instances)
    url = f"http://{target['address']}:{target['port']}/{path}"

    # 3) проксируем запрос и возвращаем ответ клиенту как есть
    upstream = requests.request(request.method, url, params=request.args, timeout=5)
    resp = Response(upstream.content, status=upstream.status_code)
    resp.headers["Content-Type"] = upstream.headers.get("Content-Type", "application/json")
    resp.headers["X-Routed-To"] = f"{target['address']}:{target['port']}"  # видно, куда ушёл запрос
    return resp


@app.errorhandler(requests.RequestException)
def upstream_error(err):
    # Consul или сервис недоступны -> 502 Bad Gateway
    return jsonify(error=str(err)), 502


if __name__ == "__main__":
    print(f"[gateway] listening on {PORT}, consul={CONSUL}", flush=True)
    app.run(host="0.0.0.0", port=PORT)
