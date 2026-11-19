<?php
declare(strict_types=1);

namespace BookStream\Tests;

final class OcrExportTest extends TestCase
{
    /** @var array<string,mixed> */
    private array $book;

    protected function setUp(): void
    {
        parent::setUp();
        $this->login();
        $this->book = $this->createBook();
    }

    /** @return array<string,mixed> */
    private function leaseOne(): array
    {
        $r = $this->call('POST', '/api/ocr/lease', ['book_id' => $this->book['id']]);
        self::assertSame(200, $r->status, $r->body);
        return $this->data($r)['job'];
    }

    public function testFullOcrLifecycleAndParallelExports(): void
    {
        $this->upload($this->book['id'], 1, null, null, 'single', '12');
        // upload already queued the page automatically
        self::assertSame('queued', $this->db->one('SELECT ocr_status FROM pages')['ocr_status']);
        // enqueue again: no duplicates
        self::assertSame(0, $this->data($this->call('POST', "/api/books/{$this->book['id']}/ocr/enqueue", []))['enqueued']);

        $job = $this->leaseOne();
        self::assertCount(2, $job['regions']);
        [$orig, $trans] = $job['regions'];
        self::assertSame('mrw', $orig['lang']);
        self::assertSame('eng', $orig['tesseract_lang']);
        self::assertFalse($orig['use_dictionary'], 'Maranao must not use the English dictionary');
        self::assertTrue($trans['use_dictionary']);
        // job is leased → nothing else to lease
        self::assertNull($this->data($this->call('POST', '/api/ocr/lease', ['book_id' => $this->book['id']]))['job']);

        $maranao = "Na so Bantugan na\nmiyakambalingan";
        $r = $this->call('POST', "/api/ocr/jobs/{$job['id']}/complete", [
            'lease_token' => $job['lease_token'],
            'results' => [
                ['region_id' => $orig['id'], 'text' => $maranao, 'confidence' => 71.5, 'engine' => 'tesseract.js', 'engine_version' => '5', 'language' => 'eng', 'flagged_words' => ['miyakambalingan']],
                ['region_id' => $trans['id'], 'text' => "And so Bantugan\nwas wandering", 'confidence' => 93, 'engine' => 'tesseract.js', 'language' => 'eng'],
            ],
        ]);
        self::assertSame(200, $r->status, $r->body);
        self::assertSame('needs_review', $this->data($r)['status']);

        $page = $this->data($this->call('GET', '/api/pages/' . $job['page_id']));
        self::assertSame($maranao, $page['regions'][0]['text'], 'OCR text must be stored verbatim incl. line breaks');
        self::assertSame('inferred', $page['regions'][0]['alignment']['status']);
        self::assertSame($page['regions'][0]['alignment']['group_id'], $page['regions'][1]['alignment']['group_id']);

        // correction stored separately; OCR kept
        $c = $this->data($this->call('POST', "/api/regions/{$orig['id']}/correction", ['text' => "Na so Bantugan na\nmiyakambalingan."]));
        self::assertSame('correction', $c['text_source']);
        self::assertSame($maranao, $c['ocr_text']);
        self::assertSame('needs_review', $this->db->one('SELECT review_status FROM pages')['review_status']);

        $orig_txt = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=original");
        self::assertStringContainsString("miyakambalingan.", $orig_txt->body);
        self::assertStringNotContainsString('wandering', $orig_txt->body);
        $en = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=translation");
        self::assertStringContainsString('wandering', $en->body);
        self::assertStringNotContainsString('Bantugan na', $en->body);
        $par = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=parallel");
        self::assertStringContainsString('--- Pair 1 (inferred) ---', $par->body);
        $tsv = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=parallel&format=tsv");
        self::assertStringContainsString("12\t1\t1\tinferred\tNa so Bantugan na\\nmiyakambalingan.\tAnd so Bantugan\\nwas wandering", $tsv->body);

        $json = json_decode($this->call('GET', "/api/books/{$this->book['id']}/export.json")->body, true);
        self::assertSame('bookstream.book.v1', $json['schema']);
        $region = $json['pages'][0]['regions'][0];
        self::assertSame('correction', $region['text_source']);
        self::assertSame($maranao, $region['ocr_results'][0]['text']);
        self::assertCount(1, $region['corrections']);
        self::assertNotEmpty($json['pages'][0]['source_image']['checksum_sha256']);
    }

    public function testVerifiedAlignmentManyToOneSurvivesReinference(): void
    {
        $this->upload($this->book['id'], 1);
        $pageId = $this->db->one('SELECT id FROM pages')['id'];
        $detail = $this->data($this->call('GET', "/api/pages/$pageId"));
        $regions = $detail['regions'];
        // add a second original stanza → 2 originals : 1 translation
        $regions[] = ['bbox' => ['x' => 0.03, 'y' => 0.6, 'w' => 0.44, 'h' => 0.3], 'column_id' => 'left', 'reading_order' => 3, 'lang' => 'mrw', 'role' => 'original', 'block_type' => 'verse'];
        $saved = $this->data($this->call('PUT', "/api/pages/$pageId/regions", ['regions' => $regions]));
        self::assertCount(3, $saved['regions']);
        $ids = array_column($saved['regions'], 'id');
        $r = $this->call('PUT', "/api/pages/$pageId/alignment", ['groups' => [['region_ids' => $ids, 'status' => 'verified']]]);
        self::assertSame(200, $r->status, $r->body);
        $this->call('POST', "/api/pages/$pageId/alignment/infer", []);
        $after = $this->data($this->call('GET', "/api/pages/$pageId"));
        self::assertSame(['verified', 'verified', 'verified'], array_map(fn($x) => $x['alignment']['status'], $after['regions']));
        self::assertCount(1, array_unique(array_map(fn($x) => $x['alignment']['group_id'], $after['regions'])));
    }

