<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Http\Request;
use BookStream\Http\Response;

/** Measured pipeline timings (p50/p95) for the diagnostics screen. */
final class MetricsController
{
    public function __construct(private App $app)
    {
    }

    public function book(Request $req, string $bookId): Response
    {
        $this->app->book($bookId);
        $db = $this->app->db;
        $caps = $db->all('SELECT server_ms, client_metrics, size_bytes, width, height FROM captures WHERE book_id = ? ORDER BY created_at DESC LIMIT 300', [$bookId]);
        $client = [];
        foreach ($caps as $c) {
            $m = json_decode((string)$c['client_metrics'], true);
            if (!is_array($m)) {
                continue;
            }
            foreach ($m as $k => $v) {
                if (is_numeric($v) && preg_match('/^[a-z_]{1,32}$/', (string)$k)) {
                    $client[$k][] = (float)$v;
                }
            }
        }
        $jobs = $db->all("SELECT created_ts, leased_ts, completed_ts FROM ocr_jobs WHERE book_id = ? AND status = 'done' AND completed_ts IS NOT NULL ORDER BY completed_ts DESC LIMIT 300", [$bookId]);
        $queueDelay = [];
        $ocrTotal = [];
        foreach ($jobs as $j) {
            if ($j['created_ts'] !== null && $j['leased_ts'] !== null) {
                $queueDelay[] = 1000.0 * ((int)$j['leased_ts'] - (int)$j['created_ts']);
            }
            if ($j['leased_ts'] !== null) {
                $ocrTotal[] = 1000.0 * ((int)$j['completed_ts'] - (int)$j['leased_ts']);
            }
        }
        $exec = array_map('floatval', array_column($db->all('SELECT o.duration_ms FROM ocr_results o JOIN pages p ON p.id = o.page_id WHERE p.book_id = ? AND o.duration_ms IS NOT NULL ORDER BY o.created_at DESC LIMIT 600', [$bookId]), 'duration_ms'));

        $out = [
            'server_ms' => self::stats(array_map('floatval', array_filter(array_column($caps, 'server_ms'), fn($v) => $v !== null))),
            'stored_bytes' => self::stats(array_map('floatval', array_column($caps, 'size_bytes'))),
            'ocr_queue_delay_ms' => self::stats($queueDelay),
            'ocr_job_ms' => self::stats($ocrTotal),
            'ocr_region_exec_ms' => self::stats($exec),
            'client' => array_map([self::class, 'stats'], $client),
        ];
        return Response::json($out);
    }

    /** @param list<float> $v @return array{n:int,p50:?float,p95:?float,max:?float} */
    public static function stats(array $v): array
    {
        $v = array_values($v);
        sort($v);
        $n = count($v);
        $pick = fn(float $q) => $n ? round($v[min($n - 1, (int)floor($q * ($n - 1) + 0.5))], 1) : null;
        return ['n' => $n, 'p50' => $pick(0.5), 'p95' => $pick(0.95), 'max' => $n ? round($v[$n - 1], 1) : null];
    }
}
