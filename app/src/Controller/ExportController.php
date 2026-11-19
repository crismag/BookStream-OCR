<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;

/**
 * Exports are generated from the structured model. Region text = latest human
 * correction if present, otherwise the latest OCR result, never altered.
 */
final class ExportController
{
    public const SCHEMA = 'bookstream.book.v1';
    private const MODES = ['full', 'original', 'translation', 'parallel'];

    public function __construct(private App $app)
    {
    }

    /** @return array{book:array<string,mixed>,pages:list<array<string,mixed>>,integrity:array<string,mixed>} */
    private function collect(string $bookId, Request $req): array
    {
        $book = $this->app->book($bookId);
        $from = isset($req->query['from']) ? max(1, (int)$req->query['from']) : 1;
        $to = isset($req->query['to']) ? (int)$req->query['to'] : PHP_INT_MAX;
        $exclude = array_filter(explode(',', (string)($req->query['exclude'] ?? '')));
        $rows = $this->app->db->all('SELECT * FROM pages WHERE book_id = ? ORDER BY sort_key, created_at', [$bookId]);
        $integrity = BookController::missingPages(array_column($rows, 'printed_page_number'), $book['expected_page_count'] === null ? null : (int)$book['expected_page_count']);
        $pages = [];
        foreach ($rows as $i => $p) {
            $seq = $i + 1;
            if ($seq < $from || $seq > $to) {
                continue;
            }
            $detail = PageController::detail($this->app, $p, $book);
            $detail['regions'] = array_values(array_filter($detail['regions'], fn($r) => !in_array($r['block_type'], $exclude, true)));
            $pages[] = $detail;
        }
        return ['book' => $book, 'pages' => $pages, 'integrity' => $integrity];
    }

    public function txt(Request $req, string $bookId): Response
    {
        $mode = (string)($req->query['mode'] ?? 'full');
        if (!in_array($mode, self::MODES, true)) {
            throw new HttpError(422, 'invalid_mode', 'mode must be full, original, translation or parallel.');
        }
        ['book' => $book, 'pages' => $pages, 'integrity' => $integrity] = $this->collect($bookId, $req);
        $lang = isset($req->query['lang']) ? BookController::langCode($req->query['lang']) : match ($mode) {
            'original' => (string)$book['original_language'],
            'translation' => (string)$book['translation_language'],
            default => null,
        };
        if (($req->query['format'] ?? '') === 'tsv' && $mode === 'parallel') {
            return $this->parallelTsv($book, $pages);
        }
        $out = [];
        $out[] = '# ' . $book['title'] . ($book['author'] !== '' ? ' — ' . $book['author'] : '');
        $out[] = '# BookStream OCR export · mode=' . $mode . ($lang !== null ? ' · lang=' . $lang : '') . ' · ' . Db::now();
        $out[] = '# Text = human correction where present, otherwise unmodified OCR output.';
        if ($integrity['missing'] !== []) {
            $out[] = '# Missing printed pages: ' . self::ranges($integrity['missing']);
        }
        if ($integrity['duplicates'] !== []) {
            $out[] = '# Duplicate printed page numbers: ' . implode(', ', $integrity['duplicates']);
        }
        $out[] = '';
        foreach ($pages as $d) {
            $p = $d['page'];
            $label = $p['printed_page_number'] !== null ? 'Page ' . $p['printed_page_number'] : 'Unnumbered page';
            $out[] = '=== ' . $label . ' (sequence ' . $p['sequence_number'] . ') ===';
            if ($mode === 'parallel') {
                $out = array_merge($out, $this->parallelBlocks($d['regions']));
            } else {
                foreach ($d['regions'] as $r) {
                    if ($lang !== null && $r['lang'] !== $lang) {
                        continue;
                    }
                    if ($mode === 'full') {
                        $out[] = '[' . $r['column_id'] . ' · ' . $r['lang'] . ' · ' . $r['block_type'] . ($r['text_source'] === 'none' ? ' · NOT PROCESSED' : '') . ($r['text_source'] === 'ocr' ? ' · uncorrected' : '') . ']';
                    }
                    $out[] = $r['text'] ?? '';
                    $out[] = '';
                }
            }
            $out[] = '';
        }
        $name = self::slug((string)$book['title']) . '-' . $mode . ($lang ? '-' . $lang : '') . '.txt';
        $body = implode("\n", $out);
        return ($req->query['download'] ?? '1') === '0' ? Response::text($body) : Response::text($body, 'text/plain; charset=utf-8', $name);
    }

    /** @param list<array<string,mixed>> $regions @return list<string> */
    private function parallelBlocks(array $regions): array
    {
        $out = [];
        $groups = [];
        $unpaired = [];
        foreach ($regions as $r) {
            if ($r['alignment'] !== null) {
                $groups[$r['alignment']['group_id']][] = $r;
            } else {
                $unpaired[] = $r;
            }
        }
        $n = 0;
        foreach ($groups as $members) {
            $n++;
            $out[] = '--- Pair ' . $n . ' (' . $members[0]['alignment']['status'] . ') ---';
            usort($members, fn($a, $b) => [$a['role'] === 'translation', $a['reading_order']] <=> [$b['role'] === 'translation', $b['reading_order']]);
            foreach ($members as $m) {
                $out[] = '[' . $m['lang'] . ' · ' . $m['role'] . ']';
                $out[] = $m['text'] ?? '';
                $out[] = '';
            }
        }
        foreach ($unpaired as $r) {
            $out[] = '--- Unpaired [' . $r['lang'] . ' · ' . $r['role'] . '] ---';
            $out[] = $r['text'] ?? '';
            $out[] = '';
        }
        return $out;
    }

