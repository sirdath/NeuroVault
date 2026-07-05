# Third-Party Notices

NeuroVault is free and open-source software released under the **MIT License**
(see `LICENSE`). This document inventories the third-party components NeuroVault
builds on, and the license under which each is distributed.

Scope and method:

- **Rust crates** — the full transitive set of *normal* (runtime) dependencies of
  the `neurovault` crate, as reported by `cargo tree -e normal` and cross-referenced
  with the `license` field from `cargo metadata`. Build-only and dev-only
  dependencies are excluded.
- **npm packages** — the **direct** dependencies and devDependencies declared in the
  root `package.json`, with the license read from each package's installed
  `node_modules/<pkg>/package.json`. Transitive npm dependencies are **not**
  enumerated here.
- **ML models** — the embedding and reranker models are **downloaded at first run**
  to `~/.neurovault/.fastembed_cache/`. They are **not** redistributed in this
  repository. Their licenses are recorded below with links to the model cards.
- **Bundled native binaries** — the `sqlite-vec` extension (`vec0.dylib` / `vec0.dll`)
  shipped in `src-tauri/resources/`, plus the SQLite and ONNX Runtime libraries that
  are vendored or downloaded during the build.

No component in the dependency tree is under a strong-copyleft (GPL/AGPL/LGPL) or a
non-commercial / research-only license. The single weak-copyleft crate present
(`option-ext`, MPL-2.0) is file-level copyleft and imposes no obligation on
NeuroVault's own source; it is listed in the Rust table below.

Every license listed here is the license **as declared by the upstream component**.
When licenses are expressed as a choice (e.g. `MIT OR Apache-2.0`), NeuroVault may
use the component under either.

---

## 1. Rust crates

Runtime (normal) dependencies, transitive. 315 crates.

License summary:

| License | Crate count |
|---|---|
| `MIT OR Apache-2.0` | 139 |
| `MIT` | 74 |
| `Unicode-3.0` | 18 |
| `MIT/Apache-2.0` | 16 |
| `Apache-2.0 OR MIT` | 10 |
| `Apache-2.0` | 9 |
| `BSD-3-Clause` | 7 |
| `Unlicense OR MIT` | 6 |
| `BSD-2-Clause` | 4 |
| `MIT OR Apache-2.0 OR Zlib` | 3 |
| `Apache-2.0 OR ISC OR MIT` | 2 |
| `Apache-2.0 OR MIT OR Zlib` | 2 |
| `Apache-2.0/MIT` | 2 |
| `BSD-2-Clause OR Apache-2.0 OR MIT` | 2 |
| `BSD-3-Clause OR Apache-2.0` | 2 |
| `CDLA-Permissive-2.0` | 2 |
| `ISC` | 2 |
| `Unlicense/MIT` | 2 |
| `(MIT OR Apache-2.0) AND Unicode-3.0` | 1 |
| `0BSD OR MIT OR Apache-2.0` | 1 |
| `Apache-2.0 / MIT` | 1 |
| `Apache-2.0 AND ISC` | 1 |
| `Apache-2.0 OR BSL-1.0` | 1 |
| `CC0-1.0` | 1 |
| `CC0-1.0 OR Apache-2.0` | 1 |
| `CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception` | 1 |
| `CC0-1.0 OR MIT-0 OR Apache-2.0` | 1 |
| `MIT AND BSD-3-Clause` | 1 |
| `MIT OR Zlib OR Apache-2.0` | 1 |
| `MPL-2.0` | 1 |
| `Zlib OR Apache-2.0 OR MIT` | 1 |

> **Note on MPL-2.0.** Exactly one crate, `option-ext` (a transitive dependency of
> `dirs`), is licensed MPL-2.0. The Mozilla Public License 2.0 is a *weak, file-level*
> copyleft: it only requires that modifications to MPL-covered files themselves remain
> MPL. It does not affect the license of NeuroVault's own code and is compatible with
> distribution of the app. No other copyleft license appears in the tree.

Full crate list (alphabetical):

