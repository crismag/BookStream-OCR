<?php
// Development router for `php -S localhost:8080 -t public public/router.php`.
// Not used by Apache/Hostinger (see .htaccess).
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (str_starts_with($path, '/api/')) {
    require __DIR__ . '/index.php';
    return true;
}
$file = __DIR__ . $path;
if ($path !== '/' && is_file($file) && !str_ends_with($file, '.php')) {
    if (str_ends_with($file, '.wasm')) {
        header('Content-Type: application/wasm');
        readfile($file);
        return true;
    }
    return false;
}
readfile(__DIR__ . '/index.html');
return true;
