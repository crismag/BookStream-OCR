<?php
declare(strict_types=1);

namespace BookStream;

use RuntimeException;

/**
 * Filesystem layout:
 *   storage/books/<book-uuid>/originals/<capture-uuid>.<ext>
 *   storage/books/<book-uuid>/processed/<page-uuid>-<variant>-<hash>.jpg
 *   storage/books/<book-uuid>/exports/
 * Only UUIDs ever become path segments, so client input cannot traverse paths.
 */
final class Storage
{
    public function __construct(private string $root)
    {
        if (!is_dir($root)) {
            mkdir($root, 0770, true);
        }
        $deny = $root . '/.htaccess';
        if (!is_file($deny)) {
            @file_put_contents($deny, "Require all denied\nDeny from all\n");
        }
    }

    public function root(): string
    {
        return $this->root;
    }

    public function bookDir(string $bookId, string $sub = ''): string
    {
        if (!Db::isUuid($bookId) || !in_array($sub, ['', 'originals', 'processed', 'exports'], true)) {
            throw new RuntimeException('Invalid storage path.');
        }
        $dir = $this->root . '/books/' . $bookId . ($sub !== '' ? '/' . $sub : '');
        if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) {
            throw new RuntimeException('Cannot create storage directory.');
        }
        return $dir;
    }

    public function originalKey(string $bookId, string $captureId, string $ext): string
    {
        if (!Db::isUuid($captureId) || !in_array($ext, ['jpg', 'png', 'webp'], true)) {
            throw new RuntimeException('Invalid storage key.');
        }
        $this->bookDir($bookId, 'originals');
        return 'books/' . $bookId . '/originals/' . $captureId . '.' . $ext;
    }

    public function path(string $key): string
    {
        if (!preg_match('#^books/[0-9a-f-]{36}/(originals|processed|exports)/[0-9a-z._-]+$#', $key) || str_contains($key, '..')) {
            throw new RuntimeException('Invalid storage key.');
        }
        return $this->root . '/' . $key;
    }

    /**
     * Durably write a source file to $key: copy to a temp file in the same directory,
     * fsync, then atomically rename. Returns the SHA-256 of the bytes written.
     */
    public function persist(string $sourcePath, string $key): string
    {
        $dest = $this->path($key);
        $tmp = $dest . '.tmp-' . bin2hex(random_bytes(6));
        $in = fopen($sourcePath, 'rb');
        $out = fopen($tmp, 'xb');
        if ($in === false || $out === false) {
            throw new RuntimeException('Cannot open files for persist.');
        }
        $ctx = hash_init('sha256');
        while (!feof($in)) {
            $chunk = fread($in, 1 << 20);
            if ($chunk === false) {
                throw new RuntimeException('Read failed.');
            }
            hash_update($ctx, $chunk);
            if (fwrite($out, $chunk) !== strlen($chunk)) {
                fclose($out);
                @unlink($tmp);
                throw new RuntimeException('Write failed (disk full?).');
            }
        }
        fflush($out);
        if (function_exists('fsync')) {
            fsync($out);
        }
        fclose($out);
        fclose($in);
        $sum = hash_final($ctx);
        if (hash_file('sha256', $tmp) !== $sum) {
            @unlink($tmp);
            throw new RuntimeException('Checksum mismatch after write.');
        }
        if (!rename($tmp, $dest)) {
            @unlink($tmp);
            throw new RuntimeException('Rename failed.');
        }
        return $sum;
    }

    public function deleteBook(string $bookId): void
    {
        $dir = $this->root . '/books/' . $bookId;
        if (!Db::isUuid($bookId) || !is_dir($dir)) {
            return;
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($it as $f) {
            $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
        }
        rmdir($dir);
    }

    /** Remove cached derived images for a page (after crop/rotate/replace). */
    public function clearPageCache(string $bookId, string $pageId): void
    {
        foreach (glob($this->bookDir($bookId, 'processed') . '/' . $pageId . '-*') ?: [] as $f) {
            @unlink($f);
        }
    }
}