| Crate | Version | License |
|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| ahash | 0.8.12 | MIT OR Apache-2.0 |
| aho-corasick | 1.1.4 | Unlicense OR MIT |
| aligned | 0.4.3 | MIT OR Apache-2.0 |
| aligned-vec | 0.6.4 | MIT |
| anyhow | 1.0.102 | MIT OR Apache-2.0 |
| arg_enum_proc_macro | 0.3.4 | MIT |
| arrayref | 0.3.9 | BSD-2-Clause |
| arrayvec | 0.7.6 | MIT OR Apache-2.0 |
| as-slice | 0.2.1 | MIT OR Apache-2.0 |
| async-trait | 0.1.89 | MIT OR Apache-2.0 |
| atomic-waker | 1.1.2 | Apache-2.0 OR MIT |
| av-scenechange | 0.14.1 | MIT |
| av1-grain | 0.2.5 | BSD-2-Clause |
| avif-serialize | 0.8.8 | BSD-3-Clause |
| axum | 0.7.9 | MIT |
| axum-core | 0.4.5 | MIT |
| base64 | 0.13.1 | MIT/Apache-2.0 |
| base64 | 0.22.1 | MIT OR Apache-2.0 |
| bit_field | 0.10.3 | Apache-2.0/MIT |
| bitflags | 1.3.2 | MIT/Apache-2.0 |
| bitflags | 2.11.0 | MIT OR Apache-2.0 |
| bitstream-io | 4.10.0 | MIT/Apache-2.0 |
| blake3 | 1.8.5 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 |
| bstr | 1.12.1 | MIT OR Apache-2.0 |
| bumpalo | 3.20.2 | MIT OR Apache-2.0 |
| bytemuck | 1.25.0 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| byteorder-lite | 0.1.0 | Unlicense OR MIT |
| bytes | 1.11.1 | MIT |
| castaway | 0.2.4 | MIT |
| cfg-if | 1.0.4 | MIT OR Apache-2.0 |
| chrono | 0.4.44 | MIT OR Apache-2.0 |
| color_quant | 1.1.0 | MIT |
| compact_str | 0.9.0 | MIT |
| console | 0.15.11 | MIT |
| constant_time_eq | 0.4.2 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| core-foundation-sys | 0.8.7 | MIT OR Apache-2.0 |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 |
| crc32fast | 1.5.0 | MIT OR Apache-2.0 |
| crossbeam-channel | 0.5.15 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.6 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.18 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.21 | MIT OR Apache-2.0 |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 |
| darling | 0.20.11 | MIT |
| darling | 0.23.0 | MIT |
| darling_core | 0.20.11 | MIT |
| darling_core | 0.23.0 | MIT |
| darling_macro | 0.20.11 | MIT |
| darling_macro | 0.23.0 | MIT |
| dary_heap | 0.3.9 | MIT OR Apache-2.0 |
| deranged | 0.5.8 | MIT OR Apache-2.0 |
| derive_builder | 0.20.2 | MIT OR Apache-2.0 |
| derive_builder_core | 0.20.2 | MIT OR Apache-2.0 |
| derive_builder_macro | 0.20.2 | MIT OR Apache-2.0 |
| deunicode | 1.6.2 | BSD-3-Clause |
| digest | 0.10.7 | MIT OR Apache-2.0 |
| dirs | 6.0.0 | MIT OR Apache-2.0 |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 |
| displaydoc | 0.2.5 | MIT OR Apache-2.0 |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 |
| either | 1.15.0 | MIT OR Apache-2.0 |
| equator | 0.4.2 | MIT |
| equator-macro | 0.4.2 | MIT |
| equivalent | 1.0.2 | Apache-2.0 OR MIT |
| errno | 0.3.14 | MIT OR Apache-2.0 |
| esaxx-rs | 0.1.10 | Apache-2.0 |
| exr | 1.74.0 | BSD-3-Clause |
| fallible-iterator | 0.3.0 | MIT/Apache-2.0 |
| fallible-streaming-iterator | 0.1.9 | MIT/Apache-2.0 |
| fastembed | 4.9.1 | Apache-2.0 |
| fax | 0.2.6 | MIT |
| fax_derive | 0.2.0 | MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| filetime | 0.2.27 | MIT/Apache-2.0 |
| flate2 | 1.1.9 | MIT OR Apache-2.0 |
| fnv | 1.0.7 | Apache-2.0 / MIT |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 |
| fsevent-sys | 4.1.0 | MIT |
| futures | 0.3.32 | MIT OR Apache-2.0 |
| futures-channel | 0.3.32 | MIT OR Apache-2.0 |
| futures-core | 0.3.32 | MIT OR Apache-2.0 |
| futures-executor | 0.3.32 | MIT OR Apache-2.0 |
| futures-io | 0.3.32 | MIT OR Apache-2.0 |
| futures-macro | 0.3.32 | MIT OR Apache-2.0 |
| futures-sink | 0.3.32 | MIT OR Apache-2.0 |
| futures-task | 0.3.32 | MIT OR Apache-2.0 |
| futures-util | 0.3.32 | MIT OR Apache-2.0 |
| generic-array | 0.14.7 | MIT |
| getrandom | 0.2.17 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| getrandom | 0.4.2 | MIT OR Apache-2.0 |
| gif | 0.14.2 | MIT OR Apache-2.0 |
| globset | 0.4.18 | Unlicense OR MIT |
| half | 2.7.1 | MIT OR Apache-2.0 |
| hashbrown | 0.14.5 | MIT OR Apache-2.0 |
| hashbrown | 0.17.0 | MIT OR Apache-2.0 |
| hashlink | 0.9.1 | MIT OR Apache-2.0 |
| hf-hub | 0.4.3 | Apache-2.0 |
| http | 1.4.0 | MIT OR Apache-2.0 |
| http-body | 1.0.1 | MIT |
| http-body-util | 0.1.3 | MIT |
| httparse | 1.10.1 | MIT OR Apache-2.0 |
| httpdate | 1.0.3 | MIT OR Apache-2.0 |
| hyper | 1.9.0 | MIT |
| hyper-rustls | 0.27.9 | Apache-2.0 OR ISC OR MIT |
| hyper-util | 0.1.20 | MIT |
| icu_collections | 2.2.0 | Unicode-3.0 |
| icu_locale_core | 2.2.0 | Unicode-3.0 |
| icu_normalizer | 2.2.0 | Unicode-3.0 |
| icu_normalizer_data | 2.2.0 | Unicode-3.0 |
| icu_properties | 2.2.0 | Unicode-3.0 |
| icu_properties_data | 2.2.0 | Unicode-3.0 |
| icu_provider | 2.2.0 | Unicode-3.0 |
| ident_case | 1.0.1 | MIT/Apache-2.0 |
| idna | 1.1.0 | MIT OR Apache-2.0 |
| idna_adapter | 1.2.1 | Apache-2.0 OR MIT |
| ignore | 0.4.26 | Unlicense OR MIT |
| image | 0.25.10 | MIT OR Apache-2.0 |
| image-webp | 0.2.4 | MIT OR Apache-2.0 |
| imgref | 1.12.0 | CC0-1.0 OR Apache-2.0 |
| indexmap | 2.14.0 | Apache-2.0 OR MIT |
| indicatif | 0.17.11 | MIT |
| ipnet | 2.12.0 | MIT OR Apache-2.0 |
| iri-string | 0.7.12 | MIT OR Apache-2.0 |
| itertools | 0.14.0 | MIT OR Apache-2.0 |
| itoa | 1.0.18 | MIT OR Apache-2.0 |
| lebe | 0.5.3 | BSD-3-Clause |
| libc | 0.2.184 | MIT OR Apache-2.0 |
| libsqlite3-sys | 0.30.1 | MIT |
| litemap | 0.8.2 | Unicode-3.0 |
| lock_api | 0.4.14 | MIT OR Apache-2.0 |
| log | 0.4.29 | MIT OR Apache-2.0 |
| loop9 | 0.1.5 | MIT |
| macro_rules_attribute | 0.2.2 | Apache-2.0 OR MIT OR Zlib |
| macro_rules_attribute-proc_macro | 0.2.2 | Apache-2.0 OR MIT OR Zlib |
| matchit | 0.7.3 | MIT AND BSD-3-Clause |
| matrixmultiply | 0.3.10 | MIT/Apache-2.0 |
| maybe-rayon | 0.1.1 | MIT |
| memchr | 2.8.0 | Unlicense OR MIT |
| mime | 0.3.17 | MIT OR Apache-2.0 |
| minimal-lexical | 0.2.1 | MIT/Apache-2.0 |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| mio | 1.2.0 | MIT |
| monostate | 0.1.18 | MIT OR Apache-2.0 |
| monostate-impl | 0.1.18 | MIT OR Apache-2.0 |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 |
| ndarray | 0.16.1 | MIT OR Apache-2.0 |
| netstat2 | 0.9.1 | MIT OR Apache-2.0 |
| new_debug_unreachable | 1.0.6 | MIT |
| no_std_io2 | 0.9.3 | Apache-2.0 OR MIT |
| nom | 7.1.3 | MIT |
| nom | 8.0.0 | MIT |
| noop_proc_macro | 0.3.0 | MIT |
| notify | 6.1.1 | CC0-1.0 |
| num-bigint | 0.4.6 | MIT OR Apache-2.0 |
| num-complex | 0.4.6 | MIT OR Apache-2.0 |
| num-conv | 0.2.1 | MIT OR Apache-2.0 |
| num-derive | 0.3.3 | MIT OR Apache-2.0 |
| num-derive | 0.4.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.46 | MIT OR Apache-2.0 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| number_prefix | 0.4.0 | MIT |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| onig | 6.5.1 | MIT |
| onig_sys | 69.9.1 | MIT |
| option-ext | 0.2.0 | MPL-2.0 |
| ort | 2.0.0-rc.9 | MIT OR Apache-2.0 |
| ort-sys | 2.0.0-rc.9 | MIT OR Apache-2.0 |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| pastey | 0.1.1 | MIT OR Apache-2.0 |
| pastey | 0.2.3 | MIT OR Apache-2.0 |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT |
| png | 0.18.1 | MIT OR Apache-2.0 |
| portable-atomic | 1.13.1 | Apache-2.0 OR MIT |
| potential_utf | 0.1.5 | Unicode-3.0 |
| powerfmt | 0.2.0 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.106 | MIT OR Apache-2.0 |
| profiling | 1.0.17 | MIT OR Apache-2.0 |
| profiling-procmacros | 1.0.17 | MIT OR Apache-2.0 |
| pxfm | 0.1.29 | BSD-3-Clause OR Apache-2.0 |
| qoi | 0.4.1 | MIT/Apache-2.0 |
| quick-error | 2.0.1 | MIT/Apache-2.0 |
| quote | 1.0.45 | MIT OR Apache-2.0 |
| rand | 0.9.4 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rav1e | 0.8.1 | BSD-2-Clause |
| ravif | 0.13.0 | BSD-3-Clause |
| rawpointer | 0.2.1 | MIT/Apache-2.0 |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-cond | 0.4.0 | Apache-2.0/MIT |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| ref-cast | 1.0.25 | MIT OR Apache-2.0 |
| ref-cast-impl | 1.0.25 | MIT OR Apache-2.0 |
| regex | 1.12.3 | MIT OR Apache-2.0 |
| regex-automata | 0.4.14 | MIT OR Apache-2.0 |
| regex-syntax | 0.8.10 | MIT OR Apache-2.0 |
| reqwest | 0.12.28 | MIT OR Apache-2.0 |
| rgb | 0.8.53 | MIT |
| ring | 0.17.14 | Apache-2.0 AND ISC |
| rmcp | 1.7.0 | Apache-2.0 |
| rmcp-macros | 1.7.0 | Apache-2.0 |
| rusqlite | 0.32.1 | MIT |
| rustls | 0.23.38 | Apache-2.0 OR ISC OR MIT |
| rustls-pki-types | 1.14.0 | MIT OR Apache-2.0 |
| rustls-webpki | 0.103.13 | ISC |
| rustversion | 1.0.22 | MIT OR Apache-2.0 |
| ryu | 1.0.23 | Apache-2.0 OR BSL-1.0 |
| same-file | 1.0.6 | Unlicense/MIT |
| schemars | 1.2.1 | MIT |
| schemars_derive | 1.2.1 | MIT |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 |
| serde | 1.0.228 | MIT OR Apache-2.0 |
| serde_core | 1.0.228 | MIT OR Apache-2.0 |
| serde_derive | 1.0.228 | MIT OR Apache-2.0 |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 |
| serde_json | 1.0.149 | MIT OR Apache-2.0 |
| serde_path_to_error | 0.1.20 | MIT OR Apache-2.0 |
| serde_urlencoded | 0.7.1 | MIT/Apache-2.0 |
| sha1_smol | 1.0.1 | BSD-3-Clause |
| sha2 | 0.10.9 | MIT OR Apache-2.0 |
| signal-hook-registry | 1.4.8 | MIT OR Apache-2.0 |
| simd-adler32 | 0.3.9 | MIT |
| simd_helpers | 0.1.0 | MIT |
| slab | 0.4.12 | MIT |
| slug | 0.1.6 | MIT/Apache-2.0 |
| smallvec | 1.15.1 | MIT OR Apache-2.0 |
| socket2 | 0.6.3 | MIT OR Apache-2.0 |
| socks | 0.3.4 | MIT/Apache-2.0 |
| spm_precompiled | 0.1.4 | Apache-2.0 |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| static_assertions | 1.1.0 | MIT OR Apache-2.0 |
| streaming-iterator | 0.1.9 | MIT OR Apache-2.0 |
| strsim | 0.11.1 | MIT |
| subtle | 2.6.1 | BSD-3-Clause |
| syn | 1.0.109 | MIT OR Apache-2.0 |
| syn | 2.0.117 | MIT OR Apache-2.0 |
| sync_wrapper | 1.0.2 | Apache-2.0 |
| synstructure | 0.13.2 | MIT |
| sysinfo | 0.30.13 | MIT |
| thiserror | 1.0.69 | MIT OR Apache-2.0 |
| thiserror | 2.0.18 | MIT OR Apache-2.0 |
| thiserror-impl | 1.0.69 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.18 | MIT OR Apache-2.0 |
| tiff | 0.11.3 | MIT |
| time | 0.3.47 | MIT OR Apache-2.0 |
| time-core | 0.1.8 | MIT OR Apache-2.0 |
| time-macros | 0.2.27 | MIT OR Apache-2.0 |
| tinystr | 0.8.3 | Unicode-3.0 |
| tokenizers | 0.21.4 | Apache-2.0 |
| tokio | 1.51.1 | MIT |
| tokio-macros | 2.7.0 | MIT |
| tokio-rustls | 0.26.4 | MIT OR Apache-2.0 |
| tokio-util | 0.7.18 | MIT |
| tower | 0.5.3 | MIT |
| tower-http | 0.5.2 | MIT |
| tower-http | 0.6.8 | MIT |
| tower-layer | 0.3.3 | MIT |
| tower-service | 0.3.3 | MIT |
| tracing | 0.1.44 | MIT |
| tracing-attributes | 0.1.31 | MIT |
| tracing-core | 0.1.36 | MIT |
| tree-sitter | 0.24.7 | MIT |
| tree-sitter-c-sharp | 0.23.1 | MIT |
| tree-sitter-go | 0.23.4 | MIT |
| tree-sitter-java | 0.23.5 | MIT |
| tree-sitter-language | 0.1.7 | MIT |
| tree-sitter-python | 0.23.6 | MIT |
| tree-sitter-ruby | 0.23.1 | MIT |
| tree-sitter-rust | 0.23.3 | MIT |
| tree-sitter-typescript | 0.23.2 | MIT |
| try-lock | 0.2.5 | MIT |
| typenum | 1.19.0 | MIT OR Apache-2.0 |
| unicode-ident | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| unicode-normalization-alignments | 0.1.12 | MIT/Apache-2.0 |
| unicode-segmentation | 1.13.2 | MIT OR Apache-2.0 |
| unicode-width | 0.2.2 | MIT OR Apache-2.0 |
| unicode_categories | 0.1.1 | MIT OR Apache-2.0 |
| untrusted | 0.9.0 | ISC |
| ureq | 2.12.1 | MIT OR Apache-2.0 |
| url | 2.5.8 | MIT OR Apache-2.0 |
| utf8_iter | 1.0.4 | Apache-2.0 OR MIT |
| uuid | 1.23.0 | Apache-2.0 OR MIT |
| v_frame | 0.3.9 | BSD-2-Clause |
| walkdir | 2.5.0 | Unlicense/MIT |
| want | 0.3.1 | MIT |
| webpki-roots | 0.26.11 | CDLA-Permissive-2.0 |
| webpki-roots | 1.0.7 | CDLA-Permissive-2.0 |
| weezl | 0.1.12 | MIT OR Apache-2.0 |
| writeable | 0.6.3 | Unicode-3.0 |
| y4m | 0.8.0 | MIT |
| yoke | 0.8.2 | Unicode-3.0 |
| yoke-derive | 0.8.2 | Unicode-3.0 |
| zerocopy | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerofrom | 0.1.7 | Unicode-3.0 |
| zerofrom-derive | 0.1.7 | Unicode-3.0 |
| zeroize | 1.8.2 | Apache-2.0 OR MIT |
| zerotrie | 0.2.4 | Unicode-3.0 |
| zerovec | 0.11.6 | Unicode-3.0 |
| zerovec-derive | 0.11.3 | Unicode-3.0 |
| zip | 2.4.2 | MIT |
| zmij | 1.0.21 | MIT |
| zopfli | 0.8.3 | Apache-2.0 |
| zune-core | 0.5.1 | MIT OR Apache-2.0 OR Zlib |
| zune-inflate | 0.2.54 | MIT OR Apache-2.0 OR Zlib |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib |

