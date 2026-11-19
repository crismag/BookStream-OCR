<?php
declare(strict_types=1);

namespace BookStream;

/**
 * Layout presets turn a page into starting regions. Regions use normalized bounding
 * boxes {x,y,w,h} relative to the derived page image. Users can edit them afterwards.
 */
final class Layout
{
    public const TYPES = ['single', 'two_column', 'parallel', 'mixed'];
    public const ROLES = ['text', 'original', 'translation'];
    public const BLOCK_TYPES = ['text', 'heading', 'verse', 'footnote', 'header', 'footer', 'page_number', 'caption'];

    /**
     * @param array<string,mixed> $book
     * @return list<array<string,mixed>>
     */
    public static function preset(string $layout, array $book): array
    {
        $orig = (string)$book['original_language'];
        $trans = (string)$book['translation_language'];
        $m = 0.03; // margin
        return match ($layout) {
            'two_column' => [
                ['bbox' => ['x' => $m, 'y' => $m, 'w' => 0.47 - $m, 'h' => 1 - 2 * $m], 'column_id' => 'col1', 'reading_order' => 1, 'lang' => $orig, 'role' => 'text', 'block_type' => 'text'],
                ['bbox' => ['x' => 0.53, 'y' => $m, 'w' => 0.47 - $m, 'h' => 1 - 2 * $m], 'column_id' => 'col2', 'reading_order' => 2, 'lang' => $orig, 'role' => 'text', 'block_type' => 'text'],
            ],
            'parallel' => [
                ['bbox' => ['x' => $m, 'y' => $m, 'w' => 0.47 - $m, 'h' => 1 - 2 * $m], 'column_id' => 'left', 'reading_order' => 1, 'lang' => $orig, 'role' => 'original', 'block_type' => 'verse'],
                ['bbox' => ['x' => 0.53, 'y' => $m, 'w' => 0.47 - $m, 'h' => 1 - 2 * $m], 'column_id' => 'right', 'reading_order' => 2, 'lang' => $trans, 'role' => 'translation', 'block_type' => 'verse'],
            ],
            default => [
                ['bbox' => ['x' => $m, 'y' => $m, 'w' => 1 - 2 * $m, 'h' => 1 - 2 * $m], 'column_id' => 'main', 'reading_order' => 1, 'lang' => $orig, 'role' => 'text', 'block_type' => 'text'],
            ],
        };
    }

    /** @param mixed $bbox @return array{x:float,y:float,w:float,h:float} */
    public static function cleanBbox(mixed $bbox): array
    {
        if (!is_array($bbox)) {
            throw new Http\HttpError(422, 'invalid_bbox', 'bbox must be {x,y,w,h}.');
        }
        $c = [];
        foreach (['x', 'y', 'w', 'h'] as $k) {
            if (!isset($bbox[$k]) || !is_numeric($bbox[$k])) {
                throw new Http\HttpError(422, 'invalid_bbox', 'bbox must be {x,y,w,h}.');
            }
            $c[$k] = round(max(0.0, min(1.0, (float)$bbox[$k])), 5);
        }
        if ($c['w'] < 0.01 || $c['h'] < 0.01) {
            throw new Http\HttpError(422, 'invalid_bbox', 'Region is too small.');
        }
        return $c;
    }
}
