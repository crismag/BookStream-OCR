<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;
use BookStream\Layout;

final class BookController
{
    public function __construct(private App $app)
    {
    }

    public function list(Request $req): Response
    {
        $u = $this->app->auth->requireUser();
        $archived = ($req->query['archived'] ?? '0') === '1' ? 1 : 0;
        $books = $this->app->db->all('SELECT * FROM books WHERE user_id = ? AND archived = ? ORDER BY updated_at DESC', [$u['id'], $archived]);
        return Response::json(['books' => array_map(fn($b) => $this->present($b), $books)]);
    }

    public function create(Request $req): Response
    {
        $u = $this->app->auth->requireUser();
        $d = $this->validate($req->json(), true);
        $id = Db::uuid();
        $now = Db::now();
        $this->app->db->run(
            'INSERT INTO books (id, user_id, title, author, description, expected_page_count, languages, original_language, translation_language, default_layout, archived, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)',
            [$id, $u['id'], $d['title'], $d['author'] ?? '', $d['description'] ?? '', $d['expected_page_count'] ?? null,
             json_encode($d['languages'] ?? ['eng']), $d['original_language'] ?? 'eng', $d['translation_language'] ?? 'eng',
             $d['default_layout'] ?? 'single', $now, $now]
        );
        $this->app->storage->bookDir($id);
        return Response::json(['book' => $this->present($this->app->book($id))], 201);
    }

    public function get(Request $req, string $id): Response
    {
        return Response::json(['book' => $this->present($this->app->book($id))]);
    }

    public function update(Request $req, string $id): Response
    {
        $this->app->book($id);
        $d = $this->validate($req->json(), false);
        $cols = ['title', 'author', 'description', 'expected_page_count', 'original_language', 'translation_language', 'default_layout'];
        $sets = [];
        $params = [];
        foreach ($cols as $c) {
            if (array_key_exists($c, $d)) {
                $sets[] = "$c = ?";
                $params[] = $d[$c];
            }
        }
        if (array_key_exists('languages', $d)) {
            $sets[] = 'languages = ?';
            $params[] = json_encode($d['languages']);
        }
        if ($sets !== []) {
            $sets[] = 'updated_at = ?';
            $params[] = Db::now();
            $params[] = $id;
            $this->app->db->run('UPDATE books SET ' . implode(', ', $sets) . ' WHERE id = ?', $params);
        }
        return Response::json(['book' => $this->present($this->app->book($id))]);
    }

    public function archive(Request $req, string $id): Response
    {
        $this->app->book($id);
        $archived = !empty($req->json()['archived']) ? 1 : 0;
        $this->app->db->run('UPDATE books SET archived = ?, updated_at = ? WHERE id = ?', [$archived, Db::now(), $id]);
        return Response::json(['book' => $this->present($this->app->book($id))]);
    }

    /** Deletion requires the exact title as confirmation. */
    public function delete(Request $req, string $id): Response
    {
        $book = $this->app->book($id);
        if ((string)($req->json()['confirm_title'] ?? '') !== (string)$book['title']) {
            throw new HttpError(422, 'confirmation_required', 'Type the exact book title to confirm deletion.');
        }
        $db = $this->app->db;
        $db->tx(function () use ($db, $id): void {
            $pageIds = "SELECT id FROM pages WHERE book_id = ?";
            $regionIds = "SELECT r.id FROM regions r JOIN pages p ON p.id = r.page_id WHERE p.book_id = ?";
            $db->run("DELETE FROM alignment_members WHERE book_id = ?", [$id]);
            $db->run("DELETE FROM corrections WHERE region_id IN ($regionIds)", [$id]);
            $db->run("DELETE FROM ocr_results WHERE region_id IN ($regionIds)", [$id]);
            $db->run("DELETE FROM regions WHERE page_id IN ($pageIds)", [$id]);
            $db->run("DELETE FROM ocr_jobs WHERE book_id = ?", [$id]);
            $db->run("DELETE FROM pages WHERE book_id = ?", [$id]);
            $db->run("DELETE FROM captures WHERE book_id = ?", [$id]);
            $db->run("DELETE FROM books WHERE id = ?", [$id]);
        });
        $this->app->storage->deleteBook($id);
        return Response::json(['deleted' => true]);
    }

