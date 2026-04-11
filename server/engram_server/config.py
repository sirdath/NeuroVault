from pathlib import Path

# Base directory for all Engram data
ENGRAM_HOME = Path.home() / ".engram"

# Multi-brain directories
BRAINS_DIR = ENGRAM_HOME / "brains"
REGISTRY_PATH = ENGRAM_HOME / "brains.json"

# Embedding model — BAAI/bge-small-en-v1.5 scores ~65 MTEB (vs 56 for all-MiniLM-L6-v2)
# Same 384 dims, 10% faster, 10-15% better retrieval quality, zero cost
EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"
EMBEDDING_DIM = 384

# Server
SERVER_PORT = 8765

# Ensure base directory exists (brain dirs created by BrainManager)
ENGRAM_HOME.mkdir(parents=True, exist_ok=True)
