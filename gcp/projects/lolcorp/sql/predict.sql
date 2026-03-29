-- Daily outlier detection: runs ML.PREDICT on the last 24h of anomalies,
-- keeps those with centroid distance above the 75th percentile (P75).
-- Scheduled daily at 03:00 UTC via BigQuery data transfer.

INSERT INTO `audit_anomalies.outliers`
  (cluster_id, outlier_distance, detected_at, principal_email, method_name,
   resource_name, project_id, severity_score, anomaly_type, explanation)
WITH predictions AS (
  SELECT
    CENTROID_ID AS cluster_id,
    NEAREST_CENTROIDS_DISTANCE[OFFSET(0)].DISTANCE AS outlier_distance,
    detected_at,
    principal_email,
    method_name,
    resource_name,
    project_id,
    severity_score,
    anomaly_type,
    explanation
  FROM ML.PREDICT(MODEL `audit_anomalies.anomaly_clusters`,
    (SELECT
      EXTRACT(HOUR FROM detected_at)      AS hour_of_day,
      EXTRACT(DAYOFWEEK FROM detected_at)  AS day_of_week,
      severity_score,
      FARM_FINGERPRINT(anomaly_type)       AS anomaly_type_encoded,
      FARM_FINGERPRINT(principal_email)    AS principal_hash,
      detected_at,
      principal_email,
      method_name,
      resource_name,
      project_id,
      anomaly_type,
      explanation
    FROM `audit_anomalies.anomalies`
    WHERE detected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY))
  )
)
SELECT * FROM predictions
WHERE outlier_distance > (
  SELECT APPROX_QUANTILES(outlier_distance, 4)[OFFSET(3)] FROM predictions
);
