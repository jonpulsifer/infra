{{/*
The release's base name. Every object is derived from it, and the namespace is
assumed to match — Flux creates the Namespace alongside this release.
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
Selector labels for one process. `app.kubernetes.io/component` is what
separates the two Deployments and what the Service targets.
*/}}
{{- define "spindrift.selectorLabels" -}}
app.kubernetes.io/name: {{ include "spindrift.fullname" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "spindrift.databaseName" -}}
{{ include "spindrift.fullname" . }}-db
{{- end }}

{{/*
The ConfigMap projected at `ca.crt` — the one file `NODE_EXTRA_CA_CERTS` names.

A release carrying `serviceAccount.token.caBundle` gets a ConfigMap of this
chart's own, rendered from that text in ca-bundle.yaml, so the same string can
be digested onto the pod template. One naming somebody else's ConfigMap gets
that name and no digest: the chart cannot hash content it does not hold.
*/}}
{{- define "spindrift.caConfigMapName" -}}
{{- if .Values.serviceAccount.token.caBundle -}}
{{ include "spindrift.fullname" . }}-trust-bundle
{{- else -}}
{{ .Values.serviceAccount.token.caConfigMap }}
{{- end }}
{{- end }}

{{/*
The migration Job's name carries a digest of every input to its immutable pod
template. New migrations arrive with a new image and become a new Job; an
unrelated chart revision leaves the completed Job alone.
*/}}
{{- define "spindrift.migrationName" -}}
{{- $inputs := dict "image" .Values.image "sandbox" .Values.sandbox "envFromSecret" .Values.envFromSecret -}}
{{- $digest := toJson $inputs | sha256sum | trunc 20 -}}
{{ include "spindrift.fullname" . }}-migrate-{{ $digest }}
{{- end }}
