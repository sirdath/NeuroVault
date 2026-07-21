# NeuroVault licensing map

NeuroVault has two current distribution boundaries and one historical one.

## NeuroVault Core

[NeuroVault Core](https://github.com/sirdath/neurovault-core) is the public,
MIT-licensed local memory engine. It includes Markdown-canonical storage,
indexing and retrieval, the HTTP and MCP surfaces, compatible automatic-context
hooks, journaling, and evidence-backed consolidation. Core is independently
useful and is not a trial of Desktop.

## NeuroVault Desktop

This private repository contains the commercial consumer application. Its
product target is the signed Mac shell, Memories, Graph, Review, themes,
guided setup, lifecycle management, Store distribution, and support. The
current sandboxed Store flavor is still a release scaffold and exposes only
the standalone Libraries, Memories, Search, Graph, editing, import/export,
themes, and local-embedding subset; Review and automatic cross-AI memory are
launch blockers, not shipped Store capabilities. Original additions and
modifications made after the v0.6.0 boundary are proprietary unless a file
says otherwise.

Desktop remains a mixed-license work. It incorporates MIT-licensed NeuroVault
code and third-party components under their own licenses. Those notices and
permissions remain in force. Purchasing Desktop grants an end-user license to
use the application; it does not transfer NeuroVault intellectual property.

## Historical public Desktop source

First-party material covered by this repository's MIT license at tag `v0.6.0`,
commit `90b7883070bd76c243282e58558c9ee5f050d3f0`, was publicly released under
MIT. Third-party material and trademarks retain their separate terms. The
repository's MIT license is preserved verbatim in
`LICENSES/NeuroVault-v0.6.0-MIT.txt`. Repository visibility does not revoke it.

The boundary tag `desktop-mit-final-v0.6.0` records the same commit without
moving or rewriting the historical `v0.6.0` tag.

## Contributions

Public engine contributions belong in NeuroVault Core. Do not accept outside
contributions to proprietary Desktop code without an explicit inbound-license
or assignment policy. Security reports follow `SECURITY.md`.

This map documents the engineering boundary. It is not legal advice or a
substitute for review of the final EULA, trademarks, and bundled dependency
notices before release.
