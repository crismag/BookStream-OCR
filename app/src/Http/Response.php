<?php
declare(strict_types=1);

namespace BookStream\Http;

final class Response
{
    /** @param array<string,string> $headers */
    public function __construct(
        public int $status = 200,
        public string $body = '',
        public array $headers = [],
        public ?string $filePath = null,
    ) {
    }

    /** @param mixed $data */
    public static function json(mixed $data, int $status = 200): self
    {
        return new self($status, (string)json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE), [
            'Content-Type' => 'application/json; charset=utf-8',
            'Cache-Control' => 'no-store',
        ]);
    }

    public static function text(string $text, string $type = 'text/plain; charset=utf-8', ?string $download = null): self
    {
        $h = ['Content-Type' => $type, 'Cache-Control' => 'no-store'];
        if ($download !== null) {
            $h['Content-Disposition'] = 'attachment; filename="' . preg_replace('/[^A-Za-z0-9._-]/', '_', $download) . '"';
        }
        return new self(200, $text, $h);
    }

    public static function file(string $path, string $mime): self
    {
        return new self(200, '', [
            'Content-Type' => $mime,
            'Cache-Control' => 'private, max-age=3600',
            'Content-Length' => (string)filesize($path),
        ], $path);
    }

    public function send(): void
    {
        http_response_code($this->status);
        $security = [
            'X-Content-Type-Options' => 'nosniff',
            'Referrer-Policy' => 'same-origin',
            'X-Frame-Options' => 'DENY',
            'Permissions-Policy' => 'camera=(self), microphone=(), geolocation=()',
        ];
        foreach ($this->headers + $security as $k => $v) {
            header($k . ': ' . $v);
        }
        if ($this->filePath !== null) {
            readfile($this->filePath);
        } else {
            echo $this->body;
        }
    }
}