---

## 2. npm packages (direct dependencies only)

The tables below cover only the **direct** dependencies declared in the root
`package.json`. Transitive npm dependencies are not enumerated. Versions shown are
the versions installed in `node_modules` at the time this file was generated.

### Runtime dependencies (26)

| Package | Version | License |
|---|---|---|
| @codemirror/autocomplete | 6.20.1 | MIT |
| @codemirror/commands | 6.10.3 | MIT |
| @codemirror/lang-markdown | 6.5.0 | MIT |
| @codemirror/language-data | 6.5.2 | MIT |
| @codemirror/state | 6.6.0 | MIT |
| @codemirror/view | 6.41.0 | MIT |
| @dnd-kit/core | 6.3.1 | MIT |
| @dnd-kit/sortable | 10.0.0 | MIT |
| @dnd-kit/utilities | 3.2.2 | MIT |
| @tanstack/react-virtual | 3.13.23 | MIT |
| @tauri-apps/api | 2.10.1 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-deep-link | 2.4.8 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-dialog | 2.7.0 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-fs | 2.5.0 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-process | 2.3.1 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-shell | 2.3.5 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-updater | 2.10.1 | MIT OR Apache-2.0 |
| @uiw/react-codemirror | 4.25.9 | MIT |
| framer-motion | 11.18.2 | MIT |
| react | 19.2.5 | MIT |
| react-dom | 19.2.5 | MIT |
| react-force-graph-2d | 1.29.1 | MIT |
| react-force-graph-3d | 1.29.1 | MIT |
| react-markdown | 10.1.0 | MIT |
| remark-gfm | 4.0.1 | MIT |
| zustand | 5.0.12 | MIT |

