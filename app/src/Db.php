<?php
declare(strict_types=1);

namespace BookStream;

use PDO;

final class Db
{
    public PDO $pdo;
    public string $driver;

    public function __construct(Config $config)
    {
        $driver = $config->get('DB_DRIVER', 'sqlite');
        if ($driver === 'mysql') {
            $dsn = sprintf(
                'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                $config->get('DB_HOST', 'localhost'),
                $config->get('DB_PORT', '3306'),
                $config->get('DB_NAME', 'bookstream')
            );
            $this->pdo = new PDO($dsn, $config->get('DB_USER', ''), $config->get('DB_PASS', ''));
        } else {
            $path = $config->get('DB_PATH', $config->storageDir() . '/bookstream.sqlite');
            if ($path !== ':memory:' && !is_dir(dirname($path))) {
                mkdir(dirname($path), 0770, true);
            }
            $this->pdo = new PDO('sqlite:' . $path);
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            $this->pdo->exec('PRAGMA journal_mode = WAL');
            $this->pdo->exec('PRAGMA busy_timeout = 5000');
            $driver = 'sqlite';
        }
        $this->driver = $driver;
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $this->pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
    }

    /** Apply schema migrations idempotently. */
    public function migrate(): void
    {
        $this->pdo->exec('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(64) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)');
        $applied = array_column($this->all('SELECT version FROM schema_migrations'), 'version');
        $files = glob(BOOKSTREAM_APP_DIR . '/migrations/*.sql') ?: [];
        sort($files);
        foreach ($files as $file) {
            $version = basename($file, '.sql');
            if (in_array($version, $applied, true)) {
                continue;
            }
            $sql = (string)file_get_contents($file);
            if ($this->driver === 'mysql') {
                $sql = str_replace('/*MYSQL_ENGINE*/', 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', $sql);
            }
            foreach (array_filter(array_map('trim', explode(";\n", $sql))) as $stmt) {
                $this->pdo->exec($stmt);
            }
            $this->run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [$version, self::now()]);
        }
    }

    /** @param list<mixed> $params @return list<array<string,mixed>> */
    public function all(string $sql, array $params = []): array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    /** @param list<mixed> $params @return array<string,mixed>|null */
    public function one(string $sql, array $params = []): ?array
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        $row = $st->fetch();
        return $row === false ? null : $row;
    }

    /** @param list<mixed> $params */
    public function run(string $sql, array $params = []): int
    {
        $st = $this->pdo->prepare($sql);
        $st->execute($params);
        return $st->rowCount();
    }

    /** @template T @param callable():T $fn @return T */
    public function tx(callable $fn): mixed
    {
        $this->pdo->beginTransaction();
        try {
            $r = $fn();
            $this->pdo->commit();
            return $r;
        } catch (\Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
    }

    public static function now(): string
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }

    public static function uuid(): string
    {
        $b = random_bytes(16);
        $b[6] = chr((ord($b[6]) & 0x0f) | 0x40);
        $b[8] = chr((ord($b[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($b), 4));
    }

    public static function isUuid(string $s): bool
    {
        return (bool)preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $s);
    }
}
