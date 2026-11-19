<?php
declare(strict_types=1);

namespace BookStream\Http;

/** Session storage abstraction so tests can run without PHP's session extension state. */
interface Session
{
    public function get(string $key): mixed;
    public function set(string $key, mixed $value): void;
    public function regenerate(): void;
    public function destroy(): void;
}
