<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;
use BookStream\Http\UploadedFile;
use BookStream\ImageService;

final class CaptureController
{
    public function __construct(private App $app)
    {
    }

    /**
     * Idempotent capture upload. The response is sent only after the file is validated,
     * fsynced, renamed into place and the DB transaction has committed. The returned
     * checksum lets the client verify the server stored exactly the bytes it sent.
     */
    public function upload(Request $req, string $bookId): Response
    {
        $t0 = hrtime(true);
        $u = $this->app->auth->requireUser();
        $book = $this->app->book($bookId);
        $this->app->rate->hit('upload:' . $u['id'], $this->app->config->int('UPLOADS_PER_MINUTE', 120), 60);

        $captureId = strtolower((string)($req->post['capture_id'] ?? ''));
        $checksum = strtolower((string)($req->post['checksum'] ?? ''));
        $index = (int)($req->post['capture_index'] ?? 0);
        $mode = (string)($req->post['mode'] ?? 'single');
        $sessionId = substr(preg_replace('/[^A-Za-z0-9-]/', '', (string)($req->post['session_id'] ?? '')) ?? '', 0, 64);
        $printed = self::printedNumber($req->post['printed_page_number'] ?? null);

        if (!Db::isUuid($captureId)) {
            throw new HttpError(422, 'invalid_capture_id', 'capture_id must be a UUID.');
        }
        if (!preg_match('/^[0-9a-f]{64}$/', $checksum)) {
            throw new HttpError(422, 'invalid_checksum', 'checksum must be a SHA-256 hex digest.');
        }
        if ($index < 1 || $index > 1000000) {
            throw new HttpError(422, 'invalid_index', 'capture_index must be a positive integer.');
        }
        if (!in_array($mode, ['single', 'spread'], true)) {
            throw new HttpError(422, 'invalid_mode', 'mode must be single or spread.');
        }

        $existing = $this->app->db->one('SELECT * FROM captures WHERE id = ?', [$captureId]);
        if ($existing !== null) {
            return $this->replay($existing, $bookId, $checksum);
        }

        $file = $req->files['image'] ?? null;
        if (!$file instanceof UploadedFile || !$file->isGenuine()) {
            throw new HttpError(422, 'missing_file', 'No valid image was uploaded (field "image").');
        }
        $meta = ImageService::inspect(
            $file->tmpPath,
            $this->app->config->int('MAX_UPLOAD_BYTES', 15 * 1024 * 1024),
            $this->app->config->int('MAX_IMAGE_PIXELS', 60_000_000)
        );
        if (!hash_equals(hash_file('sha256', $file->tmpPath) ?: '', $checksum)) {
            throw new HttpError(422, 'checksum_mismatch', 'Uploaded bytes do not match the checksum (corrupted in transit). Retry.');
        }

        $key = $this->app->storage->originalKey($bookId, $captureId, $meta['ext']);
        $stored = $this->app->storage->persist($file->tmpPath, $key);
        if ($stored !== $checksum) {
            @unlink($this->app->storage->path($key));
            throw new HttpError(500, 'persist_failed', 'Stored file failed verification.');
        }

        try {
            $pages = $this->app->db->tx(function () use ($book, $captureId, $index, $mode, $sessionId, $printed, $file, $meta, $checksum, $key): array {
                if ($this->app->db->one('SELECT id FROM captures WHERE id = ?', [$captureId]) !== null) {
                    throw new HttpError(409, 'race', 'Capture was stored concurrently; retry to receive the acknowledgment.');
                }
                $now = Db::now();
                $this->app->db->run(
                    'INSERT INTO captures (id, book_id, session_id, capture_index, mode, original_filename, mime, size_bytes, width, height, checksum, storage_key, upload_status, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [$captureId, $book['id'], $sessionId, $index, $mode, mb_substr(basename($file->clientName), 0, 255), $meta['mime'],
                     (int)filesize($this->app->storage->path($key)), $meta['width'], $meta['height'], $checksum, $key, 'confirmed', $now]
                );
                $sides = $mode === 'spread' ? ['left', 'right'] : ['full'];
                $out = [];
                foreach ($sides as $i => $side) {
                    $num = $printed;
                    if ($i === 1 && $printed !== null && ctype_digit($printed)) {
                        $num = (string)((int)$printed + 1);
                    } elseif ($i === 1) {
                        $num = null;
                    }
                    $pageId = Db::uuid();
                    $this->app->db->run(
                        'INSERT INTO pages (id, book_id, capture_id, side, printed_page_number, sort_key, rotation, image_status, ocr_status, review_status, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)',
                        [$pageId, $book['id'], $captureId, $side, $num, $index * 10 + $i, 'stored', 'not_processed', 'not_reviewed', $now, $now]
                    );
                    PageController::createPresetRegions($this->app, $pageId, (string)$book['default_layout'], $book);
                    $queued = $this->app->config->bool('AUTO_OCR', true) && OcrController::enqueuePage($this->app, (string)$book['id'], $pageId);
                    $out[] = ['id' => $pageId, 'side' => $side, 'printed_page_number' => $num, 'ocr_status' => $queued ? 'queued' : 'not_processed'];
                }
                $this->app->db->run('UPDATE books SET updated_at = ? WHERE id = ?', [$now, $book['id']]);
                return $out;
            });
        } catch (\Throwable $e) {
            @unlink($this->app->storage->path($key));
            throw $e;
        }
        $serverMs = (int)round((hrtime(true) - $t0) / 1e6);
        $metrics = (string)($req->post['client_metrics'] ?? '');
        $metrics = (strlen($metrics) <= 2000 && is_array(json_decode($metrics, true))) ? $metrics : null;
        $this->app->db->run('UPDATE captures SET server_ms = ?, client_metrics = ? WHERE id = ?', [$serverMs, $metrics, $captureId]);

