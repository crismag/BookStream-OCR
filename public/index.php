<?php
declare(strict_types=1);

// Front controller for /api/*.
//
// BOOKSTREAM_HOME holds the private, persistent data: .env and storage/ (scans + logs).
// It must be OUTSIDE the web root so that redeploys (which replace the web root) never
// touch it and it is never web-reachable. Resolution order:
//   1. $BOOKSTREAM_HOME environment variable
//   2. ../            when ../app exists (repository / local development layout)
//   3. ../bookstream  or ../../bookstream (zip deploy, or a subdomain inside public_html)
//   4. ../bookstream  created on first run (Git build deploy)
// PHP code is taken from ./_bookstream/app (bundled by the Git build) or HOME/app (zip deploy).
$home = getenv('BOOKSTREAM_HOME') ? rtrim((string)getenv('BOOKSTREAM_HOME'), '/') : null;
if ($home === null && is_file(dirname(__DIR__) . '/app/bootstrap.php')) {
    $home = dirname(__DIR__);
}
if ($home === null) {
    foreach ([dirname(__DIR__) . '/bookstream', dirname(__DIR__, 2) . '/bookstream'] as $dir) {
        if (is_dir($dir)) {
            $home = $dir;
            break;
        }
    }
}
if ($home === null) {
    $home = dirname(__DIR__) . '/bookstream';
    @mkdir($home, 0750, true);
}
$appDir = null;
foreach ([__DIR__ . '/_bookstream/app', $home . '/app'] as $c) {
    if (is_file($c . '/bootstrap.php')) {
        $appDir = $c;
        break;
    }
}
if ($appDir === null || !is_dir($home) || !is_writable($home)) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => 'misconfigured',
        'message' => $appDir === null
            ? 'BookStream app code not found.'
            : 'Private data folder is missing or not writable: create it next to the web root (e.g. domains/<domain>/bookstream) with permission 755.',
    ]);
    exit;
}
define('BOOKSTREAM_HOME', $home);
require $appDir . '/bootstrap.php';

use BookStream\App;
use BookStream\Config;
use BookStream\Db;
use BookStream\Http\NativeSession;
use BookStream\Http\Request;

ini_set('display_errors', '0');
ini_set('log_errors', '1');

$config = Config::load($home . '/.env');
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