### Dev dependencies (12)

| Package | Version | License |
|---|---|---|
| @tailwindcss/vite | 4.2.2 | MIT |
| @tauri-apps/cli | 2.10.1 | Apache-2.0 OR MIT |
| @types/d3-force | 3.0.10 | MIT |
| @types/react | 19.2.14 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @types/three | 0.184.0 | MIT |
| @vitejs/plugin-react | 4.7.0 | MIT |
| d3-force | 3.0.0 | ISC |
| puppeteer-core | 25.1.0 | Apache-2.0 |
| tailwindcss | 4.2.2 | MIT |
| typescript | 5.9.3 | Apache-2.0 |
| vite | 6.4.2 | MIT |

**`dist-npm/` (the `@neurovault/mcp` publish tree).** Its `package.json` declares no
third-party runtime dependencies — only NeuroVault's own first-party platform packages
(`@neurovault/mcp-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-win32-x64`, all
version-locked to NeuroVault) as `optionalDependencies`. The launcher scripts
(`dist-npm/bin/neurovault-mcp.js`, `dist-npm/lib/resolve.js`) are first-party and
bundle no third-party JavaScript.

---

## 3. ML models

NeuroVault runs entirely on-device embedding and reranking models via
`fastembed-rs`. **These models are downloaded on first use** to
`~/.neurovault/.fastembed_cache/` and are **not** redistributed in this repository.

