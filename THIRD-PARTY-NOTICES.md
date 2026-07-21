# Third-Party Notices

NeuroVault Desktop is a mixed-license application. Original Desktop material
added after the v0.6.0 boundary is proprietary, while the code and assets at
tag `v0.6.0` remain available under MIT. Third-party components retain their
own licenses. See `LICENSE` and `LICENSES/NeuroVault-v0.6.0-MIT.txt`.

This inventory is generated from the locked production dependency graphs by
`scripts/generate-third-party-notices.mjs`. It covers normal Rust dependencies
for the current macOS, Windows, and Linux release targets, plus production npm
dependencies that can participate in the packaged webview. Build-only and
development-only tools are excluded. Platform filtering may still make the
inventory conservatively broader than the bytes in any one app build.

The accompanying `LICENSES/THIRD-PARTY-LICENSES.txt` preserves the license and
notice files found in the installed package sources. Exact notices for linked
native components are preserved under `LICENSES/native/` and pinned by SHA-256
in `LICENSES/NATIVE-NOTICE-SOURCES.json`. A manifest-only section identifies
packages that do not publish a standalone license file in their archive. This
inventory assists compliance review; it is not a legal opinion.

## Material requiring explicit attention

### MPL-2.0 covered components (5)

The following unmodified Rust crates declare MPL-2.0. MPL-2.0 is weak copyleft
at the covered-file level; it does not relicense NeuroVault's own files. The
full MPL text is preserved in the bundled license collection. Exact source
archive links and Cargo checksums are in
`LICENSES/MPL-2.0-COVERED-SOURCE.md`.

