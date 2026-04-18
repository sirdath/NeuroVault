# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — bundle neurovault_server as a standalone Windows exe.

Built with:
    uv run pyinstaller neurovault_server.spec --clean --noconfirm

The resulting onefile exe at dist/neurovault-server.exe is copied into
src-tauri/binaries/neurovault-server-x86_64-pc-windows-msvc.exe so the Tauri
app can spawn it as a sidecar.

SIZE NOTES (v0.2 — post-ONNX migration):

  The v0.1 sidecar was ~263 MB because it bundled PyTorch (~150 MB compressed)
  for sentence-transformers. v0.2 replaces torch with fastembed (ONNX Runtime),
  dropping the bundle to ~60-80 MB.

  fastembed downloads the ONNX model weights (~30 MB) on first use to
  ~/.cache/fastembed/. Not bundled in the exe.

  PyMuPDF (fitz) is NOT bundled in the base sidecar — it's a 51 MB C
  extension used only for PDF ingestion. If the user uploads a PDF, the
  server imports pymupdf lazily and fails with a clear error if it's not
  installed. Power users can install it via `uv pip install pymupdf`.

  sqlite-vec ships a vec0.dll loaded via ctypes at runtime. PyInstaller
  can't see it statically, so we collect it as a data file.
"""

from PyInstaller.utils.hooks import collect_all, copy_metadata, collect_data_files
from pathlib import Path

block_cipher = None
server_root = Path('.').resolve()

# --- Deps that need collection ---
hidden = []
datas = []
binaries = []

# fastembed + onnxruntime + PIL (fastembed imports PIL.Image unconditionally
# even for text-only embeddings, so Pillow must be bundled)
for pkg in ('fastembed', 'onnxruntime', 'huggingface_hub', 'tokenizers', 'PIL'):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hidden += h
    except Exception:
        pass  # package may not be installed; skip gracefully

# Metadata lookups (FastAPI/Starlette use importlib.metadata for version strings)
for pkg in ('fastapi', 'uvicorn', 'starlette', 'pydantic', 'pydantic_core', 'anthropic', 'mcp'):
    try:
        datas += copy_metadata(pkg)
    except Exception:
        pass

# sqlite_vec vec0.dll — ctypes-loaded, invisible to static analysis
datas += collect_data_files('sqlite_vec', include_py_files=False)

# Extra hidden imports uvicorn loads by name at runtime
hidden += [
    'uvicorn.lifespan.on',
    'uvicorn.lifespan.off',
    'uvicorn.protocols.http.h11_impl',
    'uvicorn.protocols.http.httptools_impl',
    'uvicorn.protocols.websockets.auto',
    'uvicorn.protocols.websockets.websockets_impl',
    'uvicorn.loops.auto',
    'uvicorn.loops.asyncio',
    'uvicorn.logging',
    'neurovault_server',
    'neurovault_server.__main__',
    'neurovault_server.server',
    'neurovault_server.api',
    'neurovault_server.brain',
    'neurovault_server.database',
    'neurovault_server.embeddings',
    'neurovault_server.retriever',
    'neurovault_server.ingest',
    'neurovault_server.hooks',
    'neurovault_server.insight_extractor',
    'neurovault_server.consolidation',
    'neurovault_server.bm25_index',
    'neurovault_server.conversation_log',
    'neurovault_server.write_back',
    'neurovault_server.config',
    'neurovault_server.audit',
    'neurovault_server.compiler',
]


a = Analysis(
    [str(server_root / 'neurovault_server' / '__main__.py')],
    pathex=[str(server_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # --- Big packages we no longer need ---
        'torch',
        'torch.*',
        'sentence_transformers',
        'transformers',
        'scipy',
        'scipy.*',
        'sklearn',
        'sklearn.*',
        'pymupdf',           # deferred — lazy import at runtime
        'fitz',              # pymupdf alias
        # --- Stuff we never used ---
        'tkinter',
        'matplotlib',
        # PIL/pillow is required by fastembed (even for text-only embeddings —
        # fastembed's __init__.py imports the image module unconditionally).
        # Keep it bundled or the sidecar crashes on boot with ModuleNotFoundError.
        'PIL.ImageTk',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
        'IPython',
        'jupyter',
        'notebook',
        'pytest',
        'sphinx',
        'numpy.testing',
        'numpy.doc',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='neurovault-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=True,             # strip debug symbols — saves ~5-10%
    upx=False,              # skip UPX — causes antivirus false positives on Windows
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,           # sidecar runs headless; stdout visible in child process
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
