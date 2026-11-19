<?php
declare(strict_types=1);

namespace BookStream\Http;

final class HttpError extends \RuntimeException
{
    /** @param array<string,mixed> $extra */
    public function __construct(public int $status, public string $errorCode, string $message, public array $extra = [])
    {
        parent::__construct($message);
    }
}
