<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;
use BookStream\ImageService;
use BookStream\Layout;

final class PageController
{
    public const REVIEW = ['not_reviewed', 'needs_review', 'reviewed'];

    public function __construct(private App $app)
    {
    }

    public function list(Request $req, string $bookId): Response
    {
        $book = $this->app->book($bookId);
        $rows = $this->app->db->all(
            'SELECT p.*, c.capture_index, c.mode AS capture_mode FROM pages p JOIN captures c ON c.id = p.capture_id WHERE p.book_id = ? ORDER BY p.sort_key, p.created_at',
            [$bookId]
        );
        $pages = [];
        foreach ($rows as $i => $r) {
            $pages[] = self::presentPage($r) + ['sequence_number' => $i + 1, 'capture_index' => (int)$r['capture_index']];
        }
        $gaps = BookController::missingPages(array_column($rows, 'printed_page_number'), $book['expected_page_count'] === null ? null : (int)$book['expected_page_count']);
        return Response::json(['pages' => $pages, 'integrity' => $gaps]);
    }

    public function reorder(Request $req, string $bookId): Response
    {
        $this->app->book($bookId);
        $ids = $req->json()['page_ids'] ?? null;
        if (!is_array($ids) || $ids === []) {
            throw new HttpError(422, 'invalid_order', 'page_ids must be a non-empty array.');
        }
        $current = array_column($this->app->db->all('SELECT id FROM pages WHERE book_id = ?', [$bookId]), 'id');
        sort($current);
        $given = array_map('strval', $ids);
        $sorted = $given;
        sort($sorted);
        if ($sorted !== $current) {
            throw new HttpError(422, 'invalid_order', 'page_ids must list every page of the book exactly once.');
        }
        $this->app->db->tx(function () use ($given): void {
            foreach ($given as $i => $id) {
                $this->app->db->run('UPDATE pages SET sort_key = ?, updated_at = ? WHERE id = ?', [($i + 1) * 10, Db::now(), $id]);
            }
        });
        return Response::json(['ok' => true]);
    }

