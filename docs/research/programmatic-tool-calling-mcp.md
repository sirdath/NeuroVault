# Programmatic Tool Calling for MCP — and whether NeuroVault should adopt it

> **Research document · 2026-06-06**
> Method: multi-source web research (5 angles, 21 sources fetched, 104 candidate
> claims, 25 adversarially verified — 24 confirmed, 1 refuted) plus direct
> inspection of NeuroVault's MCP codebase. Token-savings numbers are the
> weakest evidence in this space and are flagged as such throughout.

---

## TL;DR

**Programmatic tool calling (PTC)** — also called *"code execution with MCP"*
(Anthropic) or *"code mode"* (Cloudflare) — replaces the standard
one-tool-call-per-turn MCP loop with a pattern where the model **writes code
against a typed API generated from the MCP server's tools**. The code runs in a
sandbox, and **only the final result returns to the model's context** instead of
every tool definition and every intermediate result round-tripping through the
model.

**For NeuroVault:** technically very feasible (the registry already carries
everything a typed SDK needs), but the **net value is moderate and
conditional**. PTC and NeuroVault's existing **tier system** chase the *same*
token-saving goal by different means, PTC's biggest wins apply to only a subset
of NeuroVault flows, and a "run code" tool reintroduces exactly the
sandbox-security risks that sank several of the surveyed projects. **Recommended
posture: don't adopt now; revisit behind a flag once there's telemetry showing
multi-step sessions are common.** Details in §6–7.

---

## 1. What PTC is

In the **standard MCP loop**, the client discovers tools via a `tools/list`
request, invokes each via a separate `tools/call`, and *every* result is routed
back to the LLM to process before the next call
([MCP spec, 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)).
Each step is an explicit round trip through the model.

