"""Synthetic parallel-text page (invented Maranao-like verse + English) for e2e tests.
Writes a PNG and a Y4M video so Chrome's fake camera "sees" the page."""
import subprocess, sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/bs-e2e'
W, H = 1920, 1440
img = Image.new('RGB', (W, H), (248, 246, 238))
d = ImageDraw.Draw(img)
font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 46)
left = ["Na so manga datu", "a miyamagompong", "ko lopa a Bembaran,", "na mialolot iran", "so kambayoka."]
right = ["And the chieftains", "who gathered together", "in the land of Bembaran", "were all singing", "the kambayoka."]
y = 200
for l, r in zip(left, right):
    d.text((140, y), l, fill=(20, 20, 20), font=font)
    d.text((1040, y), r, fill=(20, 20, 20), font=font)
    y += 110
d.text((930, 1300), "12", fill=(20, 20, 20), font=font)
img.save(f'{out}/parallel.png')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', f'{out}/parallel.png', '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', f'{out}/parallel.y4m'], check=True)
print('ok')

# Tabletop scene: the same page, smaller and rotated, on a dark desk (tests auto-crop).
page = Image.open(f'{out}/parallel.png').resize((1300, 975))
page = page.rotate(5, expand=True, fillcolor=(52, 38, 30))
desk = Image.new('RGB', (W, H), (52, 38, 30))
desk.paste(page, ((W - page.width) // 2, (H - page.height) // 2))
desk.save(f'{out}/tabletop.png')
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-i', f'{out}/tabletop.png', '-t', '2', '-r', '10', '-pix_fmt', 'yuv420p', f'{out}/tabletop.y4m'], check=True)
print('tabletop ok')
