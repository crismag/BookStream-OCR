<?php
declare(strict_types=1);

namespace BookStream;

use BookStream\Http\HttpError;
use BookStream\Http\Request;

final class Auth
{
    private bool $workerRequest = false;

    public function __construct(private App $app)
    {
    }

    public function csrfToken(): string
    {
        $t = $this->app->session->get('csrf');
        if (!is_string($t) || strlen($t) < 32) {
            $t = bin2hex(random_bytes(32));
            $this->app->session->set('csrf', $t);
        }
        return $t;
    }

    public function requireCsrf(Request $req): void
    {
        if ($this->workerRequest) {
            return;
        }
        $sent = $req->header('x-csrf-token') ?? '';
        $t = $this->app->session->get('csrf');
        if (!is_string($t) || $sent === '' || !hash_equals($t, $sent)) {
            throw new HttpError(403, 'csrf_failed', 'Security token missing or expired. Reload and try again.');
        }
    }

    /** @return array<string,mixed>|null */
    public function user(): ?array
    {
        $uid = $this->app->session->get('user_id');
        if (!is_string($uid)) {
            return null;
        }
        $idle = $this->app->config->int('SESSION_IDLE_SECONDS', 12 * 3600);
        $last = (int)($this->app->session->get('last_seen') ?? 0);
        if ($last > 0 && time() - $last > $idle) {
            $this->app->session->destroy();
            return null;
        }
        $this->app->session->set('last_seen', time());
        return $this->app->db->one('SELECT id, username, created_at FROM users WHERE id = ?', [$uid]);
    }

    /** @return array<string,mixed> */
    public function requireUser(): array
    {
        $u = $this->user();
        if ($u === null) {
            throw new HttpError(401, 'unauthenticated', 'Please sign in.');
        }
        return $u;
    }

    public function isWorker(Request $req): bool
    {
        $token = $this->app->config->get('WORKER_TOKEN');
        $hdr = $req->header('authorization') ?? '';
        if ($token === null || strlen($token) < 24 || !str_starts_with($hdr, 'Bearer ')) {
            return false;
        }
        $this->workerRequest = hash_equals($token, substr($hdr, 7));
        return $this->workerRequest;
    }

    /** @param array<string,mixed> $book */
    public function canAccessBook(array $book): bool
    {
        if ($this->workerRequest) {
            return true; // single-owner deployment: the worker token is issued by the owner
        }
        $u = $this->user();
        return $u !== null && hash_equals((string)$u['id'], (string)$book['user_id']);
    }

    public function login(string $username, string $password): array
    {
        $user = $this->app->db->one('SELECT * FROM users WHERE username = ?', [$username]);
        // Verify against a dummy hash when the user is missing to keep timing similar.
        $hash = $user['password_hash'] ?? '$2y$10$usesomesillystringfore7hnbRJHxXVLeakoG8K30oukPsA.ztMG';
        if (!password_verify($password, (string)$hash) || $user === null) {
            throw new HttpError(401, 'invalid_credentials', 'Wrong username or password.');
        }
        if (password_needs_rehash((string)$user['password_hash'], PASSWORD_DEFAULT)) {
            $this->app->db->run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }
        $this->app->session->regenerate();
        $this->app->session->set('user_id', $user['id']);
        $this->app->session->set('last_seen', time());
        $this->app->session->set('csrf', bin2hex(random_bytes(32)));
        return ['id' => $user['id'], 'username' => $user['username']];
    }
}
