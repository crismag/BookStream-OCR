<?php
declare(strict_types=1);

/*
 * BookStream bootstrap: autoloader + config. No Composer needed at runtime.
 */

spl_autoload_register(static function (string $class): void {
    $prefix = 'BookStream\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $rel = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = __DIR__ . '/src/' . $rel . '.php';
    if (is_file($file)) {
        require $file;
    }
});

define('BOOKSTREAM_APP_DIR', __DIR__);
