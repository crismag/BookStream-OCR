<?php
declare(strict_types=1);

namespace BookStream\Tests;

final class AuthTest extends TestCase
{
    public function testStateRequiresSetupInitially(): void
    {
        $d = $this->data($this->call('GET', '/api/auth/state'));
        self::assertTrue($d['setup_required']);
        self::assertTrue($d['setup_enabled']);
        self::assertFalse($d['authenticated']);
        self::assertSame(64, strlen($d['csrf']));
    }

    public function testSetupRejectsWrongTokenAndRequiresCsrf(): void
    {
        $r = $this->call('POST', '/api/auth/setup', ['setup_token' => 'x', 'username' => 'cris', 'password' => 'correct-horse-battery']);
        self::assertSame(403, $r->status);
        self::assertSame('csrf_failed', $this->data($r)['error']);

        $this->csrf = (string)$this->data($this->call('GET', '/api/auth/state'))['csrf'];
        $r = $this->call('POST', '/api/auth/setup', ['setup_token' => 'wrong-token-xxxx', 'username' => 'cris', 'password' => 'correct-horse-battery']);
        self::assertSame('bad_setup_token', $this->data($r)['error']);
    }

    public function testSetupOnlyOnceAndLoginLogout(): void
    {
        $this->login();
        $state = $this->data($this->call('GET', '/api/auth/state'));
        self::assertTrue($state['authenticated']);
        self::assertSame('cris', $state['user']['username']);

        $again = $this->call('POST', '/api/auth/setup', ['setup_token' => 'test-setup-token-123', 'username' => 'other', 'password' => 'correct-horse-battery']);
        self::assertSame(409, $again->status);

        self::assertSame(200, $this->call('POST', '/api/auth/logout')->status);
        self::assertSame(401, $this->call('GET', '/api/books')->status);

        $this->csrf = (string)$this->data($this->call('GET', '/api/auth/state'))['csrf'];
        $bad = $this->call('POST', '/api/auth/login', ['username' => 'cris', 'password' => 'nope']);
        self::assertSame(401, $bad->status);
        $ok = $this->call('POST', '/api/auth/login', ['username' => 'cris', 'password' => 'correct-horse-battery']);
        self::assertSame(200, $ok->status);
        $this->csrf = (string)$this->data($ok)['csrf'];
        self::assertSame(200, $this->call('GET', '/api/books')->status);
    }

    public function testPasswordIsHashed(): void
    {
        $this->login();
        $row = $this->db->one('SELECT password_hash FROM users');
        self::assertNotNull($row);
        self::assertStringNotContainsString('correct-horse', (string)$row['password_hash']);
        self::assertTrue(password_verify('correct-horse-battery', (string)$row['password_hash']));
    }

    public function testLoginRateLimited(): void
    {
        $this->login();
        $this->call('POST', '/api/auth/logout');
        $this->csrf = (string)$this->data($this->call('GET', '/api/auth/state'))['csrf'];
        $last = null;
        for ($i = 0; $i < 9; $i++) {
            $last = $this->call('POST', '/api/auth/login', ['username' => 'cris', 'password' => 'wrong-' . $i]);
        }
        self::assertNotNull($last);
        self::assertSame(429, $last->status);
    }

    public function testSessionIdleExpiry(): void
    {
        $this->login();
        $this->session->set('last_seen', time() - 13 * 3600);
        self::assertSame(401, $this->call('GET', '/api/books')->status);
    }

    public function testMutationWithoutCsrfRejected(): void
    {
        $this->login();
        $r = $this->call('POST', '/api/books', ['title' => 'X'], [], [], [], false);
        self::assertSame(403, $r->status);
    }
}
