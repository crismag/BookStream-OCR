<?php
declare(strict_types=1);

namespace BookStream;

use BookStream\Controller\AuthController;
use BookStream\Controller\BookController;
use BookStream\Controller\CaptureController;
use BookStream\Controller\ExportController;
use BookStream\Controller\OcrController;
use BookStream\Controller\PageController;
use BookStream\Http\HttpError;
use BookStream\Http\Request;
use BookStream\Http\Response;
use BookStream\Http\Session;

final class App
{
    public Auth $auth;
    public Storage $storage;
    public RateLimiter $rate;

    /** @var list<array{0:string,1:string,2:callable,3:string}> method, regex, handler, access */
    private array $routes = [];

    public function __construct(public Config $config, public Db $db, public Session $session)
    {
        $this->storage = new Storage($config->storageDir());
        $this->rate = new RateLimiter($db);
        $this->auth = new Auth($this);
        $this->registerRoutes();
    }

    private function registerRoutes(): void
    {
        $id = '([0-9a-f-]{36})';
        $a = new AuthController($this);
        $b = new BookController($this);
        $c = new CaptureController($this);
        $p = new PageController($this);
        $o = new OcrController($this);
        $e = new ExportController($this);

        // access: public | user | worker (user session OR worker bearer token)
        $this->add('GET', '/api/health', fn() => Response::json(['ok' => true, 'time' => Db::now()]), 'public');
        $this->add('GET', '/api/auth/state', [$a, 'state'], 'public');
        $this->add('POST', '/api/auth/setup', [$a, 'setup'], 'public');
        $this->add('POST', '/api/auth/login', [$a, 'login'], 'public');
        $this->add('POST', '/api/auth/logout', [$a, 'logout'], 'user');

        $this->add('GET', '/api/books', [$b, 'list'], 'user');
        $this->add('POST', '/api/books', [$b, 'create'], 'user');
        $this->add('GET', "/api/books/$id", [$b, 'get'], 'user');
        $this->add('PATCH', "/api/books/$id", [$b, 'update'], 'user');
        $this->add('POST', "/api/books/$id/archive", [$b, 'archive'], 'user');
        $this->add('DELETE', "/api/books/$id", [$b, 'delete'], 'user');

        $this->add('POST', "/api/books/$id/captures", [$c, 'upload'], 'user');
        $this->add('POST', "/api/captures/$id/replace", [$c, 'replace'], 'user');

        $this->add('GET', "/api/books/$id/pages", [$p, 'list'], 'user');
        $this->add('POST', "/api/books/$id/pages/reorder", [$p, 'reorder'], 'user');
        $this->add('GET', "/api/pages/$id", [$p, 'get'], 'worker');
        $this->add('PATCH', "/api/pages/$id", [$p, 'update'], 'user');
        $this->add('DELETE', "/api/pages/$id", [$p, 'delete'], 'user');
        $this->add('GET', "/api/pages/$id/image", [$p, 'image'], 'worker');
        $this->add('POST', "/api/pages/$id/regions/preset", [$p, 'applyPreset'], 'user');
        $this->add('PUT', "/api/pages/$id/regions", [$p, 'saveRegions'], 'user');
        $this->add('DELETE', "/api/regions/$id", [$p, 'deleteRegion'], 'user');
        $this->add('POST', "/api/regions/$id/correction", [$p, 'correct'], 'user');
        $this->add('POST', "/api/pages/$id/alignment/infer", [$p, 'inferAlignment'], 'user');
        $this->add('PUT', "/api/pages/$id/alignment", [$p, 'saveAlignment'], 'user');

        $this->add('POST', "/api/books/$id/ocr/enqueue", [$o, 'enqueue'], 'user');
        $this->add('GET', "/api/books/$id/ocr/status", [$o, 'status'], 'user');
        $this->add('POST', '/api/ocr/lease', [$o, 'lease'], 'worker');
        $this->add('POST', "/api/ocr/jobs/$id/complete", [$o, 'complete'], 'worker');
        $this->add('POST', "/api/ocr/jobs/$id/fail", [$o, 'fail'], 'worker');

        $this->add('GET', "/api/books/$id/export\\.txt", [$e, 'txt'], 'user');
        $this->add('GET', "/api/books/$id/export\\.json", [$e, 'json'], 'user');
    }

    private function add(string $method, string $path, callable $handler, string $access): void
    {
        $this->routes[] = [$method, '#^' . $path . '$#', $handler, $access];
    }

    public function handle(Request $req): Response
    {
        try {
            $pathMatched = false;
            foreach ($this->routes as [$method, $regex, $handler, $access]) {
                if (!preg_match($regex, $req->path, $m)) {
                    continue;
                }
                $pathMatched = true;
                if ($method !== $req->method) {
                    continue;
                }
                $this->guard($req, $access);
                return $handler($req, ...array_slice($m, 1));
            }
            throw $pathMatched
                ? new HttpError(405, 'method_not_allowed', 'Method not allowed.')
                : new HttpError(404, 'not_found', 'Not found.');
        } catch (HttpError $e) {
            return Response::json(['error' => $e->errorCode, 'message' => $e->getMessage()] + $e->extra, $e->status);
        } catch (\Throwable $e) {
            error_log('[bookstream] ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
            return Response::json(['error' => 'server_error', 'message' => 'Internal server error.'], 500);
        }
    }

    private function guard(Request $req, string $access): void
    {
        if ($this->config->bool('FORCE_HTTPS', false) && !$req->secure) {
            throw new HttpError(403, 'https_required', 'HTTPS is required.');
        }
        if ($access === 'public') {
            if ($req->method !== 'GET') {
                $this->auth->requireCsrf($req);
            }
            return;
        }
        if ($access === 'worker' && $this->auth->isWorker($req)) {
            return;
        }
        $this->auth->requireUser();
        if ($req->method !== 'GET') {
            $this->auth->requireCsrf($req);
        }
    }

    /** @return array<string,mixed> */
    public function book(string $bookId): array
    {
        $book = $this->db->one('SELECT * FROM books WHERE id = ?', [$bookId]);
        if ($book === null || !$this->auth->canAccessBook($book)) {
            throw new HttpError(404, 'book_not_found', 'Book not found.');
        }
        return $book;
    }

    /** @return array{0:array<string,mixed>,1:array<string,mixed>} page, book */
    public function page(string $pageId): array
    {
        $page = $this->db->one('SELECT * FROM pages WHERE id = ?', [$pageId]);
        if ($page === null) {
            throw new HttpError(404, 'page_not_found', 'Page not found.');
        }
        return [$page, $this->book((string)$page['book_id'])];
    }
}
