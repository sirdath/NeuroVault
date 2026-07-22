# Third-Party Notices

NeuroVault is licensed under MIT. Third-party components retain their own
licenses. This inventory is generated from the locked production dependency
graphs used by the desktop app and headless MCP distribution: normal/runtime
Rust dependencies for the current macOS Apple Silicon, Linux x64 glibc, and
Windows x64 binary targets, plus production npm dependencies from the root
webview application. Build-only and development-only tools are excluded.
Platform filtering can still make this union broader than the bytes in any one
platform build.

The accompanying `LICENSES/THIRD-PARTY-LICENSES.txt` preserves license and
notice files found in the dependency package sources. Exact notices for linked
native components are preserved under `LICENSES/native/` and pinned by
SHA-256 in `LICENSES/NATIVE-NOTICE-SOURCES.json`. A manifest-only section
identifies packages whose archives do not expose a standalone top-level
license file. This inventory assists release compliance review; it is not a
legal opinion.

## Material requiring explicit attention

### MPL-2.0 covered components (5)

The following unmodified Rust crate releases declare MPL-2.0. MPL-2.0 is weak
copyleft at the covered-file level; it does not relicense NeuroVault's own
files. Exact versioned source archive links and Cargo checksums are provided in
`LICENSES/MPL-2.0-COVERED-SOURCE.md`, and the full license text shipped by
the crate is included in the license collection.

