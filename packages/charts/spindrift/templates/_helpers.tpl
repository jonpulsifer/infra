{{/*
The release's base name. Every object is derived from it.
*/}}
{{- define "spindrift.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Where this release installs.

`.Release.Namespace` — the namespace Helm was told to install into — rather
than the release's own name, which is what this used to assume. The two agree
for the installation this chart was written beside and disagree for every
other: `helm install spindrift oci://… -n anything-else` wrote its Deployments,
its database and its Gateway into a namespace called `spindrift`, which is
either a namespace that does not exist or, worse, somebody else's installation.

That is a property of an extractable artifact rather than a detail: a chart
that only installs where its author put it has not been extracted, whatever
registry it is published to.

`namespaceOverride` stays for a release that genuinely wants to write outside
the namespace it was installed into.
*/}}
{{- define "spindrift.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride }}
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
The migration Job's name carries a digest of every input to its immutable pod
template. New migrations arrive with a new image and become a new Job; an
unrelated chart revision leaves the completed Job alone.
*/}}
{{- define "spindrift.migrationName" -}}
{{- $inputs := dict "image" .Values.image "sandbox" .Values.sandbox "envFromSecret" .Values.envFromSecret -}}
{{- $digest := toJson $inputs | sha256sum | trunc 20 -}}
{{ include "spindrift.fullname" . }}-migrate-{{ $digest }}
{{- end }}

