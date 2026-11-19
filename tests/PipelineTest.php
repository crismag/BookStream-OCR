<?php
declare(strict_types=1);

namespace BookStream\Tests;

use BookStream\Db;

final class PipelineTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->login();
    }

    public function testUploadAutoEnqueuesOcrIdempotently(): void
    {
        $book = $this->createBook();
        $file = $this->jpeg();
        $id = Db::uuid();
        $d = $this->data($this->upload($book['id'], 1, $id, $file, 'spread', '10'));
        self::assertSame(['queued', 'queued'], array_column($d['pages'], 'ocr_status'));
        self::assertIsInt($d['server_ms']);
        self::assertSame(2, (int)$this->db->one("SELECT COUNT(*) AS n FROM ocr_jobs WHERE status = 'queued'")['n']);
        // replay (lost ack) must not create more jobs or pages
        $this->upload($book['id'], 1, $id, $file, 'spread', '10');
        self::assertSame(2, (int)$this->db->one('SELECT COUNT(*) AS n FROM ocr_jobs')['n']);
        self::assertSame(2, (int)$this->db->one('SELECT COUNT(*) AS n FROM pages')['n']);
        // manual enqueue does not duplicate active jobs
        self::assertSame(0, $this->data($this->call('POST', "/api/books/{$book['id']}/ocr/enqueue", []))['enqueued']);
    }

    public function testAutoOcrCanBeDisabled(): void
    {
        $this->env = ['AUTO_OCR' => 'false'];
        parent::setUp();
        $this->login();
        $book = $this->createBook();
        $d = $this->data($this->upload($book['id'], 1));
        self::assertSame('not_processed', $d['pages'][0]['ocr_status']);
        self::assertSame(0, (int)$this->db->one('SELECT COUNT(*) AS n FROM ocr_jobs')['n']);
    }

    public function testWorkerVisibilityAndTimings(): void
    {
        $book = $this->createBook();
        $this->upload($book['id'], 1);
        $st = $this->data($this->call('GET', "/api/books/{$book['id']}/ocr/status"));
        self::assertFalse($st['worker_active'], 'no worker yet: UI must say so');
        self::assertSame(1, $st['queued']);
        self::assertNotNull($st['oldest_queued_seconds']);

        $w = ['worker_id' => 'w-test-1', 'worker_label' => 'Laptop Chrome'];
        $job = $this->data($this->call('POST', '/api/ocr/lease', $w + ['book_id' => $book['id']]))['job'];
        $st = $this->data($this->call('GET', "/api/books/{$book['id']}/ocr/status"));
        self::assertTrue($st['worker_active']);
        self::assertTrue($st['workers'][0]['busy']);
        self::assertSame(1, $st['leased']);

        $this->call('POST', "/api/ocr/jobs/{$job['id']}/complete", $w + ['lease_token' => $job['lease_token'], 'results' => [
            ['region_id' => $job['regions'][0]['id'], 'text' => 'a', 'confidence' => 90, 'duration_ms' => 1234],
            ['region_id' => $job['regions'][1]['id'], 'text' => 'b', 'confidence' => 90, 'duration_ms' => 1500],
        ]]);
        $st = $this->data($this->call('GET', "/api/books/{$book['id']}/ocr/status"));
        self::assertFalse($st['workers'][0]['busy']);
        self::assertSame(1, $st['workers'][0]['jobs_done']);

        $m = $this->data($this->call('GET', "/api/books/{$book['id']}/metrics"));
        self::assertSame(2, $m['ocr_region_exec_ms']['n']);
        self::assertSame(1, $m['server_ms']['n']);
        self::assertSame(1, $m['ocr_queue_delay_ms']['n']);

        // stale worker disappears after 60 s
        $this->db->run('UPDATE ocr_workers SET last_seen = ?', [time() - 61]);
        self::assertFalse($this->data($this->call('GET', "/api/books/{$book['id']}/ocr/status"))['worker_active']);
    }

    public function testClientMetricsStoredWhenValid(): void
    {
        $book = $this->createBook();
        $file = $this->jpeg();
        $copy = $file . '.c';
        copy($file, $copy);
        $r = $this->call('POST', "/api/books/{$book['id']}/captures", null, [
            'capture_id' => Db::uuid(), 'checksum' => hash_file('sha256', $file), 'capture_index' => '1', 'mode' => 'single',
            'client_metrics' => json_encode(['acquire_ms' => 120, 'prepare_ms' => 300, 'upload_ms' => 900]),
        ], ['image' => new \BookStream\Http\UploadedFile($copy, 'p.jpg', (int)filesize($copy), UPLOAD_ERR_OK, false)]);
        self::assertSame(201, $r->status);
        $m = $this->data($this->call('GET', "/api/books/{$book['id']}/metrics"));
        self::assertEquals(120, $m['client']['acquire_ms']['p50']);
    }

    public function testMigrationIsAdditiveAndRerunSafe(): void
    {
        $this->db->migrate();
        $this->db->migrate();
        self::assertSame(2, (int)$this->db->one('SELECT COUNT(*) AS n FROM schema_migrations')['n']);
    }
}
