CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  username VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at VARCHAR(32) NOT NULL
) /*MYSQL_ENGINE*/;

CREATE TABLE login_attempts (
  id VARCHAR(36) PRIMARY KEY,
  key_hash VARCHAR(64) NOT NULL,
  attempted_at INTEGER NOT NULL
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_login_attempts_key ON login_attempts (key_hash, attempted_at);

CREATE TABLE books (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  title VARCHAR(500) NOT NULL,
  author VARCHAR(500) NOT NULL DEFAULT '',
  description TEXT,
  expected_page_count INTEGER,
  languages VARCHAR(255) NOT NULL DEFAULT '["eng"]',
  original_language VARCHAR(16) NOT NULL DEFAULT 'eng',
  translation_language VARCHAR(16) NOT NULL DEFAULT 'eng',
  default_layout VARCHAR(32) NOT NULL DEFAULT 'single',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
) /*MYSQL_ENGINE*/;

CREATE TABLE captures (
  id VARCHAR(36) PRIMARY KEY,
  book_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(64) NOT NULL DEFAULT '',
  capture_index INTEGER NOT NULL,
  mode VARCHAR(16) NOT NULL DEFAULT 'single',
  original_filename VARCHAR(255) NOT NULL DEFAULT '',
  mime VARCHAR(64) NOT NULL,
  size_bytes INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  storage_key VARCHAR(255) NOT NULL,
  upload_status VARCHAR(16) NOT NULL DEFAULT 'confirmed',
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id)
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_captures_book ON captures (book_id, capture_index);

CREATE TABLE pages (
  id VARCHAR(36) PRIMARY KEY,
  book_id VARCHAR(36) NOT NULL,
  capture_id VARCHAR(36) NOT NULL,
  side VARCHAR(8) NOT NULL DEFAULT 'full',
  printed_page_number VARCHAR(32),
  sort_key DOUBLE PRECISION NOT NULL,
  crop_region VARCHAR(255),
  rotation INTEGER NOT NULL DEFAULT 0,
  layout VARCHAR(32),
  image_status VARCHAR(16) NOT NULL DEFAULT 'stored',
  ocr_status VARCHAR(16) NOT NULL DEFAULT 'not_processed',
  review_status VARCHAR(16) NOT NULL DEFAULT 'not_reviewed',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (book_id) REFERENCES books(id),
  FOREIGN KEY (capture_id) REFERENCES captures(id)
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_pages_book ON pages (book_id, sort_key);

CREATE TABLE regions (
  id VARCHAR(36) PRIMARY KEY,
  page_id VARCHAR(36) NOT NULL,
  bbox VARCHAR(255) NOT NULL,
  column_id VARCHAR(16) NOT NULL DEFAULT 'main',
  reading_order INTEGER NOT NULL DEFAULT 0,
  lang VARCHAR(16) NOT NULL DEFAULT 'eng',
  role VARCHAR(16) NOT NULL DEFAULT 'text',
  block_type VARCHAR(32) NOT NULL DEFAULT 'text',
  source VARCHAR(16) NOT NULL DEFAULT 'preset',
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_regions_page ON regions (page_id, reading_order);

CREATE TABLE ocr_results (
  id VARCHAR(36) PRIMARY KEY,
  region_id VARCHAR(36) NOT NULL,
  page_id VARCHAR(36) NOT NULL,
  engine VARCHAR(64) NOT NULL,
  engine_version VARCHAR(64) NOT NULL DEFAULT '',
  settings TEXT,
  language VARCHAR(32) NOT NULL,
  recognized_text MEDIUMTEXT NOT NULL,
  confidence DOUBLE PRECISION,
  flagged_words TEXT,
  version INTEGER NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_ocr_region ON ocr_results (region_id, version);

CREATE TABLE corrections (
  id VARCHAR(36) PRIMARY KEY,
  region_id VARCHAR(36) NOT NULL,
  page_id VARCHAR(36) NOT NULL,
  previous_text MEDIUMTEXT,
  corrected_text MEDIUMTEXT NOT NULL,
  based_on_ocr_version INTEGER,
  updated_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_corrections_region ON corrections (region_id, updated_at);

CREATE TABLE alignment_members (
  id VARCHAR(36) PRIMARY KEY,
  book_id VARCHAR(36) NOT NULL,
  group_id VARCHAR(36) NOT NULL,
  region_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'inferred',
  created_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (region_id) REFERENCES regions(id) ON DELETE CASCADE
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_align_group ON alignment_members (group_id);
CREATE INDEX idx_align_region ON alignment_members (region_id);

CREATE TABLE ocr_jobs (
  id VARCHAR(36) PRIMARY KEY,
  book_id VARCHAR(36) NOT NULL,
  page_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  lease_token VARCHAR(64),
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_jobs_status ON ocr_jobs (status, created_at);

CREATE TABLE rate_events (
  id VARCHAR(36) PRIMARY KEY,
  bucket VARCHAR(100) NOT NULL,
  at INTEGER NOT NULL
) /*MYSQL_ENGINE*/;

CREATE INDEX idx_rate_bucket ON rate_events (bucket, at)
