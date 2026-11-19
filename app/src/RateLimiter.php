<?php
declare(strict_types=1);

namespace BookStream;

use BookStream\Http\HttpError;

final class RateLimiter
{
    public function __construct(private Db $db)
    {
    }

    /** Record a hit in $bucket and throw 429 if more than $max hits happened in $windowSeconds. */
    public function hit(string $bucket, int $max, int $windowSeconds): void
    {
        $key = substr(hash('sha256', $bucket), 0, 40);
        $now = time();
        $this->db->run('DELETE FROM rate_events WHERE bucket = ? AND at < ?', [$key, $now - $windowSeconds]);
        $row = $this->db->one('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ?', [$key]);
        if ((int)($row['n'] ?? 0) >= $max) {
            throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.', ['retry_after' => $windowSeconds]);
        }
        $this->db->run('INSERT INTO rate_events (id, bucket, at) VALUES (?, ?, ?)', [Db::uuid(), $key, $now]);
    }

    public function clear(string $bucket): void
    {
        $this->db->run('DELETE FROM rate_events WHERE bucket = ?', [substr(hash('sha256', $bucket), 0, 40)]);
    }
}
