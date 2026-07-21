# Security Policy

NeuroVault is local-first. In the Direct flavor, the server binds to
`127.0.0.1:8765`; the current Store flavor does not start or expose that
server and runs inside the macOS App Sandbox. Shared transport/server modules
and dependencies may still be statically compiled into the Store executable,
so this is a reachability claim rather than a claim that all dormant code is
absent. This file describes what we consider a vulnerability, how to report
one, and what response to expect.

## Supported versions

NeuroVault follows semantic versioning. Security fixes land on the
latest minor release line; older minors are **not** back-patched unless
the bug is critical.

| Version | Supported |
|---|---|
| Private Desktop development builds | Maintainer-supported; not publicly distributed |
| 0.6.0 (last public MIT source release) | Best effort while the public Core transition settles |
| < 0.6 | Unsupported |

The supported public engine now lives in
[NeuroVault Core](https://github.com/sirdath/neurovault-core). Store submission
and a paid Desktop release have not happened yet.

## What counts as a vulnerability

We treat these as security bugs and will prioritize them:

- **Arbitrary file read or write** via the MCP API or Tauri command surface
  (e.g. a crafted `filename` argument that escapes the vault directory).
- **Remote code execution** via any means — e.g. via deserializing
  untrusted data or a crafted note/tool argument reaching a shell.
- **Privilege escalation** from within the Tauri app (e.g. spawning the
  sidecar with elevated args the user didn't authorize).
- **Network exposure regressions** — anything that makes the server
  listen on `0.0.0.0` or otherwise expose the API off-loopback by
  default. Opting in to bind more broadly is fine; defaulting to it is
  a security bug.
- **Crashes triggered by malformed vault content** (malicious markdown,
  oversized notes, crafted PDFs, adversarial embeddings).
- **Information leaks in outbound connections** beyond what [PRIVACY.md](PRIVACY.md)
  enumerates.

## What we don't consider a vulnerability

- A user voluntarily sharing their vault folder, markdown files, or
  API keys — the trust boundary is the filesystem they control.
- A supply-chain issue in an upstream dependency unless NeuroVault
  specifically enables the exploit path.
- A connected local agent acting on what it recalls — agents run under
  their own runtime and permissions; NeuroVault executes no
  agent-supplied code. The server refuses requests from off-loopback
  by default.
- Missing features that other memory apps have (2FA for brains,
  per-note ACLs, etc.) unless the absence causes a privacy regression.

## How to report

**Preferred: private vulnerability report in the public Core repository.**
Open
[github.com/sirdath/neurovault-core/security/advisories/new](https://github.com/sirdath/neurovault-core/security/advisories/new)
and state whether the affected surface is Core, Direct Desktop, or the Store
candidate. This keeps the reporting route public without exposing details in a
normal issue even though the Desktop repository is private.
Include:

- Version you tested (from the About dialog or `neurovault --version`)
- OS + platform
- A proof-of-concept or clear reproduction
- Impact description — what can an attacker do?
- Your suggested severity (CVSS is optional)

**If you'd rather email**, use the GitHub profile contact for
[@sirdath](https://github.com/sirdath). Please don't open
a public issue for anything that might expose real users.

## Response SLA

At the current project maturity (single maintainer):

- **Acknowledgement**: within 72 hours of a report. Usually much faster.
- **Severity triage**: within 7 days.
- **Fix ETA**: severity-dependent. Critical (remote code execution,
  arbitrary read/write): within 14 days, with a point release. High
  (local privilege, off-loopback exposure): within 30 days. Medium /
  low: rolled into the next planned release.

Hardened SLAs (24-hour ack, faster fix, public post-mortems) will be
introduced when the project has more than one maintainer. Honesty
beats aspiration in a published policy.

## Disclosure process

1. You report privately via the advisory or email.
2. We acknowledge, triage, and share the planned fix timeline.
3. We develop the fix on a private branch. You're welcome to review.
4. We ship a patch release.
5. We publish the advisory (with CVE if we request one) within 30 days
   of the patch landing, crediting the reporter unless they opt out.

If you publish the vulnerability before step 4, that's your call, but
we'll prioritize the fix regardless and appreciate your patience.

## Things we do that mitigate common classes of bug

- In Direct builds, the HTTP server binds `127.0.0.1` explicitly — not `0.0.0.0` — so
  misconfigured routers / accidentally-shared wifi don't expose it.
- Direct Tauri capability scoping: the main webview can open user-selected files,
  save exports, open normal web links, check signed updates, and restart after
  an update. It has no generic filesystem, shell execute/spawn, shell kill,
  deep-link registration, or global-shortcut plugin permission. The Store
  candidate uses a separate, narrower capability file.
- The legacy Rust sidecar command (not a webview shell permission) can only
  resolve the bundled `neurovault-server` binary; arbitrary executable paths
  and arbitrary argument vectors are not accepted.
- Filename validation on every write path — note save, `remember`, and
  rename/move: absolute paths, `..` components and non-`.md`
  extensions are rejected before any filesystem work.
- Brain ids are validated as a single path segment, so the `brain`
  parameter carried by nearly every route and tool cannot relocate a
  vault or database outside `~/.neurovault/brains/`.
- Requests from untrusted browser origins are refused outright, not
  merely denied a CORS header. A "simple" cross-origin POST fires no
  preflight, so withholding the header would have hidden the response
  while still letting the side effect run.
- NeuroVault executes no agent-supplied code, and spawns no
  interpreter. The Python-subprocess bridge this section used to
  describe (`run_python_job`) was removed in 2026-05 with the Python
  server package; there is no PDF/Zotero helper process and no
  `python` invocation anywhere in the product.
- In Direct builds, the cross-encoder reranker is an on-device ONNX model
  acquired on first use and cached locally; downloading it is a disclosed
  network call. There is no `torch`, `sentence-transformers`, or Python in the
  runtime, and recall falls back to the fusion ranker if it cannot load. The
  Store flavor excludes the reranker and bundles its smaller embedding model.

## Things we know we don't do yet

- **The current Store candidate is not submission-signed.** An Apple Developer
  membership exists, but the final bundle identifier, distribution
  certificates, provisioning profile, App Store Connect record, and TestFlight
  acceptance remain release gates.
- **No vault encryption at rest** — documented in
  [PRIVACY.md § Encryption at rest](PRIVACY.md#encryption-at-rest);
  on the research roadmap.
- **Dependency scanning is automated**: weekly npm production and RustSec
  audits run in Actions, Dependabot covers npm/Cargo/Actions, and release
  bundles publish SPDX SBOMs plus Sigstore-backed GitHub build-provenance
  attestations. Public Core pull requests also receive GitHub dependency
  review; GitHub does not provide that check to this private Desktop repository
  without the separate Advanced Security product.

---

*Last updated: 2026-07-21.*