    public function get(Request $req, string $pageId): Response
    {
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    public function update(Request $req, string $pageId): Response
    {
        [$page] = $this->app->page($pageId);
        $d = $req->json();
        $sets = [];
        $params = [];
        $imageChanged = false;
        if (array_key_exists('printed_page_number', $d)) {
            $sets[] = 'printed_page_number = ?';
            $params[] = CaptureController::printedNumber($d['printed_page_number']);
        }
        if (array_key_exists('rotation', $d)) {
            $rot = (int)$d['rotation'];
            if (!in_array((($rot % 360) + 360) % 360, [0, 90, 180, 270], true)) {
                throw new HttpError(422, 'invalid_rotation', 'Rotation must be a multiple of 90.');
            }
            $sets[] = 'rotation = ?';
            $params[] = (($rot % 360) + 360) % 360;
            $imageChanged = true;
        }
        if (array_key_exists('crop_region', $d)) {
            $sets[] = 'crop_region = ?';
            $params[] = $d['crop_region'] === null ? null : json_encode(Layout::cleanBbox($d['crop_region']));
            $imageChanged = true;
        }
        if (array_key_exists('layout', $d)) {
            if ($d['layout'] !== null && !in_array($d['layout'], Layout::TYPES, true)) {
                throw new HttpError(422, 'invalid_layout', 'Unknown layout.');
            }
            $sets[] = 'layout = ?';
            $params[] = $d['layout'];
        }
        if (array_key_exists('review_status', $d)) {
            if (!in_array($d['review_status'], self::REVIEW, true)) {
                throw new HttpError(422, 'invalid_status', 'Unknown review status.');
            }
            $sets[] = 'review_status = ?';
            $params[] = $d['review_status'];
        }
        if ($sets !== []) {
            $sets[] = 'updated_at = ?';
            $params[] = Db::now();
            $params[] = $pageId;
            $this->app->db->run('UPDATE pages SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        }
        if ($imageChanged) {
            $this->app->storage->clearPageCache((string)$page['book_id'], $pageId);
        }
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    /** Removes the logical page (and its regions/OCR). The captured original image is kept. */
    public function delete(Request $req, string $pageId): Response
    {
        [$page] = $this->app->page($pageId);
        if (empty($req->json()['confirm'])) {
            throw new HttpError(422, 'confirmation_required', 'Send {"confirm": true} to delete a page.');
        }
        $db = $this->app->db;
        $db->tx(function () use ($db, $pageId): void {
            $regions = 'SELECT id FROM regions WHERE page_id = ?';
            $db->run("DELETE FROM alignment_members WHERE region_id IN ($regions)", [$pageId]);
            $db->run("DELETE FROM corrections WHERE region_id IN ($regions)", [$pageId]);
            $db->run("DELETE FROM ocr_results WHERE region_id IN ($regions)", [$pageId]);
            $db->run('DELETE FROM regions WHERE page_id = ?', [$pageId]);
            $db->run('DELETE FROM ocr_jobs WHERE page_id = ?', [$pageId]);
            $db->run('DELETE FROM pages WHERE id = ?', [$pageId]);
        });
        $this->app->storage->clearPageCache((string)$page['book_id'], $pageId);
        return Response::json(['deleted' => true]);
    }

    public function image(Request $req, string $pageId): Response
    {
        [$page] = $this->app->page($pageId);
        $cap = $this->app->db->one('SELECT * FROM captures WHERE id = ?', [$page['capture_id']]);
        if ($cap === null) {
            throw new HttpError(404, 'capture_not_found', 'Capture not found.');
        }
        $variant = (string)($req->query['variant'] ?? 'view');
        if ($variant === 'original') {
            return Response::file($this->app->storage->path((string)$cap['storage_key']), (string)$cap['mime']);
        }
        if (!isset(ImageService::VARIANTS[$variant])) {
            throw new HttpError(422, 'invalid_variant', 'variant must be thumb, view, full or original.');
        }
        return Response::file(ImageService::derive($this->app->storage, $page, $cap, $variant), 'image/jpeg');
    }

    public function applyPreset(Request $req, string $pageId): Response
    {
        [$page, $book] = $this->app->page($pageId);
        $d = $req->json();
        $layout = (string)($d['layout'] ?? ($page['layout'] ?? $book['default_layout']));
        if (!in_array($layout, Layout::TYPES, true)) {
            throw new HttpError(422, 'invalid_layout', 'Unknown layout.');
        }
        $hasOcr = $this->app->db->one('SELECT o.id FROM ocr_results o JOIN regions r ON r.id = o.region_id WHERE r.page_id = ? LIMIT 1', [$pageId]) !== null;
        if ($hasOcr && empty($d['force'])) {
            throw new HttpError(409, 'has_ocr', 'This page already has OCR text. Send force=true to discard regions and their text.');
        }
        $this->app->db->tx(function () use ($pageId, $layout, $book): void {
            $this->deleteRegions($pageId);
            $this->app->db->run('UPDATE pages SET layout = ?, ocr_status = ?, updated_at = ? WHERE id = ?', [$layout, 'not_processed', Db::now(), $pageId]);
            self::createPresetRegions($this->app, $pageId, $layout, $book);
        });
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    /** Upsert regions. Regions not listed are kept unless delete_missing=true. */
    public function saveRegions(Request $req, string $pageId): Response
    {
        [$page, $book] = $this->app->page($pageId);
        $d = $req->json();
        $list = $d['regions'] ?? null;
        if (!is_array($list)) {
            throw new HttpError(422, 'invalid_regions', 'regions must be an array.');
        }
        $this->app->db->tx(function () use ($list, $pageId, $d): void {
            $keep = [];
            foreach ($list as $i => $r) {
                if (!is_array($r)) {
                    throw new HttpError(422, 'invalid_regions', 'Each region must be an object.');
                }
                $bbox = json_encode(Layout::cleanBbox($r['bbox'] ?? null));
                $role = (string)($r['role'] ?? 'text');
                $type = (string)($r['block_type'] ?? 'text');
                if (!in_array($role, Layout::ROLES, true) || !in_array($type, Layout::BLOCK_TYPES, true)) {
                    throw new HttpError(422, 'invalid_region_type', 'Unknown region role or block type.');
                }
                $lang = BookController::langCode($r['lang'] ?? 'eng');
                $col = substr(preg_replace('/[^A-Za-z0-9_-]/', '', (string)($r['column_id'] ?? 'main')) ?: 'main', 0, 16);
                $order = (int)($r['reading_order'] ?? ($i + 1));
                $id = isset($r['id']) ? (string)$r['id'] : null;
                $now = Db::now();
                if ($id !== null && $this->app->db->one('SELECT id FROM regions WHERE id = ? AND page_id = ?', [$id, $pageId]) !== null) {
                    $this->app->db->run(
                        'UPDATE regions SET bbox = ?, column_id = ?, reading_order = ?, lang = ?, role = ?, block_type = ?, source = ?, updated_at = ? WHERE id = ?',
                        [$bbox, $col, $order, $lang, $role, $type, 'manual', $now, $id]
                    );
                } else {
                    $id = Db::uuid();
                    $this->app->db->run(
                        'INSERT INTO regions (id, page_id, bbox, column_id, reading_order, lang, role, block_type, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                        [$id, $pageId, $bbox, $col, $order, $lang, $role, $type, 'manual', $now, $now]
                    );
                }
                $keep[] = $id;
            }
            if (!empty($d['delete_missing'])) {
                foreach ($this->app->db->all('SELECT id FROM regions WHERE page_id = ?', [$pageId]) as $r) {
                    if (!in_array($r['id'], $keep, true)) {
                        $this->deleteRegion(null, (string)$r['id'], false);
                    }
                }
            }
        });
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    public function deleteRegion(?Request $req, string $regionId, bool $respond = true): ?Response
    {
        $r = $this->app->db->one('SELECT * FROM regions WHERE id = ?', [$regionId]);
        if ($r === null) {
            throw new HttpError(404, 'region_not_found', 'Region not found.');
        }
        $this->app->page((string)$r['page_id']);
        foreach (['alignment_members', 'corrections', 'ocr_results'] as $t) {
            $this->app->db->run("DELETE FROM $t WHERE region_id = ?", [$regionId]);
        }
        $this->app->db->run('DELETE FROM regions WHERE id = ?', [$regionId]);
        return $respond ? Response::json(['deleted' => true]) : null;
    }

    private function deleteRegions(string $pageId): void
    {
        foreach ($this->app->db->all('SELECT id FROM regions WHERE page_id = ?', [$pageId]) as $r) {
            $this->deleteRegion(null, (string)$r['id'], false);
        }
    }

    /** Human correction, stored separately from OCR output. */
    public function correct(Request $req, string $regionId): Response
    {
        $r = $this->app->db->one('SELECT * FROM regions WHERE id = ?', [$regionId]);
        if ($r === null) {
            throw new HttpError(404, 'region_not_found', 'Region not found.');
        }
        $this->app->page((string)$r['page_id']);
        $text = $req->json()['text'] ?? null;
        if (!is_string($text) || strlen($text) > 200000) {
            throw new HttpError(422, 'invalid_text', 'text must be a string (max 200k).');
        }
        if (!mb_check_encoding($text, 'UTF-8')) {
            throw new HttpError(422, 'invalid_text', 'text must be valid UTF-8.');
        }
        $prev = self::effectiveText($this->app, $regionId);
        $ocr = $this->app->db->one('SELECT version FROM ocr_results WHERE region_id = ? ORDER BY version DESC LIMIT 1', [$regionId]);
        $this->app->db->run(
            'INSERT INTO corrections (id, region_id, page_id, previous_text, corrected_text, based_on_ocr_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [Db::uuid(), $regionId, $r['page_id'], $prev['text'], $text, $ocr['version'] ?? null, Db::now()]
        );
        $this->app->db->run("UPDATE pages SET review_status = CASE WHEN review_status = 'reviewed' THEN 'reviewed' ELSE 'needs_review' END, updated_at = ? WHERE id = ?", [Db::now(), $r['page_id']]);
        return Response::json(['region_id' => $regionId] + self::effectiveText($this->app, $regionId));
    }

    /**
     * Inferred alignment: pair original and translation regions by reading order.
     * Extra regions on either side stay unpaired. Verified groups are never touched.
     */
    public function inferAlignment(Request $req, string $pageId): Response
    {
        [$page, $book] = $this->app->page($pageId);
        $regions = $this->app->db->all('SELECT * FROM regions WHERE page_id = ? ORDER BY reading_order', [$pageId]);
        $verified = [];
        foreach ($regions as $r) {
            if ($this->app->db->one("SELECT id FROM alignment_members WHERE region_id = ? AND status = 'verified'", [$r['id']]) !== null) {
                $verified[$r['id']] = true;
            }
        }
        $orig = array_values(array_filter($regions, fn($r) => $r['role'] === 'original' && !isset($verified[$r['id']])));
        $trans = array_values(array_filter($regions, fn($r) => $r['role'] === 'translation' && !isset($verified[$r['id']])));
        $this->app->db->tx(function () use ($regions, $verified, $orig, $trans, $book): void {
            foreach ($regions as $r) {
                if (!isset($verified[$r['id']])) {
                    $this->app->db->run("DELETE FROM alignment_members WHERE region_id = ? AND status = 'inferred'", [$r['id']]);
                }
            }
            for ($i = 0; $i < min(count($orig), count($trans)); $i++) {
                $g = Db::uuid();
                foreach ([$orig[$i], $trans[$i]] as $r) {
                    $this->app->db->run('INSERT INTO alignment_members (id, book_id, group_id, region_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [Db::uuid(), $book['id'], $g, $r['id'], 'inferred', Db::now()]);
                }
            }
        });
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    /**
     * Replace this page's alignment with explicit groups: {"groups":[{"region_ids":[...],"status":"verified"}]}.
     * Groups may be 1:1, 1:n or n:1; regions not in any group are unpaired.
     */
    public function saveAlignment(Request $req, string $pageId): Response
    {
        [$page, $book] = $this->app->page($pageId);
        $groups = $req->json()['groups'] ?? null;
        if (!is_array($groups)) {
            throw new HttpError(422, 'invalid_groups', 'groups must be an array.');
        }
        $pageRegions = array_column($this->app->db->all('SELECT id FROM regions WHERE page_id = ?', [$pageId]), 'id');
        $used = [];
        foreach ($groups as $g) {
            $ids = is_array($g['region_ids'] ?? null) ? array_map('strval', $g['region_ids']) : [];
            if (count($ids) < 2) {
                throw new HttpError(422, 'invalid_groups', 'Each group needs at least two regions.');
            }
            foreach ($ids as $id) {
                if (!in_array($id, $pageRegions, true) || isset($used[$id])) {
                    throw new HttpError(422, 'invalid_groups', 'Regions must belong to this page and appear in only one group.');
                }
                $used[$id] = true;
            }
        }
        $this->app->db->tx(function () use ($groups, $pageRegions, $book): void {
            foreach ($pageRegions as $rid) {
                $this->app->db->run('DELETE FROM alignment_members WHERE region_id = ?', [$rid]);
            }
            foreach ($groups as $g) {
                $gid = Db::uuid();
                $status = ($g['status'] ?? 'verified') === 'inferred' ? 'inferred' : 'verified';
                foreach ($g['region_ids'] as $rid) {
                    $this->app->db->run('INSERT INTO alignment_members (id, book_id, group_id, region_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [Db::uuid(), $book['id'], $gid, (string)$rid, $status, Db::now()]);
                }
            }
        });
        [$page, $book] = $this->app->page($pageId);
        return Response::json(self::detail($this->app, $page, $book));
    }

    /** @param array<string,mixed> $book */
    public static function createPresetRegions(App $app, string $pageId, string $layout, array $book): void
    {
        foreach (Layout::preset($layout, $book) as $r) {
            $now = Db::now();
            $app->db->run(
                'INSERT INTO regions (id, page_id, bbox, column_id, reading_order, lang, role, block_type, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [Db::uuid(), $pageId, json_encode($r['bbox']), $r['column_id'], $r['reading_order'], $r['lang'], $r['role'], $r['block_type'], 'preset', $now, $now]
            );
        }
    }

    /**
     * Text to use for a region: latest correction if any, else latest OCR.
     * @return array{text:?string,source:string,ocr_text:?string,ocr_version:?int,confidence:?float,flagged_words:list<string>,corrected:bool}
     */
    public static function effectiveText(App $app, string $regionId): array
    {
        $ocr = $app->db->one('SELECT * FROM ocr_results WHERE region_id = ? ORDER BY version DESC LIMIT 1', [$regionId]);
        $cor = $app->db->one('SELECT * FROM corrections WHERE region_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1', [$regionId]);
        $flagged = $ocr !== null ? (json_decode((string)($ocr['flagged_words'] ?? '[]'), true) ?: []) : [];
        return [
            'text' => $cor !== null ? (string)$cor['corrected_text'] : ($ocr !== null ? (string)$ocr['recognized_text'] : null),
            'text_source' => $cor !== null ? 'correction' : ($ocr !== null ? 'ocr' : 'none'),
            'ocr_text' => $ocr !== null ? (string)$ocr['recognized_text'] : null,
            'ocr_version' => $ocr !== null ? (int)$ocr['version'] : null,
            'ocr_engine' => $ocr !== null ? (string)$ocr['engine'] . ($ocr['engine_version'] ? ' ' . $ocr['engine_version'] : '') : null,
            'confidence' => $ocr !== null && $ocr['confidence'] !== null ? (float)$ocr['confidence'] : null,
            'flagged_words' => array_values(array_map('strval', $flagged)),
            'corrected' => $cor !== null,
        ];
    }

    /** @param array<string,mixed> $p @return array<string,mixed> */
    public static function presentPage(array $p): array
    {
        return [
            'id' => $p['id'],
            'book_id' => $p['book_id'],
            'capture_id' => $p['capture_id'],
            'side' => $p['side'],
            'printed_page_number' => $p['printed_page_number'],
            'crop_region' => $p['crop_region'] ? json_decode((string)$p['crop_region'], true) : null,
            'rotation' => (int)$p['rotation'],
            'layout' => $p['layout'],
            'image_status' => $p['image_status'],
            'ocr_status' => $p['ocr_status'],
            'review_status' => $p['review_status'],
            'updated_at' => $p['updated_at'],
        ];
    }

    /**
     * @param array<string,mixed> $page
     * @param array<string,mixed> $book
     * @return array<string,mixed>
     */
    public static function detail(App $app, array $page, array $book): array
    {
        $regions = [];
        foreach ($app->db->all('SELECT * FROM regions WHERE page_id = ? ORDER BY reading_order, created_at', [$page['id']]) as $r) {
            $align = $app->db->one('SELECT group_id, status FROM alignment_members WHERE region_id = ?', [$r['id']]);
            $regions[] = [
                'id' => $r['id'],
                'bbox' => json_decode((string)$r['bbox'], true),
                'column_id' => $r['column_id'],
                'reading_order' => (int)$r['reading_order'],
                'lang' => $r['lang'],
                'role' => $r['role'],
                'block_type' => $r['block_type'],
                'source' => $r['source'],
                'alignment' => $align === null ? null : ['group_id' => $align['group_id'], 'status' => $align['status']],
            ] + self::effectiveText($app, (string)$r['id']);
        }
        $ordered = $app->db->all('SELECT id FROM pages WHERE book_id = ? ORDER BY sort_key, created_at', [$book['id']]);
        $ids = array_column($ordered, 'id');
        $pos = array_search($page['id'], $ids, true);
        return [
            'page' => self::presentPage($page) + [
                'sequence_number' => $pos === false ? null : $pos + 1,
                'effective_layout' => $page['layout'] ?? $book['default_layout'],
                'prev_page_id' => ($pos !== false && $pos > 0) ? $ids[$pos - 1] : null,
                'next_page_id' => ($pos !== false && $pos < count($ids) - 1) ? $ids[$pos + 1] : null,
            ],
            'book' => ['id' => $book['id'], 'title' => $book['title'], 'original_language' => $book['original_language'], 'translation_language' => $book['translation_language'], 'default_layout' => $book['default_layout']],
            'regions' => $regions,
            'ocr_versions' => $app->db->all('SELECT o.region_id, o.version, o.engine, o.engine_version, o.confidence, o.recognized_text AS text, o.created_at FROM ocr_results o JOIN regions r ON r.id = o.region_id WHERE r.page_id = ? ORDER BY o.version DESC', [$page['id']]),
        ];
    }
}