    /**
     * @param array<string,mixed> $book
     * @param list<array<string,mixed>> $pages
     */
    private function parallelTsv(array $book, array $pages): Response
    {
        $esc = fn(?string $s) => str_replace(["\\", "\t", "\r\n", "\n"], ["\\\\", '\\t', '\\n', '\\n'], (string)$s);
        $lines = ["page\tsequence\tpair\tstatus\toriginal\ttranslation"];
        foreach ($pages as $d) {
            $groups = [];
            foreach ($d['regions'] as $r) {
                $key = $r['alignment']['group_id'] ?? 'unpaired-' . $r['id'];
                $groups[$key][] = $r;
            }
            $n = 0;
            foreach ($groups as $members) {
                $n++;
                $orig = implode("\n", array_map(fn($m) => (string)$m['text'], array_filter($members, fn($m) => $m['role'] !== 'translation')));
                $tr = implode("\n", array_map(fn($m) => (string)$m['text'], array_filter($members, fn($m) => $m['role'] === 'translation')));
                $lines[] = implode("\t", [$esc($d['page']['printed_page_number']), $d['page']['sequence_number'], $n, $members[0]['alignment']['status'] ?? 'unpaired', $esc($orig), $esc($tr)]);
            }
        }
        return Response::text(implode("\n", $lines) . "\n", 'text/tab-separated-values; charset=utf-8', self::slug((string)$book['title']) . '-parallel.tsv');
    }

    public function json(Request $req, string $bookId): Response
    {
        ['book' => $book, 'pages' => $pages, 'integrity' => $integrity] = $this->collect($bookId, $req);
        $db = $this->app->db;
        $outPages = [];
        foreach ($pages as $d) {
            $regions = [];
            foreach ($d['regions'] as $r) {
                $regions[] = [
                    'id' => $r['id'],
                    'bbox' => $r['bbox'],
                    'column_id' => $r['column_id'],
                    'reading_order' => $r['reading_order'],
                    'lang' => $r['lang'],
                    'role' => $r['role'],
                    'block_type' => $r['block_type'],
                    'region_source' => $r['source'],
                    'text' => $r['text'],
                    'text_source' => $r['text_source'],
                    'alignment' => $r['alignment'],
                    'ocr_results' => array_map(fn($o) => [
                        'version' => (int)$o['version'], 'engine' => $o['engine'], 'engine_version' => $o['engine_version'],
                        'settings' => json_decode((string)$o['settings'], true), 'language' => $o['language'],
                        'text' => $o['recognized_text'], 'confidence' => $o['confidence'] === null ? null : (float)$o['confidence'],
                        'flagged_words' => json_decode((string)$o['flagged_words'], true) ?: [], 'created_at' => $o['created_at'],
                    ], $db->all('SELECT * FROM ocr_results WHERE region_id = ? ORDER BY version', [$r['id']])),
                    'corrections' => array_map(fn($c) => [
                        'corrected_text' => $c['corrected_text'], 'previous_text' => $c['previous_text'],
                        'based_on_ocr_version' => $c['based_on_ocr_version'] === null ? null : (int)$c['based_on_ocr_version'], 'updated_at' => $c['updated_at'],
                    ], $db->all('SELECT * FROM corrections WHERE region_id = ? ORDER BY updated_at', [$r['id']])),
                ];
            }
            $p = $d['page'];
            $outPages[] = [
                'id' => $p['id'], 'capture_id' => $p['capture_id'], 'sequence_number' => $p['sequence_number'],
                'printed_page_number' => $p['printed_page_number'], 'side' => $p['side'], 'layout' => $p['effective_layout'],
                'crop_region' => $p['crop_region'], 'rotation' => $p['rotation'],
                'image_status' => $p['image_status'], 'ocr_status' => $p['ocr_status'], 'review_status' => $p['review_status'],
                'source_image' => ['capture_id' => $p['capture_id'], 'checksum_sha256' => $db->one('SELECT checksum FROM captures WHERE id = ?', [$p['capture_id']])['checksum'] ?? null],
                'regions' => $regions,
            ];
        }
        $doc = [
            'schema' => self::SCHEMA,
            'exported_at' => Db::now(),
            'book' => [
                'id' => $book['id'], 'title' => $book['title'], 'author' => $book['author'], 'description' => $book['description'],
                'expected_page_count' => $book['expected_page_count'] === null ? null : (int)$book['expected_page_count'],
                'languages' => json_decode((string)$book['languages'], true), 'original_language' => $book['original_language'],
                'translation_language' => $book['translation_language'], 'default_layout' => $book['default_layout'],
            ],
            'integrity' => $integrity,
            'pages' => $outPages,
        ];
        $body = (string)json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        return Response::text($body, 'application/json; charset=utf-8', ($req->query['download'] ?? '1') === '0' ? null : self::slug((string)$book['title']) . '.json');
    }

    /** @param list<int> $nums */
    public static function ranges(array $nums): string
    {
        $parts = [];
        $start = $prev = null;
        foreach ($nums as $n) {
            if ($start === null) {
                $start = $prev = $n;
            } elseif ($n === $prev + 1) {
                $prev = $n;
            } else {
                $parts[] = $start === $prev ? (string)$start : $start . "–" . $prev;
                $start = $prev = $n;
            }
        }
        if ($start !== null) {
            $parts[] = $start === $prev ? (string)$start : $start . "–" . $prev;
        }
        return implode(', ', $parts);
    }

    public static function slug(string $s): string
    {
        $s = strtolower(trim((string)preg_replace('/[^A-Za-z0-9]+/', '-', $s), '-'));
        return $s === '' ? 'book' : substr($s, 0, 80);
    }
}
