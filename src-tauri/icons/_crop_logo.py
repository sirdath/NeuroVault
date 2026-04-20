"""Remove off-white background from logo screenshot, make transparent, square, 1024x1024."""
from PIL import Image
from pathlib import Path
from collections import deque

src = Path(r"C:\Users\Dath\OneDrive\Desktop\AntiGravity Stuff\Ai-Brain\Screenshot 2026-04-18 113322.png")
out = Path(__file__).parent / "_source_1024.png"

img = Image.open(src).convert("RGBA")
w, h = img.size
pixels = img.load()
print(f"Original: {w}x{h}")

def is_bg(rgba):
    r, g, b, _ = rgba
    return r >= 235 and g >= 235 and b >= 235

visited = [[False] * w for _ in range(h)]
queue = deque()
for x in range(w):
    for y in (0, h - 1):
        if is_bg(pixels[x, y]):
            queue.append((x, y))
            visited[y][x] = True
for y in range(h):
    for x in (0, w - 1):
        if is_bg(pixels[x, y]) and not visited[y][x]:
            queue.append((x, y))
            visited[y][x] = True

cleared = 0
while queue:
    x, y = queue.popleft()
    pixels[x, y] = (0, 0, 0, 0)
    cleared += 1
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        nx, ny = x + dx, y + dy
        if 0 <= nx < w and 0 <= ny < h and not visited[ny][nx]:
            if is_bg(pixels[nx, ny]):
                visited[ny][nx] = True
                queue.append((nx, ny))
print(f"Transparent pixels: {cleared}")

bbox = img.getbbox()
print(f"Bbox after clearing: {bbox}")
if bbox:
    img = img.crop(bbox)

cw, ch = img.size
side = max(cw, ch)
square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
square.paste(img, ((side - cw) // 2, (side - ch) // 2))

square = square.resize((1024, 1024), Image.LANCZOS)
square.save(out, "PNG")
print(f"Saved: {out} ({square.size})")