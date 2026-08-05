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
The migration Job's name carries a digest of every input to its immutable pod
template. New migrations arrive with a new image and become a new Job; an
unrelated chart revision leaves the completed Job alone.
*/}}
{{- define "spindrift.migrationName" -}}
{{- $inputs := dict "image" .Values.image "sandbox" .Values.sandbox "envFromSecret" .Values.envFromSecret -}}
{{- $digest := toJson $inputs | sha256sum | trunc 20 -}}
{{ include "spindrift.fullname" . }}-migrate-{{ $digest }}
{{- end }}

{{/*
The manifest document this release seeds, as YAML text — empty when there is
none.

Two sources, in order. An operator's own declaration (`.Values.manifest`)
wins whenever it is set. Absent that, a release with a `hostname` seeds
`files/default-manifest.yaml` instead: the chart's own copy of the code's
`DEFAULT_PLACEHOLDER_MANIFEST`, templated with this release's own
`controlPlane.hostname` in place of the code's `spindrift.example.com`.

Ticket 77: a bare `manifest: {}` release used to seed nothing, so
`loadStoredManifest` fell through to the code's placeholder — whose
`controlPlane.hostname` is `spindrift.example.com`, not this release's own —
and `serve.ts` binds the passkey relying party to whatever hostname the seeded
document carries. A browser refuses a ceremony whose relying-party id is not
the origin it began at, so the first operator could never sign in far enough
to reach onboarding. Seeding the deployment's own hostname here, rather than
correcting it after the fact in the process, keeps one authority for what an
installation manifest *is* — a document the chart renders or an operator
authors, never edited by a second writer once it reaches Postgres (`manifest.ts`,
`isUnconfiguredInstallation`) — at the cost of this second copy of the
placeholder, which the conformance test at
`apps/spindrift/test/conformance/chart-only-enrolment.test.ts` diffs against
the code's own so the two cannot drift apart unnoticed.

No `hostname` and no declaration is still empty, which is the release's own
"no manifest at all" case: an in-cluster-only installation with neither has no
origin to seed a relying party at, and every template gated on this stays
exactly as unrendered as it was before this existed.
*/}}
{{- define "spindrift.manifest.content" -}}
{{- if .Values.manifest -}}
{{- toYaml .Values.manifest -}}
{{- else if .Values.hostname -}}
{{- tpl (.Files.Get "files/default-manifest.yaml") . -}}
{{- end -}}
{{- end }}
