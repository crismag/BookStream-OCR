<?php
declare(strict_types=1);

namespace BookStream;

final class Config
{
    /** @param array<string,string> $values */
    public function __construct(private array $values)
    {
    }

    /** Load KEY=VALUE lines from an .env file, overlaid by real environment variables. */
    public static function load(?string $envFile): self
    {
        $values = [];
        if ($envFile !== null && is_file($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) {
                    continue;
                }
                [$k, $v] = array_map('trim', explode('=', $line, 2));
                if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && $v[-1] === $v[0]) {
                    $v = substr($v, 1, -1);
                }
                $values[$k] = $v;
            }
        }
        foreach ($values as $k => $_) {
            $env = getenv($k);
            if ($env !== false) {
                $values[$k] = $env;
            }
        }
        return new self($values);
    }

    public function get(string $key, ?string $default = null): ?string
    {
        $v = $this->values[$key] ?? getenv($key);
        return ($v === false || $v === null || $v === '') ? $default : (string)$v;
    }

    public function int(string $key, int $default): int
    {
        $v = $this->get($key);
        return $v === null ? $default : (int)$v;
    }

    public function bool(string $key, bool $default): bool
    {
        $v = $this->get($key);
        return $v === null ? $default : in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    }

    public function storageDir(): string
    {
        $home = defined('BOOKSTREAM_HOME') ? (string)constant('BOOKSTREAM_HOME') : dirname(BOOKSTREAM_APP_DIR);
        $dir = $this->get('STORAGE_DIR', $home . '/storage');
        return rtrim((string)$dir, '/');
    }
}
