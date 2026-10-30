"""Упаковка win-unpacked в переносной zip для скачивания."""
import zipfile, os

src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'release', 'win-unpacked')
out = '/home/user/TuneQueue-portable.zip'

assert os.path.isdir(src), f'нет {src}'
total = 0
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _dirs, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f)
            arc = os.path.join('TuneQueue', os.path.relpath(p, src))
            z.write(p, arc)
            total += os.path.getsize(p)
print(f'packed {total} bytes -> {out} ({os.path.getsize(out)} bytes)')
