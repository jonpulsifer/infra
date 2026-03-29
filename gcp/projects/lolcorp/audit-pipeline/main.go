package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"cloud.google.com/go/bigquery"
	"cloud.google.com/go/vertexai/genai"
)

// benignMethods are skipped without calling Gemini.
var benignMethods = map[string]bool{
	"storage.objects.get":               true,
	"storage.objects.list":              true,
	"storage.buckets.get":               true,
	"compute.instances.list":            true,
	"compute.zones.list":                true,
	"compute.regions.list":              true,
	"container.clusters.get":            true,
	"cloudresourcemanager.projects.get": true,
}

// PubSubEnvelope is the push message wrapper from Pub/Sub.
type PubSubEnvelope struct {
	Message struct {
		Data        string `json:"data"`
		MessageID   string `json:"messageId"`
		PublishTime string `json:"publishTime"`
	} `json:"message"`
	Subscription string `json:"subscription"`
}

// LogEntry represents a Cloud Audit Log entry.
type LogEntry struct {
	ProtoPayload struct {
		MethodName   string `json:"methodName"`
		ResourceName string `json:"resourceName"`
		ServiceName  string `json:"serviceName"`
		AuthenticationInfo struct {
			PrincipalEmail string `json:"principalEmail"`
		} `json:"authenticationInfo"`
		RequestMetadata struct {
			CallerIP  string `json:"callerIp"`
			UserAgent string `json:"callerSuppliedUserAgent"`
		} `json:"requestMetadata"`
	} `json:"protoPayload"`
	Resource struct {
		Type   string            `json:"type"`
		Labels map[string]string `json:"labels"`
	} `json:"resource"`
	Timestamp string `json:"timestamp"`
	LogName   string `json:"logName"`
}

// AuditEntry is the compressed representation sent to Gemini.
type AuditEntry struct {
	Timestamp    string `json:"ts"`
	Principal    string `json:"principal"`
	Method       string `json:"method"`
	Resource     string `json:"resource"`
	Service      string `json:"service"`
	CallerIP     string `json:"caller_ip"`
	UserAgent    string `json:"user_agent"`
	ProjectID    string `json:"project_id"`
	ResourceType string `json:"resource_type"`
}

// AnomalyResult is the structured response from Gemini.
type AnomalyResult struct {
	SeverityScore int    `json:"severity_score"`
	AnomalyType   string `json:"anomaly_type"`
	Explanation   string `json:"explanation"`
}

