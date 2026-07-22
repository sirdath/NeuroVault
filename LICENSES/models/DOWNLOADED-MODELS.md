# Runtime-downloaded model notice

NeuroVault's installers and npm packages do not contain model weights. The local
`fastembed` runtime downloads model artifacts into
`~/.neurovault/.fastembed_cache` when the corresponding feature is first used:

| Model | Use | Typical download/on-disk size | Upstream license metadata |
|---|---|---:|---|
| `Xenova/bge-small-en-v1.5` | Local text embeddings | about 130 MB | [BAAI model card (MIT)](https://huggingface.co/BAAI/bge-small-en-v1.5), [Xenova conversion](https://huggingface.co/Xenova/bge-small-en-v1.5) |
| `BAAI/bge-reranker-base` | Local cross-encoder reranking | about 1 GB | [BAAI model card (MIT)](https://huggingface.co/BAAI/bge-reranker-base) |

`fastembed 4.9.1` resolves the embedding weights from the
`Xenova/bge-small-en-v1.5` ONNX conversion. At the 2026-07-22 release audit,
that conversion repository identified the BAAI base model and described the
ONNX conversion but did not expose separate license metadata on its model
page. The MIT designation above therefore comes from the BAAI base model, not
an independent Xenova license declaration. Re-check both repositories before
each release.

Reranking is enabled on a fresh NeuroVault installation unless the operator disables
it. The reranker is initialized lazily, so its model is downloaded only when a
qualifying recall reaches the reranking stage. Its ONNX session can retain
about 1 GB of memory for the lifetime of the server process.

Model files are third-party material governed by the terms published with the
downloaded artifacts. Model hosts can change files or metadata independently
of NeuroVault, so release operators should audit the exact resolved
artifacts and terms for each release. The MIT text preserved at
`../native/bge-small-en-v1.5-LICENSE-MIT` is from the upstream FlagEmbedding
repository at the audited revision listed in `../NATIVE-NOTICE-SOURCES.json`.
