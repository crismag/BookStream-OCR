<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;

/**
 * Pull-based OCR job queue. Shared hosting has no background workers, so any
 * authenticated browser tab ("Process" screen) or a token-authenticated laptop
 * worker leases jobs, runs OCR locally and posts results back.
 */
final class OcrController
{
    private const LEASE_SECONDS = 300;
    private const MAX_ATTEMPTS = 3;

    public function __construct(private App $app)
    {
    }

    public function enqueue(Request $req, string $bookId): Response
    {
        $this->app->book($bookId);
        $d = $req->json();
        $force = !empty($d['force']);
        $params = [$bookId];
        $sql = 'SELECT id, ocr_status FROM pages WHERE book_id = ?';
        if (isset($d['page_ids']) && is_array($d['page_ids']) && $d['page_ids'] !== []) {
            $ids = array_values(array_filter(array_map('strval', $d['page_ids']), [Db::class, 'isUuid']));
            if ($ids === []) {
                throw new HttpError(422, 'invalid_pages', 'page_ids must be UUIDs.');
            }
            $sql .= ' AND id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
            $params = array_merge($params, $ids);
        }
        $added = 0;
        $this->app->db->tx(function () use ($sql, $params, $force, $bookId, &$added): void {
            foreach ($this->app->db->all($sql, $params) as $p) {
                if (!$force && !in_array($p['ocr_status'], ['not_processed', 'failed'], true)) {
                    continue;
                }
                $active = $this->app->db->one("SELECT id FROM ocr_jobs WHERE page_id = ? AND status IN ('queued','leased')", [$p['id']]);
                if ($active !== null) {
                    continue;
                }
                $now = Db::now();
                $this->app->db->run('INSERT INTO ocr_jobs (id, book_id, page_id, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', [Db::uuid(), $bookId, $p['id'], 'queued', $now, $now]);
                $this->app->db->run("UPDATE pages SET ocr_status = 'queued', updated_at = ? WHERE id = ?", [$now, $p['id']]);
                $added++;
            }
        });
        return Response::json(['enqueued' => $added] + $this->counts($bookId));
    }

    public function status(Request $req, string $bookId): Response
    {
        $this->app->book($bookId);
        $failed = $this->app->db->all("SELECT j.page_id, j.error, j.attempts, p.printed_page_number FROM ocr_jobs j JOIN pages p ON p.id = j.page_id WHERE j.book_id = ? AND j.status = 'failed' ORDER BY j.updated_at DESC LIMIT 50", [$bookId]);
        return Response::json($this->counts($bookId) + ['failures' => $failed]);
    }

    /** @return array<string,int> */
    private function counts(string $bookId): array
    {
        $out = ['queued' => 0, 'leased' => 0, 'done' => 0, 'failed' => 0];
        foreach ($this->app->db->all('SELECT status, COUNT(*) AS n FROM ocr_jobs WHERE book_id = ? GROUP BY status', [$bookId]) as $r) {
            $out[(string)$r['status']] = (int)$r['n'];
        }
        return $out;
    }

    public function lease(Request $req): Response
    {
        $d = $req->json();
        $bookId = isset($d['book_id']) ? (string)$d['book_id'] : null;
        if ($bookId !== null) {
            $this->app->book($bookId);
        }
        $now = time();
        $params = [$now];
        $sql = "SELECT j.* FROM ocr_jobs j JOIN books b ON b.id = j.book_id WHERE (j.status = 'queued' OR (j.status = 'leased' AND j.lease_until < ?))";
        if ($bookId !== null) {
            $sql .= ' AND j.book_id = ?';
            $params[] = $bookId;
        }
        if (!$this->app->auth->isWorker($req)) {
            $u = $this->app->auth->requireUser();
            $sql .= ' AND b.user_id = ?';
            $params[] = $u['id'];
        }
        $sql .= ' ORDER BY j.created_at LIMIT 5';
        foreach ($this->app->db->all($sql, $params) as $job) {
            $token = bin2hex(random_bytes(16));
            $claimed = $this->app->db->run(
                "UPDATE ocr_jobs SET status = 'leased', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
                 WHERE id = ? AND (status = 'queued' OR (status = 'leased' AND lease_until < ?))",
                [$token, $now + self::LEASE_SECONDS, Db::now(), $job['id'], $now]
            );
            if ($claimed !== 1) {
                continue;
            }
            $this->app->db->run("UPDATE pages SET ocr_status = 'processing', updated_at = ? WHERE id = ?", [Db::now(), $job['page_id']]);
            [$page, $book] = $this->app->page((string)$job['page_id']);
            $detail = PageController::detail($this->app, $page, $book);
            $regions = array_map(fn($r) => [
                'id' => $r['id'],
                'bbox' => $r['bbox'],
                'lang' => $r['lang'],
                'role' => $r['role'],
                'block_type' => $r['block_type'],
                'reading_order' => $r['reading_order'],
                'tesseract_lang' => $this->tesseractLang((string)$r['lang']),
                // Dictionaries pull unfamiliar words toward English; disable them for every
                // language that has no dedicated model, to preserve original spelling.
                'use_dictionary' => $this->tesseractLang((string)$r['lang']) === (string)$r['lang'],
                'preserve_lines' => true,
            ], $detail['regions']);
            return Response::json([
                'job' => [
                    'id' => $job['id'],
                    'lease_token' => $token,
                    'lease_seconds' => self::LEASE_SECONDS,
                    'book_id' => $job['book_id'],
                    'page_id' => $job['page_id'],
                    'printed_page_number' => $page['printed_page_number'],
                    'image_url' => '/api/pages/' . $job['page_id'] . '/image?variant=full',
                    'regions' => $regions,
                ],
            ]);
        }
        return Response::json(['job' => null]);
    }