    /** @param array<string,mixed> $in @return array<string,mixed> */
    private function validate(array $in, bool $creating): array
    {
        $out = [];
        if ($creating || array_key_exists('title', $in)) {
            $t = trim((string)($in['title'] ?? ''));
            if ($t === '' || mb_strlen($t) > 500) {
                throw new HttpError(422, 'invalid_title', 'Title is required (max 500 characters).');
            }
            $out['title'] = $t;
        }
        foreach (['author' => 500, 'description' => 5000] as $k => $max) {
            if (array_key_exists($k, $in)) {
                $out[$k] = mb_substr(trim((string)$in[$k]), 0, $max);
            }
        }
        if (array_key_exists('expected_page_count', $in)) {
            $n = $in['expected_page_count'];
            $out['expected_page_count'] = ($n === null || $n === '') ? null : max(0, min(100000, (int)$n));
        }
        foreach (['original_language', 'translation_language'] as $k) {
            if (array_key_exists($k, $in)) {
                $out[$k] = self::langCode($in[$k]);
            }
        }
        if (array_key_exists('languages', $in)) {
            $langs = is_array($in['languages']) ? $in['languages'] : [];
            $out['languages'] = array_values(array_unique(array_map([self::class, 'langCode'], $langs))) ?: ['eng'];
        }
        if (array_key_exists('default_layout', $in)) {
            if (!in_array($in['default_layout'], Layout::TYPES, true)) {
                throw new HttpError(422, 'invalid_layout', 'Unknown layout.');
            }
            $out['default_layout'] = $in['default_layout'];
        }
        return $out;
    }

    public static function langCode(mixed $v): string
    {
        $v = strtolower(trim((string)$v));
        if (!preg_match('/^[a-z]{2,3}([_-][a-z0-9]{2,8})?$/', $v)) {
            throw new HttpError(422, 'invalid_language', 'Language codes look like "eng" or "mrw".');
        }
        return $v;
    }

    /** @param array<string,mixed> $b @return array<string,mixed> */
    public function present(array $b): array
    {
        $db = $this->app->db;
        $s = $db->one(
            "SELECT COUNT(*) AS pages,
                    SUM(CASE WHEN ocr_status IN ('ocr_complete','needs_review') THEN 1 ELSE 0 END) AS ocr_done,
                    SUM(CASE WHEN ocr_status = 'failed' THEN 1 ELSE 0 END) AS ocr_failed,
                    SUM(CASE WHEN review_status = 'reviewed' THEN 1 ELSE 0 END) AS reviewed,
                    MAX(updated_at) AS last_page_activity
             FROM pages WHERE book_id = ?",
            [$b['id']]
        ) ?? [];
        $cap = $db->one('SELECT COUNT(*) AS n, MAX(capture_index) AS max_index FROM captures WHERE book_id = ?', [$b['id']]) ?? [];
        $numbers = array_column($db->all('SELECT printed_page_number FROM pages WHERE book_id = ? ORDER BY sort_key', [$b['id']]), 'printed_page_number');
        $missing = self::missingPages($numbers, $b['expected_page_count'] === null ? null : (int)$b['expected_page_count']);
        $last = end($numbers);
        $next = (is_string($last) && ctype_digit($last)) ? (string)((int)$last + 1) : null;
        return [
            'id' => $b['id'],
            'title' => $b['title'],
            'author' => $b['author'],
            'description' => $b['description'],
            'expected_page_count' => $b['expected_page_count'] === null ? null : (int)$b['expected_page_count'],
            'languages' => json_decode((string)$b['languages'], true) ?: ['eng'],
            'original_language' => $b['original_language'],
            'translation_language' => $b['translation_language'],
            'default_layout' => $b['default_layout'],
            'archived' => (bool)$b['archived'],
            'created_at' => $b['created_at'],
            'updated_at' => $b['updated_at'],
            'last_activity' => max((string)$b['updated_at'], (string)($s['last_page_activity'] ?? '')),
            'stats' => [
                'captures' => (int)($cap['n'] ?? 0),
                'pages' => (int)($s['pages'] ?? 0),
                'ocr_done' => (int)($s['ocr_done'] ?? 0),
                'ocr_failed' => (int)($s['ocr_failed'] ?? 0),
                'reviewed' => (int)($s['reviewed'] ?? 0),
                'missing_count' => count($missing['missing']),
            ],
            'next_capture_index' => (int)($cap['max_index'] ?? 0) + 1,
            'next_printed_page' => $next,
        ];
    }

    /**
     * Gaps and duplicates in numeric printed page numbers, plus the expected count.
     * @param list<string|null> $numbers
     * @return array{missing:list<int>,duplicates:list<string>,numbered:int,unnumbered:int}
     */
    public static function missingPages(array $numbers, ?int $expected): array
    {
        $nums = [];
        $unnumbered = 0;
        $seen = [];
        $dups = [];
        foreach ($numbers as $n) {
            if ($n === null || $n === '') {
                $unnumbered++;
                continue;
            }
            if (isset($seen[$n])) {
                $dups[$n] = true;
            }
            $seen[$n] = true;
            if (ctype_digit($n)) {
                $nums[(int)$n] = true;
            }
        }
        $missing = [];
        if ($nums !== []) {
            $hi = max(array_keys($nums));
            if ($expected !== null && $expected > $hi) {
                $hi = $expected;
            }
            $lo = min(array_keys($nums));
            if ($expected !== null) {
                $lo = min(1, $lo);
            }
            for ($i = $lo; $i <= $hi && count($missing) < 5000; $i++) {
                if (!isset($nums[$i])) {
                    $missing[] = $i;
                }
            }
        }
        return ['missing' => $missing, 'duplicates' => array_map('strval', array_keys($dups)), 'numbered' => count($nums), 'unnumbered' => $unnumbered];
    }
}
