{{/*
The release's base name. Every object is derived from it, and the namespace is
assumed to match — Flux creates the Namespace alongside this release rather than
the chart rendering one, the same split `packages/charts/app` uses.
*/}}
{{- define "spindrift.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "spindrift.namespace" -}}
{{- default (include "spindrift.fullname" .) .Values.namespaceOverride }}
{{- end }}

{{- define "spindrift.serviceAccountName" -}}
{{- default (include "spindrift.fullname" .) .Values.serviceAccount.name }}
{{- end }}

{{- define "spindrift.labels" -}}
app.kubernetes.io/name: {{ include "spindrift.fullname" . }}
app.kubernetes.io/part-of: {{ include "spindrift.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

{{/*
Selector labels for one process.

§19 makes this two Deployments off one image, so the selector has to separate
them — `app.kubernetes.io/component` is what the Service targets, and getting it
wrong would point the route at the reconciler.
*/}}
{{- define "spindrift.selectorLabels" -}}
app.kubernetes.io/name: {{ include "spindrift.fullname" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "spindrift.databaseName" -}}
{{ include "spindrift.fullname" . }}-db
{{- end }}

{{/*
The migration Job's name carries the image digest, so a new image is a new Job
rather than an immutable-field conflict on the old one.
*/}}
{{- define "spindrift.migrationName" -}}
{{- $tag := last (splitList ":" .Values.image) -}}
{{- $safe := $tag | lower | replace "." "-" | replace "@" "-" | replace "_" "-" | replace "+" "-" | trunc 20 | trimSuffix "-" -}}
{{ include "spindrift.fullname" . }}-migrate-{{ $safe }}
{{- end }}
