# Service Discovery with Consul

Learning project: three dummy services register themselves in **Consul**, and an **API Gateway** discovers them through Consul's HTTP API and routes requests to them.

```
client ──► gateway :8080 ──(query Consul)──► consul :8500
                │
                └──► service-a / service-b / service-c :3000
```

> Пошаговое объяснение, как собрать проект с нуля и зачем нужен каждый шаг: [GUIDE.md](GUIDE.md)

## Components

| Part | Description |
|------|-------------|
| `consul` | Consul in dev mode (UI on :8500, DNS on :8600) |
| `services/` | Dummy service (one image, run 3 times as Service A/B/C). `GET /info` returns the service name and current timestamp; `GET /health` is used by Consul health checks. Registers itself in Consul on startup, deregisters on shutdown |
| `gateway/` | Single entry point. Looks up healthy instances in Consul (`/v1/health/service/<name>?passing=true`) and proxies the request (round-robin if several instances) |

## Run

```bash
docker compose up --build
```

## Try it

```bash
# via gateway (routing by service name)
curl http://localhost:8080/service-a/info
curl http://localhost:8080/service-b/info
curl http://localhost:8080/service-c/info

# what the gateway sees in Consul
curl http://localhost:8080/services

# Consul directly
curl http://localhost:8500/v1/catalog/services
curl "http://localhost:8500/v1/health/service/service-a?passing=true"

# Consul DNS interface
dig @127.0.0.1 -p 8600 service-a.service.consul SRV
```

Example response:

```json
{ "service": "Service A", "timestamp": "2026-10-18T16:00:00.000Z" }
```

Consul UI: http://localhost:8500

## How it works

1. **Registration** – on startup each service calls `PUT /v1/agent/service/register` with its name, address, port and an HTTP health check.
2. **Discovery** – the gateway calls the Consul health API and only gets instances whose checks are passing.
3. **Routing** – `/<service-name>/<path>` is forwarded to a discovered instance.
4. **Failure handling** – stop a service (`docker compose stop service-b`) and the gateway returns `503` for it once Consul marks it unhealthy/deregisters it.
