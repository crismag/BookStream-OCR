<?php
declare(strict_types=1);

namespace BookStream\Http;

final class Request
{
    /**
     * @param array<string,string> $query
     * @param array<string,mixed> $post
     * @param array<string,UploadedFile> $files
     * @param array<string,string> $headers lower-cased names
     */
    public function __construct(
        public string $method,
        public string $path,
        public array $query = [],
        public array $post = [],
        public array $files = [],
        public array $headers = [],
        public string $body = '',
        public string $ip = '127.0.0.1',
        public bool $secure = false,
    ) {
    }

    public static function fromGlobals(): self
    {
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $headers = [];
        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $headers[strtolower(str_replace('_', '-', substr($k, 5)))] = (string)$v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $headers['content-type'] = (string)$_SERVER['CONTENT_TYPE'];
        }
        $files = [];
        foreach ($_FILES as $name => $f) {
            if (is_array($f) && !is_array($f['name'] ?? null)) {
                $files[$name] = new UploadedFile(
                    (string)$f['tmp_name'], (string)$f['name'], (int)$f['size'], (int)$f['error'], true
                );
            }
        }
        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        return new self(
            strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'),
            $path,
            array_map('strval', $_GET),
            $_POST,
            $files,
            $headers,
            (string)file_get_contents('php://input'),
            (string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'),
            $secure,
        );
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->post !== []) {
            return $this->post;
        }
        if ($this->body === '') {
            return [];
        }
        $data = json_decode($this->body, true);
        if (!is_array($data)) {
            throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
        }
        return $data;
    }
}
