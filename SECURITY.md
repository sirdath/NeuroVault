# Security Policy

NeuroVault is local-first — the server binds to `127.0.0.1:8765` and the
app runs with the user's own OS permissions. The realistic threat model
is narrow, but real. This file describes what we consider a vulnerability,
how to report one, and what response to expect.

## Supported versions

NeuroVault follows semantic versioning. Security fixes land on the
latest minor release line; older minors are **not** back-patched unless
the bug is critical.

| Version | Supported |
|---|---|
| 0.6.x (current) | ✅ |
| 0.5.x | ⚠️ Critical fixes only through 2026-08-20 |
| < 0.5 | ❌ — upgrade to 0.6.x |

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

**Preferred: GitHub private vulnerability reporting.**
Open a private advisory at
[github.com/sirdath/NeuroVault/security/advisories/new](https://github.com/sirdath/NeuroVault/security/advisories/new).
Include:

- Version you tested (from the About dialog or `neurovault --version`)
- OS + platform
- A proof-of-concept or clear reproduction
- Impact description — what can an attacker do?
- Your suggested severity (CVSS is optional)

If GitHub says private reporting is unavailable, open a public issue containing
only the words "private security contact requested" and your preferred contact
method. Do not include the vulnerability, affected paths, proof of concept, or
user data in that issue. The project must enable private vulnerability
reporting before its next general-public release.

## Response SLA

At the current project maturity (v0.6.x, single-maintainer):

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

- The HTTP server binds `127.0.0.1` explicitly — not `0.0.0.0` — so
  misconfigured routers / accidentally-shared wifi don't expose it.
- Tauri capability scoping: the main webview can open user-selected files,
  save exports, open normal web links, check signed updates, and restart after
  an update. It has no generic filesystem, shell execute/spawn, shell kill,
  deep-link registration, or global-shortcut plugin permission.
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
- The cross-encoder reranker runs on-device through fastembed-rs, with no
  `torch`, `sentence-transformers`, or Python in the app. Its model may be
  downloaded from Hugging Face on first qualifying use as documented in
  `PRIVACY.md`; recall falls back to the fusion ranker if it cannot load.

## Things we know we don't do yet

- **Windows installers are not Authenticode-signed yet.** SmartScreen reports
  an unknown publisher. Published macOS Apple Silicon builds are Developer ID
  signed and notarized, and the release gate verifies the signature, hardened
  runtime, stapled app ticket, bundled native extension and Gatekeeper result.
- **No vault encryption at rest** — documented in
  [PRIVACY.md § Encryption at rest](PRIVACY.md#encryption-at-rest);
  on the research roadmap.
- **Dependency scanning is automated**: pull requests receive GitHub
  dependency review, weekly npm production and RustSec audits run in Actions,
  Dependabot covers npm/Cargo/Actions, and release bundles publish SPDX SBOMs
  plus Sigstore-backed GitHub build-provenance attestations.

---

*Last updated: 2026-07-22.*
