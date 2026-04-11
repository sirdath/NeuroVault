# PyInstaller spec for engram-server binary
# Build: cd server && uv run pyinstaller engram-server.spec
# Output: server/dist/engram-server/engram-server.exe

import sys
from pathlib import Path

block_cipher = None

# Collect sentence-transformers model data
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

datas = []
datas += collect_data_files('sentence_transformers')
datas += collect_data_files('transformers')
datas += collect_data_files('tokenizers')

# sqlite-vec extension DLL
import sqlite_vec
sqlite_vec_dir = Path(sqlite_vec.__file__).parent
for dll in sqlite_vec_dir.glob('*.dll'):
    datas.append((str(dll), 'sqlite_vec'))
for so in sqlite_vec_dir.glob('*.so'):
    datas.append((str(so), 'sqlite_vec'))

hiddenimports = [
    'sentence_transformers',
    'transformers',
    'torch',
    'sqlite_vec',
    'rank_bm25',
    'anthropic',
    'loguru',
    'mcp',
    'fastapi',
    'uvicorn',
    'watchdog',
    'pydantic',
]
hiddenimports += collect_submodules('transformers')
hiddenimports += collect_submodules('sentence_transformers')

a = Analysis(
    ['engram_server/__main__.py'],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib', 'PIL', 'scipy.spatial.cKDTree',
        'IPython', 'notebook', 'jupyterlab',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='engram-server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='engram-server',
)
