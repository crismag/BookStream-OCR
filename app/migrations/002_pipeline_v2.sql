ALTER TABLE ocr_jobs ADD COLUMN created_ts INTEGER;
ALTER TABLE ocr_jobs ADD COLUMN leased_ts INTEGER;
ALTER TABLE ocr_jobs ADD COLUMN completed_ts INTEGER;
ALTER TABLE ocr_jobs ADD COLUMN worker_id VARCHAR(64);
ALTER TABLE ocr_results ADD COLUMN duration_ms INTEGER;
ALTER TABLE captures ADD COLUMN server_ms INTEGER;
ALTER TABLE captures ADD COLUMN client_metrics TEXT;

CREATE TABLE ocr_workers (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36),
  label VARCHAR(100) NOT NULL DEFAULT '',
  last_seen INTEGER NOT NULL,
  current_job VARCHAR(36),
  jobs_done INTEGER NOT NULL DEFAULT 0
) /*MYSQL_ENGINE*/
