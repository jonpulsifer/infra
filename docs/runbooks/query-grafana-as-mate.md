---
title: Query Grafana as mate
description: Authenticate with mate's cluster identity and search metrics or retained logs on either cluster through Grafana.
---

Mate uses its short-lived Kubernetes token to reach a query-only Grafana endpoint on each cluster. Operator, investigator and responder threads can use it.

## Authenticate and discover data sources

1. Choose `offsite` or `folly` and set the service-proxy path.

   ```bash
   site=offsite
   endpoint=/api/v1/namespaces/monitoring/services/grafana-mate:8081/proxy
   kubectl --context "$site" get --raw "$endpoint/api/user"
   ```

   Result: Grafana identifies the caller as `mate-investigator`, with `isGrafanaAdmin: false`. No password or separate Grafana token is needed.

2. Discover the data source UIDs.

   ```bash
   kubectl --context "$site" get --raw "$endpoint/api/datasources" |
     jq '.[] | {name, uid, type}'
   ```

## Search metrics

1. Put the Prometheus UID from discovery in `query.json`.

   ```json
   {
     "from": "now-15m",
     "to": "now",
     "queries": [{
       "refId": "A",
       "datasource": {"type": "prometheus", "uid": "REPLACE_WITH_UID"},
       "expr": "up == 0",
       "range": true,
       "instant": false,
       "intervalMs": 60000,
       "maxDataPoints": 300
     }]
   }
   ```

2. Submit the query.

   ```bash
   kubectl --context "$site" create --raw "$endpoint/api/ds/query" -f query.json
   ```

   Result: Grafana returns data frames under `results.A.frames`. Check `results.A.error` as well as the HTTP status.

## Search retained logs

Use the same command with this payload in `query.json`. Replace the expression with a LogsQL filter for the investigation.

```json
{
  "from": "now-15m",
  "to": "now",
  "queries": [{
    "refId": "A",
    "datasource": {"type": "victoriametrics-logs-datasource", "uid": "victorialogs"},
    "expr": "error",
    "queryType": "instant",
    "maxLines": 100,
    "intervalMs": 60000,
    "maxDataPoints": 100
  }]
}
```

Grafana uses the tenant headers in each cluster's data source configuration. Keep the time range and line limit small; broaden them when the evidence needs it.

## Access limits

`clusters/base/monitoring/grafana-mate/` defines the endpoint. The Kubernetes API authenticates the caller and checks service-proxy access. The sidecar supplies a fixed Grafana Viewer identity through loopback-only auth proxy.

Only `GET /api/user`, `GET /api/datasources` and `POST /api/ds/query` pass. Kubernetes calls the POST permission `create`; it does not grant resource creation. Dashboard writes, login sessions and arbitrary data-source proxy routes return 403. Direct VictoriaLogs access stays unavailable to read-only threads.

The network policy admits the API server and the Grafana node's host-network pods to the sidecar. Those nodes are trusted. Public Grafana requests cannot supply the trusted loopback identity.

## If a query fails

| Symptom | Check |
| --- | --- |
| Kubernetes returns Forbidden | The cluster's `monitoring/mate-sandbox-reader.yaml` binding and the base Role |
| The sidecar returns 403 | Use the exact method and path, without query arguments |
| Connection fails | Grafana's HelmRelease, the `mate-query` container and its network policy |
| Grafana returns a data-source error | The discovered UID, query type, expression and time range |

## Related

- [Rowbutt](../apps/mate.md)
- [How Rowbutt works](../apps/mate/how-it-works.md)