| Crate | Version | License | Source |
|---|---:|---|---|
| cssparser | 0.29.6 | `MPL-2.0` | [crates.io](https://crates.io/crates/cssparser/0.29.6) |
| cssparser-macros | 0.6.1 | `MPL-2.0` | [crates.io](https://crates.io/crates/cssparser-macros/0.6.1) |
| dtoa-short | 0.3.5 | `MPL-2.0` | [crates.io](https://crates.io/crates/dtoa-short/0.3.5) |
| option-ext | 0.2.0 | `MPL-2.0` | [crates.io](https://crates.io/crates/option-ext/0.2.0) |
| selectors | 0.24.0 | `MPL-2.0` | [crates.io](https://crates.io/crates/selectors/0.24.0) |

### Historical NeuroVault MIT material

NeuroVault source and assets at tag `v0.6.0` were released under MIT. That
permission is not withdrawn by the later commercial boundary. The original
license is preserved at `LICENSES/NeuroVault-v0.6.0-MIT.txt` and is included
in application resources.

### Native libraries and downloaded models

| Component | Distribution | Declared license | Source |
|---|---|---|---|
| sqlite-vec v0.1.9 | loadable `vec0.dylib` in direct builds; statically linked into the Store executable | MIT OR Apache-2.0; exact texts bundled | https://github.com/asg017/sqlite-vec/tree/v0.1.9 |
| SQLite | linked through the `rusqlite` bundled feature | Public Domain | https://www.sqlite.org/copyright.html |
| ONNX Runtime 1.20.0 | statically linked by `ort-sys 2.0.0-rc.9` as configured by `fastembed` | MIT plus upstream third-party notices; exact files bundled | https://github.com/microsoft/onnxruntime/tree/v1.20.0 |
| BAAI/bge-small-en-v1.5, ONNX conversion by Xenova | exact ONNX/tokenizer payload is bundled in the Store app; direct builds download it on first embedding use | MIT (upstream model card); revision and checksums bundled under `LICENSES/models/` | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| BAAI/bge-reranker-base | excluded from Store v1; direct builds download it only if local reranking is enabled | MIT (model card) | https://huggingface.co/BAAI/bge-reranker-base |

Model files are governed by the terms published with those files. The Store
payload is pinned by revision and SHA-256; direct-build downloads must still be
audited at release time. These entries are not a legal opinion.

## Rust production dependency inventory (612)

License expression summary:

| SPDX expression declared by package | Count |
|---|---:|
| `(Apache-2.0 OR MIT) AND BSD-3-Clause` | 1 |
| `(MIT OR Apache-2.0) AND Unicode-3.0` | 1 |
| `0BSD OR MIT OR Apache-2.0` | 1 |
| `Apache-2.0` | 11 |
| `Apache-2.0 / MIT` | 1 |
| `Apache-2.0 AND ISC` | 1 |
| `Apache-2.0 AND MIT` | 1 |
| `Apache-2.0 OR BSL-1.0` | 1 |
| `Apache-2.0 OR ISC OR MIT` | 3 |
| `Apache-2.0 OR MIT` | 50 |
| `Apache-2.0 OR MIT OR Zlib` | 2 |
| `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | 2 |
| `Apache-2.0/MIT` | 4 |
| `BSD-2-Clause` | 4 |
| `BSD-2-Clause OR Apache-2.0 OR MIT` | 2 |
| `BSD-3-Clause` | 9 |
| `BSD-3-Clause AND MIT` | 1 |
| `BSD-3-Clause OR Apache-2.0` | 2 |
| `BSD-3-Clause/MIT` | 1 |
| `CC0-1.0` | 2 |
| `CC0-1.0 OR Apache-2.0` | 1 |
| `CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception` | 1 |
| `CC0-1.0 OR MIT-0 OR Apache-2.0` | 2 |
| `CDLA-Permissive-2.0` | 2 |
| `ISC` | 5 |
| `MIT` | 162 |
| `MIT / Apache-2.0` | 1 |
| `MIT AND BSD-3-Clause` | 1 |
| `MIT OR Apache-2.0` | 254 |
| `MIT OR Apache-2.0 OR Zlib` | 7 |
| `MIT OR Zlib OR Apache-2.0` | 1 |
| `MIT/Apache-2.0` | 33 |
| `MPL-2.0` | 5 |
| `Unicode-3.0` | 18 |
| `Unlicense OR MIT` | 7 |
| `Unlicense/MIT` | 2 |
| `Zlib OR Apache-2.0 OR MIT` | 10 |

| Crate | Version | Declared license | Package |
|---|---:|---|---|
| adler2 | 2.0.1 | `0BSD OR MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/adler2/2.0.1) |
| ahash | 0.8.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ahash/0.8.12) |
| aho-corasick | 1.1.4 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/aho-corasick/1.1.4) |
| aligned | 0.4.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/aligned/0.4.3) |
| aligned-vec | 0.6.4 | `MIT` | [crates.io](https://crates.io/crates/aligned-vec/0.6.4) |
| alloc-no-stdlib | 2.0.4 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/alloc-no-stdlib/2.0.4) |
| alloc-stdlib | 0.2.2 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/alloc-stdlib/0.2.2) |
| anyhow | 1.0.102 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/anyhow/1.0.102) |
| arg_enum_proc_macro | 0.3.4 | `MIT` | [crates.io](https://crates.io/crates/arg_enum_proc_macro/0.3.4) |
| arrayref | 0.3.9 | `BSD-2-Clause` | [crates.io](https://crates.io/crates/arrayref/0.3.9) |
| arrayvec | 0.7.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/arrayvec/0.7.6) |
| as-slice | 0.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/as-slice/0.2.1) |
| async-broadcast | 0.7.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/async-broadcast/0.7.2) |
| async-channel | 2.5.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-channel/2.5.0) |
| async-executor | 1.14.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-executor/1.14.0) |
| async-io | 2.6.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-io/2.6.0) |
| async-lock | 3.4.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-lock/3.4.2) |
| async-process | 2.5.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-process/2.5.0) |
| async-recursion | 1.1.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/async-recursion/1.1.1) |
| async-signal | 0.2.14 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-signal/0.2.14) |
| async-task | 4.7.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/async-task/4.7.1) |
| async-trait | 0.1.89 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/async-trait/0.1.89) |
| atk | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/atk/0.18.2) |
| atk-sys | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/atk-sys/0.18.2) |
| atomic-waker | 1.1.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/atomic-waker/1.1.2) |
| av-scenechange | 0.14.1 | `MIT` | [crates.io](https://crates.io/crates/av-scenechange/0.14.1) |
| av1-grain | 0.2.5 | `BSD-2-Clause` | [crates.io](https://crates.io/crates/av1-grain/0.2.5) |
| avif-serialize | 0.8.8 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/avif-serialize/0.8.8) |
| axum | 0.7.9 | `MIT` | [crates.io](https://crates.io/crates/axum/0.7.9) |
| axum-core | 0.4.5 | `MIT` | [crates.io](https://crates.io/crates/axum-core/0.4.5) |
| base64 | 0.13.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/base64/0.13.1) |
| base64 | 0.21.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/base64/0.21.7) |
| base64 | 0.22.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/base64/0.22.1) |
| bit_field | 0.10.3 | `Apache-2.0/MIT` | [crates.io](https://crates.io/crates/bit_field/0.10.3) |
| bitflags | 1.3.2 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/bitflags/1.3.2) |
| bitflags | 2.11.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/bitflags/2.11.0) |
| bitstream-io | 4.10.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/bitstream-io/4.10.0) |
| blake3 | 1.8.5 | `CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception` | [crates.io](https://crates.io/crates/blake3/1.8.5) |
| block-buffer | 0.10.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/block-buffer/0.10.4) |
| block2 | 0.6.2 | `MIT` | [crates.io](https://crates.io/crates/block2/0.6.2) |
| blocking | 1.6.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/blocking/1.6.2) |
| brotli | 8.0.2 | `BSD-3-Clause AND MIT` | [crates.io](https://crates.io/crates/brotli/8.0.2) |
| brotli-decompressor | 5.0.0 | `BSD-3-Clause/MIT` | [crates.io](https://crates.io/crates/brotli-decompressor/5.0.0) |
| bstr | 1.12.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/bstr/1.12.1) |
| bumpalo | 3.20.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/bumpalo/3.20.2) |
| bytemuck | 1.25.0 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/bytemuck/1.25.0) |
| byteorder | 1.5.0 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/byteorder/1.5.0) |
| byteorder-lite | 0.1.0 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/byteorder-lite/0.1.0) |
| bytes | 1.11.1 | `MIT` | [crates.io](https://crates.io/crates/bytes/1.11.1) |
| cairo-rs | 0.18.5 | `MIT` | [crates.io](https://crates.io/crates/cairo-rs/0.18.5) |
| cairo-sys-rs | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/cairo-sys-rs/0.18.2) |
| camino | 1.2.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/camino/1.2.2) |
| cargo_metadata | 0.19.2 | `MIT` | [crates.io](https://crates.io/crates/cargo_metadata/0.19.2) |
| cargo-platform | 0.1.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/cargo-platform/0.1.9) |
| castaway | 0.2.4 | `MIT` | [crates.io](https://crates.io/crates/castaway/0.2.4) |
| cfb | 0.7.3 | `MIT` | [crates.io](https://crates.io/crates/cfb/0.7.3) |
| cfg-if | 1.0.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/cfg-if/1.0.4) |
| chacha20 | 0.10.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/chacha20/0.10.1) |
| chrono | 0.4.44 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/chrono/0.4.44) |
| color_quant | 1.1.0 | `MIT` | [crates.io](https://crates.io/crates/color_quant/1.1.0) |
| compact_str | 0.9.0 | `MIT` | [crates.io](https://crates.io/crates/compact_str/0.9.0) |
| concurrent-queue | 2.5.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/concurrent-queue/2.5.0) |
| console | 0.15.11 | `MIT` | [crates.io](https://crates.io/crates/console/0.15.11) |
| const-random | 0.1.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/const-random/0.1.18) |
| const-random-macro | 0.1.16 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/const-random-macro/0.1.16) |
| constant_time_eq | 0.4.2 | `CC0-1.0 OR MIT-0 OR Apache-2.0` | [crates.io](https://crates.io/crates/constant_time_eq/0.4.2) |
| convert_case | 0.4.0 | `MIT` | [crates.io](https://crates.io/crates/convert_case/0.4.0) |
| cookie | 0.18.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/cookie/0.18.1) |
| core-foundation | 0.10.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/core-foundation/0.10.1) |
| core-foundation-sys | 0.8.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/core-foundation-sys/0.8.7) |
| core-graphics | 0.25.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/core-graphics/0.25.0) |
| core-graphics-types | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/core-graphics-types/0.2.0) |
| cpufeatures | 0.2.17 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/cpufeatures/0.2.17) |
| cpufeatures | 0.3.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/cpufeatures/0.3.0) |
| crc32fast | 1.5.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crc32fast/1.5.0) |
| crossbeam-channel | 0.5.15 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crossbeam-channel/0.5.15) |
| crossbeam-deque | 0.8.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crossbeam-deque/0.8.6) |
| crossbeam-epoch | 0.9.20 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crossbeam-epoch/0.9.20) |
| crossbeam-utils | 0.8.21 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crossbeam-utils/0.8.21) |
| crunchy | 0.2.4 | `MIT` | [crates.io](https://crates.io/crates/crunchy/0.2.4) |
| crypto-common | 0.1.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/crypto-common/0.1.7) |
| cssparser | 0.29.6 | `MPL-2.0` | [crates.io](https://crates.io/crates/cssparser/0.29.6) |
| cssparser-macros | 0.6.1 | `MPL-2.0` | [crates.io](https://crates.io/crates/cssparser-macros/0.6.1) |
| ctor | 0.2.9 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/ctor/0.2.9) |
| darling | 0.20.11 | `MIT` | [crates.io](https://crates.io/crates/darling/0.20.11) |
| darling | 0.23.0 | `MIT` | [crates.io](https://crates.io/crates/darling/0.23.0) |
| darling_core | 0.20.11 | `MIT` | [crates.io](https://crates.io/crates/darling_core/0.20.11) |
| darling_core | 0.23.0 | `MIT` | [crates.io](https://crates.io/crates/darling_core/0.23.0) |
| darling_macro | 0.20.11 | `MIT` | [crates.io](https://crates.io/crates/darling_macro/0.20.11) |
| darling_macro | 0.23.0 | `MIT` | [crates.io](https://crates.io/crates/darling_macro/0.23.0) |
| dary_heap | 0.3.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dary_heap/0.3.9) |
| deranged | 0.5.8 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/deranged/0.5.8) |
| derive_builder | 0.20.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/derive_builder/0.20.2) |
| derive_builder_core | 0.20.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/derive_builder_core/0.20.2) |
| derive_builder_macro | 0.20.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/derive_builder_macro/0.20.2) |
| derive_more | 0.99.20 | `MIT` | [crates.io](https://crates.io/crates/derive_more/0.99.20) |
| deunicode | 1.6.2 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/deunicode/1.6.2) |
| digest | 0.10.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/digest/0.10.7) |
| dirs | 6.0.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dirs/6.0.0) |
| dirs-sys | 0.5.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dirs-sys/0.5.0) |
| dispatch2 | 0.3.1 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/dispatch2/0.3.1) |
| displaydoc | 0.2.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/displaydoc/0.2.5) |
| dlopen2 | 0.8.2 | `MIT` | [crates.io](https://crates.io/crates/dlopen2/0.8.2) |
| dlopen2_derive | 0.4.3 | `MIT` | [crates.io](https://crates.io/crates/dlopen2_derive/0.4.3) |
| dlv-list | 0.5.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dlv-list/0.5.2) |
| dpi | 0.1.2 | `Apache-2.0 AND MIT` | [crates.io](https://crates.io/crates/dpi/0.1.2) |
| dtoa | 1.0.11 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dtoa/1.0.11) |
| dtoa-short | 0.3.5 | `MPL-2.0` | [crates.io](https://crates.io/crates/dtoa-short/0.3.5) |
| dunce | 1.0.5 | `CC0-1.0 OR MIT-0 OR Apache-2.0` | [crates.io](https://crates.io/crates/dunce/1.0.5) |
| dyn-clone | 1.0.20 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/dyn-clone/1.0.20) |
| either | 1.15.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/either/1.15.0) |
| embed_plist | 1.2.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/embed_plist/1.2.2) |
| encode_unicode | 1.0.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/encode_unicode/1.0.0) |
| encoding_rs | 0.8.35 | `(Apache-2.0 OR MIT) AND BSD-3-Clause` | [crates.io](https://crates.io/crates/encoding_rs/0.8.35) |
| endi | 1.1.1 | `MIT` | [crates.io](https://crates.io/crates/endi/1.1.1) |
| enumflags2 | 0.7.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/enumflags2/0.7.12) |
| enumflags2_derive | 0.7.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/enumflags2_derive/0.7.12) |
| equator | 0.4.2 | `MIT` | [crates.io](https://crates.io/crates/equator/0.4.2) |
| equator-macro | 0.4.2 | `MIT` | [crates.io](https://crates.io/crates/equator-macro/0.4.2) |
| equivalent | 1.0.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/equivalent/1.0.2) |
| erased-serde | 0.4.10 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/erased-serde/0.4.10) |
| errno | 0.3.14 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/errno/0.3.14) |
| esaxx-rs | 0.1.10 | `Apache-2.0` | [crates.io](https://crates.io/crates/esaxx-rs/0.1.10) |
| event-listener | 5.4.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/event-listener/5.4.1) |
| event-listener-strategy | 0.5.4 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/event-listener-strategy/0.5.4) |
| exr | 1.74.0 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/exr/1.74.0) |
| fallible-iterator | 0.3.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/fallible-iterator/0.3.0) |
| fallible-streaming-iterator | 0.1.9 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/fallible-streaming-iterator/0.1.9) |
| fastembed | 4.9.1 | `Apache-2.0` | [crates.io](https://crates.io/crates/fastembed/4.9.1) |
| fastrand | 2.4.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/fastrand/2.4.1) |
| fax | 0.2.6 | `MIT` | [crates.io](https://crates.io/crates/fax/0.2.6) |
| fax_derive | 0.2.0 | `MIT` | [crates.io](https://crates.io/crates/fax_derive/0.2.0) |
| fdeflate | 0.3.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/fdeflate/0.3.7) |
| field-offset | 0.3.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/field-offset/0.3.6) |
| filetime | 0.2.27 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/filetime/0.2.27) |
| flate2 | 1.1.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/flate2/1.1.9) |
| fnv | 1.0.7 | `Apache-2.0 / MIT` | [crates.io](https://crates.io/crates/fnv/1.0.7) |
| foreign-types | 0.5.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/foreign-types/0.5.0) |
| foreign-types-macros | 0.2.3 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/foreign-types-macros/0.2.3) |
| foreign-types-shared | 0.3.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/foreign-types-shared/0.3.1) |
| form_urlencoded | 1.2.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/form_urlencoded/1.2.2) |
| fsevent-sys | 4.1.0 | `MIT` | [crates.io](https://crates.io/crates/fsevent-sys/4.1.0) |
| futf | 0.1.5 | `MIT / Apache-2.0` | [crates.io](https://crates.io/crates/futf/0.1.5) |
| futures | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures/0.3.32) |
| futures-channel | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-channel/0.3.32) |
| futures-core | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-core/0.3.32) |
| futures-executor | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-executor/0.3.32) |
| futures-io | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-io/0.3.32) |
| futures-lite | 2.6.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/futures-lite/2.6.1) |
| futures-macro | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-macro/0.3.32) |
| futures-sink | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-sink/0.3.32) |
| futures-task | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-task/0.3.32) |
| futures-util | 0.3.32 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/futures-util/0.3.32) |
| fxhash | 0.2.1 | `Apache-2.0/MIT` | [crates.io](https://crates.io/crates/fxhash/0.2.1) |
| gdk | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gdk/0.18.2) |
| gdk-pixbuf | 0.18.5 | `MIT` | [crates.io](https://crates.io/crates/gdk-pixbuf/0.18.5) |
| gdk-pixbuf-sys | 0.18.0 | `MIT` | [crates.io](https://crates.io/crates/gdk-pixbuf-sys/0.18.0) |
| gdk-sys | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gdk-sys/0.18.2) |
| gdkwayland-sys | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gdkwayland-sys/0.18.2) |
| gdkx11 | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gdkx11/0.18.2) |
| gdkx11-sys | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gdkx11-sys/0.18.2) |
| generic-array | 0.14.7 | `MIT` | [crates.io](https://crates.io/crates/generic-array/0.14.7) |
| gethostname | 1.1.0 | `Apache-2.0` | [crates.io](https://crates.io/crates/gethostname/1.1.0) |
| getrandom | 0.2.17 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/getrandom/0.2.17) |
| getrandom | 0.3.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/getrandom/0.3.4) |
| getrandom | 0.4.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/getrandom/0.4.2) |
| gif | 0.14.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/gif/0.14.2) |
| gio | 0.18.4 | `MIT` | [crates.io](https://crates.io/crates/gio/0.18.4) |
| gio-sys | 0.18.1 | `MIT` | [crates.io](https://crates.io/crates/gio-sys/0.18.1) |
| glib | 0.18.5 | `MIT` | [crates.io](https://crates.io/crates/glib/0.18.5) |
| glib-macros | 0.18.5 | `MIT` | [crates.io](https://crates.io/crates/glib-macros/0.18.5) |
| glib-sys | 0.18.1 | `MIT` | [crates.io](https://crates.io/crates/glib-sys/0.18.1) |
| glob | 0.3.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/glob/0.3.3) |
| global-hotkey | 0.7.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/global-hotkey/0.7.0) |
| globset | 0.4.18 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/globset/0.4.18) |
| gobject-sys | 0.18.0 | `MIT` | [crates.io](https://crates.io/crates/gobject-sys/0.18.0) |
| gtk | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gtk/0.18.2) |
| gtk-sys | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gtk-sys/0.18.2) |
| gtk3-macros | 0.18.2 | `MIT` | [crates.io](https://crates.io/crates/gtk3-macros/0.18.2) |
| half | 2.7.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/half/2.7.1) |
| hashbrown | 0.12.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/hashbrown/0.12.3) |
| hashbrown | 0.14.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/hashbrown/0.14.5) |
| hashbrown | 0.17.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/hashbrown/0.17.0) |
| hashlink | 0.9.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/hashlink/0.9.1) |
| heck | 0.4.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/heck/0.4.1) |
| heck | 0.5.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/heck/0.5.0) |
| hex | 0.4.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/hex/0.4.3) |
| hf-hub | 0.4.3 | `Apache-2.0` | [crates.io](https://crates.io/crates/hf-hub/0.4.3) |
| html5ever | 0.29.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/html5ever/0.29.1) |
| http | 1.4.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/http/1.4.0) |
| http-body | 1.0.1 | `MIT` | [crates.io](https://crates.io/crates/http-body/1.0.1) |
| http-body-util | 0.1.3 | `MIT` | [crates.io](https://crates.io/crates/http-body-util/0.1.3) |
| httparse | 1.10.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/httparse/1.10.1) |
| httpdate | 1.0.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/httpdate/1.0.3) |
| hyper | 1.9.0 | `MIT` | [crates.io](https://crates.io/crates/hyper/1.9.0) |
| hyper-rustls | 0.27.9 | `Apache-2.0 OR ISC OR MIT` | [crates.io](https://crates.io/crates/hyper-rustls/0.27.9) |
| hyper-util | 0.1.20 | `MIT` | [crates.io](https://crates.io/crates/hyper-util/0.1.20) |
| iana-time-zone | 0.1.65 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/iana-time-zone/0.1.65) |
| ico | 0.5.0 | `MIT` | [crates.io](https://crates.io/crates/ico/0.5.0) |
| icu_collections | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_collections/2.2.0) |
| icu_locale_core | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_locale_core/2.2.0) |
| icu_normalizer | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_normalizer/2.2.0) |
| icu_normalizer_data | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_normalizer_data/2.2.0) |
| icu_properties | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_properties/2.2.0) |
| icu_properties_data | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_properties_data/2.2.0) |
| icu_provider | 2.2.0 | `Unicode-3.0` | [crates.io](https://crates.io/crates/icu_provider/2.2.0) |
| ident_case | 1.0.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/ident_case/1.0.1) |
| idna | 1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/idna/1.1.0) |
| idna_adapter | 1.2.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/idna_adapter/1.2.1) |
| ignore | 0.4.26 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/ignore/0.4.26) |
| image | 0.25.10 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/image/0.25.10) |
| image-webp | 0.2.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/image-webp/0.2.4) |
| imgref | 1.12.0 | `CC0-1.0 OR Apache-2.0` | [crates.io](https://crates.io/crates/imgref/1.12.0) |
| indexmap | 1.9.3 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/indexmap/1.9.3) |
| indexmap | 2.14.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/indexmap/2.14.0) |
| indicatif | 0.17.11 | `MIT` | [crates.io](https://crates.io/crates/indicatif/0.17.11) |
| infer | 0.19.0 | `MIT` | [crates.io](https://crates.io/crates/infer/0.19.0) |
| inotify | 0.9.6 | `ISC` | [crates.io](https://crates.io/crates/inotify/0.9.6) |
| inotify-sys | 0.1.5 | `ISC` | [crates.io](https://crates.io/crates/inotify-sys/0.1.5) |
| ipnet | 2.12.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ipnet/2.12.0) |
| iri-string | 0.7.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/iri-string/0.7.12) |
| is-docker | 0.2.0 | `MIT` | [crates.io](https://crates.io/crates/is-docker/0.2.0) |
| is-wsl | 0.4.0 | `MIT` | [crates.io](https://crates.io/crates/is-wsl/0.4.0) |
| itertools | 0.14.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/itertools/0.14.0) |
| itoa | 1.0.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/itoa/1.0.18) |
| javascriptcore-rs | 1.1.2 | `MIT` | [crates.io](https://crates.io/crates/javascriptcore-rs/1.1.2) |
| javascriptcore-rs-sys | 1.1.1 | `MIT` | [crates.io](https://crates.io/crates/javascriptcore-rs-sys/1.1.1) |
| json-patch | 3.0.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/json-patch/3.0.1) |
| jsonptr | 0.6.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/jsonptr/0.6.3) |
| keyboard-types | 0.7.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/keyboard-types/0.7.0) |
| kuchikiki | 0.8.8-speedreader | `MIT` | [crates.io](https://crates.io/crates/kuchikiki/0.8.8-speedreader) |
| lebe | 0.5.3 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/lebe/0.5.3) |
| libappindicator | 0.9.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/libappindicator/0.9.0) |
| libappindicator-sys | 0.9.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/libappindicator-sys/0.9.0) |
| libc | 0.2.184 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/libc/0.2.184) |
| libloading | 0.7.4 | `ISC` | [crates.io](https://crates.io/crates/libloading/0.7.4) |
| libsqlite3-sys | 0.30.1 | `MIT` | [crates.io](https://crates.io/crates/libsqlite3-sys/0.30.1) |
| linux-raw-sys | 0.12.1 | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/linux-raw-sys/0.12.1) |
| litemap | 0.8.2 | `Unicode-3.0` | [crates.io](https://crates.io/crates/litemap/0.8.2) |
| lock_api | 0.4.14 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/lock_api/0.4.14) |
| log | 0.4.29 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/log/0.4.29) |
| loop9 | 0.1.5 | `MIT` | [crates.io](https://crates.io/crates/loop9/0.1.5) |
| lru-slab | 0.1.2 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/lru-slab/0.1.2) |
| mac | 0.1.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/mac/0.1.1) |
| macro_rules_attribute | 0.2.2 | `Apache-2.0 OR MIT OR Zlib` | [crates.io](https://crates.io/crates/macro_rules_attribute/0.2.2) |
| macro_rules_attribute-proc_macro | 0.2.2 | `Apache-2.0 OR MIT OR Zlib` | [crates.io](https://crates.io/crates/macro_rules_attribute-proc_macro/0.2.2) |
| markup5ever | 0.14.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/markup5ever/0.14.1) |
| match_token | 0.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/match_token/0.1.0) |
| matches | 0.1.10 | `MIT` | [crates.io](https://crates.io/crates/matches/0.1.10) |
| matchit | 0.7.3 | `MIT AND BSD-3-Clause` | [crates.io](https://crates.io/crates/matchit/0.7.3) |
| matrixmultiply | 0.3.10 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/matrixmultiply/0.3.10) |
| maybe-rayon | 0.1.1 | `MIT` | [crates.io](https://crates.io/crates/maybe-rayon/0.1.1) |
| memchr | 2.8.0 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/memchr/2.8.0) |
| memoffset | 0.9.1 | `MIT` | [crates.io](https://crates.io/crates/memoffset/0.9.1) |
| mime | 0.3.17 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/mime/0.3.17) |
| minimal-lexical | 0.2.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/minimal-lexical/0.2.1) |
| minisign-verify | 0.2.5 | `MIT` | [crates.io](https://crates.io/crates/minisign-verify/0.2.5) |
| miniz_oxide | 0.8.9 | `MIT OR Zlib OR Apache-2.0` | [crates.io](https://crates.io/crates/miniz_oxide/0.8.9) |
| mio | 0.8.11 | `MIT` | [crates.io](https://crates.io/crates/mio/0.8.11) |
| mio | 1.2.0 | `MIT` | [crates.io](https://crates.io/crates/mio/1.2.0) |
| monostate | 0.1.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/monostate/0.1.18) |
| monostate-impl | 0.1.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/monostate-impl/0.1.18) |
| moxcms | 0.8.1 | `BSD-3-Clause OR Apache-2.0` | [crates.io](https://crates.io/crates/moxcms/0.8.1) |
| muda | 0.17.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/muda/0.17.2) |
| ndarray | 0.16.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ndarray/0.16.1) |
| netstat2 | 0.9.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/netstat2/0.9.1) |
| new_debug_unreachable | 1.0.6 | `MIT` | [crates.io](https://crates.io/crates/new_debug_unreachable/1.0.6) |
| no_std_io2 | 0.9.3 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/no_std_io2/0.9.3) |
| nodrop | 0.1.14 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/nodrop/0.1.14) |
| nom | 7.1.3 | `MIT` | [crates.io](https://crates.io/crates/nom/7.1.3) |
| nom | 8.0.0 | `MIT` | [crates.io](https://crates.io/crates/nom/8.0.0) |
| noop_proc_macro | 0.3.0 | `MIT` | [crates.io](https://crates.io/crates/noop_proc_macro/0.3.0) |
| notify | 6.1.1 | `CC0-1.0` | [crates.io](https://crates.io/crates/notify/6.1.1) |
| ntapi | 0.4.3 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/ntapi/0.4.3) |
| num-bigint | 0.4.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-bigint/0.4.6) |
| num-complex | 0.4.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-complex/0.4.6) |
| num-conv | 0.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-conv/0.2.1) |
| num-derive | 0.3.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-derive/0.3.3) |
| num-derive | 0.4.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-derive/0.4.2) |
| num-integer | 0.1.46 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-integer/0.1.46) |
| num-rational | 0.4.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-rational/0.4.2) |
| num-traits | 0.2.19 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/num-traits/0.2.19) |
| number_prefix | 0.4.0 | `MIT` | [crates.io](https://crates.io/crates/number_prefix/0.4.0) |
| objc2 | 0.6.4 | `MIT` | [crates.io](https://crates.io/crates/objc2/0.6.4) |
| objc2-app-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-app-kit/0.3.2) |
| objc2-core-foundation | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-core-foundation/0.3.2) |
| objc2-core-graphics | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-core-graphics/0.3.2) |
| objc2-encode | 4.1.0 | `MIT` | [crates.io](https://crates.io/crates/objc2-encode/4.1.0) |
| objc2-exception-helper | 0.1.1 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-exception-helper/0.1.1) |
| objc2-foundation | 0.3.2 | `MIT` | [crates.io](https://crates.io/crates/objc2-foundation/0.3.2) |
| objc2-io-surface | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-io-surface/0.3.2) |
| objc2-osa-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-osa-kit/0.3.2) |
| objc2-web-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/objc2-web-kit/0.3.2) |
| once_cell | 1.21.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/once_cell/1.21.4) |
| onig | 6.5.1 | `MIT` | [crates.io](https://crates.io/crates/onig/6.5.1) |
| onig_sys | 69.9.1 | `MIT` | [crates.io](https://crates.io/crates/onig_sys/69.9.1) |
| open | 5.3.3 | `MIT` | [crates.io](https://crates.io/crates/open/5.3.3) |
| openssl-probe | 0.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/openssl-probe/0.2.1) |
| option-ext | 0.2.0 | `MPL-2.0` | [crates.io](https://crates.io/crates/option-ext/0.2.0) |
| ordered-multimap | 0.7.3 | `MIT` | [crates.io](https://crates.io/crates/ordered-multimap/0.7.3) |
| ordered-stream | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ordered-stream/0.2.0) |
| ort | 2.0.0-rc.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ort/2.0.0-rc.9) |
| ort-sys | 2.0.0-rc.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ort-sys/2.0.0-rc.9) |
| os_pipe | 1.2.3 | `MIT` | [crates.io](https://crates.io/crates/os_pipe/1.2.3) |
| osakit | 0.3.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/osakit/0.3.1) |
| pango | 0.18.3 | `MIT` | [crates.io](https://crates.io/crates/pango/0.18.3) |
| pango-sys | 0.18.0 | `MIT` | [crates.io](https://crates.io/crates/pango-sys/0.18.0) |
| parking | 2.2.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/parking/2.2.1) |
| parking_lot | 0.12.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/parking_lot/0.12.5) |
| parking_lot_core | 0.9.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/parking_lot_core/0.9.12) |
| paste | 1.0.15 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/paste/1.0.15) |
| pastey | 0.1.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/pastey/0.1.1) |
| pastey | 0.2.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/pastey/0.2.3) |
| pathdiff | 0.2.3 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/pathdiff/0.2.3) |
| percent-encoding | 2.3.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/percent-encoding/2.3.2) |
| phf | 0.10.1 | `MIT` | [crates.io](https://crates.io/crates/phf/0.10.1) |
| phf | 0.11.3 | `MIT` | [crates.io](https://crates.io/crates/phf/0.11.3) |
| phf | 0.8.0 | `MIT` | [crates.io](https://crates.io/crates/phf/0.8.0) |
| phf_generator | 0.10.0 | `MIT` | [crates.io](https://crates.io/crates/phf_generator/0.10.0) |
| phf_generator | 0.11.3 | `MIT` | [crates.io](https://crates.io/crates/phf_generator/0.11.3) |
| phf_macros | 0.10.0 | `MIT` | [crates.io](https://crates.io/crates/phf_macros/0.10.0) |
| phf_macros | 0.11.3 | `MIT` | [crates.io](https://crates.io/crates/phf_macros/0.11.3) |
| phf_shared | 0.10.0 | `MIT` | [crates.io](https://crates.io/crates/phf_shared/0.10.0) |
| phf_shared | 0.11.3 | `MIT` | [crates.io](https://crates.io/crates/phf_shared/0.11.3) |
| phf_shared | 0.8.0 | `MIT` | [crates.io](https://crates.io/crates/phf_shared/0.8.0) |
| pin-project-lite | 0.2.17 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/pin-project-lite/0.2.17) |
| piper | 0.2.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/piper/0.2.5) |
| plist | 1.8.0 | `MIT` | [crates.io](https://crates.io/crates/plist/1.8.0) |
| png | 0.17.16 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/png/0.17.16) |
| png | 0.18.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/png/0.18.1) |
| polling | 3.11.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/polling/3.11.0) |
| portable-atomic | 1.13.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/portable-atomic/1.13.1) |
| potential_utf | 0.1.5 | `Unicode-3.0` | [crates.io](https://crates.io/crates/potential_utf/0.1.5) |
| powerfmt | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/powerfmt/0.2.0) |
| ppv-lite86 | 0.2.21 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ppv-lite86/0.2.21) |
| precomputed-hash | 0.1.1 | `MIT` | [crates.io](https://crates.io/crates/precomputed-hash/0.1.1) |
| proc-macro-crate | 1.3.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-crate/1.3.1) |
| proc-macro-crate | 2.0.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-crate/2.0.2) |
| proc-macro-crate | 3.5.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-crate/3.5.0) |
| proc-macro-error | 1.0.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-error/1.0.4) |
| proc-macro-error-attr | 1.0.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-error-attr/1.0.4) |
| proc-macro-hack | 0.5.20+deprecated | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro-hack/0.5.20+deprecated) |
| proc-macro2 | 1.0.106 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/proc-macro2/1.0.106) |
| profiling | 1.0.17 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/profiling/1.0.17) |
| profiling-procmacros | 1.0.17 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/profiling-procmacros/1.0.17) |
| pxfm | 0.1.29 | `BSD-3-Clause OR Apache-2.0` | [crates.io](https://crates.io/crates/pxfm/0.1.29) |
| qoi | 0.4.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/qoi/0.4.1) |
| quick-error | 2.0.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/quick-error/2.0.1) |
| quick-xml | 0.38.4 | `MIT` | [crates.io](https://crates.io/crates/quick-xml/0.38.4) |
| quinn | 0.11.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/quinn/0.11.9) |
| quinn-proto | 0.11.16 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/quinn-proto/0.11.16) |
| quinn-udp | 0.5.14 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/quinn-udp/0.5.14) |
| quote | 1.0.45 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/quote/1.0.45) |
| rand | 0.10.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand/0.10.2) |
| rand | 0.8.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand/0.8.5) |
| rand | 0.9.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand/0.9.4) |
| rand_chacha | 0.3.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_chacha/0.3.1) |
| rand_chacha | 0.9.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_chacha/0.9.0) |
| rand_core | 0.10.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_core/0.10.1) |
| rand_core | 0.6.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_core/0.6.4) |
| rand_core | 0.9.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_core/0.9.5) |
| rand_pcg | 0.10.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rand_pcg/0.10.2) |
| rav1e | 0.8.1 | `BSD-2-Clause` | [crates.io](https://crates.io/crates/rav1e/0.8.1) |
| ravif | 0.13.0 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/ravif/0.13.0) |
| raw-window-handle | 0.6.2 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/raw-window-handle/0.6.2) |
| rawpointer | 0.2.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/rawpointer/0.2.1) |
| rayon | 1.12.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rayon/1.12.0) |
| rayon-cond | 0.4.0 | `Apache-2.0/MIT` | [crates.io](https://crates.io/crates/rayon-cond/0.4.0) |
| rayon-core | 1.13.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rayon-core/1.13.0) |
| ref-cast | 1.0.25 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ref-cast/1.0.25) |
| ref-cast-impl | 1.0.25 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ref-cast-impl/1.0.25) |
| regex | 1.12.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/regex/1.12.3) |
| regex-automata | 0.4.14 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/regex-automata/0.4.14) |
| regex-syntax | 0.8.10 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/regex-syntax/0.8.10) |
| reqwest | 0.12.28 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/reqwest/0.12.28) |
| reqwest | 0.13.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/reqwest/0.13.2) |
| rfd | 0.16.0 | `MIT` | [crates.io](https://crates.io/crates/rfd/0.16.0) |
| rgb | 0.8.53 | `MIT` | [crates.io](https://crates.io/crates/rgb/0.8.53) |
| ring | 0.17.14 | `Apache-2.0 AND ISC` | [crates.io](https://crates.io/crates/ring/0.17.14) |
| rmcp | 1.7.0 | `Apache-2.0` | [crates.io](https://crates.io/crates/rmcp/1.7.0) |
| rmcp-macros | 1.7.0 | `Apache-2.0` | [crates.io](https://crates.io/crates/rmcp-macros/1.7.0) |
| rusqlite | 0.32.1 | `MIT` | [crates.io](https://crates.io/crates/rusqlite/0.32.1) |
| rust-ini | 0.21.3 | `MIT` | [crates.io](https://crates.io/crates/rust-ini/0.21.3) |
| rustc-hash | 2.1.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/rustc-hash/2.1.2) |
| rustix | 1.1.4 | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/rustix/1.1.4) |
| rustls | 0.23.38 | `Apache-2.0 OR ISC OR MIT` | [crates.io](https://crates.io/crates/rustls/0.23.38) |
| rustls-native-certs | 0.8.3 | `Apache-2.0 OR ISC OR MIT` | [crates.io](https://crates.io/crates/rustls-native-certs/0.8.3) |
| rustls-pki-types | 1.14.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rustls-pki-types/1.14.0) |
| rustls-platform-verifier | 0.6.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rustls-platform-verifier/0.6.2) |
| rustls-webpki | 0.103.13 | `ISC` | [crates.io](https://crates.io/crates/rustls-webpki/0.103.13) |
| rustversion | 1.0.22 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/rustversion/1.0.22) |
| ryu | 1.0.23 | `Apache-2.0 OR BSL-1.0` | [crates.io](https://crates.io/crates/ryu/1.0.23) |
| same-file | 1.0.6 | `Unlicense/MIT` | [crates.io](https://crates.io/crates/same-file/1.0.6) |
| schemars | 0.8.22 | `MIT` | [crates.io](https://crates.io/crates/schemars/0.8.22) |
| schemars | 0.9.0 | `MIT` | [crates.io](https://crates.io/crates/schemars/0.9.0) |
| schemars | 1.2.1 | `MIT` | [crates.io](https://crates.io/crates/schemars/1.2.1) |
| schemars_derive | 0.8.22 | `MIT` | [crates.io](https://crates.io/crates/schemars_derive/0.8.22) |
| schemars_derive | 1.2.1 | `MIT` | [crates.io](https://crates.io/crates/schemars_derive/1.2.1) |
| scopeguard | 1.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/scopeguard/1.2.0) |
| security-framework | 3.7.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/security-framework/3.7.0) |
| security-framework-sys | 2.17.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/security-framework-sys/2.17.0) |
| selectors | 0.24.0 | `MPL-2.0` | [crates.io](https://crates.io/crates/selectors/0.24.0) |
| semver | 1.0.28 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/semver/1.0.28) |
| serde | 1.0.228 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde/1.0.228) |
| serde_core | 1.0.228 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_core/1.0.228) |
| serde_derive | 1.0.228 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_derive/1.0.228) |
| serde_derive_internals | 0.29.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_derive_internals/0.29.1) |
| serde_json | 1.0.149 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_json/1.0.149) |
| serde_path_to_error | 0.1.20 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_path_to_error/0.1.20) |
| serde_repr | 0.1.20 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_repr/0.1.20) |
| serde_spanned | 0.6.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_spanned/0.6.9) |
| serde_spanned | 1.1.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_spanned/1.1.1) |
| serde_urlencoded | 0.7.1 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/serde_urlencoded/0.7.1) |
| serde_with | 3.18.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_with/3.18.0) |
| serde_with_macros | 3.18.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde_with_macros/3.18.0) |
| serde-untagged | 0.1.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serde-untagged/0.1.9) |
| serialize-to-javascript | 0.1.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serialize-to-javascript/0.1.2) |
| serialize-to-javascript-impl | 0.1.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/serialize-to-javascript-impl/0.1.2) |
| servo_arc | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/servo_arc/0.2.0) |
| sha1_smol | 1.0.1 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/sha1_smol/1.0.1) |
| sha2 | 0.10.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/sha2/0.10.9) |
| shared_child | 1.1.1 | `MIT` | [crates.io](https://crates.io/crates/shared_child/1.1.1) |
| sigchld | 0.2.4 | `MIT` | [crates.io](https://crates.io/crates/sigchld/0.2.4) |
| signal-hook | 0.3.18 | `Apache-2.0/MIT` | [crates.io](https://crates.io/crates/signal-hook/0.3.18) |
| signal-hook-registry | 1.4.8 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/signal-hook-registry/1.4.8) |
| simd_helpers | 0.1.0 | `MIT` | [crates.io](https://crates.io/crates/simd_helpers/0.1.0) |
| simd-adler32 | 0.3.9 | `MIT` | [crates.io](https://crates.io/crates/simd-adler32/0.3.9) |
| siphasher | 0.3.11 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/siphasher/0.3.11) |
| siphasher | 1.0.2 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/siphasher/1.0.2) |
| slab | 0.4.12 | `MIT` | [crates.io](https://crates.io/crates/slab/0.4.12) |
| slug | 0.1.6 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/slug/0.1.6) |
| smallvec | 1.15.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/smallvec/1.15.1) |
| socket2 | 0.6.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/socket2/0.6.3) |
| socks | 0.3.4 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/socks/0.3.4) |
| softbuffer | 0.4.8 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/softbuffer/0.4.8) |
| soup3 | 0.5.0 | `MIT` | [crates.io](https://crates.io/crates/soup3/0.5.0) |
| soup3-sys | 0.5.0 | `MIT` | [crates.io](https://crates.io/crates/soup3-sys/0.5.0) |
| spm_precompiled | 0.1.4 | `Apache-2.0` | [crates.io](https://crates.io/crates/spm_precompiled/0.1.4) |
| sqlite-vec | 0.1.9 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/sqlite-vec/0.1.9) |
| stable_deref_trait | 1.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/stable_deref_trait/1.2.1) |
| static_assertions | 1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/static_assertions/1.1.0) |
| streaming-iterator | 0.1.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/streaming-iterator/0.1.9) |
| string_cache | 0.8.9 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/string_cache/0.8.9) |
| strsim | 0.11.1 | `MIT` | [crates.io](https://crates.io/crates/strsim/0.11.1) |
| subtle | 2.6.1 | `BSD-3-Clause` | [crates.io](https://crates.io/crates/subtle/2.6.1) |
| swift-rs | 1.0.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/swift-rs/1.0.7) |
| syn | 1.0.109 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/syn/1.0.109) |
| syn | 2.0.117 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/syn/2.0.117) |
| sync_wrapper | 1.0.2 | `Apache-2.0` | [crates.io](https://crates.io/crates/sync_wrapper/1.0.2) |
| synstructure | 0.13.2 | `MIT` | [crates.io](https://crates.io/crates/synstructure/0.13.2) |
| sysinfo | 0.30.13 | `MIT` | [crates.io](https://crates.io/crates/sysinfo/0.30.13) |
| tao | 0.34.8 | `Apache-2.0` | [crates.io](https://crates.io/crates/tao/0.34.8) |
| tar | 0.4.45 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/tar/0.4.45) |
| tauri | 2.10.3 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri/2.10.3) |
| tauri-codegen | 2.5.5 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-codegen/2.5.5) |
| tauri-macros | 2.5.5 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-macros/2.5.5) |
| tauri-plugin-deep-link | 2.4.7 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-deep-link/2.4.7) |
| tauri-plugin-dialog | 2.7.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-dialog/2.7.0) |
| tauri-plugin-fs | 2.5.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-fs/2.5.0) |
| tauri-plugin-global-shortcut | 2.3.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-global-shortcut/2.3.1) |
| tauri-plugin-process | 2.3.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-process/2.3.1) |
| tauri-plugin-shell | 2.3.5 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-shell/2.3.5) |
| tauri-plugin-single-instance | 2.4.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-single-instance/2.4.0) |
| tauri-plugin-updater | 2.10.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-plugin-updater/2.10.1) |
| tauri-runtime | 2.10.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-runtime/2.10.1) |
| tauri-runtime-wry | 2.10.1 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-runtime-wry/2.10.1) |
| tauri-utils | 2.8.3 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tauri-utils/2.8.3) |
| tempfile | 3.27.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/tempfile/3.27.0) |
| tendril | 0.4.3 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/tendril/0.4.3) |
| thiserror | 1.0.69 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/thiserror/1.0.69) |
| thiserror | 2.0.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/thiserror/2.0.18) |
| thiserror-impl | 1.0.69 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/thiserror-impl/1.0.69) |
| thiserror-impl | 2.0.18 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/thiserror-impl/2.0.18) |
| tiff | 0.11.3 | `MIT` | [crates.io](https://crates.io/crates/tiff/0.11.3) |
| time | 0.3.47 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/time/0.3.47) |
| time-core | 0.1.8 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/time-core/0.1.8) |
| time-macros | 0.2.27 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/time-macros/0.2.27) |
| tiny-keccak | 2.0.2 | `CC0-1.0` | [crates.io](https://crates.io/crates/tiny-keccak/2.0.2) |
| tinystr | 0.8.3 | `Unicode-3.0` | [crates.io](https://crates.io/crates/tinystr/0.8.3) |
| tinyvec | 1.11.0 | `Zlib OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/tinyvec/1.11.0) |
| tinyvec_macros | 0.1.1 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/tinyvec_macros/0.1.1) |
| tokenizers | 0.21.4 | `Apache-2.0` | [crates.io](https://crates.io/crates/tokenizers/0.21.4) |
| tokio | 1.51.1 | `MIT` | [crates.io](https://crates.io/crates/tokio/1.51.1) |
| tokio-macros | 2.7.0 | `MIT` | [crates.io](https://crates.io/crates/tokio-macros/2.7.0) |
| tokio-rustls | 0.26.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/tokio-rustls/0.26.4) |
| tokio-util | 0.7.18 | `MIT` | [crates.io](https://crates.io/crates/tokio-util/0.7.18) |
| toml | 0.9.12+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml/0.9.12+spec-1.1.0) |
| toml_datetime | 0.6.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_datetime/0.6.3) |
| toml_datetime | 0.7.5+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_datetime/0.7.5+spec-1.1.0) |
| toml_datetime | 1.1.1+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_datetime/1.1.1+spec-1.1.0) |
| toml_edit | 0.19.15 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_edit/0.19.15) |
| toml_edit | 0.20.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_edit/0.20.2) |
| toml_edit | 0.25.11+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_edit/0.25.11+spec-1.1.0) |
| toml_parser | 1.1.2+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_parser/1.1.2+spec-1.1.0) |
| toml_writer | 1.1.1+spec-1.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/toml_writer/1.1.1+spec-1.1.0) |
| tower | 0.5.3 | `MIT` | [crates.io](https://crates.io/crates/tower/0.5.3) |
| tower-http | 0.5.2 | `MIT` | [crates.io](https://crates.io/crates/tower-http/0.5.2) |
| tower-http | 0.6.8 | `MIT` | [crates.io](https://crates.io/crates/tower-http/0.6.8) |
| tower-layer | 0.3.3 | `MIT` | [crates.io](https://crates.io/crates/tower-layer/0.3.3) |
| tower-service | 0.3.3 | `MIT` | [crates.io](https://crates.io/crates/tower-service/0.3.3) |
| tracing | 0.1.44 | `MIT` | [crates.io](https://crates.io/crates/tracing/0.1.44) |
| tracing-attributes | 0.1.31 | `MIT` | [crates.io](https://crates.io/crates/tracing-attributes/0.1.31) |
| tracing-core | 0.1.36 | `MIT` | [crates.io](https://crates.io/crates/tracing-core/0.1.36) |
| tray-icon | 0.21.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/tray-icon/0.21.3) |
| tree-sitter | 0.24.7 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter/0.24.7) |
| tree-sitter-c-sharp | 0.23.1 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-c-sharp/0.23.1) |
| tree-sitter-go | 0.23.4 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-go/0.23.4) |
| tree-sitter-java | 0.23.5 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-java/0.23.5) |
| tree-sitter-language | 0.1.7 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-language/0.1.7) |
| tree-sitter-python | 0.23.6 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-python/0.23.6) |
| tree-sitter-ruby | 0.23.1 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-ruby/0.23.1) |
| tree-sitter-rust | 0.23.3 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-rust/0.23.3) |
| tree-sitter-typescript | 0.23.2 | `MIT` | [crates.io](https://crates.io/crates/tree-sitter-typescript/0.23.2) |
| try-lock | 0.2.5 | `MIT` | [crates.io](https://crates.io/crates/try-lock/0.2.5) |
| typeid | 1.0.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/typeid/1.0.3) |
| typenum | 1.19.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/typenum/1.19.0) |
| unic-char-property | 0.9.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unic-char-property/0.9.0) |
| unic-char-range | 0.9.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unic-char-range/0.9.0) |
| unic-common | 0.9.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unic-common/0.9.0) |
| unic-ucd-ident | 0.9.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unic-ucd-ident/0.9.0) |
| unic-ucd-version | 0.9.0 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unic-ucd-version/0.9.0) |
| unicode_categories | 0.1.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/unicode_categories/0.1.1) |
| unicode-ident | 1.0.24 | `(MIT OR Apache-2.0) AND Unicode-3.0` | [crates.io](https://crates.io/crates/unicode-ident/1.0.24) |
| unicode-normalization-alignments | 0.1.12 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/unicode-normalization-alignments/0.1.12) |
| unicode-segmentation | 1.13.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/unicode-segmentation/1.13.2) |
| unicode-width | 0.2.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/unicode-width/0.2.2) |
| untrusted | 0.9.0 | `ISC` | [crates.io](https://crates.io/crates/untrusted/0.9.0) |
| ureq | 2.12.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/ureq/2.12.1) |
| url | 2.5.8 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/url/2.5.8) |
| urlpattern | 0.3.0 | `MIT` | [crates.io](https://crates.io/crates/urlpattern/0.3.0) |
| utf-8 | 0.7.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/utf-8/0.7.6) |
| utf8_iter | 1.0.4 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/utf8_iter/1.0.4) |
| uuid | 1.23.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/uuid/1.23.0) |
| v_frame | 0.3.9 | `BSD-2-Clause` | [crates.io](https://crates.io/crates/v_frame/0.3.9) |
| walkdir | 2.5.0 | `Unlicense/MIT` | [crates.io](https://crates.io/crates/walkdir/2.5.0) |
| want | 0.3.1 | `MIT` | [crates.io](https://crates.io/crates/want/0.3.1) |
| wasm-bindgen | 0.2.118 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/wasm-bindgen/0.2.118) |
| wasm-bindgen-macro | 0.2.118 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/wasm-bindgen-macro/0.2.118) |
| wasm-bindgen-macro-support | 0.2.118 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/wasm-bindgen-macro-support/0.2.118) |
| wasm-bindgen-shared | 0.2.118 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/wasm-bindgen-shared/0.2.118) |
| webkit2gtk | 2.0.2 | `MIT` | [crates.io](https://crates.io/crates/webkit2gtk/2.0.2) |
| webkit2gtk-sys | 2.0.2 | `MIT` | [crates.io](https://crates.io/crates/webkit2gtk-sys/2.0.2) |
| webpki-roots | 0.26.11 | `CDLA-Permissive-2.0` | [crates.io](https://crates.io/crates/webpki-roots/0.26.11) |
| webpki-roots | 1.0.7 | `CDLA-Permissive-2.0` | [crates.io](https://crates.io/crates/webpki-roots/1.0.7) |
| webview2-com | 0.38.2 | `MIT` | [crates.io](https://crates.io/crates/webview2-com/0.38.2) |
| webview2-com-macros | 0.8.1 | `MIT` | [crates.io](https://crates.io/crates/webview2-com-macros/0.8.1) |
| webview2-com-sys | 0.38.2 | `MIT` | [crates.io](https://crates.io/crates/webview2-com-sys/0.38.2) |
| weezl | 0.1.12 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/weezl/0.1.12) |
| winapi | 0.3.9 | `MIT/Apache-2.0` | [crates.io](https://crates.io/crates/winapi/0.3.9) |
| winapi-util | 0.1.11 | `Unlicense OR MIT` | [crates.io](https://crates.io/crates/winapi-util/0.1.11) |
| window-vibrancy | 0.6.0 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/window-vibrancy/0.6.0) |
| windows | 0.52.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows/0.52.0) |
| windows | 0.61.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows/0.61.3) |
| windows_x86_64_msvc | 0.48.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows_x86_64_msvc/0.48.5) |
| windows_x86_64_msvc | 0.52.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows_x86_64_msvc/0.52.6) |
| windows_x86_64_msvc | 0.53.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows_x86_64_msvc/0.53.1) |
| windows-collections | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-collections/0.2.0) |
| windows-core | 0.52.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-core/0.52.0) |
| windows-core | 0.61.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-core/0.61.2) |
| windows-future | 0.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-future/0.2.1) |
| windows-implement | 0.60.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-implement/0.60.2) |
| windows-interface | 0.59.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-interface/0.59.3) |
| windows-link | 0.1.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-link/0.1.3) |
| windows-link | 0.2.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-link/0.2.1) |
| windows-numerics | 0.2.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-numerics/0.2.0) |
| windows-registry | 0.5.3 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-registry/0.5.3) |
| windows-result | 0.3.4 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-result/0.3.4) |
| windows-strings | 0.4.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-strings/0.4.2) |
| windows-sys | 0.48.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-sys/0.48.0) |
| windows-sys | 0.59.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-sys/0.59.0) |
| windows-sys | 0.60.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-sys/0.60.2) |
| windows-sys | 0.61.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-sys/0.61.2) |
| windows-targets | 0.48.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-targets/0.48.5) |
| windows-targets | 0.52.6 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-targets/0.52.6) |
| windows-targets | 0.53.5 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-targets/0.53.5) |
| windows-threading | 0.1.0 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-threading/0.1.0) |
| windows-version | 0.1.7 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/windows-version/0.1.7) |
| winnow | 0.5.40 | `MIT` | [crates.io](https://crates.io/crates/winnow/0.5.40) |
| winnow | 0.7.15 | `MIT` | [crates.io](https://crates.io/crates/winnow/0.7.15) |
| winnow | 1.0.1 | `MIT` | [crates.io](https://crates.io/crates/winnow/1.0.1) |
| writeable | 0.6.3 | `Unicode-3.0` | [crates.io](https://crates.io/crates/writeable/0.6.3) |
| wry | 0.54.4 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/wry/0.54.4) |
| x11 | 2.21.0 | `MIT` | [crates.io](https://crates.io/crates/x11/2.21.0) |
| x11-dl | 2.21.0 | `MIT` | [crates.io](https://crates.io/crates/x11-dl/2.21.0) |
| x11rb | 0.13.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/x11rb/0.13.2) |
| x11rb-protocol | 0.13.2 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/x11rb-protocol/0.13.2) |
| xattr | 1.6.1 | `MIT OR Apache-2.0` | [crates.io](https://crates.io/crates/xattr/1.6.1) |
| xkeysym | 0.2.1 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/xkeysym/0.2.1) |
| y4m | 0.8.0 | `MIT` | [crates.io](https://crates.io/crates/y4m/0.8.0) |
| yoke | 0.8.2 | `Unicode-3.0` | [crates.io](https://crates.io/crates/yoke/0.8.2) |
| yoke-derive | 0.8.2 | `Unicode-3.0` | [crates.io](https://crates.io/crates/yoke-derive/0.8.2) |
| zbus | 5.14.0 | `MIT` | [crates.io](https://crates.io/crates/zbus/5.14.0) |
| zbus_macros | 5.14.0 | `MIT` | [crates.io](https://crates.io/crates/zbus_macros/5.14.0) |
| zbus_names | 4.3.1 | `MIT` | [crates.io](https://crates.io/crates/zbus_names/4.3.1) |
| zerocopy | 0.8.48 | `BSD-2-Clause OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/zerocopy/0.8.48) |
| zerocopy-derive | 0.8.48 | `BSD-2-Clause OR Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/zerocopy-derive/0.8.48) |
| zerofrom | 0.1.7 | `Unicode-3.0` | [crates.io](https://crates.io/crates/zerofrom/0.1.7) |
| zerofrom-derive | 0.1.7 | `Unicode-3.0` | [crates.io](https://crates.io/crates/zerofrom-derive/0.1.7) |
| zeroize | 1.8.2 | `Apache-2.0 OR MIT` | [crates.io](https://crates.io/crates/zeroize/1.8.2) |
| zerotrie | 0.2.4 | `Unicode-3.0` | [crates.io](https://crates.io/crates/zerotrie/0.2.4) |
| zerovec | 0.11.6 | `Unicode-3.0` | [crates.io](https://crates.io/crates/zerovec/0.11.6) |
| zerovec-derive | 0.11.3 | `Unicode-3.0` | [crates.io](https://crates.io/crates/zerovec-derive/0.11.3) |
| zip | 2.4.2 | `MIT` | [crates.io](https://crates.io/crates/zip/2.4.2) |
| zip | 4.6.1 | `MIT` | [crates.io](https://crates.io/crates/zip/4.6.1) |
| zmij | 1.0.21 | `MIT` | [crates.io](https://crates.io/crates/zmij/1.0.21) |
| zopfli | 0.8.3 | `Apache-2.0` | [crates.io](https://crates.io/crates/zopfli/0.8.3) |
| zune-core | 0.5.1 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/zune-core/0.5.1) |
| zune-inflate | 0.2.54 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/zune-inflate/0.2.54) |
| zune-jpeg | 0.5.15 | `MIT OR Apache-2.0 OR Zlib` | [crates.io](https://crates.io/crates/zune-jpeg/0.5.15) |
| zvariant | 5.10.0 | `MIT` | [crates.io](https://crates.io/crates/zvariant/5.10.0) |
| zvariant_derive | 5.10.0 | `MIT` | [crates.io](https://crates.io/crates/zvariant_derive/5.10.0) |
| zvariant_utils | 3.3.0 | `MIT` | [crates.io](https://crates.io/crates/zvariant_utils/3.3.0) |

## npm production dependency inventory (140)

The npm inventory follows `package-lock.json` production entries and filters
packages whose declared OS/CPU constraints cannot run on either supported Mac
architecture. Vite may tree-shake additional packages from a particular build.

| SPDX expression declared by package | Count |
|---|---:|
| `0BSD` | 1 |
| `Apache-2.0 OR MIT` | 1 |
| `BSD-3-Clause` | 5 |
| `ISC` | 16 |
| `MIT` | 111 |
| `MIT OR Apache-2.0` | 6 |

| Package | Version | Declared license | Registry artifact |
|---|---:|---|---|
| @babel/runtime | 7.29.2 | `MIT` | [npm](https://registry.npmjs.org/@babel/runtime/-/runtime-7.29.2.tgz) |
| @codemirror/autocomplete | 6.20.1 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/autocomplete/-/autocomplete-6.20.1.tgz) |
| @codemirror/commands | 6.10.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/commands/-/commands-6.10.3.tgz) |
| @codemirror/lang-angular | 0.1.4 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-angular/-/lang-angular-0.1.4.tgz) |
| @codemirror/lang-cpp | 6.0.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-cpp/-/lang-cpp-6.0.3.tgz) |
| @codemirror/lang-css | 6.3.1 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-css/-/lang-css-6.3.1.tgz) |
| @codemirror/lang-go | 6.0.1 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-go/-/lang-go-6.0.1.tgz) |
| @codemirror/lang-html | 6.4.11 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-html/-/lang-html-6.4.11.tgz) |
| @codemirror/lang-java | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-java/-/lang-java-6.0.2.tgz) |
| @codemirror/lang-javascript | 6.2.5 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-javascript/-/lang-javascript-6.2.5.tgz) |
| @codemirror/lang-jinja | 6.0.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-jinja/-/lang-jinja-6.0.0.tgz) |
| @codemirror/lang-json | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-json/-/lang-json-6.0.2.tgz) |
| @codemirror/lang-less | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-less/-/lang-less-6.0.2.tgz) |
| @codemirror/lang-liquid | 6.3.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-liquid/-/lang-liquid-6.3.2.tgz) |
| @codemirror/lang-markdown | 6.5.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-markdown/-/lang-markdown-6.5.0.tgz) |
| @codemirror/lang-php | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-php/-/lang-php-6.0.2.tgz) |
| @codemirror/lang-python | 6.2.1 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-python/-/lang-python-6.2.1.tgz) |
| @codemirror/lang-rust | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-rust/-/lang-rust-6.0.2.tgz) |
| @codemirror/lang-sass | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-sass/-/lang-sass-6.0.2.tgz) |
| @codemirror/lang-sql | 6.10.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-sql/-/lang-sql-6.10.0.tgz) |
| @codemirror/lang-vue | 0.1.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-vue/-/lang-vue-0.1.3.tgz) |
| @codemirror/lang-wast | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-wast/-/lang-wast-6.0.2.tgz) |
| @codemirror/lang-xml | 6.1.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-xml/-/lang-xml-6.1.0.tgz) |
| @codemirror/lang-yaml | 6.1.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lang-yaml/-/lang-yaml-6.1.3.tgz) |
| @codemirror/language | 6.12.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/language/-/language-6.12.3.tgz) |
| @codemirror/language-data | 6.5.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/language-data/-/language-data-6.5.2.tgz) |
| @codemirror/legacy-modes | 6.5.2 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/legacy-modes/-/legacy-modes-6.5.2.tgz) |
| @codemirror/lint | 6.9.5 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/lint/-/lint-6.9.5.tgz) |
| @codemirror/search | 6.6.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/search/-/search-6.6.0.tgz) |
| @codemirror/state | 6.6.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/state/-/state-6.6.0.tgz) |
| @codemirror/theme-one-dark | 6.1.3 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/theme-one-dark/-/theme-one-dark-6.1.3.tgz) |
| @codemirror/view | 6.41.0 | `MIT` | [npm](https://registry.npmjs.org/@codemirror/view/-/view-6.41.0.tgz) |
| @dnd-kit/accessibility | 3.1.1 | `MIT` | [npm](https://registry.npmjs.org/@dnd-kit/accessibility/-/accessibility-3.1.1.tgz) |
| @dnd-kit/core | 6.3.1 | `MIT` | [npm](https://registry.npmjs.org/@dnd-kit/core/-/core-6.3.1.tgz) |
| @dnd-kit/sortable | 10.0.0 | `MIT` | [npm](https://registry.npmjs.org/@dnd-kit/sortable/-/sortable-10.0.0.tgz) |
| @dnd-kit/utilities | 3.2.2 | `MIT` | [npm](https://registry.npmjs.org/@dnd-kit/utilities/-/utilities-3.2.2.tgz) |
| @lezer/common | 1.5.2 | `MIT` | [npm](https://registry.npmjs.org/@lezer/common/-/common-1.5.2.tgz) |
| @lezer/cpp | 1.1.5 | `MIT` | [npm](https://registry.npmjs.org/@lezer/cpp/-/cpp-1.1.5.tgz) |
| @lezer/css | 1.3.3 | `MIT` | [npm](https://registry.npmjs.org/@lezer/css/-/css-1.3.3.tgz) |
| @lezer/go | 1.0.1 | `MIT` | [npm](https://registry.npmjs.org/@lezer/go/-/go-1.0.1.tgz) |
| @lezer/highlight | 1.2.3 | `MIT` | [npm](https://registry.npmjs.org/@lezer/highlight/-/highlight-1.2.3.tgz) |
| @lezer/html | 1.3.13 | `MIT` | [npm](https://registry.npmjs.org/@lezer/html/-/html-1.3.13.tgz) |
| @lezer/java | 1.1.3 | `MIT` | [npm](https://registry.npmjs.org/@lezer/java/-/java-1.1.3.tgz) |
| @lezer/javascript | 1.5.4 | `MIT` | [npm](https://registry.npmjs.org/@lezer/javascript/-/javascript-1.5.4.tgz) |
| @lezer/json | 1.0.3 | `MIT` | [npm](https://registry.npmjs.org/@lezer/json/-/json-1.0.3.tgz) |
| @lezer/lr | 1.4.8 | `MIT` | [npm](https://registry.npmjs.org/@lezer/lr/-/lr-1.4.8.tgz) |
| @lezer/markdown | 1.6.3 | `MIT` | [npm](https://registry.npmjs.org/@lezer/markdown/-/markdown-1.6.3.tgz) |
| @lezer/php | 1.0.5 | `MIT` | [npm](https://registry.npmjs.org/@lezer/php/-/php-1.0.5.tgz) |
| @lezer/python | 1.1.18 | `MIT` | [npm](https://registry.npmjs.org/@lezer/python/-/python-1.1.18.tgz) |
| @lezer/rust | 1.0.2 | `MIT` | [npm](https://registry.npmjs.org/@lezer/rust/-/rust-1.0.2.tgz) |
| @lezer/sass | 1.1.0 | `MIT` | [npm](https://registry.npmjs.org/@lezer/sass/-/sass-1.1.0.tgz) |
| @lezer/xml | 1.0.6 | `MIT` | [npm](https://registry.npmjs.org/@lezer/xml/-/xml-1.0.6.tgz) |
| @lezer/yaml | 1.0.4 | `MIT` | [npm](https://registry.npmjs.org/@lezer/yaml/-/yaml-1.0.4.tgz) |
| @marijn/find-cluster-break | 1.0.2 | `MIT` | [npm](https://registry.npmjs.org/@marijn/find-cluster-break/-/find-cluster-break-1.0.2.tgz) |
| @sigma/edge-curve | 3.1.0 | `MIT` | [npm](https://registry.npmjs.org/@sigma/edge-curve/-/edge-curve-3.1.0.tgz) |
| @sigma/export-image | 3.0.0 | `MIT` | [npm](https://registry.npmjs.org/@sigma/export-image/-/export-image-3.0.0.tgz) |
| @sigma/node-border | 3.0.0 | `MIT` | [npm](https://registry.npmjs.org/@sigma/node-border/-/node-border-3.0.0.tgz) |
| @tanstack/react-virtual | 3.13.23 | `MIT` | [npm](https://registry.npmjs.org/@tanstack/react-virtual/-/react-virtual-3.13.23.tgz) |
| @tanstack/virtual-core | 3.13.23 | `MIT` | [npm](https://registry.npmjs.org/@tanstack/virtual-core/-/virtual-core-3.13.23.tgz) |
| @tauri-apps/api | 2.10.1 | `Apache-2.0 OR MIT` | [npm](https://registry.npmjs.org/@tauri-apps/api/-/api-2.10.1.tgz) |
| @tauri-apps/plugin-deep-link | 2.4.8 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-deep-link/-/plugin-deep-link-2.4.8.tgz) |
| @tauri-apps/plugin-dialog | 2.7.0 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-dialog/-/plugin-dialog-2.7.0.tgz) |
| @tauri-apps/plugin-fs | 2.5.0 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-fs/-/plugin-fs-2.5.0.tgz) |
| @tauri-apps/plugin-process | 2.3.1 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-process/-/plugin-process-2.3.1.tgz) |
| @tauri-apps/plugin-shell | 2.3.5 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-shell/-/plugin-shell-2.3.5.tgz) |
| @tauri-apps/plugin-updater | 2.10.1 | `MIT OR Apache-2.0` | [npm](https://registry.npmjs.org/@tauri-apps/plugin-updater/-/plugin-updater-2.10.1.tgz) |
| @tweenjs/tween.js | 25.0.0 | `MIT` | [npm](https://registry.npmjs.org/@tweenjs/tween.js/-/tween.js-25.0.0.tgz) |
| @types/react | 19.2.14 | `MIT` | [npm](https://registry.npmjs.org/@types/react/-/react-19.2.14.tgz) |
| @uiw/codemirror-extensions-basic-setup | 4.25.9 | `MIT` | [npm](https://registry.npmjs.org/@uiw/codemirror-extensions-basic-setup/-/codemirror-extensions-basic-setup-4.25.9.tgz) |
| @uiw/react-codemirror | 4.25.9 | `MIT` | [npm](https://registry.npmjs.org/@uiw/react-codemirror/-/react-codemirror-4.25.9.tgz) |
| 3d-force-graph | 1.80.0 | `MIT` | [npm](https://registry.npmjs.org/3d-force-graph/-/3d-force-graph-1.80.0.tgz) |
| accessor-fn | 1.5.3 | `MIT` | [npm](https://registry.npmjs.org/accessor-fn/-/accessor-fn-1.5.3.tgz) |
| bezier-js | 6.1.4 | `MIT` | [npm](https://registry.npmjs.org/bezier-js/-/bezier-js-6.1.4.tgz) |
| canvas-color-tracker | 1.3.2 | `MIT` | [npm](https://registry.npmjs.org/canvas-color-tracker/-/canvas-color-tracker-1.3.2.tgz) |
| codemirror | 6.0.2 | `MIT` | [npm](https://registry.npmjs.org/codemirror/-/codemirror-6.0.2.tgz) |
| crelt | 1.0.6 | `MIT` | [npm](https://registry.npmjs.org/crelt/-/crelt-1.0.6.tgz) |
| csstype | 3.2.3 | `MIT` | [npm](https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz) |
| d3-array | 3.2.4 | `ISC` | [npm](https://registry.npmjs.org/d3-array/-/d3-array-3.2.4.tgz) |
| d3-binarytree | 1.0.2 | `MIT` | [npm](https://registry.npmjs.org/d3-binarytree/-/d3-binarytree-1.0.2.tgz) |
| d3-color | 3.1.0 | `ISC` | [npm](https://registry.npmjs.org/d3-color/-/d3-color-3.1.0.tgz) |
| d3-dispatch | 3.0.1 | `ISC` | [npm](https://registry.npmjs.org/d3-dispatch/-/d3-dispatch-3.0.1.tgz) |
| d3-drag | 3.0.0 | `ISC` | [npm](https://registry.npmjs.org/d3-drag/-/d3-drag-3.0.0.tgz) |
| d3-ease | 3.0.1 | `BSD-3-Clause` | [npm](https://registry.npmjs.org/d3-ease/-/d3-ease-3.0.1.tgz) |
| d3-force-3d | 3.0.6 | `MIT` | [npm](https://registry.npmjs.org/d3-force-3d/-/d3-force-3d-3.0.6.tgz) |
| d3-format | 3.1.2 | `ISC` | [npm](https://registry.npmjs.org/d3-format/-/d3-format-3.1.2.tgz) |
| d3-interpolate | 3.0.1 | `ISC` | [npm](https://registry.npmjs.org/d3-interpolate/-/d3-interpolate-3.0.1.tgz) |
| d3-octree | 1.1.0 | `MIT` | [npm](https://registry.npmjs.org/d3-octree/-/d3-octree-1.1.0.tgz) |
| d3-quadtree | 3.0.1 | `ISC` | [npm](https://registry.npmjs.org/d3-quadtree/-/d3-quadtree-3.0.1.tgz) |
| d3-scale | 4.0.2 | `ISC` | [npm](https://registry.npmjs.org/d3-scale/-/d3-scale-4.0.2.tgz) |
| d3-scale-chromatic | 3.1.0 | `ISC` | [npm](https://registry.npmjs.org/d3-scale-chromatic/-/d3-scale-chromatic-3.1.0.tgz) |
| d3-selection | 3.0.0 | `ISC` | [npm](https://registry.npmjs.org/d3-selection/-/d3-selection-3.0.0.tgz) |
| d3-time | 3.1.0 | `ISC` | [npm](https://registry.npmjs.org/d3-time/-/d3-time-3.1.0.tgz) |
| d3-time-format | 4.1.0 | `ISC` | [npm](https://registry.npmjs.org/d3-time-format/-/d3-time-format-4.1.0.tgz) |
| d3-timer | 3.0.1 | `ISC` | [npm](https://registry.npmjs.org/d3-timer/-/d3-timer-3.0.1.tgz) |
| d3-transition | 3.0.1 | `ISC` | [npm](https://registry.npmjs.org/d3-transition/-/d3-transition-3.0.1.tgz) |
| d3-zoom | 3.0.0 | `ISC` | [npm](https://registry.npmjs.org/d3-zoom/-/d3-zoom-3.0.0.tgz) |
| data-bind-mapper | 1.0.3 | `MIT` | [npm](https://registry.npmjs.org/data-bind-mapper/-/data-bind-mapper-1.0.3.tgz) |
| events | 3.3.0 | `MIT` | [npm](https://registry.npmjs.org/events/-/events-3.3.0.tgz) |
| file-saver | 2.0.5 | `MIT` | [npm](https://registry.npmjs.org/file-saver/-/file-saver-2.0.5.tgz) |
| float-tooltip | 1.7.5 | `MIT` | [npm](https://registry.npmjs.org/float-tooltip/-/float-tooltip-1.7.5.tgz) |
| force-graph | 1.51.4 | `MIT` | [npm](https://registry.npmjs.org/force-graph/-/force-graph-1.51.4.tgz) |
| framer-motion | 11.18.2 | `MIT` | [npm](https://registry.npmjs.org/framer-motion/-/framer-motion-11.18.2.tgz) |
| graphology | 0.26.0 | `MIT` | [npm](https://registry.npmjs.org/graphology/-/graphology-0.26.0.tgz) |
| graphology-layout-forceatlas2 | 0.10.1 | `MIT` | [npm](https://registry.npmjs.org/graphology-layout-forceatlas2/-/graphology-layout-forceatlas2-0.10.1.tgz) |
| graphology-types | 0.24.8 | `MIT` | [npm](https://registry.npmjs.org/graphology-types/-/graphology-types-0.24.8.tgz) |
| graphology-utils | 2.5.2 | `MIT` | [npm](https://registry.npmjs.org/graphology-utils/-/graphology-utils-2.5.2.tgz) |
| index-array-by | 1.4.2 | `MIT` | [npm](https://registry.npmjs.org/index-array-by/-/index-array-by-1.4.2.tgz) |
| internmap | 2.0.3 | `ISC` | [npm](https://registry.npmjs.org/internmap/-/internmap-2.0.3.tgz) |
| jerrypick | 1.1.2 | `MIT` | [npm](https://registry.npmjs.org/jerrypick/-/jerrypick-1.1.2.tgz) |
| js-tokens | 4.0.0 | `MIT` | [npm](https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz) |
| kapsule | 1.16.3 | `MIT` | [npm](https://registry.npmjs.org/kapsule/-/kapsule-1.16.3.tgz) |
| lodash-es | 4.18.1 | `MIT` | [npm](https://registry.npmjs.org/lodash-es/-/lodash-es-4.18.1.tgz) |
| loose-envify | 1.4.0 | `MIT` | [npm](https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz) |
| motion-dom | 11.18.1 | `MIT` | [npm](https://registry.npmjs.org/motion-dom/-/motion-dom-11.18.1.tgz) |
| motion-utils | 11.18.1 | `MIT` | [npm](https://registry.npmjs.org/motion-utils/-/motion-utils-11.18.1.tgz) |
| ngraph.events | 1.4.0 | `BSD-3-Clause` | [npm](https://registry.npmjs.org/ngraph.events/-/ngraph.events-1.4.0.tgz) |
| ngraph.forcelayout | 3.3.1 | `BSD-3-Clause` | [npm](https://registry.npmjs.org/ngraph.forcelayout/-/ngraph.forcelayout-3.3.1.tgz) |
| ngraph.graph | 20.1.2 | `BSD-3-Clause` | [npm](https://registry.npmjs.org/ngraph.graph/-/ngraph.graph-20.1.2.tgz) |
| ngraph.merge | 1.0.0 | `MIT` | [npm](https://registry.npmjs.org/ngraph.merge/-/ngraph.merge-1.0.0.tgz) |
| ngraph.random | 1.2.0 | `BSD-3-Clause` | [npm](https://registry.npmjs.org/ngraph.random/-/ngraph.random-1.2.0.tgz) |
| object-assign | 4.1.1 | `MIT` | [npm](https://registry.npmjs.org/object-assign/-/object-assign-4.1.1.tgz) |
| polished | 4.3.1 | `MIT` | [npm](https://registry.npmjs.org/polished/-/polished-4.3.1.tgz) |
| preact | 10.29.1 | `MIT` | [npm](https://registry.npmjs.org/preact/-/preact-10.29.1.tgz) |
| prop-types | 15.8.1 | `MIT` | [npm](https://registry.npmjs.org/prop-types/-/prop-types-15.8.1.tgz) |
| react | 19.2.5 | `MIT` | [npm](https://registry.npmjs.org/react/-/react-19.2.5.tgz) |
| react-dom | 19.2.5 | `MIT` | [npm](https://registry.npmjs.org/react-dom/-/react-dom-19.2.5.tgz) |
| react-force-graph-2d | 1.29.1 | `MIT` | [npm](https://registry.npmjs.org/react-force-graph-2d/-/react-force-graph-2d-1.29.1.tgz) |
| react-force-graph-3d | 1.29.1 | `MIT` | [npm](https://registry.npmjs.org/react-force-graph-3d/-/react-force-graph-3d-1.29.1.tgz) |
| react-is | 16.13.1 | `MIT` | [npm](https://registry.npmjs.org/react-is/-/react-is-16.13.1.tgz) |
| react-kapsule | 2.5.7 | `MIT` | [npm](https://registry.npmjs.org/react-kapsule/-/react-kapsule-2.5.7.tgz) |
| scheduler | 0.27.0 | `MIT` | [npm](https://registry.npmjs.org/scheduler/-/scheduler-0.27.0.tgz) |
| sigma | 3.0.3 | `MIT` | [npm](https://registry.npmjs.org/sigma/-/sigma-3.0.3.tgz) |
| style-mod | 4.1.3 | `MIT` | [npm](https://registry.npmjs.org/style-mod/-/style-mod-4.1.3.tgz) |
| three | 0.184.0 | `MIT` | [npm](https://registry.npmjs.org/three/-/three-0.184.0.tgz) |
| three-forcegraph | 1.43.4 | `MIT` | [npm](https://registry.npmjs.org/three-forcegraph/-/three-forcegraph-1.43.4.tgz) |
| three-render-objects | 1.41.1 | `MIT` | [npm](https://registry.npmjs.org/three-render-objects/-/three-render-objects-1.41.1.tgz) |
| tinycolor2 | 1.6.0 | `MIT` | [npm](https://registry.npmjs.org/tinycolor2/-/tinycolor2-1.6.0.tgz) |
| tslib | 2.8.1 | `0BSD` | [npm](https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz) |
| w3c-keyname | 2.2.8 | `MIT` | [npm](https://registry.npmjs.org/w3c-keyname/-/w3c-keyname-2.2.8.tgz) |
| zustand | 5.0.12 | `MIT` | [npm](https://registry.npmjs.org/zustand/-/zustand-5.0.12.tgz) |

## Release maintenance

Run `node scripts/generate-third-party-notices.mjs --write` after any dependency
change, and `--check` in the release gate. Treat a new copyleft, source-available,
non-commercial, custom, or `NOASSERTION` entry as a release blocker until a
person reviews its terms. Generated output does not decide license compatibility.
