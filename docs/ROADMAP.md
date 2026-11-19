# Roadmap

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, docs, CI, packaging | Done |
| 1 | Scanner MVP: login, books, camera, queue, verified uploads, gallery, resume | Done (needs on-device check on the S24) |
| 2 | Structured page model, region editor, basic OCR (browser Tesseract), TXT/JSON export | Done |
| 3 | Multi-column reading order, language-selective export, spread split, rotate, reorder, missing pages | Done; free-form crop editor pending |
| 4 | Parallel alignment (inferred/verified, 1:n), parallel TXT/TSV | Done. DOCX, HTML, searchable PDF exports pending |
| 5 | Automatic capture, page-stability & duplicate-page detection, laptop Python worker (Surya/PaddleOCR), engine benchmark on real pages | Not started |

## Next candidates (in priority order)

1. On-device validation on the Galaxy S24 + fixes.
2. Benchmark Tesseract (eng, no dictionary) vs `tgl` model vs Surya on 5–10 real Darangen pages; record accuracy in docs.
3. HTML export (verse-preserving) and DOCX export.
4. Automatic region detection (line clustering → columns) to replace fixed presets on irregular pages.
5. Searchable PDF via client-side `pdf-lib` (image + invisible text layer).
6. Optional native Android capture client (CameraX + ML Kit document scanner + WorkManager uploads) using the same API.
