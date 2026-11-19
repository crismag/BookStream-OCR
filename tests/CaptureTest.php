<?php
declare(strict_types=1);

namespace BookStream\Tests;

use BookStream\Db;
use BookStream\Http\UploadedFile;

final class CaptureTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        $this->login();
    }

    public function testUploadConfirmsWithChecksumAndCreatesPagesAndRegions(): void
    {
        $book = $this->createBook();
        $file = $this->jpeg();
        $r = $this->upload($book['id'], 1, null, $file);
        self::assertSame(201, $r->status, $r->body);
        $d = $this->data($r);
        self::assertSame('confirmed', $d['status']);
        self::assertSame(hash_file('sha256', $file), $d['checksum']);
        self::assertCount(1, $d['pages']);

        $stored = $this->db->one('SELECT storage_key FROM captures WHERE id = ?', [$d['capture_id']]);
        self::assertFileExists($this->dir . '/storage/' . $stored['storage_key']);
        // parallel default layout → 2 regions (original + translation)
        $regions = $this->db->all('SELECT role, lang FROM regions WHERE page_id = ? ORDER BY reading_order', [$d['pages'][0]['id']]);
        self::assertSame([['role' => 'original', 'lang' => 'mrw'], ['role' => 'translation', 'lang' => 'eng']], $regions);
    }

    public function testIdempotentReplayAndConflict(): void
    {
        $book = $this->createBook();
        $file = $this->jpeg();
        $id = Db::uuid();
        self::assertSame(201, $this->upload($book['id'], 1, $id, $file)->status);
        $replay = $this->upload($book['id'], 1, $id, $file);
        self::assertSame(200, $replay->status);
        self::assertTrue($this->data($replay)['idempotent_replay']);
        self::assertSame(1, (int)$this->db->one('SELECT COUNT(*) AS n FROM pages')['n']);

        $other = $this->jpeg(800, 600, 99);
        $conflict = $this->upload($book['id'], 1, $id, $other);
        self::assertSame(409, $conflict->status);
    }

    public function testChecksumMismatchRejected(): void
    {
        $book = $this->createBook();
        $r = $this->upload($book['id'], 1, null, null, 'single', null, str_repeat('a', 64));
        self::assertSame(422, $r->status);
        self::assertSame('checksum_mismatch', $this->data($r)['error']);
        self::assertSame(0, (int)$this->db->one('SELECT COUNT(*) AS n FROM captures')['n']);
    }

    public function testRejectsNonImageAndOversized(): void
    {
        $book = $this->createBook();
        $txt = $this->dir . '/evil.jpg';
        file_put_contents($txt, "<?php echo 'pwned'; ?>" . str_repeat('x', 500));
        $r = $this->upload($book['id'], 1, null, $txt);
        self::assertSame(415, $r->status);

        $this->env = ['MAX_UPLOAD_BYTES' => '1000'];
        $this->setUp();
        $book = $this->createBook();
        $r = $this->upload($book['id'], 1);
        self::assertSame(413, $r->status);
    }

    public function testMaliciousFilenameAndInvalidIds(): void
    {
        $book = $this->createBook();
        $file = $this->jpeg();
        $copy = $file . '.c';
        copy($file, $copy);
        $r = $this->call('POST', "/api/books/{$book['id']}/captures", null, [
            'capture_id' => '../../etc/passwd', 'checksum' => hash_file('sha256', $file), 'capture_index' => '1', 'mode' => 'single',
        ], ['image' => new UploadedFile($copy, '../../x.php', (int)filesize($copy), UPLOAD_ERR_OK, false)]);
        self::assertSame(422, $r->status);
        self::assertSame('invalid_capture_id', $this->data($r)['error']);

        $ok = $this->call('POST', "/api/books/{$book['id']}/captures", null, [
            'capture_id' => Db::uuid(), 'checksum' => hash_file('sha256', $file), 'capture_index' => '1', 'mode' => 'single',
        ], ['image' => new UploadedFile($copy, '../../x.php', (int)filesize($copy), UPLOAD_ERR_OK, false)]);
        self::assertSame(201, $ok->status, $ok->body);
        $row = $this->db->one('SELECT storage_key, original_filename FROM captures');
        self::assertMatchesRegularExpression('#^books/[0-9a-f-]{36}/originals/[0-9a-f-]{36}\.jpg$#', $row['storage_key']);
        self::assertSame('x.php', $row['original_filename']);
    }

    public function testSpreadCreatesLeftAndRightPagesWithSequentialNumbers(): void
    {
        $book = $this->createBook();
        $d = $this->data($this->upload($book['id'], 1, null, null, 'spread', '12'));
        self::assertSame(['left', 'right'], array_column($d['pages'], 'side'));
        self::assertSame(['12', '13'], array_column($d['pages'], 'printed_page_number'));
        $thumb = $this->call('GET', '/api/pages/' . $d['pages'][1]['id'] . '/image?variant=thumb');
        self::assertSame(200, $thumb->status);
        [$w] = getimagesize((string)$thumb->filePath);
        self::assertLessThanOrEqual(360, $w);
    }

    public function testOrderingIsByCaptureIndexNotArrival(): void
    {
        $book = $this->createBook(['default_layout' => 'single']);
        $this->upload($book['id'], 3, null, null, 'single', '3');
        $this->upload($book['id'], 1, null, null, 'single', '1');
        $this->upload($book['id'], 2, null, null, 'single', '2');
        $pages = $this->data($this->call('GET', "/api/books/{$book['id']}/pages"))['pages'];
        self::assertSame(['1', '2', '3'], array_column($pages, 'printed_page_number'));
        self::assertSame([1, 2, 3], array_column($pages, 'sequence_number'));
        $b = $this->data($this->call('GET', "/api/books/{$book['id']}"))['book'];
        self::assertSame(4, $b['next_capture_index']);
        self::assertSame('4', $b['next_printed_page']);
    }

    public function testMissingPageDetection(): void
    {
        $book = $this->createBook(['default_layout' => 'single', 'expected_page_count' => 5]);
        $this->upload($book['id'], 1, null, null, 'single', '1');
        $this->upload($book['id'], 2, null, null, 'single', '3');
        $this->upload($book['id'], 3, null, null, 'single', '3');
        $integrity = $this->data($this->call('GET', "/api/books/{$book['id']}/pages"))['integrity'];
        self::assertSame([2, 4, 5], $integrity['missing']);
        self::assertSame(['3'], $integrity['duplicates']);
    }

    public function testReplaceRequiresConfirmationAndKeepsOldOriginal(): void
    {
        $book = $this->createBook();
        $d = $this->data($this->upload($book['id'], 1));
        $old = $this->db->one('SELECT storage_key FROM captures')['storage_key'];
        $new = $this->jpeg(900, 700, 55);
        $copy = $new . '.c';
        copy($new, $copy);
        $file = new UploadedFile($copy, 'p.jpg', (int)filesize($copy), UPLOAD_ERR_OK, false);
        $r = $this->call('POST', "/api/captures/{$d['capture_id']}/replace", null, ['checksum' => hash_file('sha256', $new)], ['image' => $file]);
        self::assertSame(422, $r->status);
        copy($new, $copy);
        $r = $this->call('POST', "/api/captures/{$d['capture_id']}/replace", null, ['checksum' => hash_file('sha256', $new), 'confirm_replace' => '1'], ['image' => $file]);
        self::assertSame(200, $r->status, $r->body);
        self::assertFileExists($this->dir . '/storage/' . $old);
        self::assertSame(hash_file('sha256', $new), $this->db->one('SELECT checksum FROM captures')['checksum']);
    }

    public function testCrossUserBookAccessDenied(): void
    {
        $book = $this->createBook();
        // second user inserted directly; log in as them
        $this->db->run('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [Db::uuid(), 'mallory', password_hash('mallory-password', PASSWORD_DEFAULT), Db::now()]);
        $this->call('POST', '/api/auth/logout');
        $this->csrf = (string)$this->data($this->call('GET', '/api/auth/state'))['csrf'];
        $r = $this->call('POST', '/api/auth/login', ['username' => 'mallory', 'password' => 'mallory-password']);
        $this->csrf = (string)$this->data($r)['csrf'];
        self::assertSame(404, $this->call('GET', "/api/books/{$book['id']}")->status);
        self::assertSame(404, $this->upload($book['id'], 1)->status);
        self::assertSame([], $this->data($this->call('GET', '/api/books'))['books']);
    }

    public function testStorageIsDeniedToWeb(): void
    {
        self::assertFileExists($this->dir . '/storage/.htaccess');
        self::assertStringContainsString('denied', (string)file_get_contents($this->dir . '/storage/.htaccess'));
    }

    public function testHundredSimulatedCapturesStayOrdered(): void
    {
        $book = $this->createBook(['default_layout' => 'single', 'expected_page_count' => 100]);
        $file = $this->jpeg(400, 300, 7);
        $order = range(1, 100);
        shuffle($order);
        foreach ($order as $i) {
            // vary bytes so each checksum is unique
            $f = $this->dir . "/sim-$i.jpg";
            $img = imagecreatefromjpeg($file);
            imagestring($img, 3, 10, 10, (string)$i, imagecolorallocate($img, 0, 0, 0));
            imagejpeg($img, $f, 80);
            self::assertSame(201, $this->upload($book['id'], $i, null, $f, 'single', (string)$i)->status);
        }
        $pages = $this->data($this->call('GET', "/api/books/{$book['id']}/pages"));
        self::assertSame(array_map('strval', range(1, 100)), array_column($pages['pages'], 'printed_page_number'));
        self::assertSame([], $pages['integrity']['missing']);
    }
}
