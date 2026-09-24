# audit-pipeline

Go service that scores GCP audit logs for anomalies. Pub/Sub pushes each audit-log entry to it on Cloud Run, it asks Gemini on Vertex AI for a severity score, and it writes high scores to BigQuery. See [Cloud](https://wiki.lolwtf.ca/platform/cloud/) on the wiki.

## Develop

```bash
go vet ./...
go build ./...
```

CI does not build or vet this module, and it has no tests.

The service listens on `PORT` (default `8080`). `POST /` takes Pub/Sub push messages, and `GET /health` answers health checks. It returns 200 for a message it cannot parse, so Pub/Sub does not retry it, and 500 when Gemini or BigQuery fails, so Pub/Sub retries.

| Variable | Default | Meaning |
| --- | --- | --- |
| `GCP_PROJECT` | none | Project for Vertex AI and BigQuery |
| `BQ_DATASET` | `audit_anomalies` | BigQuery dataset |
| `BQ_TABLE` | `anomalies` | BigQuery table |
| `VERTEX_LOCATION` | `us-central1` | Vertex AI region |
| `VERTEX_MODEL` | `gemini-2.5-flash-lite` | Gemini model |
| `SEVERITY_THRESHOLD` | `7` | Lowest score that the service writes to BigQuery |

## Deploy

`../cloudrun.tf` runs the image by digest, and Atlantis applies the `lolcorp` root. To ship a change, build and push a new image, then set its digest in `../cloudrun.tf`:

```bash
gcloud builds submit --project lolcorp --region us-central1 \
  --tag us-central1-docker.pkg.dev/lolcorp/cloud-run-source-deploy/audit-pipeline .
```
