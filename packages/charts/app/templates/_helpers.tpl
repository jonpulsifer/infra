{{/*
Expand the name of the chart.
*/}}
{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "app.fullname" -}}
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

{{/*
Common labels
*/}}
{{- define "app.labels" -}}
app.kubernetes.io/name: {{ include "app.fullname" . }}
app.kubernetes.io/part-of: {{ include "app.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ include "app.name" . }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

{{/*
The same labels for a pod template, without `helm.sh/chart`.

This chart is reconciled `Revision` from a GitRepository, so source-controller
stamps the git head sha into `.Chart.Version`: the version changes on every
commit to main, not when this chart changes. A label on a pod template is part
of the pod template, so carrying it there made every unrelated commit a new
pod-template-hash, a new ReplicaSet, and a rollout — about fourteen a day, none
of them caused by a change to this chart or its values.

`ChartVersion` is not the fix. Templates and values in this tree change often
without `Chart.yaml` moving, and every one of those changes would then silently
never ship. Keeping the version off pod templates is; `ai-agent` already does
this, which is why hermes does not churn.
*/}}
{{- define "app.podLabels" -}}
app.kubernetes.io/name: {{ include "app.fullname" . }}
app.kubernetes.io/part-of: {{ include "app.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.fullname" . }}
{{- end }}

{{/*
Database cluster name
*/}}
{{- define "app.databaseName" -}}
{{ include "app.fullname" . }}-db
{{- end }}

{{/*
Migration job name - includes image tag for immutability
*/}}
{{- define "app.migrationName" -}}
{{- $tag := last (splitList ":" .Values.image) -}}
{{- $safe := $tag | lower | replace "." "-" | replace "@" "-" | replace "_" "-" | replace "+" "-" | trunc 63 | trimSuffix "-" -}}
{{ include "app.fullname" . }}-migrate-{{ $safe }}
{{- end }}
