-- BQML KMEANS clustering for audit log anomaly baseline detection.
-- The first 10 TB of BQML training per month is free.
-- Run periodically to update behavioral clusters.

CREATE OR REPLACE MODEL `audit_anomalies.anomaly_clusters`
OPTIONS (
  model_type = 'KMEANS',
  num_clusters = 5,
  max_iterations = 20
) AS
SELECT
  EXTRACT(HOUR FROM detected_at)      AS hour_of_day,
  EXTRACT(DAYOFWEEK FROM detected_at)  AS day_of_week,
  severity_score,
  FARM_FINGERPRINT(anomaly_type)       AS anomaly_type_encoded,
  FARM_FINGERPRINT(principal_email)    AS principal_hash
FROM
  `audit_anomalies.anomalies`
WHERE
  detected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY);
