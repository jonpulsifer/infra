{{- define "prowler.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "prowler.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "prowler.labels" -}}
helm.sh/chart: {{ include "prowler.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "prowler.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Per-component selector labels. Five workloads share one chart, so the component
is part of the selector — without it every Service would match every pod.
*/}}
{{- define "prowler.selectorLabels" -}}
app.kubernetes.io/name: {{ include "prowler.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Pod labels: the common set plus the component, with the two keys the selector
already carries left to it. Emitting `prowler.labels` and `prowler.selectorLabels`
together would repeat `name` and `instance`, and a duplicate mapping key is a
parse error on the way into the API server, not a cosmetic one.
*/}}
{{- define "prowler.podLabels" -}}
helm.sh/chart: {{ include "prowler.name" .root }}-{{ .root.Chart.Version | replace "+" "_" }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
{{ include "prowler.selectorLabels" . }}
{{- end }}

{{- define "prowler.databaseName" -}}
{{ include "prowler.fullname" . }}-db
{{- end }}

{{/*
The operator names its Service `valkey-<cluster>`, so the cluster is named for
the release alone — `<release>-valkey` would render `valkey-prowler-valkey`.
*/}}
{{- define "prowler.valkeyName" -}}
{{ include "prowler.fullname" . }}
{{- end }}

{{- define "prowler.neo4jName" -}}
{{ include "prowler.fullname" . }}-neo4j
{{- end }}

{{/*
The env every api-family container shares. The API, the Celery worker and the
beat scheduler are the same image and the same Django settings module, so they
read the same contract; only the entrypoint argument differs.

POSTGRES_ADMIN_* is the CNPG-created owner role, which the chart also grants
CREATEROLE so the first migration can create POSTGRES_USER. Both credentials are
runtime dependencies, not just migration-time — `api/db_router.py` routes every
`django_*`, allauth and celery-results table through the admin connection.
*/}}
{{- define "prowler.apiEnv" -}}
{{- $db := include "prowler.databaseName" . }}
- name: DJANGO_SETTINGS_MODULE
  # `manage.py` and the gunicorn config both `setdefault` this, but
  # `config/celery.py` does not — worker and beat need it named explicitly.
  value: config.django.production
- name: DJANGO_BIND_ADDRESS
  # Defaults to 127.0.0.1, which no probe and no Service can reach.
  value: 0.0.0.0
- name: DJANGO_PORT
  value: {{ .Values.api.port | quote }}
{{/*
The API has no route of its own — the only caller is the UI pod, server-side, at
the Service name. The public hostname is deliberately absent: nothing reaches the
API there, and listing it would claim otherwise. Probes send the pod IP as Host,
which no list can predict, so they override the header instead.
*/}}
- name: DJANGO_ALLOWED_HOSTS
  value: {{ printf "%s-api,%s-api.%s.svc.cluster.local" (include "prowler.fullname" .) (include "prowler.fullname" .) .Release.Namespace | quote }}
- name: DJANGO_LOGGING_FORMATTER
  value: ndjson
- name: DJANGO_CELERY_WORKER_CONCURRENCY
  value: {{ .Values.worker.concurrency | quote }}
- name: POSTGRES_HOST
  valueFrom:
    secretKeyRef: {name: {{ $db }}-app, key: host}
- name: POSTGRES_PORT
  valueFrom:
    secretKeyRef: {name: {{ $db }}-app, key: port}
- name: POSTGRES_DB
  valueFrom:
    secretKeyRef: {name: {{ $db }}-app, key: dbname}
- name: POSTGRES_ADMIN_USER
  valueFrom:
    secretKeyRef: {name: {{ $db }}-app, key: username}
- name: POSTGRES_ADMIN_PASSWORD
  valueFrom:
    secretKeyRef: {name: {{ $db }}-app, key: password}
- name: POSTGRES_USER
  value: {{ .Values.database.user | quote }}
{{/*
Valkey carries the Celery broker on DB 0 and the SSE pub/sub bus on DB 2. The
operator's Service is headless and authenticates nobody — no ACL user is
declared, so the URL has no credentials. The scheme must be `redis`; anything
else raises at settings import.
*/}}
- name: VALKEY_SCHEME
  value: redis
- name: VALKEY_HOST
  value: valkey-{{ include "prowler.valkeyName" . }}
- name: VALKEY_PORT
  value: "6379"
- name: VALKEY_DB
  value: "0"
{{/*
Prowler puts the SSE pub/sub bus on database 2 by default, to keep a noisy
broker off the streaming keyspace. It cannot have one here: the valkey operator
runs every cluster with `cluster-enabled yes` — there is no knob to turn that
off, and `shards: 1` only means one shard, not one plain server — and cluster
mode serves database 0 alone. `SELECT 2` answers `ERR DB index is out of range`.
Both therefore share database 0.
*/}}
- name: EVENTSTREAM_VALKEY_DB
  value: "0"
{{- if .Values.neo4j.enabled }}
- name: NEO4J_HOST
  value: {{ include "prowler.neo4jName" . }}
- name: NEO4J_PORT
  value: "7687"
- name: NEO4J_USER
  value: neo4j
{{- end }}
{{- with .Values.gcp.audience }}
- name: GOOGLE_APPLICATION_CREDENTIALS
  value: {{ printf "%s/gcp-credentials.json" $.Values.gcp.tokenMountPath | quote }}
{{- end }}
{{- end }}

{{/*
The GCP federation mount, on every container that talks to Google. The worker
runs the scans; the API runs the connection test the UI calls when a provider is
added. Both need the projected token at the path the credential document names.
*/}}
{{- define "prowler.gcpVolumeMounts" -}}
{{- with .Values.gcp.audience }}
- name: gcp-federation
  mountPath: {{ $.Values.gcp.tokenMountPath }}
  readOnly: true
{{- end }}
{{- end }}

{{- define "prowler.gcpVolume" -}}
{{- with .Values.gcp.audience }}
- name: gcp-federation
  projected:
    sources:
      - serviceAccountToken:
          audience: {{ . | quote }}
          expirationSeconds: {{ $.Values.gcp.expirationSeconds }}
          path: gcp-token
      - configMap:
          name: {{ include "prowler.fullname" $ }}-gcp
{{- end }}
{{- end }}

{{/*
Pod hardening. The image runs as uid/gid 1000 (`prowler`), not the 65532 the
`app` chart uses, and the root filesystem is read-only — so every path the API
writes gets an emptyDir: /tmp for report staging, and ~/.config/prowler-api for
the JWT keypair the app writes when the signing key is not supplied.
*/}}
{{- define "prowler.podSecurityContext" -}}
runAsNonRoot: true
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end }}

{{- define "prowler.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop:
    - ALL
{{- end }}

{{- define "prowler.writableMounts" -}}
- name: tmp
  mountPath: /tmp
- name: config
  mountPath: /home/prowler/.config
{{/*
Every entrypoint path is `uv run`, and uv builds its cache under $HOME before it
executes anything — so this is not an optimisation, it is what lets the process
start at all. It cannot be a mount of /home/prowler itself: the application code
lives at /home/prowler/backend and an emptyDir there would hide it.
*/}}
- name: cache
  mountPath: /home/prowler/.cache
# gunicorn's control server opens its state here. Failing to is not fatal, but it
# logs an error on every boot.
- name: gunicorn
  mountPath: /home/prowler/.gunicorn
{{- end }}

{{- define "prowler.writableVolumes" -}}
- name: tmp
  emptyDir: {}
- name: config
  emptyDir: {}
- name: cache
  emptyDir: {}
- name: gunicorn
  emptyDir: {}
{{- end }}