// BigQueryRow is a row written to the anomalies table.
type BigQueryRow struct {
	DetectedAt     time.Time `bigquery:"detected_at"`
	LogTimestamp    time.Time `bigquery:"log_timestamp"`
	PrincipalEmail string    `bigquery:"principal_email"`
	MethodName     string    `bigquery:"method_name"`
	ResourceName   string    `bigquery:"resource_name"`
	ProjectID      string    `bigquery:"project_id"`
	SeverityScore  int64     `bigquery:"severity_score"`
	AnomalyType    string    `bigquery:"anomaly_type"`
	Explanation    string    `bigquery:"explanation"`
	RawLog         string    `bigquery:"raw_log"`
	ToonPayload    string    `bigquery:"toon_payload"`
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("POST /", auditHandler)

	log.Printf("starting audit-pipeline on :%s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}

func auditHandler(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	var envelope PubSubEnvelope
	if err := json.NewDecoder(r.Body).Decode(&envelope); err != nil {
		log.Printf("bad envelope: %v", err)
		w.WriteHeader(http.StatusOK) // ACK to prevent infinite retries
		return
	}

	data, err := base64.StdEncoding.DecodeString(envelope.Message.Data)
	if err != nil {
		log.Printf("base64 decode error: %v", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	var entry LogEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		log.Printf("log entry parse error: %v", err)
		w.WriteHeader(http.StatusOK)
		return
	}

	if benignMethods[entry.ProtoPayload.MethodName] {
		w.WriteHeader(http.StatusOK)
		return
	}

	projectID := entry.Resource.Labels["project_id"]
	audit := AuditEntry{
		Timestamp:    entry.Timestamp,
		Principal:    entry.ProtoPayload.AuthenticationInfo.PrincipalEmail,
		Method:       entry.ProtoPayload.MethodName,
		Resource:     entry.ProtoPayload.ResourceName,
		Service:      entry.ProtoPayload.ServiceName,
		CallerIP:     entry.ProtoPayload.RequestMetadata.CallerIP,
		UserAgent:    entry.ProtoPayload.RequestMetadata.UserAgent,
		ProjectID:    projectID,
		ResourceType: entry.Resource.Type,
	}

	toonPayload := toTOON(audit)

	result, err := analyzeWithGemini(ctx, toonPayload)
	if err != nil {
		log.Printf("gemini error: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	threshold, _ := strconv.Atoi(getEnv("SEVERITY_THRESHOLD", "7"))
	if result.SeverityScore >= threshold {
		if err := writeToBigQuery(ctx, audit, result, string(data), toonPayload); err != nil {
			log.Printf("bigquery error: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		log.Printf("anomaly: score=%d type=%s principal=%s method=%s",
			result.SeverityScore, result.AnomalyType, audit.Principal, audit.Method)
	}

	w.WriteHeader(http.StatusOK)
}

// toTOON serializes an AuditEntry into TOON (Text Object Oriented Notation) format.
func toTOON(a AuditEntry) string {
	var b strings.Builder
	b.WriteString("[AuditEntry]\n")
	b.WriteString("ts=" + a.Timestamp + "\n")
	b.WriteString("principal=" + a.Principal + "\n")
	b.WriteString("method=" + a.Method + "\n")
	b.WriteString("resource=" + a.Resource + "\n")
	b.WriteString("service=" + a.Service + "\n")
	b.WriteString("caller_ip=" + a.CallerIP + "\n")
	b.WriteString("user_agent=" + a.UserAgent + "\n")
	b.WriteString("project_id=" + a.ProjectID + "\n")
	b.WriteString("resource_type=" + a.ResourceType + "\n")
	return b.String()
}

func analyzeWithGemini(ctx context.Context, toonPayload string) (*AnomalyResult, error) {
	project := getEnv("GCP_PROJECT", "")
	location := getEnv("VERTEX_LOCATION", "us-central1")
	model := getEnv("VERTEX_MODEL", "gemini-2.5-flash-lite")

	client, err := genai.NewClient(ctx, project, location)
	if err != nil {
		return nil, fmt.Errorf("genai client: %w", err)
	}
	defer client.Close()

	gemini := client.GenerativeModel(model)
	gemini.ResponseMIMEType = "application/json"
	gemini.ResponseSchema = &genai.Schema{
		Type: genai.TypeObject,
		Properties: map[string]*genai.Schema{
			"severity_score": {Type: genai.TypeInteger, Description: "Anomaly severity 1-10, where 10 is most severe"},
			"anomaly_type":   {Type: genai.TypeString, Description: "Category: privilege_escalation, data_exfiltration, unusual_access, policy_violation, brute_force, reconnaissance, or normal"},
			"explanation":    {Type: genai.TypeString, Description: "Brief explanation of why this is or is not anomalous"},
		},
		Required: []string{"severity_score", "anomaly_type", "explanation"},
	}

	prompt := fmt.Sprintf(`Analyze this GCP audit log entry for security anomalies.
Score severity 1-10 (1=routine, 10=critical threat).
Consider: unusual timing, privilege escalation, sensitive resource access,
impossible travel, service account misuse, and policy violations.

%s`, toonPayload)

	resp, err := gemini.GenerateContent(ctx, genai.Text(prompt))
	if err != nil {
		return nil, fmt.Errorf("generate content: %w", err)
	}

	if len(resp.Candidates) == 0 || len(resp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("empty response from gemini")
	}

	text, ok := resp.Candidates[0].Content.Parts[0].(genai.Text)
	if !ok {
		return nil, fmt.Errorf("unexpected response part type")
	}

	var result AnomalyResult
	if err := json.Unmarshal([]byte(text), &result); err != nil {
		return nil, fmt.Errorf("parse gemini response: %w", err)
	}

	return &result, nil
}

func writeToBigQuery(ctx context.Context, audit AuditEntry, result *AnomalyResult, rawLog, toonPayload string) error {
	project := getEnv("GCP_PROJECT", "")
	dataset := getEnv("BQ_DATASET", "audit_anomalies")
	table := getEnv("BQ_TABLE", "anomalies")

	client, err := bigquery.NewClient(ctx, project)
	if err != nil {
		return fmt.Errorf("bigquery client: %w", err)
	}
	defer client.Close()

	ts, _ := time.Parse(time.RFC3339Nano, audit.Timestamp)

	row := BigQueryRow{
		DetectedAt:     time.Now().UTC(),
		LogTimestamp:    ts,
		PrincipalEmail: audit.Principal,
		MethodName:     audit.Method,
		ResourceName:   audit.Resource,
		ProjectID:      audit.ProjectID,
		SeverityScore:  int64(result.SeverityScore),
		AnomalyType:    result.AnomalyType,
		Explanation:    result.Explanation,
		RawLog:         rawLog,
		ToonPayload:    toonPayload,
	}

	inserter := client.Dataset(dataset).Table(table).Inserter()
	return inserter.Put(ctx, row)
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