    private function tesseractLang(string $lang): string
    {
        // OCR_LANG_MAP example: "mrw=eng,tgl=tgl". Unknown languages fall back to "eng" (Latin script).
        $map = [];
        foreach (explode(',', (string)$this->app->config->get('OCR_LANG_MAP', 'mrw=eng')) as $pair) {
            if (str_contains($pair, '=')) {
                [$k, $v] = array_map('trim', explode('=', $pair, 2));
                $map[$k] = $v;
            }
        }
        $available = array_map('trim', explode(',', (string)$this->app->config->get('OCR_MODELS', 'eng')));
        $t = $map[$lang] ?? $lang;
        return in_array($t, $available, true) ? $t : 'eng';
    }

    /** @return array<string,mixed> */
    private function leasedJob(string $jobId, Request $req): array
    {
        $job = $this->app->db->one('SELECT * FROM ocr_jobs WHERE id = ?', [$jobId]);
        if ($job === null) {
            throw new HttpError(404, 'job_not_found', 'Job not found.');
        }
        $this->app->book((string)$job['book_id']);
        $token = (string)($req->json()['lease_token'] ?? '');
        if ($job['status'] !== 'leased' || !is_string($job['lease_token']) || !hash_equals($job['lease_token'], $token)) {
            throw new HttpError(409, 'lease_lost', 'This job is no longer leased by you.');
        }
        return $job;
    }

    public function complete(Request $req, string $jobId): Response
    {
        $job = $this->leasedJob($jobId, $req);
        $results = $req->json()['results'] ?? null;
        if (!is_array($results) || $results === []) {
            throw new HttpError(422, 'invalid_results', 'results must be a non-empty array.');
        }
        $pageId = (string)$job['page_id'];
        $regionIds = array_column($this->app->db->all('SELECT id FROM regions WHERE page_id = ?', [$pageId]), 'id');
        $threshold = (float)$this->app->config->get('OCR_REVIEW_CONFIDENCE', '80');
        $needsReview = false;
        $this->app->db->tx(function () use ($results, $regionIds, $pageId, $jobId, $threshold, &$needsReview): void {
            foreach ($results as $r) {
                $rid = (string)($r['region_id'] ?? '');
                if (!in_array($rid, $regionIds, true)) {
                    throw new HttpError(422, 'invalid_region', 'Result references a region that is not on this page.');
                }
                $text = (string)($r['text'] ?? '');
                if (!mb_check_encoding($text, 'UTF-8') || strlen($text) > 200000) {
                    throw new HttpError(422, 'invalid_text', 'OCR text must be UTF-8 and under 200k.');
                }
                $conf = isset($r['confidence']) && is_numeric($r['confidence']) ? max(0.0, min(100.0, (float)$r['confidence'])) : null;
                $flagged = array_slice(array_values(array_map('strval', is_array($r['flagged_words'] ?? null) ? $r['flagged_words'] : [])), 0, 2000);
                if ($conf === null || $conf < $threshold || $flagged !== []) {
                    $needsReview = true;
                }
                $v = $this->app->db->one('SELECT MAX(version) AS v FROM ocr_results WHERE region_id = ?', [$rid]);
                $settings = is_array($r['settings'] ?? null) ? $r['settings'] : [];
                $this->app->db->run(
                    'INSERT INTO ocr_results (id, region_id, page_id, engine, engine_version, settings, language, recognized_text, confidence, flagged_words, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [Db::uuid(), $rid, $pageId, substr((string)($r['engine'] ?? 'unknown'), 0, 64), substr((string)($r['engine_version'] ?? ''), 0, 64),
                     json_encode($settings), substr((string)($r['language'] ?? ''), 0, 32), $text, $conf, json_encode($flagged), (int)($v['v'] ?? 0) + 1, Db::now()]
                );
            }
            $status = $needsReview ? 'needs_review' : 'ocr_complete';
            $this->app->db->run('UPDATE pages SET ocr_status = ?, review_status = CASE WHEN review_status = ? THEN ? ELSE review_status END, updated_at = ? WHERE id = ?',
                [$status, 'not_reviewed', $needsReview ? 'needs_review' : 'not_reviewed', Db::now(), $pageId]);
            $this->app->db->run("UPDATE ocr_jobs SET status = 'done', lease_token = NULL, error = NULL, updated_at = ? WHERE id = ?", [Db::now(), $jobId]);
        });
        // Parallel pages get an inferred (unverified) alignment right away.
        [$page, $book] = $this->app->page($pageId);
        if (($page['layout'] ?? $book['default_layout']) === 'parallel') {
            (new PageController($this->app))->inferAlignment($req, $pageId);
        }
        return Response::json(['status' => $needsReview ? 'needs_review' : 'ocr_complete']);
    }

    public function fail(Request $req, string $jobId): Response
    {
        $job = $this->leasedJob($jobId, $req);
        $error = mb_substr((string)($req->json()['error'] ?? 'unknown error'), 0, 1000);
        $final = (int)$job['attempts'] >= self::MAX_ATTEMPTS;
        $this->app->db->run('UPDATE ocr_jobs SET status = ?, lease_token = NULL, error = ?, updated_at = ? WHERE id = ?', [$final ? 'failed' : 'queued', $error, Db::now(), $jobId]);
        $this->app->db->run('UPDATE pages SET ocr_status = ?, updated_at = ? WHERE id = ?', [$final ? 'failed' : 'queued', Db::now(), $job['page_id']]);
        return Response::json(['status' => $final ? 'failed' : 'requeued', 'attempts' => (int)$job['attempts']]);
    }
}
