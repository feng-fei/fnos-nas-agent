#!/usr/bin/env python3
"""Generate minimal valid fnOS PNG icons using only the Python standard library."""
import math
import os
import struct
import sys
import zlib

app = sys.argv[1]
ui_images = os.path.join(app, "app", "ui", "images")
os.makedirs(ui_images, exist_ok=True)

def png(path, size):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            # Deep blue background, a simple white NAS chassis, and three status LEDs.
            r, g, b = 22, 45, 82
            margin = size * 0.19
            chassis = margin <= x <= size - margin and size * 0.23 <= y <= size * 0.77
            if chassis:
                r, g, b = 235, 241, 250
                inset = size * 0.07
                if (x < margin + inset or x > size - margin - inset or
                    y < size * 0.23 + inset or y > size * 0.77 - inset):
                    r, g, b = 184, 203, 229
                led_y = size * 0.5
                for i, led_x in enumerate((size * 0.38, size * 0.50, size * 0.62)):
                    if (x - led_x) ** 2 + (y - led_y) ** 2 <= (size * 0.025) ** 2:
                        r, g, b = ((65, 210, 145) if i == 0 else (73, 150, 255))
            row.extend((r, g, b, 255))
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    data = b"\x89PNG\r\n\x1a\n"
    data += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9))
    data += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(data)

# The desktop config uses icon_{0}.png; provide common index and size variants
# to tolerate fnOS versions that substitute either an index or a requested size.
for name, size in [
    ("icon_0.png", 64), ("icon_1.png", 256),
    ("icon_64.png", 64), ("icon_256.png", 256),
]:
    png(os.path.join(ui_images, name), size)
png(os.path.join(app, "ICON.PNG"), 64)
png(os.path.join(app, "ICON_256.PNG"), 256)
