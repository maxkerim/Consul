"""
DUMMY SERVICE (Service A / B / C)

Один и тот же код запускается три раза с разными переменными окружения.
Что делает сервис:
  1. Поднимает HTTP-сервер (Flask) с эндпоинтами /info и /health
  2. При старте РЕГИСТРИРУЕТ себя в Consul (это и есть "service discovery")
  3. При остановке УДАЛЯЕТ себя из Consul
"""
import os
import signal
import socket
import sys
import threading
import time
from datetime import datetime, timezone

import requests
from flask import Flask, jsonify

# ---- Конфигурация из переменных окружения (см. docker-compose.yml) ----
# Так один образ можно запустить как service-a, service-b, service-c.
NAME = os.getenv("SERVICE_NAME", "service-a")                 # имя в Consul (по нему ищет gateway)
DISPLAY_NAME = os.getenv("SERVICE_DISPLAY_NAME", NAME)        # красивое имя для ответа: "Service A"
PORT = int(os.getenv("PORT", "3000"))                         # порт HTTP-сервера
CONSUL = os.getenv("CONSUL_HTTP_ADDR", "http://localhost:8500")  # адрес Consul API

# Адрес, по которому ДРУГИЕ контейнеры смогут достучаться до этого сервиса.
# В Docker hostname контейнера резолвится во внутренней сети в его IP.
ADDRESS = os.getenv("SERVICE_ADDRESS", socket.gethostname())

# Уникальный ID экземпляра. Имя (NAME) у всех копий одного сервиса одинаковое,
# а ID должен быть разным, иначе Consul перепишет одну регистрацию другой.
SERVICE_ID = f"{NAME}-{ADDRESS}-{PORT}"

app = Flask(__name__)


# ---------------------------------------------------------------------
# ШАГ 1. HTTP-эндпоинты
# ---------------------------------------------------------------------
@app.get("/health")
def health():
    # Consul дёргает этот URL каждые 5 секунд.
    # Ответ 200 = "я жив". Нет ответа или ошибка = Consul перестанет отдавать нас gateway.
    return jsonify(status="ok")


@app.get("/info")
def info():
    # Тот самый "dummy endpoint" из задания: имя сервиса + текущее время.
    return jsonify(service=DISPLAY_NAME, timestamp=datetime.now(timezone.utc).isoformat())


# ---------------------------------------------------------------------
# ШАГ 2. Регистрация в Consul
# Документация: PUT /v1/agent/service/register
# ---------------------------------------------------------------------
def register():
    body = {
        "ID": SERVICE_ID,      # уникальный id экземпляра
        "Name": NAME,          # имя сервиса, по которому его будут искать
        "Address": ADDRESS,    # куда слать запросы
        "Port": PORT,
        # Health check: Consul сам ходит на этот URL и решает, жив ли сервис.
        "Check": {
            "HTTP": f"http://{ADDRESS}:{PORT}/health",
            "Interval": "5s",   # как часто проверять
            "Timeout": "2s",    # сколько ждать ответа
            # Если сервис "критичен" дольше 30с (например, контейнер убили без
            # корректного завершения), Consul сам удалит запись из реестра.
            "DeregisterCriticalServiceAfter": "30s",
        },
    }
    # Retry-цикл: при docker compose up Consul может стартовать позже сервиса
    # (depends_on ждёт только запуск контейнера, а не готовность Consul).
    attempt = 0
    while True:
        attempt += 1
        try:
            r = requests.put(f"{CONSUL}/v1/agent/service/register", json=body, timeout=3)
            r.raise_for_status()
            print(f"[{NAME}] registered in Consul as {SERVICE_ID}", flush=True)
            return
        except requests.RequestException as err:
            print(f"[{NAME}] Consul not ready (attempt {attempt}): {err}", flush=True)
            time.sleep(2)


# ---------------------------------------------------------------------
# ШАГ 3. Удаление из Consul при остановке
# ---------------------------------------------------------------------
def deregister():
    try:
        requests.put(f"{CONSUL}/v1/agent/service/deregister/{SERVICE_ID}", timeout=3)
        print(f"[{NAME}] deregistered", flush=True)
    except requests.RequestException:
        # Если Consul недоступен, ничего страшного:
        # DeregisterCriticalServiceAfter подчистит запись сам.
        pass


def handle_stop(signum, frame):
    # `docker compose stop` шлёт SIGTERM, Ctrl+C шлёт SIGINT.
    # Перехватываем их, чтобы успеть сказать Consul "я ухожу".
    deregister()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)

    # Регистрируемся в фоновом потоке: app.run() блокирует главный поток,
    # а к моменту первой проверки /health сервер уже должен отвечать.
    threading.Thread(target=register, daemon=True).start()

    print(f"[{NAME}] listening on {PORT}", flush=True)
    app.run(host="0.0.0.0", port=PORT)
