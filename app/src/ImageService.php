<?php
declare(strict_types=1);

namespace BookStream;

use BookStream\Http\HttpError;

final class ImageService
{
    public const MIME_EXT = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
    public const VARIANTS = ['thumb' => 360, 'view' => 1600, 'full' => 4000];

    /**
     * Inspect an uploaded file by content (not by name or client MIME).
     * @return array{mime:string,ext:string,width:int,height:int}
     */
    public static function inspect(string $path, int $maxBytes, int $maxPixels): array
    {
        $size = filesize($path);
        if ($size === false || $size === 0) {
            throw new HttpError(422, 'empty_file', 'The uploaded file is empty.');
        }
        if ($size > $maxBytes) {
            throw new HttpError(413, 'file_too_large', 'Image exceeds the size limit.', ['max_bytes' => $maxBytes]);
        }
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($path) ?: '';
        if (!isset(self::MIME_EXT[$mime])) {
            throw new HttpError(415, 'unsupported_type', 'Only JPEG, PNG or WebP images are accepted.');
        }
        $info = @getimagesize($path);
        if ($info === false || $info[0] < 200 || $info[1] < 200) {
            throw new HttpError(422, 'invalid_image', 'The file is not a readable image of usable size.');
        }
        if ($info[0] * $info[1] > $maxPixels) {
            throw new HttpError(413, 'too_many_pixels', 'Image resolution exceeds the limit.');
        }
        return ['mime' => $mime, 'ext' => self::MIME_EXT[$mime], 'width' => (int)$info[0], 'height' => (int)$info[1]];
    }

    /** @return \GdImage */
    public static function load(string $path, string $mime): \GdImage
    {
        $img = match ($mime) {
            'image/jpeg' => @imagecreatefromjpeg($path),
            'image/png' => @imagecreatefrompng($path),
            'image/webp' => @imagecreatefromwebp($path),
            default => false,
        };
        if (!$img instanceof \GdImage) {
            throw new \RuntimeException('Cannot decode image.');
        }
        if ($mime === 'image/jpeg' && function_exists('exif_read_data')) {
            $exif = @exif_read_data($path);
            $o = (int)($exif['Orientation'] ?? 1);
            $img = match ($o) {
                3 => imagerotate($img, 180, 0),
                6 => imagerotate($img, -90, 0),
                8 => imagerotate($img, 90, 0),
                default => $img,
            } ?: $img;
        }
        return $img;
    }

    /**
     * Produce (and cache) a derived JPEG for a page: side/crop, rotation, max size.
     * The original is never modified.
     * @param array<string,mixed> $page
     * @param array<string,mixed> $capture
     */
    public static function derive(Storage $storage, array $page, array $capture, string $variant): string
    {
        $max = self::VARIANTS[$variant] ?? self::VARIANTS['view'];
        $sig = substr(sha1(implode('|', [$capture['checksum'], $page['side'], $page['crop_region'] ?? '', $page['rotation'], $max])), 0, 12);
        $dir = $storage->bookDir((string)$page['book_id'], 'processed');
        $out = $dir . '/' . $page['id'] . '-' . $variant . '-' . $sig . '.jpg';
        if (is_file($out)) {
            return $out;
        }
        $src = self::load($storage->path((string)$capture['storage_key']), (string)$capture['mime']);
        $w = imagesx($src);
        $h = imagesy($src);
        [$cx, $cy, $cw, $ch] = self::cropRect($page, $w, $h);
        $crop = imagecrop($src, ['x' => $cx, 'y' => $cy, 'width' => $cw, 'height' => $ch]) ?: $src;
        $rot = ((int)$page['rotation'] % 360 + 360) % 360;
        if ($rot !== 0) {
            $crop = imagerotate($crop, -$rot, 0xffffff) ?: $crop;
        }
        $cw = imagesx($crop);
        $ch = imagesy($crop);
        $scale = min(1.0, $max / max($cw, $ch));
        if ($scale < 1.0) {
            $nw = max(1, (int)round($cw * $scale));
            $nh = max(1, (int)round($ch * $scale));
            $dst = imagecreatetruecolor($nw, $nh);
            imagecopyresampled($dst, $crop, 0, 0, 0, 0, $nw, $nh, $cw, $ch);
            $crop = $dst;
        }
        $tmp = $out . '.tmp-' . bin2hex(random_bytes(4));
        imagejpeg($crop, $tmp, $variant === 'thumb' ? 78 : 92);
        rename($tmp, $out);
        return $out;
    }

    /**
     * Crop rectangle in source pixels. crop_region is normalized JSON {x,y,w,h} (0..1).
     * Without an explicit crop, spread sides default to the left/right half.
     * @param array<string,mixed> $page
     * @return array{0:int,1:int,2:int,3:int}
     */
    public static function cropRect(array $page, int $w, int $h): array
    {
        $r = null;
        if (!empty($page['crop_region'])) {
            $r = json_decode((string)$page['crop_region'], true);
        }
        if (!is_array($r)) {
            $r = match ($page['side']) {
                'left' => ['x' => 0, 'y' => 0, 'w' => 0.5, 'h' => 1],
                'right' => ['x' => 0.5, 'y' => 0, 'w' => 0.5, 'h' => 1],
                default => ['x' => 0, 'y' => 0, 'w' => 1, 'h' => 1],
            };
        }
        $x = (int)round(max(0, min(1, (float)$r['x'])) * $w);
        $y = (int)round(max(0, min(1, (float)$r['y'])) * $h);
        $cw = (int)round(max(0.01, min(1, (float)$r['w'])) * $w);
        $ch = (int)round(max(0.01, min(1, (float)$r['h'])) * $h);
        return [$x, $y, max(1, min($cw, $w - $x)), max(1, min($ch, $h - $y))];
    }
}
