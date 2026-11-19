"""Auto-crop e2e: fake camera shows a rotated page on a dark desk.
Usage: python3 e2e/crop_check.py <base> /tmp/bs-e2e/tabletop.y4m <user> <password>
Assumes the account and at least one book exist (run smoke.py first)."""
import sys
from playwright.sync_api import sync_playwright

base, y4m, user, pw = sys.argv[1:5]
ok = True
def check(name, cond, detail=''):
    global ok
    ok &= bool(cond)
    print(('PASS ' if cond else 'FAIL ') + name + (f' — {detail}' if detail else ''), flush=True)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={y4m}'])
    page = b.new_context(viewport={'width': 412, 'height': 915}, is_mobile=True, has_touch=True).new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(base + '/')
    page.fill('input[name=username]', user); page.fill('input[name=password]', pw); page.click('button[type=submit]')
    page.wait_for_selector('text=Resume scanning')
    page.click('text=Resume scanning')
    page.wait_for_function("document.querySelector('.detecthint') && document.querySelector('.detecthint').textContent.includes('found')", timeout=20000)
    check('live outline detects page edges', True, page.inner_text('.detecthint'))
    check('quality preset shown', 'Balanced' in page.inner_text('body'))
    page.click('.shutter')
    page.wait_for_function("document.querySelector('.lastinfo').textContent.length > 0", timeout=20000)
    info = page.inner_text('.lastinfo')
    check('capture was cropped', 'cropped' in info, info)
    w, h = [int(x) for x in info.split(' ')[0].split('×')]
    check('cropped size < full frame and page-shaped', w < 1800 and 1.2 < w / h < 1.45, f'{w}x{h}')
    page.wait_for_function("document.querySelector('.queuestat').textContent.includes('All uploaded')", timeout=30000)
    # toggle upload-later and back
    page.click('text=☁ Uploading'); page.wait_for_selector('text=⏸ Upload later')
    page.click('.shutter'); page.wait_for_timeout(2500)
    check('upload later keeps photo on phone', '1 pending' in page.inner_text('.queuestat'), page.inner_text('.queuestat'))
    page.click('text=⏸ Upload later')
    page.wait_for_function("document.querySelector('.queuestat').textContent.includes('All uploaded')", timeout=30000)
    check('switching back uploads it', True)
    # OCR the cropped page
    book = page.evaluate("sessionStorage.getItem('bs.currentBook')")
    pages = page.evaluate(f"fetch('/api/books/{book}/pages').then(r => r.json())")['pages']
    pid = pages[-2]['id']
    page.goto(f'{base}/#/pages/{pid}/review')
    page.wait_for_selector('text=OCR this page now')
    page.click('text=OCR this page now')
    page.wait_for_function("[...document.querySelectorAll('.rcard textarea')].some(t => t.value.includes('Bembaran'))", timeout=120000)
    texts = page.eval_on_selector_all('.rcard textarea', 'els => els.map(e => e.value)')
    check('OCR on cropped+straightened page', 'datu' in texts[0] and 'chieftains' in texts[1], repr(texts[0][:60]))
    page.screenshot(path='/tmp/bs-e2e/review-crop.png', full_page=False)
    page.goto(f'{base}/#/books/{book}/scan'); page.wait_for_timeout(1500)
    page.screenshot(path='/tmp/bs-e2e/scan-crop.png')
    check('no JS errors', not errs, '; '.join(errs[:2]))
    b.close()
sys.exit(0 if ok else 1)