| Crate | Version | License | Source |
|---|---:|---|---|
| cssparser | 0.29.6 | `MPL-2.0` | [package](https://github.com/servo/rust-cssparser) |
| cssparser-macros | 0.6.1 | `MPL-2.0` | [package](https://github.com/servo/rust-cssparser) |
| dtoa-short | 0.3.5 | `MPL-2.0` | [package](https://github.com/upsuper/dtoa-short) |
| option-ext | 0.2.0 | `MPL-2.0` | [package](https://github.com/soc/option-ext.git) |
| selectors | 0.24.0 | `MPL-2.0` | [package](https://github.com/servo/servo) |

### Native libraries and runtime-downloaded models

| Component | Distribution | Declared license | Source |
|---|---|---|---|
| sqlite-vec v0.1.9 | loadable extension included in each platform binary package | MIT OR Apache-2.0; exact texts bundled | https://github.com/asg017/sqlite-vec/tree/v0.1.9 |
| SQLite | linked through the `rusqlite` bundled feature | Public Domain | https://www.sqlite.org/copyright.html |
| ONNX Runtime 1.20.0 | statically linked by `ort-sys 2.0.0-rc.9` as configured by `fastembed 4.9.1` | MIT plus upstream third-party notices; exact files bundled | https://github.com/microsoft/onnxruntime/tree/v1.20.0 |
| BAAI/bge-small-en-v1.5, ONNX conversion by Xenova | downloaded on first embedding use; not included in installers or npm packages | MIT (upstream model card); see conversion-repository caveat in the downloaded-model notice | https://huggingface.co/BAAI/bge-small-en-v1.5 |
| BAAI/bge-reranker-base | downloaded on the first qualifying reranked recall while reranking is enabled; not included in installers or npm packages | MIT (upstream model card) | https://huggingface.co/BAAI/bge-reranker-base |

Downloaded model files remain governed by the terms published with those
files. See `LICENSES/models/DOWNLOADED-MODELS.md` for the runtime behavior and
source links. Audit the exact artifacts again for every release candidate.

## Rust production dependency inventory (611)

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
| `MIT/Apache-2.0` | 32 |
| `MPL-2.0` | 5 |
| `Unicode-3.0` | 18 |
| `Unlicense OR MIT` | 7 |
| `Unlicense/MIT` | 2 |
| `Zlib OR Apache-2.0 OR MIT` | 10 |

| Crate | Version | Declared license | Package |
|---|---:|---|---|
| adler2 | 2.0.1 | `0BSD OR MIT OR Apache-2.0` | [package](https://github.com/oyvindln/adler2) |
| ahash | 0.8.12 | `MIT OR Apache-2.0` | [package](https://github.com/tkaitchuck/ahash) |
| aho-corasick | 1.1.4 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/aho-corasick) |
| aligned | 0.4.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-embedded-community/aligned) |
| aligned-vec | 0.6.4 | `MIT` | [package](https://github.com/sarah-ek/aligned-vec/) |
| alloc-no-stdlib | 2.0.4 | `BSD-3-Clause` | [package](https://github.com/dropbox/rust-alloc-no-stdlib) |
| alloc-stdlib | 0.2.2 | `BSD-3-Clause` | [package](https://github.com/dropbox/rust-alloc-no-stdlib) |
| anyhow | 1.0.103 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/anyhow) |
| arg_enum_proc_macro | 0.3.4 | `MIT` | [package](https://github.com/lu-zero/arg_enum_proc_macro) |
| arrayref | 0.3.9 | `BSD-2-Clause` | [package](https://github.com/droundy/arrayref) |
| arrayvec | 0.7.6 | `MIT OR Apache-2.0` | [package](https://github.com/bluss/arrayvec) |
| as-slice | 0.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/japaric/as-slice) |
| async-broadcast | 0.7.2 | `MIT OR Apache-2.0` | [package](https://github.com/smol-rs/async-broadcast) |
| async-channel | 2.5.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-channel) |
| async-executor | 1.14.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-executor) |
| async-io | 2.6.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-io) |
| async-lock | 3.4.2 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-lock) |
| async-process | 2.5.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-process) |
| async-recursion | 1.1.1 | `MIT OR Apache-2.0` | [package](https://github.com/dcchut/async-recursion) |
| async-signal | 0.2.14 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-signal) |
| async-task | 4.7.1 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/async-task) |
| async-trait | 0.1.89 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/async-trait) |
| atk | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| atk-sys | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| atomic-waker | 1.1.2 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/atomic-waker) |
| av-scenechange | 0.14.1 | `MIT` | [package](https://github.com/rust-av/av-scenechange) |
| av1-grain | 0.2.5 | `BSD-2-Clause` | [package](https://github.com/rust-av/av1-grain) |
| avif-serialize | 0.8.8 | `BSD-3-Clause` | [package](https://github.com/kornelski/avif-serialize) |
| axum | 0.7.9 | `MIT` | [package](https://github.com/tokio-rs/axum) |
| axum-core | 0.4.5 | `MIT` | [package](https://github.com/tokio-rs/axum) |
| base64 | 0.13.1 | `MIT/Apache-2.0` | [package](https://github.com/marshallpierce/rust-base64) |
| base64 | 0.21.7 | `MIT OR Apache-2.0` | [package](https://github.com/marshallpierce/rust-base64) |
| base64 | 0.22.1 | `MIT OR Apache-2.0` | [package](https://github.com/marshallpierce/rust-base64) |
| bit_field | 0.10.3 | `Apache-2.0/MIT` | [package](https://github.com/phil-opp/rust-bit-field) |
| bitflags | 1.3.2 | `MIT/Apache-2.0` | [package](https://github.com/bitflags/bitflags) |
| bitflags | 2.11.0 | `MIT OR Apache-2.0` | [package](https://github.com/bitflags/bitflags) |
| bitstream-io | 4.10.0 | `MIT/Apache-2.0` | [package](https://github.com/tuffy/bitstream-io) |
| blake3 | 1.8.5 | `CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception` | [package](https://github.com/BLAKE3-team/BLAKE3) |
| block-buffer | 0.10.4 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/utils) |
| block2 | 0.6.2 | `MIT` | [package](https://github.com/madsmtm/objc2) |
| blocking | 1.6.2 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/blocking) |
| brotli | 8.0.2 | `BSD-3-Clause AND MIT` | [package](https://github.com/dropbox/rust-brotli) |
| brotli-decompressor | 5.0.0 | `BSD-3-Clause/MIT` | [package](https://github.com/dropbox/rust-brotli-decompressor) |
| bstr | 1.12.1 | `MIT OR Apache-2.0` | [package](https://github.com/BurntSushi/bstr) |
| bumpalo | 3.20.2 | `MIT OR Apache-2.0` | [package](https://github.com/fitzgen/bumpalo) |
| bytemuck | 1.25.0 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/Lokathor/bytemuck) |
| byteorder | 1.5.0 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/byteorder) |
| byteorder-lite | 0.1.0 | `Unlicense OR MIT` | [package](https://github.com/image-rs/byteorder-lite) |
| bytes | 1.11.1 | `MIT` | [package](https://github.com/tokio-rs/bytes) |
| cairo-rs | 0.18.5 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| cairo-sys-rs | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| camino | 1.2.2 | `MIT OR Apache-2.0` | [package](https://github.com/camino-rs/camino) |
| cargo_metadata | 0.19.2 | `MIT` | [package](https://github.com/oli-obk/cargo_metadata) |
| cargo-platform | 0.1.9 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/cargo) |
| castaway | 0.2.4 | `MIT` | [package](https://github.com/sagebind/castaway) |
| cfb | 0.7.3 | `MIT` | [package](https://github.com/mdsteele/rust-cfb) |
| cfg-if | 1.0.4 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/cfg-if) |
| chacha20 | 0.10.1 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/stream-ciphers) |
| chrono | 0.4.44 | `MIT OR Apache-2.0` | [package](https://github.com/chronotope/chrono) |
| color_quant | 1.1.0 | `MIT` | [package](https://github.com/image-rs/color_quant.git) |
| compact_str | 0.9.0 | `MIT` | [package](https://github.com/ParkMyCar/compact_str) |
| concurrent-queue | 2.5.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/concurrent-queue) |
| console | 0.15.11 | `MIT` | [package](https://github.com/console-rs/console) |
| const-random | 0.1.18 | `MIT OR Apache-2.0` | [package](https://github.com/tkaitchuck/constrandom) |
| const-random-macro | 0.1.16 | `MIT OR Apache-2.0` | [package](https://github.com/tkaitchuck/constrandom) |
| constant_time_eq | 0.4.2 | `CC0-1.0 OR MIT-0 OR Apache-2.0` | [package](https://github.com/cesarb/constant_time_eq) |
| convert_case | 0.4.0 | `MIT` | [package](https://github.com/rutrum/convert-case) |
| cookie | 0.18.1 | `MIT OR Apache-2.0` | [package](https://github.com/SergioBenitez/cookie-rs) |
| core-foundation | 0.10.1 | `MIT OR Apache-2.0` | [package](https://github.com/servo/core-foundation-rs) |
| core-foundation-sys | 0.8.7 | `MIT OR Apache-2.0` | [package](https://github.com/servo/core-foundation-rs) |
| core-graphics | 0.25.0 | `MIT OR Apache-2.0` | [package](https://github.com/servo/core-foundation-rs) |
| core-graphics-types | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/servo/core-foundation-rs) |
| cpufeatures | 0.2.17 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/utils) |
| cpufeatures | 0.3.0 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/utils) |
| crc32fast | 1.5.0 | `MIT OR Apache-2.0` | [package](https://github.com/srijs/rust-crc32fast) |
| crossbeam-channel | 0.5.15 | `MIT OR Apache-2.0` | [package](https://github.com/crossbeam-rs/crossbeam) |
| crossbeam-deque | 0.8.6 | `MIT OR Apache-2.0` | [package](https://github.com/crossbeam-rs/crossbeam) |
| crossbeam-epoch | 0.9.20 | `MIT OR Apache-2.0` | [package](https://github.com/crossbeam-rs/crossbeam) |
| crossbeam-utils | 0.8.21 | `MIT OR Apache-2.0` | [package](https://github.com/crossbeam-rs/crossbeam) |
| crunchy | 0.2.4 | `MIT` | [package](https://github.com/eira-fransham/crunchy) |
| crypto-common | 0.1.7 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/traits) |
| cssparser | 0.29.6 | `MPL-2.0` | [package](https://github.com/servo/rust-cssparser) |
| cssparser-macros | 0.6.1 | `MPL-2.0` | [package](https://github.com/servo/rust-cssparser) |
| ctor | 0.2.9 | `Apache-2.0 OR MIT` | [package](https://github.com/mmastrac/rust-ctor) |
| darling | 0.20.11 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| darling | 0.23.0 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| darling_core | 0.20.11 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| darling_core | 0.23.0 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| darling_macro | 0.20.11 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| darling_macro | 0.23.0 | `MIT` | [package](https://github.com/TedDriggs/darling) |
| dary_heap | 0.3.9 | `MIT OR Apache-2.0` | [package](https://github.com/hanmertens/dary_heap) |
| deranged | 0.5.8 | `MIT OR Apache-2.0` | [package](https://github.com/jhpratt/deranged) |
| derive_builder | 0.20.2 | `MIT OR Apache-2.0` | [package](https://github.com/colin-kiegel/rust-derive-builder) |
| derive_builder_core | 0.20.2 | `MIT OR Apache-2.0` | [package](https://github.com/colin-kiegel/rust-derive-builder) |
| derive_builder_macro | 0.20.2 | `MIT OR Apache-2.0` | [package](https://github.com/colin-kiegel/rust-derive-builder) |
| derive_more | 0.99.20 | `MIT` | [package](https://github.com/JelteF/derive_more) |
| deunicode | 1.6.2 | `BSD-3-Clause` | [package](https://github.com/kornelski/deunicode/) |
| digest | 0.10.7 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/traits) |
| dirs | 6.0.0 | `MIT OR Apache-2.0` | [package](https://github.com/soc/dirs-rs) |
| dirs-sys | 0.5.0 | `MIT OR Apache-2.0` | [package](https://github.com/dirs-dev/dirs-sys-rs) |
| dispatch2 | 0.3.1 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| displaydoc | 0.2.5 | `MIT OR Apache-2.0` | [package](https://github.com/yaahc/displaydoc) |
| dlopen2 | 0.8.2 | `MIT` | [package](https://github.com/OpenByteDev/dlopen2) |
| dlopen2_derive | 0.4.3 | `MIT` | [package](https://github.com/OpenByteDev/dlopen2) |
| dlv-list | 0.5.2 | `MIT OR Apache-2.0` | [package](https://github.com/sgodwincs/dlv-list-rs) |
| dpi | 0.1.2 | `Apache-2.0 AND MIT` | [package](https://github.com/rust-windowing/winit) |
| dtoa | 1.0.11 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/dtoa) |
| dtoa-short | 0.3.5 | `MPL-2.0` | [package](https://github.com/upsuper/dtoa-short) |
| dunce | 1.0.5 | `CC0-1.0 OR MIT-0 OR Apache-2.0` | [package](https://gitlab.com/kornelski/dunce) |
| dyn-clone | 1.0.20 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/dyn-clone) |
| either | 1.15.0 | `MIT OR Apache-2.0` | [package](https://github.com/rayon-rs/either) |
| embed_plist | 1.2.2 | `MIT OR Apache-2.0` | [package](https://github.com/nvzqz/embed-plist-rs) |
| encode_unicode | 1.0.0 | `Apache-2.0 OR MIT` | [package](https://github.com/tormol/encode_unicode) |
| encoding_rs | 0.8.35 | `(Apache-2.0 OR MIT) AND BSD-3-Clause` | [package](https://github.com/hsivonen/encoding_rs) |
| endi | 1.1.1 | `MIT` | [package](https://github.com/zeenix/endi) |
| enumflags2 | 0.7.12 | `MIT OR Apache-2.0` | [package](https://github.com/meithecatte/enumflags2) |
| enumflags2_derive | 0.7.12 | `MIT OR Apache-2.0` | [package](https://github.com/meithecatte/enumflags2) |
| equator | 0.4.2 | `MIT` | [package](https://github.com/sarah-ek/equator/) |
| equator-macro | 0.4.2 | `MIT` | [package](https://github.com/sarah-ek/equator/) |
| equivalent | 1.0.2 | `Apache-2.0 OR MIT` | [package](https://github.com/indexmap-rs/equivalent) |
| erased-serde | 0.4.10 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/erased-serde) |
| errno | 0.3.14 | `MIT OR Apache-2.0` | [package](https://github.com/lambda-fairy/rust-errno) |
| esaxx-rs | 0.1.10 | `Apache-2.0` | [package](https://github.com/Narsil/esaxx-rs) |
| event-listener | 5.4.1 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/event-listener) |
| event-listener-strategy | 0.5.4 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/event-listener-strategy) |
| exr | 1.74.0 | `BSD-3-Clause` | [package](https://github.com/johannesvollmer/exrs) |
| fallible-iterator | 0.3.0 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/rust-fallible-iterator) |
| fallible-streaming-iterator | 0.1.9 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/fallible-streaming-iterator) |
| fastembed | 4.9.1 | `Apache-2.0` | [package](https://github.com/Anush008/fastembed-rs) |
| fastrand | 2.4.1 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/fastrand) |
| fax | 0.2.6 | `MIT` | [package](https://github.com/pdf-rs/fax) |
| fax_derive | 0.2.0 | `MIT` | [package](https://github.com/pdf-rs/fax) |
| fdeflate | 0.3.7 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/fdeflate) |
| field-offset | 0.3.6 | `MIT OR Apache-2.0` | [package](https://github.com/Diggsey/rust-field-offset) |
| filetime | 0.2.27 | `MIT/Apache-2.0` | [package](https://github.com/alexcrichton/filetime) |
| flate2 | 1.1.9 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/flate2-rs) |
| fnv | 1.0.7 | `Apache-2.0 / MIT` | [package](https://github.com/servo/rust-fnv) |
| foreign-types | 0.5.0 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/foreign-types) |
| foreign-types-macros | 0.2.3 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/foreign-types) |
| foreign-types-shared | 0.3.1 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/foreign-types) |
| form_urlencoded | 1.2.2 | `MIT OR Apache-2.0` | [package](https://github.com/servo/rust-url) |
| fsevent-sys | 4.1.0 | `MIT` | [package](https://github.com/octplane/fsevent-rust/tree/master/fsevent-sys) |
| futf | 0.1.5 | `MIT / Apache-2.0` | [package](https://github.com/servo/futf) |
| futures | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-channel | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-core | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-executor | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-io | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-lite | 2.6.1 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/futures-lite) |
| futures-macro | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-sink | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-task | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| futures-util | 0.3.32 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/futures-rs) |
| fxhash | 0.2.1 | `Apache-2.0/MIT` | [package](https://github.com/cbreeden/fxhash) |
| gdk | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gdk-pixbuf | 0.18.5 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| gdk-pixbuf-sys | 0.18.0 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| gdk-sys | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gdkwayland-sys | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gdkx11 | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gdkx11-sys | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| generic-array | 0.14.7 | `MIT` | [package](https://github.com/fizyk20/generic-array.git) |
| gethostname | 1.1.0 | `Apache-2.0` | [package](https://codeberg.org/swsnr/gethostname.rs.git) |
| getrandom | 0.2.17 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/getrandom) |
| getrandom | 0.3.4 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/getrandom) |
| getrandom | 0.4.2 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/getrandom) |
| gif | 0.14.2 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/image-gif) |
| gio | 0.18.4 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| gio-sys | 0.18.1 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| glib | 0.18.5 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| glib-macros | 0.18.5 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| glib-sys | 0.18.1 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| glob | 0.3.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/glob) |
| global-hotkey | 0.7.0 | `Apache-2.0 OR MIT` | [package](https://github.com/amrbashir/global-hotkey) |
| globset | 0.4.18 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/ripgrep/tree/master/crates/globset) |
| gobject-sys | 0.18.0 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| gtk | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gtk-sys | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| gtk3-macros | 0.18.2 | `MIT` | [package](https://github.com/gtk-rs/gtk3-rs) |
| half | 2.7.1 | `MIT OR Apache-2.0` | [package](https://github.com/VoidStarKat/half-rs) |
| hashbrown | 0.12.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/hashbrown) |
| hashbrown | 0.14.5 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/hashbrown) |
| hashbrown | 0.17.0 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/hashbrown) |
| hashlink | 0.9.1 | `MIT OR Apache-2.0` | [package](https://github.com/kyren/hashlink) |
| heck | 0.4.1 | `MIT OR Apache-2.0` | [package](https://github.com/withoutboats/heck) |
| heck | 0.5.0 | `MIT OR Apache-2.0` | [package](https://github.com/withoutboats/heck) |
| hex | 0.4.3 | `MIT OR Apache-2.0` | [package](https://github.com/KokaKiwi/rust-hex) |
| hf-hub | 0.4.3 | `Apache-2.0` | [package](https://github.com/huggingface/hf-hub) |
| html5ever | 0.29.1 | `MIT OR Apache-2.0` | [package](https://github.com/servo/html5ever) |
| http | 1.4.0 | `MIT OR Apache-2.0` | [package](https://github.com/hyperium/http) |
| http-body | 1.0.1 | `MIT` | [package](https://github.com/hyperium/http-body) |
| http-body-util | 0.1.3 | `MIT` | [package](https://github.com/hyperium/http-body) |
| httparse | 1.10.1 | `MIT OR Apache-2.0` | [package](https://github.com/seanmonstar/httparse) |
| httpdate | 1.0.3 | `MIT OR Apache-2.0` | [package](https://github.com/pyfisch/httpdate) |
| hyper | 1.9.0 | `MIT` | [package](https://github.com/hyperium/hyper) |
| hyper-rustls | 0.27.9 | `Apache-2.0 OR ISC OR MIT` | [package](https://github.com/rustls/hyper-rustls) |
| hyper-util | 0.1.20 | `MIT` | [package](https://github.com/hyperium/hyper-util) |
| iana-time-zone | 0.1.65 | `MIT OR Apache-2.0` | [package](https://github.com/strawlab/iana-time-zone) |
| ico | 0.5.0 | `MIT` | [package](https://github.com/mdsteele/rust-ico) |
| icu_collections | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_locale_core | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_normalizer | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_normalizer_data | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_properties | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_properties_data | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| icu_provider | 2.2.0 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| ident_case | 1.0.1 | `MIT/Apache-2.0` | [package](https://github.com/TedDriggs/ident_case) |
| idna | 1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/servo/rust-url/) |
| idna_adapter | 1.2.1 | `Apache-2.0 OR MIT` | [package](https://github.com/hsivonen/idna_adapter) |
| ignore | 0.4.26 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore) |
| image | 0.25.10 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/image) |
| image-webp | 0.2.4 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/image-webp) |
| imgref | 1.12.0 | `CC0-1.0 OR Apache-2.0` | [package](https://github.com/kornelski/imgref) |
| indexmap | 1.9.3 | `Apache-2.0 OR MIT` | [package](https://github.com/bluss/indexmap) |
| indexmap | 2.14.0 | `Apache-2.0 OR MIT` | [package](https://github.com/indexmap-rs/indexmap) |
| indicatif | 0.17.11 | `MIT` | [package](https://github.com/console-rs/indicatif) |
| infer | 0.19.0 | `MIT` | [package](https://github.com/bojand/infer) |
| inotify | 0.9.6 | `ISC` | [package](https://github.com/hannobraun/inotify) |
| inotify-sys | 0.1.5 | `ISC` | [package](https://github.com/hannobraun/inotify-sys) |
| ipnet | 2.12.0 | `MIT OR Apache-2.0` | [package](https://github.com/krisprice/ipnet) |
| iri-string | 0.7.12 | `MIT OR Apache-2.0` | [package](https://github.com/lo48576/iri-string) |
| is-docker | 0.2.0 | `MIT` | [package](https://github.com/TheLarkInn/is-docker) |
| is-wsl | 0.4.0 | `MIT` | [package](https://github.com/TheLarkInn/is-wsl) |
| itertools | 0.14.0 | `MIT OR Apache-2.0` | [package](https://github.com/rust-itertools/itertools) |
| itoa | 1.0.18 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/itoa) |
| javascriptcore-rs | 1.1.2 | `MIT` | [package](https://github.com/tauri-apps/javascriptcore-rs) |
| javascriptcore-rs-sys | 1.1.1 | `MIT` | [package](https://github.com/tauri-apps/javascriptcore-rs) |
| json-patch | 3.0.1 | `MIT/Apache-2.0` | [package](https://github.com/idubrov/json-patch) |
| jsonptr | 0.6.3 | `MIT OR Apache-2.0` | [package](https://github.com/chanced/jsonptr) |
| keyboard-types | 0.7.0 | `MIT OR Apache-2.0` | [package](https://github.com/pyfisch/keyboard-types) |
| kuchikiki | 0.8.8-speedreader | `MIT` | [package](https://github.com/brave/kuchikiki) |
| lebe | 0.5.3 | `BSD-3-Clause` | [package](https://github.com/johannesvollmer/lebe) |
| libappindicator | 0.9.0 | `Apache-2.0 OR MIT` | [package](https://crates.io/crates/libappindicator/0.9.0) |
| libappindicator-sys | 0.9.0 | `Apache-2.0 OR MIT` | [package](https://crates.io/crates/libappindicator-sys/0.9.0) |
| libc | 0.2.184 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/libc) |
| libloading | 0.7.4 | `ISC` | [package](https://github.com/nagisa/rust_libloading/) |
| libsqlite3-sys | 0.30.1 | `MIT` | [package](https://github.com/rusqlite/rusqlite) |
| linux-raw-sys | 0.12.1 | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | [package](https://github.com/sunfishcode/linux-raw-sys) |
| litemap | 0.8.2 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| lock_api | 0.4.14 | `MIT OR Apache-2.0` | [package](https://github.com/Amanieu/parking_lot) |
| log | 0.4.29 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/log) |
| loop9 | 0.1.5 | `MIT` | [package](https://gitlab.com/kornelski/loop9.git) |
| lru-slab | 0.1.2 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/Ralith/lru-slab) |
| mac | 0.1.1 | `MIT/Apache-2.0` | [package](https://github.com/reem/rust-mac.git) |
| macro_rules_attribute | 0.2.2 | `Apache-2.0 OR MIT OR Zlib` | [package](https://github.com/danielhenrymantilla/macro_rules_attribute-rs) |
| macro_rules_attribute-proc_macro | 0.2.2 | `Apache-2.0 OR MIT OR Zlib` | [package](https://github.com/danielhenrymantilla/macro_rules_attribute-rs) |
| markup5ever | 0.14.1 | `MIT OR Apache-2.0` | [package](https://github.com/servo/html5ever) |
| match_token | 0.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/servo/html5ever) |
| matches | 0.1.10 | `MIT` | [package](https://github.com/SimonSapin/rust-std-candidates) |
| matchit | 0.7.3 | `MIT AND BSD-3-Clause` | [package](https://github.com/ibraheemdev/matchit) |
| matrixmultiply | 0.3.10 | `MIT/Apache-2.0` | [package](https://github.com/bluss/matrixmultiply/) |
| maybe-rayon | 0.1.1 | `MIT` | [package](https://github.com/shssoichiro/maybe-rayon) |
| memchr | 2.8.0 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/memchr) |
| memoffset | 0.9.1 | `MIT` | [package](https://github.com/Gilnaa/memoffset) |
| mime | 0.3.17 | `MIT OR Apache-2.0` | [package](https://github.com/hyperium/mime) |
| minimal-lexical | 0.2.1 | `MIT/Apache-2.0` | [package](https://github.com/Alexhuszagh/minimal-lexical) |
| minisign-verify | 0.2.5 | `MIT` | [package](https://github.com/jedisct1/rust-minisign-verify) |
| miniz_oxide | 0.8.9 | `MIT OR Zlib OR Apache-2.0` | [package](https://github.com/Frommi/miniz_oxide/tree/master/miniz_oxide) |
| mio | 0.8.11 | `MIT` | [package](https://github.com/tokio-rs/mio) |
| mio | 1.2.0 | `MIT` | [package](https://github.com/tokio-rs/mio) |
| monostate | 0.1.18 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/monostate) |
| monostate-impl | 0.1.18 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/monostate) |
| moxcms | 0.8.1 | `BSD-3-Clause OR Apache-2.0` | [package](https://github.com/awxkee/moxcms.git) |
| muda | 0.17.2 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/muda) |
| ndarray | 0.16.1 | `MIT OR Apache-2.0` | [package](https://github.com/rust-ndarray/ndarray) |
| netstat2 | 0.9.1 | `MIT OR Apache-2.0` | [package](https://github.com/ohadravid/netstat2-rs) |
| new_debug_unreachable | 1.0.6 | `MIT` | [package](https://github.com/mbrubeck/rust-debug-unreachable) |
| no_std_io2 | 0.9.3 | `Apache-2.0 OR MIT` | [package](https://github.com/wcampbell0x2a/no-std-io2) |
| nodrop | 0.1.14 | `MIT/Apache-2.0` | [package](https://github.com/bluss/arrayvec) |
| nom | 7.1.3 | `MIT` | [package](https://github.com/Geal/nom) |
| nom | 8.0.0 | `MIT` | [package](https://github.com/rust-bakery/nom) |
| noop_proc_macro | 0.3.0 | `MIT` | [package](https://github.com/lu-zero/noop_proc_macro) |
| notify | 6.1.1 | `CC0-1.0` | [package](https://github.com/notify-rs/notify.git) |
| ntapi | 0.4.3 | `Apache-2.0 OR MIT` | [package](https://github.com/MSxDOS/ntapi) |
| num-bigint | 0.4.6 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-bigint) |
| num-complex | 0.4.6 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-complex) |
| num-conv | 0.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/jhpratt/num-conv) |
| num-derive | 0.3.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-derive) |
| num-derive | 0.4.2 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-derive) |
| num-integer | 0.1.46 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-integer) |
| num-rational | 0.4.2 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-rational) |
| num-traits | 0.2.19 | `MIT OR Apache-2.0` | [package](https://github.com/rust-num/num-traits) |
| number_prefix | 0.4.0 | `MIT` | [package](https://github.com/ogham/rust-number-prefix) |
| objc2 | 0.6.4 | `MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-app-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-core-foundation | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-core-graphics | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-encode | 4.1.0 | `MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-exception-helper | 0.1.1 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-foundation | 0.3.2 | `MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-io-surface | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-osa-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| objc2-web-kit | 0.3.2 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/madsmtm/objc2) |
| once_cell | 1.21.4 | `MIT OR Apache-2.0` | [package](https://github.com/matklad/once_cell) |
| onig | 6.5.1 | `MIT` | [package](https://github.com/iwillspeak/rust-onig) |
| onig_sys | 69.9.1 | `MIT` | [package](https://github.com/iwillspeak/rust-onig) |
| open | 5.3.3 | `MIT` | [package](https://github.com/Byron/open-rs) |
| openssl-probe | 0.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/rustls/openssl-probe) |
| option-ext | 0.2.0 | `MPL-2.0` | [package](https://github.com/soc/option-ext.git) |
| ordered-multimap | 0.7.3 | `MIT` | [package](https://github.com/sgodwincs/ordered-multimap-rs) |
| ordered-stream | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/danieldg/ordered-stream) |
| ort | 2.0.0-rc.9 | `MIT OR Apache-2.0` | [package](https://github.com/pykeio/ort) |
| ort-sys | 2.0.0-rc.9 | `MIT OR Apache-2.0` | [package](https://github.com/pykeio/ort) |
| os_pipe | 1.2.3 | `MIT` | [package](https://github.com/oconnor663/os_pipe.rs) |
| osakit | 0.3.1 | `MIT OR Apache-2.0` | [package](https://github.com/mdevils/rust-osakit) |
| pango | 0.18.3 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| pango-sys | 0.18.0 | `MIT` | [package](https://github.com/gtk-rs/gtk-rs-core) |
| parking | 2.2.1 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/parking) |
| parking_lot | 0.12.5 | `MIT OR Apache-2.0` | [package](https://github.com/Amanieu/parking_lot) |
| parking_lot_core | 0.9.12 | `MIT OR Apache-2.0` | [package](https://github.com/Amanieu/parking_lot) |
| paste | 1.0.15 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/paste) |
| pastey | 0.1.1 | `MIT OR Apache-2.0` | [package](https://github.com/as1100k/pastey) |
| pastey | 0.2.3 | `MIT OR Apache-2.0` | [package](https://github.com/as1100k/pastey) |
| pathdiff | 0.2.3 | `MIT/Apache-2.0` | [package](https://github.com/Manishearth/pathdiff) |
| percent-encoding | 2.3.2 | `MIT OR Apache-2.0` | [package](https://github.com/servo/rust-url/) |
| phf | 0.10.1 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| phf | 0.11.3 | `MIT` | [package](https://github.com/rust-phf/rust-phf) |
| phf | 0.8.0 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| phf_generator | 0.10.0 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| phf_generator | 0.11.3 | `MIT` | [package](https://github.com/rust-phf/rust-phf) |
| phf_macros | 0.10.0 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| phf_macros | 0.11.3 | `MIT` | [package](https://github.com/rust-phf/rust-phf) |
| phf_shared | 0.10.0 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| phf_shared | 0.11.3 | `MIT` | [package](https://github.com/rust-phf/rust-phf) |
| phf_shared | 0.8.0 | `MIT` | [package](https://github.com/sfackler/rust-phf) |
| pin-project-lite | 0.2.17 | `Apache-2.0 OR MIT` | [package](https://github.com/taiki-e/pin-project-lite) |
| piper | 0.2.5 | `MIT OR Apache-2.0` | [package](https://github.com/smol-rs/piper) |
| plist | 1.10.0 | `MIT` | [package](https://github.com/ebarnard/rust-plist/) |
| png | 0.17.16 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/image-png) |
| png | 0.18.1 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/image-png) |
| polling | 3.11.0 | `Apache-2.0 OR MIT` | [package](https://github.com/smol-rs/polling) |
| portable-atomic | 1.13.1 | `Apache-2.0 OR MIT` | [package](https://github.com/taiki-e/portable-atomic) |
| potential_utf | 0.1.5 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| powerfmt | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/jhpratt/powerfmt) |
| ppv-lite86 | 0.2.21 | `MIT OR Apache-2.0` | [package](https://github.com/cryptocorrosion/cryptocorrosion) |
| precomputed-hash | 0.1.1 | `MIT` | [package](https://github.com/emilio/precomputed-hash) |
| proc-macro-crate | 1.3.1 | `MIT OR Apache-2.0` | [package](https://github.com/bkchr/proc-macro-crate) |
| proc-macro-crate | 2.0.2 | `MIT OR Apache-2.0` | [package](https://github.com/bkchr/proc-macro-crate) |
| proc-macro-crate | 3.5.0 | `MIT OR Apache-2.0` | [package](https://github.com/bkchr/proc-macro-crate) |
| proc-macro-error | 1.0.4 | `MIT OR Apache-2.0` | [package](https://gitlab.com/CreepySkeleton/proc-macro-error) |
| proc-macro-error-attr | 1.0.4 | `MIT OR Apache-2.0` | [package](https://gitlab.com/CreepySkeleton/proc-macro-error) |
| proc-macro-hack | 0.5.20+deprecated | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/proc-macro-hack) |
| proc-macro2 | 1.0.106 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/proc-macro2) |
| profiling | 1.0.17 | `MIT OR Apache-2.0` | [package](https://github.com/aclysma/profiling) |
| profiling-procmacros | 1.0.17 | `MIT OR Apache-2.0` | [package](https://github.com/aclysma/profiling) |
| pxfm | 0.1.29 | `BSD-3-Clause OR Apache-2.0` | [package](https://github.com/awxkee/pxfm) |
| qoi | 0.4.1 | `MIT/Apache-2.0` | [package](https://github.com/aldanor/qoi-rust) |
| quick-error | 2.0.1 | `MIT/Apache-2.0` | [package](http://github.com/tailhook/quick-error) |
| quick-xml | 0.41.0 | `MIT` | [package](https://github.com/tafia/quick-xml) |
| quinn | 0.11.9 | `MIT OR Apache-2.0` | [package](https://github.com/quinn-rs/quinn) |
| quinn-proto | 0.11.16 | `MIT OR Apache-2.0` | [package](https://github.com/quinn-rs/quinn) |
| quinn-udp | 0.5.14 | `MIT OR Apache-2.0` | [package](https://github.com/quinn-rs/quinn) |
| quote | 1.0.45 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/quote) |
| rand | 0.10.2 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand | 0.8.5 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand | 0.9.4 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand_chacha | 0.3.1 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand_chacha | 0.9.0 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand_core | 0.10.1 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand_core) |
| rand_core | 0.6.4 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand_core | 0.9.5 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rand) |
| rand_pcg | 0.10.2 | `MIT OR Apache-2.0` | [package](https://github.com/rust-random/rngs) |
| rav1e | 0.8.1 | `BSD-2-Clause` | [package](https://github.com/xiph/rav1e/) |
| ravif | 0.13.0 | `BSD-3-Clause` | [package](https://github.com/kornelski/cavif-rs) |
| raw-window-handle | 0.6.2 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/rust-windowing/raw-window-handle) |
| rawpointer | 0.2.1 | `MIT/Apache-2.0` | [package](https://github.com/bluss/rawpointer/) |
| rayon | 1.12.0 | `MIT OR Apache-2.0` | [package](https://github.com/rayon-rs/rayon) |
| rayon-cond | 0.4.0 | `Apache-2.0/MIT` | [package](https://github.com/cuviper/rayon-cond) |
| rayon-core | 1.13.0 | `MIT OR Apache-2.0` | [package](https://github.com/rayon-rs/rayon) |
| ref-cast | 1.0.25 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/ref-cast) |
| ref-cast-impl | 1.0.25 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/ref-cast) |
| regex | 1.12.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/regex) |
| regex-automata | 0.4.14 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/regex) |
| regex-syntax | 0.8.10 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/regex) |
| reqwest | 0.12.28 | `MIT OR Apache-2.0` | [package](https://github.com/seanmonstar/reqwest) |
| reqwest | 0.13.2 | `MIT OR Apache-2.0` | [package](https://github.com/seanmonstar/reqwest) |
| rfd | 0.16.0 | `MIT` | [package](https://github.com/PolyMeilex/rfd) |
| rgb | 0.8.53 | `MIT` | [package](https://github.com/kornelski/rust-rgb) |
| ring | 0.17.14 | `Apache-2.0 AND ISC` | [package](https://github.com/briansmith/ring) |
| rmcp | 1.7.0 | `Apache-2.0` | [package](https://github.com/modelcontextprotocol/rust-sdk/) |
| rmcp-macros | 1.7.0 | `Apache-2.0` | [package](https://github.com/modelcontextprotocol/rust-sdk/) |
| rusqlite | 0.32.1 | `MIT` | [package](https://github.com/rusqlite/rusqlite) |
| rust-ini | 0.21.3 | `MIT` | [package](https://github.com/zonyitoo/rust-ini) |
| rustc-hash | 2.1.2 | `Apache-2.0 OR MIT` | [package](https://github.com/rust-lang/rustc-hash) |
| rustix | 1.1.4 | `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT` | [package](https://github.com/bytecodealliance/rustix) |
| rustls | 0.23.38 | `Apache-2.0 OR ISC OR MIT` | [package](https://github.com/rustls/rustls) |
| rustls-native-certs | 0.8.3 | `Apache-2.0 OR ISC OR MIT` | [package](https://github.com/rustls/rustls-native-certs) |
| rustls-pki-types | 1.14.0 | `MIT OR Apache-2.0` | [package](https://github.com/rustls/pki-types) |
| rustls-platform-verifier | 0.6.2 | `MIT OR Apache-2.0` | [package](https://github.com/rustls/rustls-platform-verifier) |
| rustls-webpki | 0.103.13 | `ISC` | [package](https://github.com/rustls/webpki) |
| rustversion | 1.0.22 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/rustversion) |
| ryu | 1.0.23 | `Apache-2.0 OR BSL-1.0` | [package](https://github.com/dtolnay/ryu) |
| same-file | 1.0.6 | `Unlicense/MIT` | [package](https://github.com/BurntSushi/same-file) |
| schemars | 0.8.22 | `MIT` | [package](https://github.com/GREsau/schemars) |
| schemars | 0.9.0 | `MIT` | [package](https://github.com/GREsau/schemars) |
| schemars | 1.2.1 | `MIT` | [package](https://github.com/GREsau/schemars) |
| schemars_derive | 0.8.22 | `MIT` | [package](https://github.com/GREsau/schemars) |
| schemars_derive | 1.2.1 | `MIT` | [package](https://github.com/GREsau/schemars) |
| scopeguard | 1.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/bluss/scopeguard) |
| security-framework | 3.7.0 | `MIT OR Apache-2.0` | [package](https://github.com/kornelski/rust-security-framework) |
| security-framework-sys | 2.17.0 | `MIT OR Apache-2.0` | [package](https://github.com/kornelski/rust-security-framework) |
| selectors | 0.24.0 | `MPL-2.0` | [package](https://github.com/servo/servo) |
| semver | 1.0.28 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/semver) |
| serde | 1.0.228 | `MIT OR Apache-2.0` | [package](https://github.com/serde-rs/serde) |
| serde_core | 1.0.228 | `MIT OR Apache-2.0` | [package](https://github.com/serde-rs/serde) |
| serde_derive | 1.0.228 | `MIT OR Apache-2.0` | [package](https://github.com/serde-rs/serde) |
| serde_derive_internals | 0.29.1 | `MIT OR Apache-2.0` | [package](https://github.com/serde-rs/serde) |
| serde_json | 1.0.149 | `MIT OR Apache-2.0` | [package](https://github.com/serde-rs/json) |
| serde_path_to_error | 0.1.20 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/path-to-error) |
| serde_repr | 0.1.20 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/serde-repr) |
| serde_spanned | 0.6.9 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| serde_spanned | 1.1.1 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| serde_urlencoded | 0.7.1 | `MIT/Apache-2.0` | [package](https://github.com/nox/serde_urlencoded) |
| serde_with | 3.18.0 | `MIT OR Apache-2.0` | [package](https://github.com/jonasbb/serde_with/) |
| serde_with_macros | 3.18.0 | `MIT OR Apache-2.0` | [package](https://github.com/jonasbb/serde_with/) |
| serde-untagged | 0.1.9 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/serde-untagged) |
| serialize-to-javascript | 0.1.2 | `MIT OR Apache-2.0` | [package](https://github.com/chippers/serialize-to-javascript) |
| serialize-to-javascript-impl | 0.1.2 | `MIT OR Apache-2.0` | [package](https://github.com/chippers/serialize-to-javascript) |
| servo_arc | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/servo/servo) |
| sha1_smol | 1.0.1 | `BSD-3-Clause` | [package](https://github.com/mitsuhiko/sha1-smol) |
| sha2 | 0.10.9 | `MIT OR Apache-2.0` | [package](https://github.com/RustCrypto/hashes) |
| shared_child | 1.1.1 | `MIT` | [package](https://github.com/oconnor663/shared_child.rs) |
| sigchld | 0.2.4 | `MIT` | [package](https://github.com/oconnor663/sigchld.rs) |
| signal-hook | 0.3.18 | `Apache-2.0/MIT` | [package](https://github.com/vorner/signal-hook) |
| signal-hook-registry | 1.4.8 | `MIT OR Apache-2.0` | [package](https://github.com/vorner/signal-hook) |
| simd_helpers | 0.1.0 | `MIT` | [package](https://github.com/lu-zero/simd_helpers) |
| simd-adler32 | 0.3.9 | `MIT` | [package](https://github.com/mcountryman/simd-adler32) |
| siphasher | 0.3.11 | `MIT/Apache-2.0` | [package](https://github.com/jedisct1/rust-siphash) |
| siphasher | 1.0.2 | `MIT/Apache-2.0` | [package](https://github.com/jedisct1/rust-siphash) |
| slab | 0.4.12 | `MIT` | [package](https://github.com/tokio-rs/slab) |
| slug | 0.1.6 | `MIT/Apache-2.0` | [package](https://github.com/Stebalien/slug-rs) |
| smallvec | 1.15.1 | `MIT OR Apache-2.0` | [package](https://github.com/servo/rust-smallvec) |
| socket2 | 0.6.3 | `MIT OR Apache-2.0` | [package](https://github.com/rust-lang/socket2) |
| socks | 0.3.4 | `MIT/Apache-2.0` | [package](https://github.com/sfackler/rust-socks) |
| softbuffer | 0.4.8 | `MIT OR Apache-2.0` | [package](https://github.com/rust-windowing/softbuffer) |
| soup3 | 0.5.0 | `MIT` | [package](https://gitlab.gnome.org/World/Rust/soup3-rs) |
| soup3-sys | 0.5.0 | `MIT` | [package](https://gitlab.gnome.org/World/Rust/soup3-rs) |
| spm_precompiled | 0.1.4 | `Apache-2.0` | [package](https://github.com/huggingface/spm_precompiled) |
| stable_deref_trait | 1.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/storyyeller/stable_deref_trait) |
| static_assertions | 1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/nvzqz/static-assertions-rs) |
| streaming-iterator | 0.1.9 | `MIT OR Apache-2.0` | [package](https://github.com/sfackler/streaming-iterator) |
| string_cache | 0.8.9 | `MIT OR Apache-2.0` | [package](https://github.com/servo/string-cache) |
| strsim | 0.11.1 | `MIT` | [package](https://github.com/rapidfuzz/strsim-rs) |
| subtle | 2.6.1 | `BSD-3-Clause` | [package](https://github.com/dalek-cryptography/subtle) |
| swift-rs | 1.0.7 | `MIT OR Apache-2.0` | [package](https://github.com/Brendonovich/swift-rs) |
| syn | 1.0.109 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/syn) |
| syn | 2.0.117 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/syn) |
| sync_wrapper | 1.0.2 | `Apache-2.0` | [package](https://github.com/Actyx/sync_wrapper) |
| synstructure | 0.13.2 | `MIT` | [package](https://github.com/mystor/synstructure) |
| sysinfo | 0.30.13 | `MIT` | [package](https://github.com/GuillaumeGomez/sysinfo) |
| tao | 0.34.8 | `Apache-2.0` | [package](https://github.com/tauri-apps/tao) |
| tar | 0.4.45 | `MIT OR Apache-2.0` | [package](https://github.com/alexcrichton/tar-rs) |
| tauri | 2.10.3 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tauri-codegen | 2.5.5 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tauri-macros | 2.5.5 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tauri-plugin-deep-link | 2.4.7 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-dialog | 2.7.0 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-fs | 2.5.0 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-global-shortcut | 2.3.1 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-process | 2.3.1 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-shell | 2.3.5 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-single-instance | 2.4.0 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-plugin-updater | 2.10.1 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/plugins-workspace) |
| tauri-runtime | 2.10.1 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tauri-runtime-wry | 2.10.1 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tauri-utils | 2.8.3 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri) |
| tempfile | 3.27.0 | `MIT OR Apache-2.0` | [package](https://github.com/Stebalien/tempfile) |
| tendril | 0.4.3 | `MIT/Apache-2.0` | [package](https://github.com/servo/tendril) |
| thiserror | 1.0.69 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/thiserror) |
| thiserror | 2.0.18 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/thiserror) |
| thiserror-impl | 1.0.69 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/thiserror) |
| thiserror-impl | 2.0.18 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/thiserror) |
| tiff | 0.11.3 | `MIT` | [package](https://github.com/image-rs/image-tiff) |
| time | 0.3.47 | `MIT OR Apache-2.0` | [package](https://github.com/time-rs/time) |
| time-core | 0.1.8 | `MIT OR Apache-2.0` | [package](https://github.com/time-rs/time) |
| time-macros | 0.2.27 | `MIT OR Apache-2.0` | [package](https://github.com/time-rs/time) |
| tiny-keccak | 2.0.2 | `CC0-1.0` | [package](https://github.com/debris/tiny-keccak) |
| tinystr | 0.8.3 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| tinyvec | 1.11.0 | `Zlib OR Apache-2.0 OR MIT` | [package](https://github.com/Lokathor/tinyvec) |
| tinyvec_macros | 0.1.1 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/Soveu/tinyvec_macros) |
| tokenizers | 0.21.4 | `Apache-2.0` | [package](https://github.com/huggingface/tokenizers) |
| tokio | 1.51.1 | `MIT` | [package](https://github.com/tokio-rs/tokio) |
| tokio-macros | 2.7.0 | `MIT` | [package](https://github.com/tokio-rs/tokio) |
| tokio-rustls | 0.26.4 | `MIT OR Apache-2.0` | [package](https://github.com/rustls/tokio-rustls) |
| tokio-util | 0.7.18 | `MIT` | [package](https://github.com/tokio-rs/tokio) |
| toml | 0.9.12+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_datetime | 0.6.3 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_datetime | 0.7.5+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_datetime | 1.1.1+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_edit | 0.19.15 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_edit | 0.20.2 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_edit | 0.25.11+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_parser | 1.1.2+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| toml_writer | 1.1.1+spec-1.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/toml-rs/toml) |
| tower | 0.5.3 | `MIT` | [package](https://github.com/tower-rs/tower) |
| tower-http | 0.5.2 | `MIT` | [package](https://github.com/tower-rs/tower-http) |
| tower-http | 0.6.8 | `MIT` | [package](https://github.com/tower-rs/tower-http) |
| tower-layer | 0.3.3 | `MIT` | [package](https://github.com/tower-rs/tower) |
| tower-service | 0.3.3 | `MIT` | [package](https://github.com/tower-rs/tower) |
| tracing | 0.1.44 | `MIT` | [package](https://github.com/tokio-rs/tracing) |
| tracing-attributes | 0.1.31 | `MIT` | [package](https://github.com/tokio-rs/tracing) |
| tracing-core | 0.1.36 | `MIT` | [package](https://github.com/tokio-rs/tracing) |
| tray-icon | 0.21.3 | `MIT OR Apache-2.0` | [package](https://github.com/tauri-apps/tray-icon) |
| tree-sitter | 0.24.7 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter) |
| tree-sitter-c-sharp | 0.23.1 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-c-sharp) |
| tree-sitter-go | 0.23.4 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-go) |
| tree-sitter-java | 0.23.5 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-java) |
| tree-sitter-language | 0.1.7 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter) |
| tree-sitter-python | 0.23.6 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-python) |
| tree-sitter-ruby | 0.23.1 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-ruby) |
| tree-sitter-rust | 0.23.3 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-rust) |
| tree-sitter-typescript | 0.23.2 | `MIT` | [package](https://github.com/tree-sitter/tree-sitter-typescript) |
| try-lock | 0.2.5 | `MIT` | [package](https://github.com/seanmonstar/try-lock) |
| typeid | 1.0.3 | `MIT OR Apache-2.0` | [package](https://github.com/dtolnay/typeid) |
| typenum | 1.19.0 | `MIT OR Apache-2.0` | [package](https://github.com/paholg/typenum) |
| unic-char-property | 0.9.0 | `MIT/Apache-2.0` | [package](https://github.com/open-i18n/rust-unic/) |
| unic-char-range | 0.9.0 | `MIT/Apache-2.0` | [package](https://github.com/open-i18n/rust-unic/) |
| unic-common | 0.9.0 | `MIT/Apache-2.0` | [package](https://github.com/open-i18n/rust-unic/) |
| unic-ucd-ident | 0.9.0 | `MIT/Apache-2.0` | [package](https://github.com/open-i18n/rust-unic/) |
| unic-ucd-version | 0.9.0 | `MIT/Apache-2.0` | [package](https://github.com/open-i18n/rust-unic/) |
| unicode_categories | 0.1.1 | `MIT OR Apache-2.0` | [package](https://github.com/swgillespie/unicode-categories) |
| unicode-ident | 1.0.24 | `(MIT OR Apache-2.0) AND Unicode-3.0` | [package](https://github.com/dtolnay/unicode-ident) |
| unicode-normalization-alignments | 0.1.12 | `MIT/Apache-2.0` | [package](https://github.com/n1t0/unicode-normalization) |
| unicode-segmentation | 1.13.2 | `MIT OR Apache-2.0` | [package](https://github.com/unicode-rs/unicode-segmentation) |
| unicode-width | 0.2.2 | `MIT OR Apache-2.0` | [package](https://github.com/unicode-rs/unicode-width) |
| untrusted | 0.9.0 | `ISC` | [package](https://github.com/briansmith/untrusted) |
| ureq | 2.12.1 | `MIT OR Apache-2.0` | [package](https://github.com/algesten/ureq) |
| url | 2.5.8 | `MIT OR Apache-2.0` | [package](https://github.com/servo/rust-url) |
| urlpattern | 0.3.0 | `MIT` | [package](https://github.com/denoland/rust-urlpattern) |
| utf-8 | 0.7.6 | `MIT OR Apache-2.0` | [package](https://github.com/SimonSapin/rust-utf8) |
| utf8_iter | 1.0.4 | `Apache-2.0 OR MIT` | [package](https://github.com/hsivonen/utf8_iter) |
| uuid | 1.23.0 | `Apache-2.0 OR MIT` | [package](https://github.com/uuid-rs/uuid) |
| v_frame | 0.3.9 | `BSD-2-Clause` | [package](https://github.com/rust-av/v_frame) |
| walkdir | 2.5.0 | `Unlicense/MIT` | [package](https://github.com/BurntSushi/walkdir) |
| want | 0.3.1 | `MIT` | [package](https://github.com/seanmonstar/want) |
| wasm-bindgen | 0.2.118 | `MIT OR Apache-2.0` | [package](https://github.com/wasm-bindgen/wasm-bindgen) |
| wasm-bindgen-macro | 0.2.118 | `MIT OR Apache-2.0` | [package](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro) |
| wasm-bindgen-macro-support | 0.2.118 | `MIT OR Apache-2.0` | [package](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/macro-support) |
| wasm-bindgen-shared | 0.2.118 | `MIT OR Apache-2.0` | [package](https://github.com/wasm-bindgen/wasm-bindgen/tree/master/crates/shared) |
| webkit2gtk | 2.0.2 | `MIT` | [package](https://github.com/tauri-apps/webkit2gtk-rs) |
| webkit2gtk-sys | 2.0.2 | `MIT` | [package](https://github.com/tauri-apps/webkit2gtk-rs) |
| webpki-roots | 0.26.11 | `CDLA-Permissive-2.0` | [package](https://github.com/rustls/webpki-roots) |
| webpki-roots | 1.0.7 | `CDLA-Permissive-2.0` | [package](https://github.com/rustls/webpki-roots) |
| webview2-com | 0.38.2 | `MIT` | [package](https://github.com/wravery/webview2-rs) |
| webview2-com-macros | 0.8.1 | `MIT` | [package](https://github.com/wravery/webview2-rs) |
| webview2-com-sys | 0.38.2 | `MIT` | [package](https://github.com/wravery/webview2-rs) |
| weezl | 0.1.12 | `MIT OR Apache-2.0` | [package](https://github.com/image-rs/weezl) |
| winapi | 0.3.9 | `MIT/Apache-2.0` | [package](https://github.com/retep998/winapi-rs) |
| winapi-util | 0.1.11 | `Unlicense OR MIT` | [package](https://github.com/BurntSushi/winapi-util) |
| window-vibrancy | 0.6.0 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/tauri-plugin-vibrancy) |
| windows | 0.52.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows | 0.61.3 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows_x86_64_msvc | 0.48.5 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows_x86_64_msvc | 0.52.6 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows_x86_64_msvc | 0.53.1 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-collections | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-core | 0.52.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-core | 0.61.2 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-future | 0.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-implement | 0.60.2 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-interface | 0.59.3 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-link | 0.1.3 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-link | 0.2.1 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-numerics | 0.2.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-registry | 0.5.3 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-result | 0.3.4 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-strings | 0.4.2 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-sys | 0.48.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-sys | 0.59.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-sys | 0.60.2 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-sys | 0.61.2 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-targets | 0.48.5 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-targets | 0.52.6 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-targets | 0.53.5 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-threading | 0.1.0 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| windows-version | 0.1.7 | `MIT OR Apache-2.0` | [package](https://github.com/microsoft/windows-rs) |
| winnow | 0.5.40 | `MIT` | [package](https://github.com/winnow-rs/winnow) |
| winnow | 0.7.15 | `MIT` | [package](https://github.com/winnow-rs/winnow) |
| winnow | 1.0.1 | `MIT` | [package](https://github.com/winnow-rs/winnow) |
| writeable | 0.6.3 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| wry | 0.54.4 | `Apache-2.0 OR MIT` | [package](https://github.com/tauri-apps/wry) |
| x11 | 2.21.0 | `MIT` | [package](https://github.com/AltF02/x11-rs.git) |
| x11-dl | 2.21.0 | `MIT` | [package](https://github.com/AltF02/x11-rs.git) |
| x11rb | 0.13.2 | `MIT OR Apache-2.0` | [package](https://github.com/psychon/x11rb) |
| x11rb-protocol | 0.13.2 | `MIT OR Apache-2.0` | [package](https://github.com/psychon/x11rb) |
| xattr | 1.6.1 | `MIT OR Apache-2.0` | [package](https://github.com/Stebalien/xattr) |
| xkeysym | 0.2.1 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/notgull/xkeysym) |
| y4m | 0.8.0 | `MIT` | [package](https://github.com/image-rs/y4m.git) |
| yoke | 0.8.2 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| yoke-derive | 0.8.2 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zbus | 5.14.0 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |
| zbus_macros | 5.14.0 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |
| zbus_names | 4.3.1 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |
| zerocopy | 0.8.48 | `BSD-2-Clause OR Apache-2.0 OR MIT` | [package](https://github.com/google/zerocopy) |
| zerocopy-derive | 0.8.48 | `BSD-2-Clause OR Apache-2.0 OR MIT` | [package](https://github.com/google/zerocopy) |
| zerofrom | 0.1.7 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zerofrom-derive | 0.1.7 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zeroize | 1.8.2 | `Apache-2.0 OR MIT` | [package](https://github.com/RustCrypto/utils) |
| zerotrie | 0.2.4 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zerovec | 0.11.6 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zerovec-derive | 0.11.3 | `Unicode-3.0` | [package](https://github.com/unicode-org/icu4x) |
| zip | 2.4.2 | `MIT` | [package](https://github.com/zip-rs/zip2.git) |
| zip | 4.6.1 | `MIT` | [package](https://github.com/zip-rs/zip2.git) |
| zmij | 1.0.21 | `MIT` | [package](https://github.com/dtolnay/zmij) |
| zopfli | 0.8.3 | `Apache-2.0` | [package](https://github.com/zopfli-rs/zopfli) |
| zune-core | 0.5.1 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/etemesi254/zune-image) |
| zune-inflate | 0.2.54 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/etemesi254/zune-image/tree/main/zune-inflate) |
| zune-jpeg | 0.5.15 | `MIT OR Apache-2.0 OR Zlib` | [package](https://github.com/etemesi254/zune-image/tree/dev/crates/zune-jpeg) |
| zvariant | 5.10.0 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |
| zvariant_derive | 5.10.0 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |
| zvariant_utils | 3.3.0 | `MIT` | [package](https://github.com/z-galaxy/zbus/) |

## npm production dependency inventory (140)

This is the transitive production graph selected from the root
`package-lock.json` for the supported release operating systems and CPU
architectures. It covers code that can ship in the desktop webview. Tooling and
test-only packages are excluded.

License expression summary:

| License declared by package | Count |
|---|---:|
| `0BSD` | 1 |
| `Apache-2.0 OR MIT` | 1 |
| `BSD-3-Clause` | 5 |
| `ISC` | 16 |
| `MIT` | 111 |
| `MIT OR Apache-2.0` | 6 |

| Package | Version | Declared license | Package |
|---|---:|---|---|
| @babel/runtime | 7.29.2 | `MIT` | [package](https://www.npmjs.com/package/@babel/runtime/v/7.29.2) |
| @codemirror/autocomplete | 6.20.1 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/autocomplete/v/6.20.1) |
| @codemirror/commands | 6.10.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/commands/v/6.10.3) |
| @codemirror/lang-angular | 0.1.4 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-angular/v/0.1.4) |
| @codemirror/lang-cpp | 6.0.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-cpp/v/6.0.3) |
| @codemirror/lang-css | 6.3.1 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-css/v/6.3.1) |
| @codemirror/lang-go | 6.0.1 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-go/v/6.0.1) |
| @codemirror/lang-html | 6.4.11 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-html/v/6.4.11) |
| @codemirror/lang-java | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-java/v/6.0.2) |
| @codemirror/lang-javascript | 6.2.5 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-javascript/v/6.2.5) |
| @codemirror/lang-jinja | 6.0.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-jinja/v/6.0.0) |
| @codemirror/lang-json | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-json/v/6.0.2) |
| @codemirror/lang-less | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-less/v/6.0.2) |
| @codemirror/lang-liquid | 6.3.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-liquid/v/6.3.2) |
| @codemirror/lang-markdown | 6.5.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-markdown/v/6.5.0) |
| @codemirror/lang-php | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-php/v/6.0.2) |
| @codemirror/lang-python | 6.2.1 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-python/v/6.2.1) |
| @codemirror/lang-rust | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-rust/v/6.0.2) |
| @codemirror/lang-sass | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-sass/v/6.0.2) |
| @codemirror/lang-sql | 6.10.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-sql/v/6.10.0) |
| @codemirror/lang-vue | 0.1.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-vue/v/0.1.3) |
| @codemirror/lang-wast | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-wast/v/6.0.2) |
| @codemirror/lang-xml | 6.1.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-xml/v/6.1.0) |
| @codemirror/lang-yaml | 6.1.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lang-yaml/v/6.1.3) |
| @codemirror/language | 6.12.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/language/v/6.12.3) |
| @codemirror/language-data | 6.5.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/language-data/v/6.5.2) |
| @codemirror/legacy-modes | 6.5.2 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/legacy-modes/v/6.5.2) |
| @codemirror/lint | 6.9.5 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/lint/v/6.9.5) |
| @codemirror/search | 6.6.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/search/v/6.6.0) |
| @codemirror/state | 6.6.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/state/v/6.6.0) |
| @codemirror/theme-one-dark | 6.1.3 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/theme-one-dark/v/6.1.3) |
| @codemirror/view | 6.41.0 | `MIT` | [package](https://www.npmjs.com/package/@codemirror/view/v/6.41.0) |
| @dnd-kit/accessibility | 3.1.1 | `MIT` | [package](https://www.npmjs.com/package/@dnd-kit/accessibility/v/3.1.1) |
| @dnd-kit/core | 6.3.1 | `MIT` | [package](https://www.npmjs.com/package/@dnd-kit/core/v/6.3.1) |
| @dnd-kit/sortable | 10.0.0 | `MIT` | [package](https://www.npmjs.com/package/@dnd-kit/sortable/v/10.0.0) |
| @dnd-kit/utilities | 3.2.2 | `MIT` | [package](https://www.npmjs.com/package/@dnd-kit/utilities/v/3.2.2) |
| @lezer/common | 1.5.2 | `MIT` | [package](https://www.npmjs.com/package/@lezer/common/v/1.5.2) |
| @lezer/cpp | 1.1.5 | `MIT` | [package](https://www.npmjs.com/package/@lezer/cpp/v/1.1.5) |
| @lezer/css | 1.3.3 | `MIT` | [package](https://www.npmjs.com/package/@lezer/css/v/1.3.3) |
| @lezer/go | 1.0.1 | `MIT` | [package](https://www.npmjs.com/package/@lezer/go/v/1.0.1) |
| @lezer/highlight | 1.2.3 | `MIT` | [package](https://www.npmjs.com/package/@lezer/highlight/v/1.2.3) |
| @lezer/html | 1.3.13 | `MIT` | [package](https://www.npmjs.com/package/@lezer/html/v/1.3.13) |
| @lezer/java | 1.1.3 | `MIT` | [package](https://www.npmjs.com/package/@lezer/java/v/1.1.3) |
| @lezer/javascript | 1.5.4 | `MIT` | [package](https://www.npmjs.com/package/@lezer/javascript/v/1.5.4) |
| @lezer/json | 1.0.3 | `MIT` | [package](https://www.npmjs.com/package/@lezer/json/v/1.0.3) |
| @lezer/lr | 1.4.8 | `MIT` | [package](https://www.npmjs.com/package/@lezer/lr/v/1.4.8) |
| @lezer/markdown | 1.6.3 | `MIT` | [package](https://www.npmjs.com/package/@lezer/markdown/v/1.6.3) |
| @lezer/php | 1.0.5 | `MIT` | [package](https://www.npmjs.com/package/@lezer/php/v/1.0.5) |
| @lezer/python | 1.1.18 | `MIT` | [package](https://www.npmjs.com/package/@lezer/python/v/1.1.18) |
| @lezer/rust | 1.0.2 | `MIT` | [package](https://www.npmjs.com/package/@lezer/rust/v/1.0.2) |
| @lezer/sass | 1.1.0 | `MIT` | [package](https://www.npmjs.com/package/@lezer/sass/v/1.1.0) |
| @lezer/xml | 1.0.6 | `MIT` | [package](https://www.npmjs.com/package/@lezer/xml/v/1.0.6) |
| @lezer/yaml | 1.0.4 | `MIT` | [package](https://www.npmjs.com/package/@lezer/yaml/v/1.0.4) |
| @marijn/find-cluster-break | 1.0.2 | `MIT` | [package](https://www.npmjs.com/package/@marijn/find-cluster-break/v/1.0.2) |
| @sigma/edge-curve | 3.1.0 | `MIT` | [package](https://www.npmjs.com/package/@sigma/edge-curve/v/3.1.0) |
| @sigma/export-image | 3.0.0 | `MIT` | [package](https://www.npmjs.com/package/@sigma/export-image/v/3.0.0) |
| @sigma/node-border | 3.0.0 | `MIT` | [package](https://www.npmjs.com/package/@sigma/node-border/v/3.0.0) |
| @tanstack/react-virtual | 3.13.23 | `MIT` | [package](https://www.npmjs.com/package/@tanstack/react-virtual/v/3.13.23) |
| @tanstack/virtual-core | 3.13.23 | `MIT` | [package](https://www.npmjs.com/package/@tanstack/virtual-core/v/3.13.23) |
| @tauri-apps/api | 2.10.1 | `Apache-2.0 OR MIT` | [package](https://www.npmjs.com/package/@tauri-apps/api/v/2.10.1) |
| @tauri-apps/plugin-deep-link | 2.4.8 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-deep-link/v/2.4.8) |
| @tauri-apps/plugin-dialog | 2.7.0 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-dialog/v/2.7.0) |
| @tauri-apps/plugin-fs | 2.5.0 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-fs/v/2.5.0) |
| @tauri-apps/plugin-process | 2.3.1 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-process/v/2.3.1) |
| @tauri-apps/plugin-shell | 2.3.5 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-shell/v/2.3.5) |
| @tauri-apps/plugin-updater | 2.10.1 | `MIT OR Apache-2.0` | [package](https://www.npmjs.com/package/@tauri-apps/plugin-updater/v/2.10.1) |
| @tweenjs/tween.js | 25.0.0 | `MIT` | [package](https://www.npmjs.com/package/@tweenjs/tween.js/v/25.0.0) |
| @types/react | 19.2.14 | `MIT` | [package](https://www.npmjs.com/package/@types/react/v/19.2.14) |
| @uiw/codemirror-extensions-basic-setup | 4.25.9 | `MIT` | [package](https://www.npmjs.com/package/@uiw/codemirror-extensions-basic-setup/v/4.25.9) |
| @uiw/react-codemirror | 4.25.9 | `MIT` | [package](https://www.npmjs.com/package/@uiw/react-codemirror/v/4.25.9) |
| 3d-force-graph | 1.80.0 | `MIT` | [package](https://www.npmjs.com/package/3d-force-graph/v/1.80.0) |
| accessor-fn | 1.5.3 | `MIT` | [package](https://www.npmjs.com/package/accessor-fn/v/1.5.3) |
| bezier-js | 6.1.4 | `MIT` | [package](https://www.npmjs.com/package/bezier-js/v/6.1.4) |
| canvas-color-tracker | 1.3.2 | `MIT` | [package](https://www.npmjs.com/package/canvas-color-tracker/v/1.3.2) |
| codemirror | 6.0.2 | `MIT` | [package](https://www.npmjs.com/package/codemirror/v/6.0.2) |
| crelt | 1.0.6 | `MIT` | [package](https://www.npmjs.com/package/crelt/v/1.0.6) |
| csstype | 3.2.3 | `MIT` | [package](https://www.npmjs.com/package/csstype/v/3.2.3) |
| d3-array | 3.2.4 | `ISC` | [package](https://www.npmjs.com/package/d3-array/v/3.2.4) |
| d3-binarytree | 1.0.2 | `MIT` | [package](https://www.npmjs.com/package/d3-binarytree/v/1.0.2) |
| d3-color | 3.1.0 | `ISC` | [package](https://www.npmjs.com/package/d3-color/v/3.1.0) |
| d3-dispatch | 3.0.1 | `ISC` | [package](https://www.npmjs.com/package/d3-dispatch/v/3.0.1) |
| d3-drag | 3.0.0 | `ISC` | [package](https://www.npmjs.com/package/d3-drag/v/3.0.0) |
| d3-ease | 3.0.1 | `BSD-3-Clause` | [package](https://www.npmjs.com/package/d3-ease/v/3.0.1) |
| d3-force-3d | 3.0.6 | `MIT` | [package](https://www.npmjs.com/package/d3-force-3d/v/3.0.6) |
| d3-format | 3.1.2 | `ISC` | [package](https://www.npmjs.com/package/d3-format/v/3.1.2) |
| d3-interpolate | 3.0.1 | `ISC` | [package](https://www.npmjs.com/package/d3-interpolate/v/3.0.1) |
| d3-octree | 1.1.0 | `MIT` | [package](https://www.npmjs.com/package/d3-octree/v/1.1.0) |
| d3-quadtree | 3.0.1 | `ISC` | [package](https://www.npmjs.com/package/d3-quadtree/v/3.0.1) |
| d3-scale | 4.0.2 | `ISC` | [package](https://www.npmjs.com/package/d3-scale/v/4.0.2) |
| d3-scale-chromatic | 3.1.0 | `ISC` | [package](https://www.npmjs.com/package/d3-scale-chromatic/v/3.1.0) |
| d3-selection | 3.0.0 | `ISC` | [package](https://www.npmjs.com/package/d3-selection/v/3.0.0) |
| d3-time | 3.1.0 | `ISC` | [package](https://www.npmjs.com/package/d3-time/v/3.1.0) |
| d3-time-format | 4.1.0 | `ISC` | [package](https://www.npmjs.com/package/d3-time-format/v/4.1.0) |
| d3-timer | 3.0.1 | `ISC` | [package](https://www.npmjs.com/package/d3-timer/v/3.0.1) |
| d3-transition | 3.0.1 | `ISC` | [package](https://www.npmjs.com/package/d3-transition/v/3.0.1) |
| d3-zoom | 3.0.0 | `ISC` | [package](https://www.npmjs.com/package/d3-zoom/v/3.0.0) |
| data-bind-mapper | 1.0.3 | `MIT` | [package](https://www.npmjs.com/package/data-bind-mapper/v/1.0.3) |
| events | 3.3.0 | `MIT` | [package](https://www.npmjs.com/package/events/v/3.3.0) |
| file-saver | 2.0.5 | `MIT` | [package](https://www.npmjs.com/package/file-saver/v/2.0.5) |
| float-tooltip | 1.7.5 | `MIT` | [package](https://www.npmjs.com/package/float-tooltip/v/1.7.5) |
| force-graph | 1.51.4 | `MIT` | [package](https://www.npmjs.com/package/force-graph/v/1.51.4) |
| framer-motion | 11.18.2 | `MIT` | [package](https://www.npmjs.com/package/framer-motion/v/11.18.2) |
| graphology | 0.26.0 | `MIT` | [package](https://www.npmjs.com/package/graphology/v/0.26.0) |
| graphology-layout-forceatlas2 | 0.10.1 | `MIT` | [package](https://www.npmjs.com/package/graphology-layout-forceatlas2/v/0.10.1) |
| graphology-types | 0.24.8 | `MIT` | [package](https://www.npmjs.com/package/graphology-types/v/0.24.8) |
| graphology-utils | 2.5.2 | `MIT` | [package](https://www.npmjs.com/package/graphology-utils/v/2.5.2) |
| index-array-by | 1.4.2 | `MIT` | [package](https://www.npmjs.com/package/index-array-by/v/1.4.2) |
| internmap | 2.0.3 | `ISC` | [package](https://www.npmjs.com/package/internmap/v/2.0.3) |
| jerrypick | 1.1.2 | `MIT` | [package](https://www.npmjs.com/package/jerrypick/v/1.1.2) |
| js-tokens | 4.0.0 | `MIT` | [package](https://www.npmjs.com/package/js-tokens/v/4.0.0) |
| kapsule | 1.16.3 | `MIT` | [package](https://www.npmjs.com/package/kapsule/v/1.16.3) |
| lodash-es | 4.18.1 | `MIT` | [package](https://www.npmjs.com/package/lodash-es/v/4.18.1) |
| loose-envify | 1.4.0 | `MIT` | [package](https://www.npmjs.com/package/loose-envify/v/1.4.0) |
| motion-dom | 11.18.1 | `MIT` | [package](https://www.npmjs.com/package/motion-dom/v/11.18.1) |
| motion-utils | 11.18.1 | `MIT` | [package](https://www.npmjs.com/package/motion-utils/v/11.18.1) |
| ngraph.events | 1.4.0 | `BSD-3-Clause` | [package](https://www.npmjs.com/package/ngraph.events/v/1.4.0) |
| ngraph.forcelayout | 3.3.1 | `BSD-3-Clause` | [package](https://www.npmjs.com/package/ngraph.forcelayout/v/3.3.1) |
| ngraph.graph | 20.1.2 | `BSD-3-Clause` | [package](https://www.npmjs.com/package/ngraph.graph/v/20.1.2) |
| ngraph.merge | 1.0.0 | `MIT` | [package](https://www.npmjs.com/package/ngraph.merge/v/1.0.0) |
| ngraph.random | 1.2.0 | `BSD-3-Clause` | [package](https://www.npmjs.com/package/ngraph.random/v/1.2.0) |
| object-assign | 4.1.1 | `MIT` | [package](https://www.npmjs.com/package/object-assign/v/4.1.1) |
| polished | 4.3.1 | `MIT` | [package](https://www.npmjs.com/package/polished/v/4.3.1) |
| preact | 10.29.1 | `MIT` | [package](https://www.npmjs.com/package/preact/v/10.29.1) |
| prop-types | 15.8.1 | `MIT` | [package](https://www.npmjs.com/package/prop-types/v/15.8.1) |
| react | 19.2.5 | `MIT` | [package](https://www.npmjs.com/package/react/v/19.2.5) |
| react-dom | 19.2.5 | `MIT` | [package](https://www.npmjs.com/package/react-dom/v/19.2.5) |
| react-force-graph-2d | 1.29.1 | `MIT` | [package](https://www.npmjs.com/package/react-force-graph-2d/v/1.29.1) |
| react-force-graph-3d | 1.29.1 | `MIT` | [package](https://www.npmjs.com/package/react-force-graph-3d/v/1.29.1) |
| react-is | 16.13.1 | `MIT` | [package](https://www.npmjs.com/package/react-is/v/16.13.1) |
| react-kapsule | 2.5.7 | `MIT` | [package](https://www.npmjs.com/package/react-kapsule/v/2.5.7) |
| scheduler | 0.27.0 | `MIT` | [package](https://www.npmjs.com/package/scheduler/v/0.27.0) |
| sigma | 3.0.3 | `MIT` | [package](https://www.npmjs.com/package/sigma/v/3.0.3) |
| style-mod | 4.1.3 | `MIT` | [package](https://www.npmjs.com/package/style-mod/v/4.1.3) |
| three | 0.184.0 | `MIT` | [package](https://www.npmjs.com/package/three/v/0.184.0) |
| three-forcegraph | 1.43.4 | `MIT` | [package](https://www.npmjs.com/package/three-forcegraph/v/1.43.4) |
| three-render-objects | 1.41.1 | `MIT` | [package](https://www.npmjs.com/package/three-render-objects/v/1.41.1) |
| tinycolor2 | 1.6.0 | `MIT` | [package](https://www.npmjs.com/package/tinycolor2/v/1.6.0) |
| tslib | 2.8.1 | `0BSD` | [package](https://www.npmjs.com/package/tslib/v/2.8.1) |
| w3c-keyname | 2.2.8 | `MIT` | [package](https://www.npmjs.com/package/w3c-keyname/v/2.2.8) |
| zustand | 5.0.12 | `MIT` | [package](https://www.npmjs.com/package/zustand/v/5.0.12) |

## Release maintenance

Run `node scripts/generate-third-party-notices.mjs --write` after any Cargo or
root npm dependency change, and `--check` in the release gate. Treat a new
copyleft, source-available, non-commercial, custom, or `NOASSERTION` entry as a
release blocker until a person reviews its terms. Generated output does not
decide license compatibility.