| Model | Role | Source (model card) | License |
|---|---|---|---|
| BAAI/bge-small-en-v1.5 | Text embeddings (384-dim, ONNX) | https://huggingface.co/BAAI/bge-small-en-v1.5 | MIT |
| BAAI/bge-reranker-base | Cross-encoder reranker | https://huggingface.co/BAAI/bge-reranker-base | MIT |

Both models are part of BAAI's **FlagEmbedding** family. The model cards state:
*"FlagEmbedding is licensed under the MIT License. The released models can be used
for commercial purposes free of charge."* (Verified from the Hugging Face model cards
linked above.)

The models are fetched from the Hugging Face Hub by the `hf-hub` crate and executed
through ONNX Runtime (see below).

---

## 4. Bundled and downloaded native libraries

| Component | How it ships | License | Copyright / source |
|---|---|---|---|
| sqlite-vec (`vec0.dylib`, `vec0.dll`) | Prebuilt binaries committed in `src-tauri/resources/` | Apache-2.0 OR MIT | Alex Garcia — https://github.com/asg017/sqlite-vec |
| ONNX Runtime | Native library downloaded/linked by the `ort` / `ort-sys` crates during build | MIT | Microsoft Corporation — https://github.com/microsoft/onnxruntime |
| SQLite | C amalgamation vendored via `rusqlite`'s `bundled` feature | Public Domain | https://www.sqlite.org/copyright.html |

