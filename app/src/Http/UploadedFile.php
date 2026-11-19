<?php
declare(strict_types=1);

namespace BookStream\Http;

final class UploadedFile
{
    public function __construct(
        public string $tmpPath,
        public string $clientName,
        public int $size,
        public int $error = UPLOAD_ERR_OK,
        private bool $fromSapi = true,
    ) {
    }

    /** True only when PHP itself received this file (prevents arbitrary path injection). */
    public function isGenuine(): bool
    {
        return $this->error === UPLOAD_ERR_OK
            && is_file($this->tmpPath)
            && (!$this->fromSapi || is_uploaded_file($this->tmpPath));
    }
}