        return Response::json([
            'status' => 'confirmed',
            'idempotent_replay' => false,
            'capture_id' => $captureId,
            'checksum' => $checksum,
            'capture_index' => $index,
            'pages' => $pages,
            'server_ms' => $serverMs,
        ], 201);
    }

    /** @param array<string,mixed> $existing */
    private function replay(array $existing, string $bookId, string $checksum): Response
    {
        if ($existing['book_id'] !== $bookId) {
            throw new HttpError(409, 'capture_conflict', 'This capture id belongs to another book.');
        }
        if (!hash_equals((string)$existing['checksum'], $checksum)) {
            throw new HttpError(409, 'capture_conflict', 'A different image is already stored under this capture id. Use explicit replacement.');
        }
        $pages = $this->app->db->all('SELECT id, side, printed_page_number, ocr_status FROM pages WHERE capture_id = ? ORDER BY sort_key', [$existing['id']]);
        return Response::json([
            'status' => 'confirmed',
            'idempotent_replay' => true,
            'capture_id' => $existing['id'],
            'checksum' => $existing['checksum'],
            'capture_index' => (int)$existing['capture_index'],
            'pages' => $pages,
        ]);
    }

    /** Explicit replacement (retake) of a confirmed capture. The previous original is kept. */
    public function replace(Request $req, string $captureId): Response
    {
        $cap = $this->app->db->one('SELECT * FROM captures WHERE id = ?', [$captureId]);
        if ($cap === null) {
            throw new HttpError(404, 'capture_not_found', 'Capture not found.');
        }
        $this->app->book((string)$cap['book_id']);
        if (($req->post['confirm_replace'] ?? '') !== '1') {
            throw new HttpError(422, 'confirmation_required', 'Set confirm_replace=1 to replace a confirmed capture.');
        }
        $checksum = strtolower((string)($req->post['checksum'] ?? ''));
        $file = $req->files['image'] ?? null;
        if (!$file instanceof UploadedFile || !$file->isGenuine()) {
            throw new HttpError(422, 'missing_file', 'No valid image was uploaded (field "image").');
        }
        $meta = ImageService::inspect($file->tmpPath, $this->app->config->int('MAX_UPLOAD_BYTES', 15 * 1024 * 1024), $this->app->config->int('MAX_IMAGE_PIXELS', 60_000_000));
        if (!preg_match('/^[0-9a-f]{64}$/', $checksum) || !hash_equals(hash_file('sha256', $file->tmpPath) ?: '', $checksum)) {
            throw new HttpError(422, 'checksum_mismatch', 'Uploaded bytes do not match the checksum.');
        }
        if (hash_equals((string)$cap['checksum'], $checksum)) {
            return Response::json(['status' => 'confirmed', 'capture_id' => $captureId, 'checksum' => $checksum, 'unchanged' => true]);
        }
        $bookId = (string)$cap['book_id'];
        $this->app->storage->bookDir($bookId, 'originals');
        $key = 'books/' . $bookId . '/originals/' . $captureId . '-r' . time() . '.' . $meta['ext'];
        $this->app->storage->persist($file->tmpPath, $key);
        $this->app->db->tx(function () use ($captureId, $meta, $checksum, $key, $bookId): void {
            $now = Db::now();
            $this->app->db->run(
                'UPDATE captures SET mime = ?, size_bytes = ?, width = ?, height = ?, checksum = ?, storage_key = ? WHERE id = ?',
                [$meta['mime'], (int)filesize($this->app->storage->path($key)), $meta['width'], $meta['height'], $checksum, $key, $captureId]
            );
            foreach ($this->app->db->all('SELECT id FROM pages WHERE capture_id = ?', [$captureId]) as $p) {
                $this->app->db->run("UPDATE pages SET ocr_status = 'not_processed', review_status = 'not_reviewed', updated_at = ? WHERE id = ?", [$now, $p['id']]);
                $this->app->storage->clearPageCache($bookId, (string)$p['id']);
                if ($this->app->config->bool('AUTO_OCR', true)) {
                    OcrController::enqueuePage($this->app, $bookId, (string)$p['id']);
                }
            }
        });
        return Response::json(['status' => 'confirmed', 'capture_id' => $captureId, 'checksum' => $checksum, 'replaced' => true]);
    }

    public static function printedNumber(mixed $v): ?string
    {
        if ($v === null) {
            return null;
        }
        $v = trim((string)$v);
        if ($v === '') {
            return null;
        }
        if (!preg_match('/^[\p{L}\p{N} .\-\/]{1,32}$/u', $v)) {
            throw new HttpError(422, 'invalid_page_number', 'Printed page number may contain letters, digits, space . - / (max 32).');
        }
        return $v;
    }
}