The Rust bindings themselves — `ort` / `ort-sys` (`MIT OR Apache-2.0`), `fastembed`
(`Apache-2.0`), `tokenizers` (`Apache-2.0`), `hf-hub` (`Apache-2.0`),
`rusqlite` / `libsqlite3-sys` (`MIT`) — are already listed in the Rust crates table
in section 1.

---

## 5. Fonts and static assets

No third-party font files (`.woff`, `.woff2`, `.ttf`, `.otf`, `.eot`) are bundled in
`src/`, `src-tauri/`, or `public/`. The UI relies on system font stacks. No other
third-party static assets requiring attribution are bundled.

---

## Maintaining this file

**When you add, remove, or upgrade a dependency, update this file.** Quick refresh
recipe:

- Rust: from `src-tauri/`, run `cargo tree --prefix none -e normal --no-default-features | sort -u`
  and reconcile licenses against `cargo metadata --format-version 1`
  (the `license` field on each package). `cargo install cargo-license` also works:
  `cargo license` prints the crate/version/license table directly.
- npm: re-read the `license` field of each direct dependency's
  `node_modules/<pkg>/package.json`.
- Models / native binaries: re-verify licenses from the upstream model cards and
  repositories linked above if versions change.

Any newly introduced GPL/AGPL/LGPL or non-commercial (e.g. CC-BY-NC, research-only)
component should be flagged and reviewed before release — NeuroVault ships under a
permissive MIT license and must stay redistribution-safe.
