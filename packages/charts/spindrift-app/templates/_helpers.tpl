{{/*
The release's object name: one App's one Component.

Both names are already DNS labels — the canonical hostname is minted from the
same two — so this composes rather than sanitizes.
*/}}
{{- define "spindrift-app.fullname" -}}
{{- printf "%s-%s" .Values.app.name .Values.app.component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels: what a Deployment's selector and a Service's selector match on.

**Immutable by construction.** A selector cannot be edited on an existing
Deployment, so nothing that changes deploy to deploy belongs here.
*/}}
{{- define "spindrift-app.selectorLabels" -}}
app.kubernetes.io/name: {{ .Values.app.component }}
app.kubernetes.io/part-of: {{ .Values.app.name }}
{{- end }}

{{/*
Common labels, on every object this chart renders.
*/}}
{{- define "spindrift-app.labels" -}}
{{ include "spindrift-app.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: {{ .Values.app.kind }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end }}

{{/*
Pod template labels: the common set plus the one label that moves per deploy.

Neither delivery flavour's applied-object enumeration covers pods, so this
label is how a pod is traced back to the Deploy that placed it.
*/}}
{{- define "spindrift-app.podLabels" -}}
{{ include "spindrift-app.labels" . }}
{{- with .Values.app.deployId }}
spindrift.dev/deploy: {{ . | quote }}
{{- end }}
{{- with .Values.shared.podLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
The value-contract version from `Chart.yaml`, stamped onto every object, so an
object in a cluster can be traced to the contract it was rendered under without
holding the chart that did it.
*/}}
{{- define "spindrift-app.contractAnnotations" -}}
spindrift.dev/values-contract: {{ index .Chart.Annotations "spindrift.dev/values-contract" | quote }}
{{- end }}

{{/*
The port this Component serves on. A website arrives normalized to a service
with a fixed port, so this never needs to know which non-job kind it rendered.
*/}}
{{- define "spindrift-app.port" -}}
{{- .Values.app.port }}
{{- end }}

{{/*
Whether this Component serves traffic at all. A job is the only workload branch
and never serves.
*/}}
{{- define "spindrift-app.serving" -}}
{{- if and (ne .Values.app.kind "job") .Values.app.expose }}true{{ end }}
{{- end }}

{{/*
The container: identical between the Deployment and the CronJob.

Hardening is fixed with no per-App opt-out, so every security field here is a
literal rather than a value. Readiness on the port, no liveness probe; a job
has no port to probe.
*/}}
{{- define "spindrift-app.container" -}}
- name: app
  image: {{ .Values.app.image | quote }}
  imagePullPolicy: IfNotPresent
  {{- with .Values.app.command }}
  command:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.app.args }}
  args:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- if ne .Values.app.kind "job" }}
  ports:
    - name: http
      containerPort: {{ include "spindrift-app.port" . }}
      protocol: TCP
  readinessProbe:
    tcpSocket:
      port: {{ include "spindrift-app.port" . }}
  {{- end }}
  env:
    # readOnlyRootFilesystem below leaves /tmp as the only writable path, so
    # the two variables every runtime reaches for point at it.
    - name: TMPDIR
      value: /tmp
    - name: HOME
      value: /tmp
    {{- range .Values.app.env }}
    - name: {{ .name }}
      value: {{ .value | quote }}
    {{- end }}
    {{- range .Values.app.secretEnv }}
    - name: {{ .name }}
      valueFrom:
        secretKeyRef:
          name: {{ .secretName }}
          # The variable's own name, which is what `externalsecret.yaml` fetches
          # each pinned reference into. The store's name for the item is not a
          # legal Secret key in every store, so it is never used as one.
          key: {{ .name }}
    {{- end }}
  volumeMounts:
    - name: tmp
      mountPath: /tmp
  resources:
    {{- toYaml .Values.shared.resources | nindent 4 }}
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    runAsGroup: 65532
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    seccompProfile:
      type: RuntimeDefault
    capabilities:
      drop:
        - ALL
{{- end }}

{{/*
The pod spec around that container, likewise shared by both workload objects.
*/}}
{{- define "spindrift-app.podSpec" -}}
automountServiceAccountToken: false
securityContext:
  runAsNonRoot: true
  seccompProfile:
    type: RuntimeDefault
{{- with .Values.platform.runtimeClassName }}
runtimeClassName: {{ . }}
{{- end }}
{{- with .Values.platform.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
containers:
  {{- include "spindrift-app.container" . | nindent 2 }}
volumes:
  - name: tmp
    emptyDir: {}
{{- end }}