**PTC collapses that into code.** As Cloudflare puts it, "agents should perform
tasks not by making tool calls, but instead by writing code that calls APIs" —
the mechanism is to "convert the MCP tools into a TypeScript API, and then ask
an LLM to write code that calls that API"
([Cloudflare, "Code Mode"](https://blog.cloudflare.com/code-mode/)).
Anthropic frames the identical pattern: present each MCP server as a code API
(every tool becomes a function/file) so the agent writes a script to wire them
together, and only the script's return value enters context
([Anthropic, "Code execution with MCP"](https://www.anthropic.com/engineering/code-execution-with-mcp)).
Simon Willison's summary captures it: *"What if you could turn MCP tools into
code functions instead, and then let the LLM wire them together with executable
code?"*
([simonwillison.net](https://simonwillison.net/2025/Nov/4/code-execution-with-mcp/)).

The shift is **MCP-as-protocol → MCP-as-code-API**. The MCP server still exists;
it's just consumed by generated code in a sandbox rather than by per-call
JSON-RPC from the model.

## 2. Why — the motivation (and an honest read on the numbers)

Three problems with the standard loop motivate PTC; all three are
well-attested. The *magnitude* of the savings is where the evidence gets soft.

1. **Tool-definition bloat.** Most MCP clients load *all* tool definitions
   upfront into context. Anthropic: "In cases where agents are connected to
   thousands of tools, they'll need to process hundreds of thousands of tokens
   before reading a request"
   ([Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp)).
2. **Intermediate-result round-tripping.** Every tool result passes through the
   model. Anthropic's example: a 2-hour meeting transcript passing through twice
   "could mean processing an additional 50,000 tokens." Cloudflare: "the output
   of each tool call must feed into the LLM's neural network, just to be copied
   over to the inputs of the next call, wasting time, energy, and tokens. When
   the LLM can write code, it can skip all that."
3. **On-demand discovery.** With tools as code on a filesystem, "models [can]
   read tool definitions on-demand, rather than reading them all up-front"
   (optionally via a `search_tools` tool) — unused tools cost *zero* tokens.

**On the headline figures — read carefully:**

- Anthropic's widely-quoted **"150,000 → 2,000 tokens (98.7%)"** is an
  **illustrative worked example** (a Google-Drive-to-Salesforce scenario with no
  disclosed tool count, dataset, or shown calculation) — *not* an instrumented
  benchmark. Cite it as Anthropic's own illustration, not as a measured result.
  *(Confidence: medium, 2-1.)*
- A **more credible measured figure** surfaced in the research is **~37%**
  (43,588 → 27,297 tokens) on complex research tasks — still vendor-adjacent, but
  closer to a real measurement.
- Cloudflare's **"entire API through just two tools (`search`/`execute`) in
  under ~1,000 tokens"** is the **vendor's self-description of its own server**
  ([Cloudflare, "Dynamic Workers"](https://blog.cloudflare.com/dynamic-workers/);
  [InfoQ](https://www.infoq.com/news/2026/04/cloudflare-code-mode-mcp-server/)),
  not an independent benchmark.
- **A separate Cloudflare "81%/99.9%-class" token-reduction claim was REFUTED
  0-3 in verification and is deliberately excluded** from this document.
- **Net savings are conditional, not guaranteed:** one cited benchmark found PTC
  ~**8% *more* expensive** on sequential single-call workflows, because PTC adds
  a discover→inspect→execute round.

A secondary (and more debatable) rationale from Cloudflare: *"LLMs are better at
writing code to call MCP than at calling MCP directly… they have seen a lot of
code [but] not a lot of tool calls."* This is a **hypothesis, not a controlled
ablation**, though it's directionally consistent with
[arXiv:2510.14453](https://arxiv.org/abs/2510.14453) (forcing JSON-structured
output cut GSM8K accuracy by 27.3 points vs. natural language). *(Confidence:
medium.)*

## 3. The MCP spec already provides the typed contract

PTC needs a machine-readable schema to codegen a typed SDK — and MCP already has
it:

- **`tools/list`** returns each tool's `name`, a **required `inputSchema`** (JSON
  Schema), and an **optional `outputSchema`** (JSON Schema) — a direct mapping to
  typed-SDK codegen
  ([spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools);
  [schema.ts 2025-11-25](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts)).
- **Structured output:** results may carry a `structuredContent` JSON object; if
  an `outputSchema` is declared, "Servers MUST provide structured results that
  conform to this schema. Clients SHOULD validate." This gives a code-mode
  wrapper a **deterministic, parseable channel to filter/transform output before
  it reaches the model**.

Caveat: `outputSchema`/`structuredContent` are **recent** (2025-06-18, refined
2025-11-25) and **not yet universally populated** by servers — including
NeuroVault's, which today returns content without declared output schemas.

## 4. Open-source landscape

| Project | What it does | Lang | Sandbox | Maturity / License | Link |
|---|---|---|---|---|---|
| **Anthropic — "Code execution with MCP"** | Reference *pattern* + guidance: tools as code files, on-demand discovery, `search_tools` | — | (pattern) | Engineering post, Nov 2025 | [anthropic.com](https://www.anthropic.com/engineering/code-execution-with-mcp) |
| **Cloudflare Code Mode / `codeMcpServer`** | Wraps an existing MCP server, **replacing its whole tool surface with a single `code()` tool**; entire API in ~2 tools / ~1k tokens | TS | **V8 isolate** (Dynamic Worker Loader) | Open-sourced SDK; Worker Loader in **open beta** (Mar 2026) | [code-mode](https://blog.cloudflare.com/code-mode/) · [dynamic-workers](https://blog.cloudflare.com/dynamic-workers/) |
| **pydantic/mcp-run-python** | Ran model-written Python as an MCP tool | Python | **Pyodide-in-Deno** (OS-isolated) | ⚠️ **Archived Jan 30 2026** — "no safe way to run Python in Pyodide safely with reasonable latency"; superseded by **Monty** | [github](https://github.com/pydantic/mcp-run-python) |
| **philschmid/code-sandbox-mcp** | STDIO MCP server; `run_python_code` / `run_js_code` in containers via `llm-sandbox` | Go/multi | **Docker/Podman** | Active; launched on-demand by client | [github](https://github.com/philschmid/code-sandbox-mcp) |
| **alfonsograziano/node-code-sandbox-mcp** | Runs model JS in disposable Docker containers (a sandbox *primitive*, not tool-as-code-API) | TS | **Docker** / MIT | Active — but had **CVE-2025-53372** sandbox escape (see §5) | [github](https://github.com/alfonsograziano/node-code-sandbox-mcp) |
| **olaservo/code-execution-with-mcp** | Community reference implementation of the Anthropic pattern | — | — | Reference | [github](https://github.com/olaservo/code-execution-with-mcp) |

**Pattern vs. primitive — an important distinction.** Cloudflare's `codeMcpServer`
and Anthropic's guidance are the *full PTC pattern* (expose *other* tools as a
typed code API). The Docker/Pyodide "run arbitrary code" servers are *sandbox
primitives* — useful building blocks, but they execute free-form code rather
than a typed wrapper over an existing tool surface.

## 5. Trade-offs & risks

**Security is the dominant risk — and the survey is a graveyard of sandbox
failures:**

- **CVE-2025-53372** (node-code-sandbox-mcp ≤1.2.0, CVSS 7.5 HIGH): a
  **command-injection** flaw — host-side orchestration built shell strings from
  unvalidated input passed to `child_process.execSync`, letting attackers inject
  shell metacharacters for **RCE on the host, entirely bypassing the Docker
  sandbox**. Fixed in 1.3.0 by switching to argument-array APIs
  ([advisory](https://advisories.gitlab.com/npm/node-code-sandbox-mcp/CVE-2025-53372/)).
  **Lesson: the host-side orchestration code is the real attack surface, not the
  container.**
- **Pyodide-in-Deno** (mcp-run-python) was **retired as fundamentally unsafe**:
  Python in Pyodide "can run arbitrary javascript," enabling runtime tainting,
  reading/writing reachable files, and OOMing the machine (Deno can't limit
  memory). Pydantic: these "were not designed as sandboxes to run untrusted
  code."

Other costs:

- **Determinism & debuggability.** PTC adds a discover→inspect→execute round and
  shifts failures into generated code that's harder to observe than a discrete
  tool call (raised in [HN 45407016](https://news.ycombinator.com/item?id=45407016)
  and [Adam Azzam's critique](https://aaazzam.substack.com/p/code-mode-isnt-a-critique-of-mcp)).
- **Vendor-blog bias.** Several primary sources (Cloudflare, Anthropic) are
  promoting their own products; causal/rationale claims are hypotheses.

**When PTC is NOT worth it** *(high confidence)*: single-call-per-turn or simple
Q&A workflows; small/modest tool surfaces already capped by other means; and any
setting where sandbox security/latency/debuggability cost exceeds the token
saving. (Recall the cited ~8%-*more*-expensive benchmark on sequential
single-call flows.)

## 6. Applicability to NeuroVault

*Grounded in the current codebase on branch `feat/agent-autostart-project-brains`.*

### 6.1 Feasibility: very high

NeuroVault is unusually well-positioned to generate a typed code SDK **for free**:

- Its native rmcp server exposes 54 tools via a **data-driven registry**.
  [`registry.rs`](../../src-tauri/src/memory/mcp/registry.rs)'s `ToolDef` already
  carries `name`, `description`, a full JSON-Schema `input_schema`, and a
  declarative `CallSpec { method, path, path_params, query, body, special }`.
- [`tools.json`](../../src-tauri/src/memory/mcp/tools.json) is embedded via
  `include_str!` and maps each tool **1:1 to a loopback `/api/*` endpoint**.
- [`forward.rs`](../../src-tauri/src/memory/mcp/forward.rs) already turns every
  MCP call into an HTTP request against `http://127.0.0.1:8765`.

So a typed SDK (TS or Python) could be **code-generated mechanically from
existing data** — no new business logic, and the loopback HTTP backend stays the
single source of truth. *(Finding 17 — codebase-verified.)*

### 6.2 Where PTC would actually pay off (a subset of flows)

The real wins map to NeuroVault's batch/exploration endpoints:

- **Chaining** `recall → related → filter → remember` without round-tripping
  each hit. NeuroVault's own MCP instructions note `related` is "~50-100× cheaper
  than a second recall" — a chain the model currently drives turn-by-turn.
- **Batch maintenance** — `find_clutter → bulk_set_kind / bulk_add_tag /
  delete_engrams` over many IDs, where the intermediate ID lists are large and
  currently flow through context.

These are exactly the loop/fan-out/filter cases the standard tool loop handles
poorly. *(Finding 18 — medium, codebase-grounded inference.)*

### 6.3 The catch: PTC *competes* with the tier system

NeuroVault already solves tool-definition bloat by **shrinking the upfront
surface** (lite = 8 tools). PTC solves the *same* problem by **lazy, on-demand
discovery behind one `execute` tool**. They're two answers to one question. For
NeuroVault's **modest 54-tool surface**, the absolute upfront saving from PTC is
*far smaller* than Anthropic's thousands-of-tools scenario — and the tier ladder
already captures most of it. A code-mode layer could even make the
minimal/lite/standard ladder *less necessary* — but only if the model is good at
the code path and the sandbox cost is acceptable. *(Finding 19 — medium.)*

### 6.4 Recommended adoption path *if* pursued

1. Add **one** optional sandboxed `run_code` tool (gated to the `full` tier) over
   the **code-generated typed SDK** that wraps the existing `/api/*` surface —
   the exact shape of Cloudflare's `codeMcpServer`. Don't rebuild logic.
2. **Sandbox choice is the open problem for a *local-first desktop* app.** The
   surveyed sandboxes (Cloudflare Workers, Docker, Deno) assume a cloud/container
   host NeuroVault doesn't have. A Rust/Tauri app more naturally wants an
   **embeddable WASM runtime** (e.g. `wasmtime` / a JS engine like QuickJS) or a
   resource-limited child-process jail — **not** Pyodide-in-Deno (retired) or a
   Docker dependency.
3. **Treat the host-side orchestration as the attack surface** (the
   CVE-2025-53372 lesson): never build shell strings from model output; restrict
   egress (the SDK should only reach `127.0.0.1:8765`); set CPU/memory/time
   limits; and ensure generated code can **never exceed what the agent's current
   tier already permits** over `/api/*`.

### 6.5 What to avoid

- A network-exposed or untrusted-code sandbox.
- Adding a Docker/Deno runtime dependency to a lightweight local desktop app.
- Duplicating per-tool authorization inside the sandbox layer.
- Shipping it before there's evidence (telemetry) that multi-step sessions are
  common enough to justify the security surface.

## 7. Verdict

**Don't adopt PTC now. Revisit behind a flag later.** The pattern is real,
current, and a genuinely good fit for *huge* tool surfaces with heavy
intermediate data. NeuroVault is neither: 54 tools already tamed by tiers, and a
common path (`recall` → answer) that PTC can make *slower and pricier*. The
honest, evidence-weighted position:

- ✅ **Feasible** — the registry hands you the SDK for free.
- ⚖️ **Moderate, conditional value** — wins on a *subset* (chaining, batch
  maintenance); overlaps the tier system on the rest.
- ⛔ **Real new risk** — a code sandbox is the single biggest new attack surface
  the project could add, and every surveyed sandbox that was breached or retired
  is a cautionary tale.

**Cheaper wins that capture much of PTC's benefit without a sandbox:** add a few
**composite endpoints** (e.g. a server-side `recall_then_related` or a
`bulk_maintenance` op) so the *server* does the chaining/filtering and returns
only the distilled result — that delivers the "don't round-trip intermediates"
benefit with zero sandbox risk. Populate **`outputSchema`/`structuredContent`**
on the high-volume tools regardless; it's strictly good and is the precondition
for PTC if you ever do pursue it.

## Open questions (what would change the recommendation)

1. **What fraction of real sessions are multi-step** (`recall→related→…→remember`
   or bulk maintenance) vs. single-recall Q&A? PTC's payoff hinges on this, and
   **NeuroVault has no telemetry to answer it yet.**
2. **Which sandbox fits a local-first Rust/Tauri app** — WASM (`wasmtime`/QuickJS),
   a child-process jail, or something else — given the surveyed options assume a
   server/cloud host?
3. **Is Monty** (Pydantic's successor to mcp-run-python) actually safe-enough +
   low-latency, and **embeddable from Rust**? Asserted by Pydantic, not
   independently verified here.
4. **Can generated code be constrained to never exceed the agent's current tier**
   over `/api/*` without re-implementing per-tool authorization in the sandbox?

## Caveats on this research

Token-savings figures are the weakest evidence: Anthropic's 98.7% is
illustrative (more credible measured ≈37%), Cloudflare's "~1,000 tokens" is
self-description, and an "81%"-class claim was **refuted 0-3** and excluded.
Net savings can be **negative** on simple workflows. Several primary sources are
vendor blogs promoting their own products, so rationale claims ("LLMs are better
at code") are hypotheses, not controlled results. The field is fast-moving
(mcp-run-python archived Jan 2026; Dynamic Workers open beta Mar 2026;
`outputSchema` is recent). NeuroVault applicability is grounded in the current
codebase, but the *value* judgments are reasoned inferences, not measured against
usage telemetry (which doesn't exist yet).

## Sources

**Primary — pattern & spec**
- Anthropic — Code execution with MCP: https://www.anthropic.com/engineering/code-execution-with-mcp
- Cloudflare — Code Mode: https://blog.cloudflare.com/code-mode/
- Cloudflare — Dynamic Workers / Worker Loader: https://blog.cloudflare.com/dynamic-workers/
- MCP spec, tools (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP schema (2025-11-25): https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-11-25/schema.ts
- Simon Willison — notes on code execution with MCP: https://simonwillison.net/2025/Nov/4/code-execution-with-mcp/

**Implementations**
- pydantic/mcp-run-python (archived): https://github.com/pydantic/mcp-run-python
- philschmid/code-sandbox-mcp: https://github.com/philschmid/code-sandbox-mcp
- alfonsograziano/node-code-sandbox-mcp: https://github.com/alfonsograziano/node-code-sandbox-mcp
- olaservo/code-execution-with-mcp: https://github.com/olaservo/code-execution-with-mcp

**Security**
- CVE-2025-53372 (node-code-sandbox-mcp): https://advisories.gitlab.com/npm/node-code-sandbox-mcp/CVE-2025-53372/

**Analysis / critique**
- InfoQ — Cloudflare Code Mode MCP: https://www.infoq.com/news/2026/04/cloudflare-code-mode-mcp-server/
- Adam Azzam — "Code Mode isn't a critique of MCP": https://aaazzam.substack.com/p/code-mode-isnt-a-critique-of-mcp
- arXiv:2510.14453 — Natural Language Tools (structured-output accuracy cost): https://arxiv.org/abs/2510.14453

**NeuroVault codebase (verified)**
- [`src-tauri/src/memory/mcp/registry.rs`](../../src-tauri/src/memory/mcp/registry.rs)
- [`src-tauri/src/memory/mcp/forward.rs`](../../src-tauri/src/memory/mcp/forward.rs)
- [`src-tauri/src/memory/mcp/tools.json`](../../src-tauri/src/memory/mcp/tools.json)
- [`src-tauri/src/memory/http_server.rs`](../../src-tauri/src/memory/http_server.rs)
