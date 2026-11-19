<?php
declare(strict_types=1);

namespace BookStream\Tests;

use BookStream\App;
use BookStream\Config;
use BookStream\Db;
use BookStream\Http\ArraySession;
use BookStream\Http\Request;
use BookStream\Http\Response;
use BookStream\Http\UploadedFile;

abstract class TestCase extends \PHPUnit\Framework\TestCase
{
    protected string $dir;
    protected Config $config;
    protected Db $db;
    protected ArraySession $session;
    protected App $app;
    protected string $csrf = '';

    /** @var array<string,string> */
    protected array $env = [];

    protected function setUp(): void
    {
        $this->dir = sys_get_temp_dir() . '/bookstream-test-' . bin2hex(random_bytes(5));
        mkdir($this->dir, 0770, true);
        $this->config = new Config($this->env + [
            'STORAGE_DIR' => $this->dir . '/storage',
            'DB_DRIVER' => 'sqlite',
            'DB_PATH' => $this->dir . '/test.sqlite',
            'SETUP_TOKEN' => 'test-setup-token-123',
            'WORKER_TOKEN' => 'worker-token-abcdefghijklmnopqrstuvwxyz',
        ]);
        $this->db = new Db($this->config);
        $this->db->migrate();
        $this->session = new ArraySession();
        $this->app = new App($this->config, $this->db, $this->session);
    }

    protected function tearDown(): void
    {
        exec('rm -rf ' . escapeshellarg($this->dir));
    }

    /**
     * @param array<string,mixed>|null $json
     * @param array<string,mixed> $post
     * @param array<string,UploadedFile> $files
     * @param array<string,string> $headers
     */
    protected function call(string $method, string $path, ?array $json = null, array $post = [], array $files = [], array $headers = [], bool $withCsrf = true): Response
    {
        $parts = parse_url($path);
        parse_str($parts['query'] ?? '', $query);
        if ($withCsrf && $this->csrf !== '') {
            $headers['x-csrf-token'] = $this->csrf;
        }
        $req = new Request($method, $parts['path'] ?? '/', array_map('strval', $query), $post, $files, $headers, $json === null ? '' : (string)json_encode($json));
        return $this->app->handle($req);
    }

    /** @return array<string,mixed> */
    protected function data(Response $r): array
    {
        $d = json_decode($r->body, true);
        return is_array($d) ? $d : [];
    }

    protected function login(): void
    {
        $this->csrf = (string)$this->data($this->call('GET', '/api/auth/state'))['csrf'];
        $r = $this->call('POST', '/api/auth/setup', ['setup_token' => 'test-setup-token-123', 'username' => 'cris', 'password' => 'correct-horse-battery']);
        self::assertSame(201, $r->status, $r->body);
        $this->csrf = (string)$this->data($r)['csrf'];
    }

    /** @param array<string,mixed> $extra @return array<string,mixed> */
    protected function createBook(array $extra = []): array
    {
        $r = $this->call('POST', '/api/books', $extra + ['title' => 'Darangen — Volume Two', 'expected_page_count' => 10, 'original_language' => 'mrw', 'translation_language' => 'eng', 'default_layout' => 'parallel']);
        self::assertSame(201, $r->status, $r->body);
        return $this->data($r)['book'];
    }

    /** Synthetic page photo (JPEG) written to a temp file. */
    protected function jpeg(int $w = 800, int $h = 600, int $seed = 1): string
    {
        $img = imagecreatetruecolor($w, $h);
        imagefill($img, 0, 0, imagecolorallocate($img, 250, 250, 245));
        $black = imagecolorallocate($img, 10, 10, 10);
        imagestring($img, 5, 40, 40, "Synthetic page $seed", $black);
        imageline($img, (int)($w / 2), 0, (int)($w / 2), $h, $black);
        $path = $this->dir . '/img-' . $seed . '-' . bin2hex(random_bytes(3)) . '.jpg';
        imagejpeg($img, $path, 90);
        return $path;
    }

    /** @return array<string,mixed> response data */
    protected function upload(string $bookId, int $index, ?string $captureId = null, ?string $file = null, string $mode = 'single', ?string $printed = null, ?string $checksum = null): Response
    {
        $file ??= $this->jpeg(800, 600, $index);
        $captureId ??= Db::uuid();
        $copy = $file . '.up-' . bin2hex(random_bytes(3));
        copy($file, $copy);
        return $this->call('POST', "/api/books/$bookId/captures", null, [
            'capture_id' => $captureId,
            'checksum' => $checksum ?? hash_file('sha256', $file),
            'capture_index' => (string)$index,
            'mode' => $mode,
            'session_id' => 'sess-1',
            'printed_page_number' => $printed ?? (string)$index,
        ], ['image' => new UploadedFile($copy, 'page.jpg', (int)filesize($copy), UPLOAD_ERR_OK, false)]);
    }
}
