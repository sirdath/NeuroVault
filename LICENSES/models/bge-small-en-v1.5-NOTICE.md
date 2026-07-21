# BGE small English v1.5 model notice

The Mac App Store flavor bundles ONNX weights and tokenizer files from
`Xenova/bge-small-en-v1.5` at revision
`ea104dacec62c0de699686887e3f920caeb4f3e3`.

The conversion repository identifies `BAAI/bge-small-en-v1.5` as its base
model. The upstream BAAI model card declares the model under the MIT License:

- https://huggingface.co/BAAI/bge-small-en-v1.5
- https://huggingface.co/Xenova/bge-small-en-v1.5/tree/ea104dacec62c0de699686887e3f920caeb4f3e3

The corresponding MIT license text is bundled at
`LICENSES/native/bge-small-en-v1.5-LICENSE-MIT`. The packaged model directory
also contains `neurovault-model.json`, a deterministic manifest binding the
repository, revision, byte lengths, and hashes below.

Packaged-file SHA-256 checksums:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `model.onnx` | 133,093,490 | `828e1496d7fabb79cfa4dcd84fa38625c0d3d21da474a00f08db0f559940cf35` |
| `tokenizer.json` | 711,396 | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| `config.json` | 683 | `fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350` |
| `special_tokens_map.json` | 125 | `b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3` |
| `tokenizer_config.json` | 366 | `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3` |

This notice records the exact model payload and its published licensing
metadata for release review. It is not a legal opinion.
