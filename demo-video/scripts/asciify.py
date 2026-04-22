"""
Convert a video → ASCII animation, pure Python, no chafa needed.

Pipeline:
  ffmpeg extracts frames → Pillow downsamples to char grid + maps brightness
  → plain-text frames + ascii-frames.json + optional rasterized GIF.

Usage:
  python asciify.py <input.mp4> <outdir> [--width 120] [--fps 24]

Prereqs:
  pip install Pillow
  ffmpeg on PATH
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Brightness ramp — dark → light
RAMP = " .:-=+*#%@"


def log(msg: str) -> None:
    print(msg, flush=True)


def extract_frames(video: Path, out_dir: Path, fps: int, max_width: int) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    # Downscale while extracting to save memory
    vf = f"fps={fps},scale={max_width * 2}:-1:flags=lanczos"
    cmd = [
        "ffmpeg", "-y", "-i", str(video),
        "-vf", vf,
        str(out_dir / "%04d.png"),
        "-loglevel", "error",
    ]
    subprocess.run(cmd, check=True)
    return len(list(out_dir.glob("*.png")))


def frame_to_ascii(png_path: Path, width: int) -> str:
    img = Image.open(png_path).convert("L")  # grayscale
    # Character cells are ~2x as tall as wide; compensate so aspect ratio is preserved
    w, h = img.size
    cell_aspect = 2.2  # empirical for monospace fonts
    height = int((h / w) * width / cell_aspect)
    if height < 2:
        height = 2
    img = img.resize((width, height), Image.LANCZOS)
    px = img.load()
    lines: list[str] = []
    ramp_len = len(RAMP)
    for y in range(height):
        row = [RAMP[min(ramp_len - 1, px[x, y] * ramp_len // 256)] for x in range(width)]
        lines.append("".join(row))
    return "\n".join(lines)


def rasterize_ascii_frame(text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont,
                          fg: str = "#FFAF87", bg: str = "#0b0b12") -> Image.Image:
    lines = text.splitlines() or [""]
    try:
        bbox = font.getbbox("W")
        cw = bbox[2] - bbox[0]
        ch = bbox[3] - bbox[1] + 2
    except AttributeError:
        cw, ch = 7, 13
    w = max(len(l) for l in lines) * cw + 16
    h = len(lines) * ch + 16
    img = Image.new("RGB", (w, h), bg)
    draw = ImageDraw.Draw(img)
    for i, line in enumerate(lines):
        draw.text((8, 8 + i * ch), line, fill=fg, font=font)
    return img


def load_mono_font(size: int = 12) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for name in ("consola.ttf", "Menlo.ttc", "DejaVuSansMono.ttf", "Consolas.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("outdir", type=Path)
    ap.add_argument("--width", type=int, default=120, help="ASCII grid width (chars)")
    ap.add_argument("--fps", type=int, default=24, help="output FPS")
    ap.add_argument("--fg", default="#FFAF87", help="foreground color for raster GIF")
    ap.add_argument("--bg", default="#0b0b12", help="background color for raster GIF")
    ap.add_argument("--no-gif", action="store_true", help="skip GIF rasterization")
    ap.add_argument("--skip-convert", action="store_true",
                    help="skip frame extraction + ASCII conversion, just re-rasterize existing frames")
    args = ap.parse_args()

    if not args.input.exists():
        print(f"Input not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    frames_dir = args.outdir / "frames"
    ascii_frames: list[str] = []

    if args.skip_convert:
        log(f"[1-3/4] skip-convert: loading existing frames from {frames_dir}/")
        txts = sorted(frames_dir.glob("*.txt"))
        if not txts:
            print(f"No existing .txt frames in {frames_dir} — can't skip-convert", file=sys.stderr)
            sys.exit(1)
        for t in txts:
            ascii_frames.append(t.read_text(encoding="utf-8"))
        log(f"        loaded {len(ascii_frames)} existing ASCII frames")
    else:
        log(f"[1/4] Extracting frames at {args.fps}fps into {frames_dir}/")
        n = extract_frames(args.input, frames_dir, args.fps, args.width)
        log(f"      {n} frames extracted")

        log(f"[2/4] Converting frames → ASCII (grid {args.width} cols)")
        pngs = sorted(frames_dir.glob("*.png"))
        for i, p in enumerate(pngs):
            art = frame_to_ascii(p, args.width)
            (p.with_suffix(".txt")).write_text(art, encoding="utf-8")
            ascii_frames.append(art)
            if (i + 1) % 50 == 0:
                log(f"      {i + 1}/{len(pngs)}")
        log(f"      {len(ascii_frames)} ASCII frames written")

        log("[3/4] Writing ascii-frames.json (for JS embed)")
        (args.outdir / "ascii-frames.json").write_text(
            json.dumps(ascii_frames, ensure_ascii=False), encoding="utf-8"
        )
        log(f"      {args.outdir / 'ascii-frames.json'} ({len(ascii_frames)} frames)")

    if args.no_gif:
        log("[4/4] skipped GIF (--no-gif)")
        return

    log(f"[4/4] Rasterizing ASCII frames → GIF (fg={args.fg} bg={args.bg})")
    font = load_mono_font(12)
    raster_dir = args.outdir / "raster"
    raster_dir.mkdir(exist_ok=True)
    for i, art in enumerate(ascii_frames):
        img = rasterize_ascii_frame(art, font, fg=args.fg, bg=args.bg)
        img.save(raster_dir / f"{i + 1:04d}.png", optimize=True)
    log(f"      {len(ascii_frames)} raster PNGs written")

    gif_path = args.outdir / "ascii.gif"
    cmd = [
        "ffmpeg", "-y", "-framerate", str(args.fps),
        "-i", str(raster_dir / "%04d.png"),
        "-vf",
        "split[s0][s1];[s0]palettegen=max_colors=32[p];[s1][p]paletteuse",
        str(gif_path), "-loglevel", "error",
    ]
    try:
        subprocess.run(cmd, check=True)
        log(f"      {gif_path} ({gif_path.stat().st_size // 1024} KB)")
    except subprocess.CalledProcessError as e:
        log(f"      gif compose failed: {e}")


if __name__ == "__main__":
    main()