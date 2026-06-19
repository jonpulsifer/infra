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
