<?php
declare(strict_types=1);

namespace BookStream\Controller;

use BookStream\App;
use BookStream\Db;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;

final class AuthController
{
    public function __construct(private App $app)
    {
    }

    public function state(Request $req): Response
    {
        $hasUser = $this->app->db->one('SELECT id FROM users LIMIT 1') !== null;
        $user = $this->app->auth->user();
        return Response::json([
            'setup_required' => !$hasUser,
            'setup_enabled' => !$hasUser && strlen((string)$this->app->config->get('SETUP_TOKEN', '')) >= 12,
            'authenticated' => $user !== null,
            'user' => $user === null ? null : ['id' => $user['id'], 'username' => $user['username']],
            'csrf' => $this->app->auth->csrfToken(),
            'limits' => [
                'max_upload_bytes' => $this->app->config->int('MAX_UPLOAD_BYTES', 15 * 1024 * 1024),
                'max_pending' => $this->app->config->int('CLIENT_MAX_PENDING', 25),
            ],
        ]);
    }

    public function setup(Request $req): Response
    {
        $this->app->rate->hit('setup:' . $req->ip, 10, 900);
        $data = $req->json();
        $expected = (string)$this->app->config->get('SETUP_TOKEN', '');
        if (strlen($expected) < 12) {
            throw new HttpError(403, 'setup_disabled', 'Set SETUP_TOKEN (12+ chars) in .env to enable first-run setup.');
        }
        if (!hash_equals($expected, (string)($data['setup_token'] ?? ''))) {
            throw new HttpError(403, 'bad_setup_token', 'Setup token is incorrect.');
        }
        $username = trim((string)($data['username'] ?? ''));
        $password = (string)($data['password'] ?? '');
        if (!preg_match('/^[A-Za-z0-9._@-]{3,100}$/', $username)) {
            throw new HttpError(422, 'invalid_username', 'Username: 3–100 letters, digits, . _ @ -');
        }
        if (strlen($password) < 10) {
            throw new HttpError(422, 'weak_password', 'Password must be at least 10 characters.');
        }
        $this->app->db->tx(function () use ($username, $password): void {
            if ($this->app->db->one('SELECT id FROM users LIMIT 1') !== null) {
                throw new HttpError(409, 'already_setup', 'An account already exists.');
            }
            $this->app->db->run(
                'INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)',
                [Db::uuid(), $username, password_hash($password, PASSWORD_DEFAULT), Db::now()]
            );
        });
        $user = $this->app->auth->login($username, $password);
        return Response::json(['user' => $user, 'csrf' => $this->app->auth->csrfToken()], 201);
    }

    public function login(Request $req): Response
    {
        $data = $req->json();
        $username = trim((string)($data['username'] ?? ''));
        $this->app->rate->hit('login-ip:' . $req->ip, 20, 900);
        $this->app->rate->hit('login-user:' . strtolower($username), 8, 900);
        $user = $this->app->auth->login($username, (string)($data['password'] ?? ''));
        $this->app->rate->clear('login-user:' . strtolower($username));
        return Response::json(['user' => $user, 'csrf' => $this->app->auth->csrfToken()]);
    }

    public function logout(Request $req): Response
    {
        $this->app->session->destroy();
        return Response::json(['ok' => true]);
    }
}
