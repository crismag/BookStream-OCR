<?php
declare(strict_types=1);

// Front controller for /api/*. Application code and storage live OUTSIDE the web root.
// Searched locations (first match wins): $BOOKSTREAM_HOME/app, ../app, ../bookstream/app, ../../bookstream/app
$candidates = array_filter([
    getenv('BOOKSTREAM_HOME') ? rtrim((string)getenv('BOOKSTREAM_HOME'), '/') . '/app' : null,
    dirname(__DIR__) . '/app',
    dirname(__DIR__) . '/bookstream/app',
    dirname(__DIR__, 2) . '/bookstream/app', // subdomain inside public_html/<sub>/
]);
$appDir = null;
foreach ($candidates as $c) {
    if (is_file($c . '/bootstrap.php')) {
        $appDir = $c;
        break;
    }
}
if ($appDir === null) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo '{"error":"misconfigured","message":"BookStream app directory not found."}';
    exit;
}
require $appDir . '/bootstrap.php';

use BookStream\App;
use BookStream\Config;
use BookStream\Db;
use BookStream\Http\NativeSession;
use BookStream\Http\Request;

ini_set('display_errors', '0');
ini_set('log_errors', '1');

$config = Config::load(dirname($appDir) . '/.env');
$request = Request::fromGlobals();

$logDir = $config->storageDir() . '/logs';
if (!is_dir($logDir)) {
    @mkdir($logDir, 0770, true);
}
ini_set('error_log', $logDir . '/php-error.log');

if ($config->bool('FORCE_HTTPS', false) && !$request->secure && PHP_SAPI !== 'cli-server') {
    header('Location: https://' . ($_SERVER['HTTP_HOST'] ?? '') . ($_SERVER['REQUEST_URI'] ?? '/'), true, 301);
    exit;
}
if ($request->secure) {
    header('Strict-Transport-Security: max-age=31536000');
}

$db = new Db($config);
$db->migrate();
$session = new NativeSession($request->secure, $config->int('SESSION_IDLE_SECONDS', 12 * 3600));
(new App($config, $db, $session))->handle($request)->send();