    public function testUnequalCountsLeaveUnpaired(): void
    {
        $this->upload($this->book['id'], 1);
        $pageId = $this->db->one('SELECT id FROM pages')['id'];
        $regions = $this->data($this->call('GET', "/api/pages/$pageId"))['regions'];
        $regions[] = ['bbox' => ['x' => 0.03, 'y' => 0.6, 'w' => 0.44, 'h' => 0.3], 'column_id' => 'left', 'reading_order' => 3, 'lang' => 'mrw', 'role' => 'original', 'block_type' => 'verse'];
        $this->call('PUT', "/api/pages/$pageId/regions", ['regions' => $regions]);
        $after = $this->data($this->call('POST', "/api/pages/$pageId/alignment/infer", []));
        $nulls = array_filter($after['regions'], fn($r) => $r['alignment'] === null);
        self::assertCount(1, $nulls);
        $par = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=parallel");
        self::assertStringContainsString('--- Unpaired [mrw · original] ---', $par->body);
    }

    public function testFailureRetriesThenFails(): void
    {
        $this->upload($this->book['id'], 1);
        $this->call('POST', "/api/books/{$this->book['id']}/ocr/enqueue", []);
        for ($i = 1; $i <= 3; $i++) {
            $job = $this->leaseOne();
            self::assertNotNull($job, "attempt $i");
            $r = $this->data($this->call('POST', "/api/ocr/jobs/{$job['id']}/fail", ['lease_token' => $job['lease_token'], 'error' => 'boom']));
            self::assertSame($i < 3 ? 'requeued' : 'failed', $r['status']);
        }
        self::assertSame('failed', $this->db->one('SELECT ocr_status FROM pages')['ocr_status']);
        $status = $this->data($this->call('GET', "/api/books/{$this->book['id']}/ocr/status"));
        self::assertSame(1, $status['failed']);
        self::assertSame('boom', $status['failures'][0]['error']);
        // failed pages can be re-enqueued
        self::assertSame(1, $this->data($this->call('POST', "/api/books/{$this->book['id']}/ocr/enqueue", []))['enqueued']);
    }

    public function testWrongLeaseTokenAndWorkerToken(): void
    {
        $this->upload($this->book['id'], 1);
        $this->call('POST', "/api/books/{$this->book['id']}/ocr/enqueue", []);
        $this->call('POST', '/api/auth/logout');
        // no session: lease denied
        self::assertSame(401, $this->call('POST', '/api/ocr/lease', [], [], [], [], false)->status);
        // worker bearer token works without session/CSRF
        $auth = ['authorization' => 'Bearer worker-token-abcdefghijklmnopqrstuvwxyz'];
        $r = $this->call('POST', '/api/ocr/lease', [], [], [], $auth, false);
        self::assertSame(200, $r->status, $r->body);
        $job = $this->data($r)['job'];
        self::assertNotNull($job);
        $img = $this->call('GET', $job['image_url'], null, [], [], $auth, false);
        self::assertSame(200, $img->status);
        $bad = $this->call('POST', "/api/ocr/jobs/{$job['id']}/complete", ['lease_token' => 'nope', 'results' => [['region_id' => $job['regions'][0]['id'], 'text' => 'x']]], [], [], $auth, false);
        self::assertSame(409, $bad->status);
        // worker token cannot reach book management
        self::assertSame(401, $this->call('GET', '/api/books', null, [], [], $auth, false)->status);
    }

    public function testExportWithMissingAndUnprocessedPages(): void
    {
        $this->upload($this->book['id'], 1, null, null, 'single', '1');
        $this->upload($this->book['id'], 2, null, null, 'single', '4');
        $txt = $this->call('GET', "/api/books/{$this->book['id']}/export.txt?mode=full");
        self::assertSame(200, $txt->status);
        self::assertStringContainsString('# Missing printed pages: 2–3, 5–10', $txt->body);
        self::assertStringContainsString('NOT PROCESSED', $txt->body);
        self::assertStringContainsString('attachment;', $txt->headers['Content-Disposition']);
    }

    public function testPresetChangeBlockedWhenOcrExists(): void
    {
        $this->upload($this->book['id'], 1);
        $this->call('POST', "/api/books/{$this->book['id']}/ocr/enqueue", []);
        $job = $this->leaseOne();
        $this->call('POST', "/api/ocr/jobs/{$job['id']}/complete", ['lease_token' => $job['lease_token'], 'results' => [['region_id' => $job['regions'][0]['id'], 'text' => 'abc', 'confidence' => 95]]]);
        $r = $this->call('POST', "/api/pages/{$job['page_id']}/regions/preset", ['layout' => 'single']);
        self::assertSame(409, $r->status);
        $r = $this->call('POST', "/api/pages/{$job['page_id']}/regions/preset", ['layout' => 'single', 'force' => true]);
        self::assertSame(200, $r->status);
        self::assertCount(1, $this->data($r)['regions']);
    }

    public function testBookDeleteRequiresTitle(): void
    {
        $this->upload($this->book['id'], 1);
        self::assertSame(422, $this->call('DELETE', "/api/books/{$this->book['id']}", ['confirm_title' => 'nope'])->status);
        self::assertSame(200, $this->call('DELETE', "/api/books/{$this->book['id']}", ['confirm_title' => $this->book['title']])->status);
        self::assertDirectoryDoesNotExist($this->dir . '/storage/books/' . $this->book['id']);
        self::assertSame(0, (int)$this->db->one('SELECT COUNT(*) AS n FROM pages')['n']);
    }
}
