# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — bundle engram_server as a standalone Windows exe.

Built with:
    uv run pyinstaller engram_server.spec --clean --noconfirm

The resulting onefile exe at dist/engram-server.exe is copied into
src-tauri/binaries/engram-server-x86_64-pc-windows-msvc.exe so the Tauri
app can spawn it as a sidecar.

NOTES ON PACKAGING PAIN POINTS:

  sqlite-vec ships a vec0.dll that Python loads at runtime via ctypes.
  PyInstaller can't see that import statically, so we add it as a data
  file and use a runtime hook to locate it relative to sys._MEIPASS.

  sentence-transformers pulls in torch + transformers + huggingface_hub.
  torch has hundreds of dynamic submodules — we use collect_all() for
  the three of them so PyInstaller grabs everything. Resulting bundle
  is ~500-700 MB but that's the cost of local embeddings.

  The BGE model weights (~130 MB) are NOT bundled — sentence-transformers
  downloads them on first call to ~/.cache/huggingface/. User needs
  internet for the first launch. If this ships to offline contexts we
  can bundle via --add-data later.

  PyMuPDF (fitz) ships a C extension; collect_all gets it.
"""

from PyInstaller.utils.hooks import collect_all, copy_metadata, collect_data_files
from pathlib import Path

block_cipher = None
server_root = Path('.').resolve()

# --- Deps that need aggressive collection ---
# torch / transformers / sentence_transformers have so many dynamic
# imports that hand-listing them is infeasible. collect_all grabs every
# submodule, data file, and binary these packages reference.
hidden = []
datas = []
binaries = []
# collect_all() returns (datas, binaries, hiddenimports) in that order.
# Getting this wrong produces a cryptic TypeError about 'tuple' in modnm.
for pkg in ('sentence_transformers', 'transformers', 'huggingface_hub', 'tokenizers', 'torch', 'pymupdf'):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hidden += h

# Metadata lookups (FastAPI/Starlette use importlib.metadata for version strings)
for pkg in ('fastapi', 'uvicorn', 'starlette', 'pydantic', 'pydantic_core', 'anthropic', 'mcp'):
    datas += copy_metadata(pkg)

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
    'engram_server',
    'engram_server.__main__',
    'engram_server.server',
    'engram_server.api',
    'engram_server.brain',
    'engram_server.database',
    'engram_server.embeddings',
    'engram_server.retriever',
    'engram_server.ingest',
    'engram_server.hooks',
    'engram_server.insight_extractor',
    'engram_server.consolidation',
    'engram_server.bm25_index',
    'engram_server.conversation_log',
    'engram_server.write_back',
    'engram_server.config',
]


a = Analysis(
    [str(server_root / 'engram_server' / '__main__.py')],
    pathex=[str(server_root)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Keep the bundle smaller by dropping stuff we never use.
        'tkinter',
        'matplotlib',
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
    name='engram-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,  # sidecar runs headless; stdout visible in child process
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
