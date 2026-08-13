//! Ollama client, preflight, canary, error taxonomy (guide §4, slice C1).
//!
//! The curator's only outbound network surface. It speaks the **native**
//! Ollama API at a verified loopback endpoint — never `/openai/v1`,
//! which does not preserve per-request `num_ctx` — and it owns every
//! knob explicitly rather than inheriting a stack default (the fastembed
//! lesson). Spec §18 is the contract this module implements.
//!
//! # The five things that are not negotiable
//!
//! 1. **Loopback only.** [`ProviderConfig::base_url`] parses the endpoint
//!    and requires a literal loopback IP. A DNS name — including
//!    `localhost` — is rejected, because a name can resolve anywhere.
//!    The client is built with no proxy and no redirect following, so
//!    the socket cannot be re-pointed after validation.
//! 2. **`think: false`, top-level, on the native request.** Never the
//!    `/no_think` prompt soft-switch. Sent only when `/api/show` reports
//!    the `thinking` capability, because Ollama rejects the field with a
//!    400 on families that have no thinking channel (see
//!    [`ProviderConfig::require_think_control`]).
//! 3. **Constrained decoding is permanent.** `format` carries the JSON
//!    schema on every generation request, including after a model has
//!    passed evaluation and the canary. The schema is a *parameter* —
//!    `prompt.rs` owns its text; this module never embeds it.
//! 4. **The canary is a real request.** `/api/tags` and `/api/show`
//!    succeeding proves nothing: `think` × `format` drops are
//!    model-family-specific and silent. Every run sends one
//!    schema-constrained known-answer request before unit 1, and a
//!    failure aborts the run with a precise reason. Never a silent
//!    degrade to unconstrained decoding.
//! 5. **Unload is verified, not assumed.** After the terminal unit the
//!    session sends `keep_alive: 0` and polls `/api/ps` until the model
//!    is absent. A release reported by the request alone is not a
//!    release.
//!
//! # Warm-up, and why it has its own ceiling
//!
//! Preflight sends a throwaway one-token generation under
//! [`ProviderConfig::timeout_warmup_secs`] (default 30 min). On the dev
//! machine an 18 GB cold load exceeded 20 minutes under memory pressure,
//! and took ~112 s even from idle. Charging that to unit 1 would force
//! per-unit timeouts so generous they stop detecting a hung inference.
//! The warm-up absorbs the cold load; the per-unit ceilings then measure
//! only inference.
//!
//! # Instrumentation
//!
//! Every response records prefill and decode **separately** —
//! `prompt_eval_count`/`prompt_eval_duration` and
//! `eval_count`/`eval_duration` ([`InferenceCounters`]). The curator's
//! token ledger is roughly 10:1 prefill:decode, so a wall-clock number
//! alone cannot say which phase a model is losing in, and every
//! model-selection decision downstream turns on exactly that.
//!
//! # What this module deliberately does not do
//!
//! It does not validate output against the schema in depth, and it does
//! not decide what a well-formed abstention means. It guarantees
//! **bounded, parseable-or-classified bytes**: the body is capped while
//! streaming, the content must be a non-empty JSON object carrying the
//! schema's required top-level keys, and anything else is a typed
//! error. G00 owns real validation. In particular a bare `{}` is
//! [`MalformedKind::EmptyObject`] — a measured qwen3 collapse mode —
//! and is *never* reported as abstention.

use std::fmt;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use super::receipts::GenerationReceipt;
use super::state::{CuratorErrorCode, UnitOutcome};

/// `GenerationReceipt::provider`.
pub const PROVIDER_NAME: &str = "ollama";

/// Hard cap on a response body, enforced **while streaming**, before any
/// deserialization. A schema-constrained proposal object is ~1 KB; 256 KB
/// is four orders of margin and still bounded.
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// Floor for the native runtime: the top-level `think` field landed in
/// 0.9.0. (`format`-as-schema needs only 0.5.0, so `think` sets the bar.)
pub const MIN_RUNTIME_VERSION: (u32, u32, u32) = (0, 9, 0);

/// Front-truncation tripwire. Ollama does **not** error when a prompt
/// overflows `num_ctx` — it silently drops leading tokens, eating the
/// system message first. A `prompt_eval_count` this close to the ceiling
/// means the prompt was probably clipped.
pub const TRUNCATION_MARGIN_TOKENS: u64 = 64;

/// Slack reserved on top of the estimate + `num_predict` in the
/// client-side budget. Grammar tokens are invisible to
/// `prompt_eval_count`, so the margin is deliberately fat.
pub const BUDGET_HEADROOM_TOKENS: u32 = 512;

/// How long the session waits for `/api/ps` to stop listing the model.
pub const UNLOAD_POLL_TIMEOUT_SECS: u64 = 30;

/// Gap between `/api/ps` polls.
pub const UNLOAD_POLL_INTERVAL_MS: u64 = 250;

/// The endpoint a fresh config points at. No test may dial it.
pub const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:11434";

// ─────────────────────────── config ───────────────────────────

/// The `provider` block of `~/.neurovault/local_curator.json`.
///
/// Every field has a default, and the struct carries `#[serde(default)]`
/// with no `deny_unknown_fields`, so a slice-1 consent file that
/// predates this block still parses and a newer file with fields this
/// build has never heard of still parses. Field names follow the
/// implementation guide; `host` and `max_output_tokens` are accepted as
/// aliases for `endpoint` and `num_predict`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    /// Loopback base URL, e.g. `http://127.0.0.1:11434`. A DNS name is
    /// refused — see [`ProviderConfig::base_url`].
    #[serde(alias = "host")]
    pub endpoint: String,
    /// Exact model tag, e.g. `qwen3:30b-a3b-instruct-2507-q4_K_M`.
    pub model: String,
    /// Digest pinned at configure time. A mismatch at preflight aborts
    /// the run: a model the user re-pulled is a *different* model until
    /// they say otherwise. `None` = not yet pinned; preflight then
    /// reports the served digest for the UI to pin.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_digest: Option<String>,
    /// Per-request context window. Units are ~3–5 k tokens of prefill;
    /// 8192 is right and there is no reason to raise it.
    pub num_ctx: u32,
    /// Output ceiling. Hitting it mid-JSON is
    /// [`ProviderError::OutputTruncated`] — a grammar cannot rescue a
    /// truncated object.
    #[serde(alias = "max_output_tokens")]
    pub num_predict: u32,
    /// Held across the whole batch so the model loads once, not per
    /// unit. Native duration string.
    pub keep_alive: String,
    /// TCP connect ceiling. Connect is not inference; keep it short.
    pub timeout_connect_secs: u64,
    /// Ceiling for the preflight warm-up only. Generous by design: it
    /// absorbs a cold model load so the per-unit ceilings stay sharp.
    pub timeout_warmup_secs: u64,
    /// Ceiling for the canary and for unit 1.
    pub timeout_first_unit_secs: u64,
    /// Ceiling for every subsequent unit.
    pub timeout_unit_secs: u64,
    /// Ceiling for the small control calls (`/api/version`, `/api/tags`,
    /// `/api/show`, `/api/ps`).
    pub timeout_control_secs: u64,
    /// Units generated per run before the batch stops cleanly.
    pub max_units_per_run: u32,
    /// Wall-clock ceiling for the batch. The run ends mid-batch, the
    /// watermark holds, and the rest runs tomorrow.
    pub run_wall_clock_mins: u64,
    /// Require the model to advertise the `thinking` capability, so
    /// `think: false` is a control that actually exists (spec §18's
    /// qwen3-class contract). Default true.
    ///
    /// Setting it false is the explicit opt-in for a non-thinking family
    /// (a dense control arm, a `gpt-oss` MoE arm): the `think` field is
    /// then **omitted** rather than sent as false, because Ollama
    /// answers 400 when `think` is set on a model with no thinking
    /// channel. The canary still asserts no `<think>` leakage either way.
    pub require_think_control: bool,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            endpoint: DEFAULT_ENDPOINT.to_string(),
            model: String::new(),
            model_digest: None,
            num_ctx: 8192,
            num_predict: 2048,
            keep_alive: "10m".to_string(),
            timeout_connect_secs: 2,
            timeout_warmup_secs: 1800,
            timeout_first_unit_secs: 240,
            timeout_unit_secs: 180,
            timeout_control_secs: 15,
            max_units_per_run: 24,
            run_wall_clock_mins: 45,
            require_think_control: true,
        }
    }
}

impl ProviderConfig {
    /// Validate the endpoint and return the trimmed base URL.
    ///
    /// Refuses anything that is not `http(s)` at a **literal** loopback
    /// IP: a DNS name (including `localhost`) can resolve off-host, and
    /// spec §18 requires a literal loopback address or a Unix socket.
    /// Unix sockets are not a V1 transport, so a `unix:` endpoint is
    /// refused outright rather than silently downgraded to TCP.
    pub fn base_url(&self) -> Result<String, ProviderError> {
        if self.model.trim().is_empty() {
            return Err(ProviderError::ModelUnset);
        }
        let raw = self.endpoint.trim().trim_end_matches('/');
        let url = reqwest::Url::parse(raw).map_err(|_| ProviderError::MalformedEndpoint {
            endpoint: self.endpoint.clone(),
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ProviderError::MalformedEndpoint {
                endpoint: self.endpoint.clone(),
            });
        }
        if !url.path().is_empty() && url.path() != "/" {
            return Err(ProviderError::MalformedEndpoint {
                endpoint: self.endpoint.clone(),
            });
        }
        let host = url
            .host_str()
            .ok_or_else(|| ProviderError::MalformedEndpoint {
                endpoint: self.endpoint.clone(),
            })?;
        // `host_str` serializes an IPv6 literal with brackets.
        let literal = host.trim_start_matches('[').trim_end_matches(']');
        let ip: IpAddr = literal
            .parse()
            .map_err(|_| ProviderError::NonLoopbackEndpoint {
                endpoint: self.endpoint.clone(),
            })?;
        if !ip.is_loopback() {
            return Err(ProviderError::NonLoopbackEndpoint {
                endpoint: self.endpoint.clone(),
            });
        }
        Ok(raw.to_string())
    }

    fn timeout(&self, secs: u64) -> Duration {
        Duration::from_secs(secs.max(1))
    }
}

/// `~/.neurovault/local_curator.json` as this module reads it.
///
/// Deliberately a second, tolerant view of the same file that
/// `evidence.rs` reads for consent: that reader owns the consent
/// booleans and must never be coupled to provider fields, and this one
/// must never gate on them. Both ignore unknown keys, so the two views
/// evolve independently.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalCuratorFile {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub transcript_access: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderConfig>,
}

impl LocalCuratorFile {
    /// Parse file contents, tolerating unknown keys. `None` only when
    /// the bytes are not JSON at all.
    pub fn parse(raw: &str) -> Option<Self> {
        serde_json::from_str(raw).ok()
    }

    /// Read the server-owned config. A missing or unreadable file is the
    /// default (consent off, no provider) — never an error, because the
    /// curator must fail closed and quiet.
    pub fn load() -> Self {
        let path = crate::memory::paths::nv_home().join("local_curator.json");
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| Self::parse(&raw))
            .unwrap_or_default()
    }

    /// The provider block, or [`ProviderError::NotConfigured`].
    pub fn provider(&self) -> Result<&ProviderConfig, ProviderError> {
        self.provider.as_ref().ok_or(ProviderError::NotConfigured)
    }
}

// ─────────────────────────── errors ───────────────────────────

/// What the runner does with a failure. Preflight is special: **any**
/// error returned from [`ProviderSession::start`] aborts the run,
/// whatever its mid-batch disposition would be, because the run has not
/// begun and the watermark has not moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    /// Abort the run before unit 1; the watermark is unchanged.
    RunAbort,
    /// This unit retries on a later run (bounded by `RetryPolicy`).
    DeferUnit,
    /// This unit will never succeed as-is; record it and move on.
    SkipUnit,
    /// A fault to surface that costs no unit — the batch is already done.
    RunFault,
}

/// Why bytes that arrived were not usable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MalformedKind {
    /// The HTTP body was not the native response envelope.
    EnvelopeNotJson,
    /// The envelope had no `message` object.
    NoMessage,
    /// `message.content` was not JSON.
    ContentNotJson,
    /// `message.content` parsed, but not to an object.
    NotObject,
    /// Literal `{}` — the measured qwen3 collapse mode. A malformed
    /// answer, never an abstention.
    EmptyObject,
    /// An object missing a key the schema lists as required. Shallow
    /// only; G00 owns real validation.
    MissingRequiredKey,
}

/// Which half of the canary contract the model broke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CanaryFailure {
    /// The canary request itself failed (transport, status, timeout).
    Transport,
    /// A thinking channel or a `<think>` tag survived `think: false`.
    ThinkLeak,
    /// Output ignored the schema — `format` was silently dropped.
    SchemaIgnored,
    /// Well-formed, but citing no expected sentence ID: the model cannot
    /// follow the evidence contract on a known answer.
    EvidenceMismatch,
    /// Output hit `num_predict` mid-object.
    Truncated,
}

/// Every way the provider can fail, typed so the runner never has to
/// pattern-match a string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ProviderError {
    // ── configuration: the run cannot start ──
    /// No `provider` block in `local_curator.json`.
    NotConfigured,
    /// Endpoint is not a literal loopback IP.
    NonLoopbackEndpoint { endpoint: String },
    /// Endpoint is not a parseable `http(s)` base URL.
    MalformedEndpoint { endpoint: String },
    /// No model tag configured.
    ModelUnset,

    // ── preflight: abort the run, watermark unchanged ──
    /// Connect refused, or a control call that never answered.
    OllamaUnreachable { detail: String },
    /// Runtime older than [`MIN_RUNTIME_VERSION`]; no top-level `think`.
    VersionTooOld { got: String },
    /// The tag is not installed. **Never** auto-pulled.
    ModelNotInstalled { model: String },
    /// `/api/show` capabilities lack `thinking` while
    /// [`ProviderConfig::require_think_control`] is set.
    ModelLacksThinkControl { model: String },
    /// The model's own context window is below the configured `num_ctx`.
    ContextWindowTooSmall { model_ctx: u32, required: u32 },
    /// The served digest is not the pinned one.
    ModelFingerprintMismatch { pinned: String, served: String },
    /// The warm-up generation failed under its (generous) ceiling.
    WarmupFailed { detail: String },
    /// The one defence against per-family `think` × `format` drops.
    CanaryFailed { reason: CanaryFailure },

    // ── per unit ──
    /// 503: the user's Ollama queue is full. Back off and retry.
    ServerBusy,
    /// Any other non-success status.
    HttpStatus { status: u16 },
    /// The per-request ceiling elapsed.
    InferenceTimeout,
    /// The client-side budget refused to send. Ollama front-truncates
    /// silently on overflow, so refusing is the only safe answer;
    /// splitting the unit is the caller's option, never ours.
    UnitOverBudget { estimated_tokens: u32, ceiling: u32 },
    /// `done_reason == "length"`: the object was cut mid-JSON.
    OutputTruncated,
    /// `prompt_eval_count` within [`TRUNCATION_MARGIN_TOKENS`] of
    /// `num_ctx` — the prompt was probably front-truncated.
    TruncationSuspected {
        prompt_eval_count: u64,
        num_ctx: u32,
    },
    /// The body exceeded [`MAX_RESPONSE_BYTES`] mid-stream.
    ResponseTooLarge { cap_bytes: usize },
    /// A success status with no body.
    EmptyBody,
    /// A thinking channel or `<think>` tag in a `think: false` response.
    ThinkLeak,
    /// Bytes arrived and are not a usable object.
    MalformedOutput { detail: MalformedKind },

    // ── batch ──
    /// The run's wall-clock ceiling elapsed; stop cleanly.
    RunDeadlineExceeded,
    /// `/api/ps` still lists the model after `keep_alive: 0`. VRAM
    /// release is never inferred from the unload request alone.
    UnloadUnverified { detail: String },
}

impl ProviderError {
    /// Closed-vocabulary token safe to persist in a receipt: printable
    /// ASCII, no space, quote, or path separator.
    pub fn code(&self) -> &'static str {
        use ProviderError::*;
        match self {
            NotConfigured => "not_configured",
            NonLoopbackEndpoint { .. } => "non_loopback_endpoint",
            MalformedEndpoint { .. } => "malformed_endpoint",
            ModelUnset => "model_unset",
            OllamaUnreachable { .. } => "ollama_unreachable",
            VersionTooOld { .. } => "version_too_old",
            ModelNotInstalled { .. } => "model_not_installed",
            ModelLacksThinkControl { .. } => "model_lacks_think_control",
            ContextWindowTooSmall { .. } => "context_window_too_small",
            ModelFingerprintMismatch { .. } => "model_fingerprint_mismatch",
            WarmupFailed { .. } => "warmup_failed",
            CanaryFailed { .. } => "canary_failed",
            ServerBusy => "server_busy",
            HttpStatus { .. } => "http_status",
            InferenceTimeout => "inference_timeout",
            UnitOverBudget { .. } => "unit_over_budget",
            OutputTruncated => "output_truncated",
            TruncationSuspected { .. } => "truncation_suspected",
            ResponseTooLarge { .. } => "response_too_large",
            EmptyBody => "empty_body",
            ThinkLeak => "think_leak",
            MalformedOutput { .. } => "malformed_output",
            RunDeadlineExceeded => "run_deadline_exceeded",
            UnloadUnverified { .. } => "unload_unverified",
        }
    }

    /// Mid-batch meaning. Preflight-class errors read [`Disposition::RunAbort`]
    /// here too, but note that *any* error out of [`ProviderSession::start`]
    /// aborts the run regardless of what this says.
    pub fn disposition(&self) -> Disposition {
        use ProviderError::*;
        match self {
            // configuration + preflight
            NotConfigured
            | NonLoopbackEndpoint { .. }
            | MalformedEndpoint { .. }
            | ModelUnset
            | VersionTooOld { .. }
            | ModelNotInstalled { .. }
            | ModelLacksThinkControl { .. }
            | ContextWindowTooSmall { .. }
            | ModelFingerprintMismatch { .. }
            | WarmupFailed { .. }
            | CanaryFailed { .. } => Disposition::RunAbort,

            // permanent for this unit: retrying an over-budget unit
            // reproduces the same refusal, byte for byte.
            UnitOverBudget { .. } => Disposition::SkipUnit,

            // transient or model-flaky: the unit comes back tomorrow.
            OllamaUnreachable { .. }
            | ServerBusy
            | HttpStatus { .. }
            | InferenceTimeout
            | OutputTruncated
            | TruncationSuspected { .. }
            | ResponseTooLarge { .. }
            | EmptyBody
            | ThinkLeak
            | MalformedOutput { .. }
            | RunDeadlineExceeded => Disposition::DeferUnit,

            // the batch is over; nothing is owed to a unit.
            UnloadUnverified { .. } => Disposition::RunFault,
        }
    }

    /// The ledger's closed error vocabulary ([`CuratorErrorCode`]).
    pub fn error_code(&self) -> CuratorErrorCode {
        use ProviderError::*;
        match self {
            NotConfigured
            | NonLoopbackEndpoint { .. }
            | MalformedEndpoint { .. }
            | ModelUnset
            | OllamaUnreachable { .. }
            | VersionTooOld { .. }
            | ModelNotInstalled { .. }
            | ServerBusy
            | HttpStatus { .. }
            | UnloadUnverified { .. } => CuratorErrorCode::ProviderUnavailable,

            InferenceTimeout | RunDeadlineExceeded => CuratorErrorCode::ProviderTimeout,

            WarmupFailed { .. }
            | CanaryFailed { .. }
            | OutputTruncated
            | TruncationSuspected { .. }
            | ResponseTooLarge { .. }
            | EmptyBody
            | ThinkLeak
            | MalformedOutput { .. } => CuratorErrorCode::InvalidResponse,

            ModelLacksThinkControl { .. }
            | ContextWindowTooSmall { .. }
            | ModelFingerprintMismatch { .. }
            | UnitOverBudget { .. } => CuratorErrorCode::PolicyRejected,
        }
    }

    /// How `state.rs` should record the unit, when a unit is in play.
    ///
    /// `None` means no unit transition applies: the run aborted before
    /// unit 1, or the fault happened after the last unit.
    ///
    /// `SkipUnit` maps to [`UnitOutcome::PermanentlyRejected`], the
    /// ledger's policy-terminal state: an over-budget unit is audited
    /// and visible, never retried, and never silently truncated.
    pub fn unit_outcome(&self) -> Option<UnitOutcome> {
        match self.disposition() {
            Disposition::DeferUnit => Some(UnitOutcome::Deferred(self.error_code())),
            Disposition::SkipUnit => Some(UnitOutcome::PermanentlyRejected),
            Disposition::RunAbort | Disposition::RunFault => None,
        }
    }

    /// Suggested in-run backoff before the caller retries this exact
    /// request. `None` = do not retry inside the run.
    pub fn retry_after(&self) -> Option<Duration> {
        use ProviderError::*;
        match self {
            // 503 is a FIFO queue that will drain.
            ServerBusy => Some(Duration::from_secs(30)),
            OllamaUnreachable { .. } => Some(Duration::from_secs(5)),
            // Retrying at temperature 0 is only useful with a fresh seed,
            // which the caller supplies; no backoff needed.
            MalformedOutput { .. } | ThinkLeak | EmptyBody | InferenceTimeout => {
                Some(Duration::ZERO)
            }
            _ => None,
        }
    }

    /// One sentence for the user. Never a path, never a prompt.
    pub fn user_hint(&self) -> String {
        use ProviderError::*;
        match self {
            NotConfigured => {
                "No local model is configured. Add a provider in Settings → Local curator.".into()
            }
            NonLoopbackEndpoint { endpoint } => format!(
                "The curator only talks to a loopback address. {endpoint} is not one — use http://127.0.0.1:11434."
            ),
            MalformedEndpoint { endpoint } => {
                format!("{endpoint} is not a usable http:// base URL.")
            }
            ModelUnset => "Pick a model in Settings → Local curator.".into(),
            OllamaUnreachable { .. } => {
                "Ollama is not answering on the configured loopback port. Start it and run the curator again.".into()
            }
            VersionTooOld { got } => format!(
                "Ollama {got} is too old: the curator needs {}.{}.{} or newer for the native think control.",
                MIN_RUNTIME_VERSION.0, MIN_RUNTIME_VERSION.1, MIN_RUNTIME_VERSION.2
            ),
            // Deliberately a prompt, not a download: NeuroVault never
            // pulls a multi-gigabyte model on the user's behalf.
            ModelNotInstalled { model } => format!(
                "The model {model} is not installed. Install it yourself (Settings shows the download size) — the curator will not pull it for you."
            ),
            ModelLacksThinkControl { model } => format!(
                "{model} has no thinking channel, so think:false is not a real control. Choose a thinking-capable model, or turn off require_think_control to run it anyway."
            ),
            ContextWindowTooSmall { model_ctx, required } => format!(
                "The model's context window is {model_ctx} tokens; the curator is configured for {required}. Lower num_ctx or pick a larger-context model."
            ),
            ModelFingerprintMismatch { .. } => {
                "The installed model changed since you pinned it. Re-pin it in Settings to confirm you want the new build.".into()
            }
            WarmupFailed { .. } => {
                "The model did not finish loading in time. Free some memory and run the curator again.".into()
            }
            CanaryFailed { reason } => format!(
                "The model failed its start-up check ({reason:?}) — it does not honour think:false plus schema-constrained output. The run stopped before any memory was proposed."
            ),
            ServerBusy => "Ollama is busy with other work; the curator will try again later.".into(),
            HttpStatus { status } => format!("Ollama answered {status}."),
            InferenceTimeout => "The model took too long on one unit; it will be retried.".into(),
            UnitOverBudget { estimated_tokens, ceiling } => format!(
                "One conversation was too long for the context window ({estimated_tokens} of {ceiling} tokens) and was skipped rather than silently cut."
            ),
            OutputTruncated => "The model's answer was cut off; it will be retried.".into(),
            TruncationSuspected { .. } => {
                "The prompt may have been cut to fit the context window, so that unit was not trusted.".into()
            }
            ResponseTooLarge { .. } => {
                "The model's answer was implausibly large and was dropped.".into()
            }
            EmptyBody => "Ollama returned an empty answer.".into(),
            ThinkLeak => "The model emitted reasoning text despite think:false.".into(),
            MalformedOutput { detail } => format!("The model's answer was not usable ({detail:?})."),
            RunDeadlineExceeded => {
                "The curator hit its time limit for tonight; the rest runs tomorrow.".into()
            }
            UnloadUnverified { .. } => {
                "The model was asked to unload but is still resident. Memory may stay in use until Ollama releases it.".into()
            }
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code(), self.user_hint())
    }
}

impl std::error::Error for ProviderError {}

// ─────────────────────── instrumentation ───────────────────────

/// Prefill and decode, measured separately.
///
/// The curator's workload is ~10:1 prefill:decode, so a single
/// wall-clock number cannot say which phase a model loses in — and every
/// model-selection decision downstream turns on exactly that. Durations
/// are nanoseconds, as the native API reports them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct InferenceCounters {
    /// Tokens the model actually ingested. Compare against `num_ctx`:
    /// too close to the ceiling means front-truncation.
    pub prompt_eval_count: u64,
    pub prompt_eval_duration_ns: u64,
    pub eval_count: u64,
    pub eval_duration_ns: u64,
    /// Nonzero means the model was (re)loaded for this request.
    pub load_duration_ns: u64,
    pub total_duration_ns: u64,
}

impl InferenceCounters {
    /// Prefill throughput, or `None` when the runtime reported no
    /// prefill duration.
    pub fn prefill_tokens_per_sec(&self) -> Option<f64> {
        rate(self.prompt_eval_count, self.prompt_eval_duration_ns)
    }

    /// Decode throughput, or `None` when the runtime reported none.
    pub fn decode_tokens_per_sec(&self) -> Option<f64> {
        rate(self.eval_count, self.eval_duration_ns)
    }

    /// True when the model was loaded during this request. True after
    /// unit 1 means `keep_alive` is not holding and the run is paying a
    /// cold load per unit.
    pub fn model_was_loaded(&self) -> bool {
        self.load_duration_ns > 0
    }
}

fn rate(count: u64, duration_ns: u64) -> Option<f64> {
    if duration_ns == 0 || count == 0 {
        return None;
    }
    Some(count as f64 * 1_000_000_000.0 / duration_ns as f64)
}

// ─────────────────────── wire types ───────────────────────

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    /// Always false: one body, with `done_reason` and the eval counters
    /// in hand. Byte capping happens on the transport, not here.
    stream: bool,
    /// Top-level, native — never a `/no_think` prompt switch. Omitted
    /// entirely for a model with no thinking channel (Ollama 400s on the
    /// field there).
    #[serde(skip_serializing_if = "Option::is_none")]
    think: Option<bool>,
    /// The JSON schema. Permanent — present on every generation request.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'a serde_json::Value>,
    keep_alive: &'a str,
    options: ChatOptions,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatOptions {
    num_ctx: u32,
    num_predict: u32,
    temperature: f32,
    seed: u64,
}

#[derive(Deserialize)]
struct ChatResponse {
    #[serde(default)]
    message: Option<RespMessage>,
    #[serde(default)]
    done_reason: Option<String>,
    #[serde(default)]
    prompt_eval_count: Option<u64>,
    #[serde(default)]
    prompt_eval_duration: Option<u64>,
    #[serde(default)]
    eval_count: Option<u64>,
    #[serde(default)]
    eval_duration: Option<u64>,
    #[serde(default)]
    load_duration: Option<u64>,
    #[serde(default)]
    total_duration: Option<u64>,
    /// Native error envelope (a 400 for an unsupported `think`, say).
    #[serde(default)]
    error: Option<String>,
}

impl ChatResponse {
    fn counters(&self) -> InferenceCounters {
        InferenceCounters {
            prompt_eval_count: self.prompt_eval_count.unwrap_or_default(),
            prompt_eval_duration_ns: self.prompt_eval_duration.unwrap_or_default(),
            eval_count: self.eval_count.unwrap_or_default(),
            eval_duration_ns: self.eval_duration.unwrap_or_default(),
            load_duration_ns: self.load_duration.unwrap_or_default(),
            total_duration_ns: self.total_duration.unwrap_or_default(),
        }
    }
}

#[derive(Deserialize)]
struct RespMessage {
    #[serde(default)]
    content: String,
    /// The native thinking channel. Any content here under
    /// `think: false` is a leak.
    #[serde(default)]
    thinking: Option<String>,
}

#[derive(Deserialize)]
struct VersionResponse {
    #[serde(default)]
    version: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<TagEntry>,
}

#[derive(Deserialize)]
struct TagEntry {
    #[serde(default)]
    name: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    digest: String,
}

#[derive(Deserialize)]
struct ShowResponse {
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default)]
    model_info: serde_json::Map<String, serde_json::Value>,
}

// ─────────────────────── token budget ───────────────────────

/// What the client-side guard computed before sending.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenBudget {
    pub estimated_prompt_tokens: u32,
    pub reserved_output_tokens: u32,
    /// `num_ctx`.
    pub ceiling: u32,
}

/// Refuse a unit that would not fit, **before** sending it.
///
/// Ollama does not error on context overflow — it front-truncates,
/// dropping the system message first, and returns a confident answer
/// derived from a prompt nobody chose. The provider cannot split a unit
/// but the caller can, so this refuses and leaves splitting to the
/// runner.
///
/// The estimate is supplied by the caller (`prompt.rs` owns it) so this
/// module couples to no tokenizer and no model family.
pub fn check_token_budget(
    cfg: &ProviderConfig,
    system: &str,
    user: &str,
    estimate: &dyn Fn(&str) -> u32,
) -> Result<TokenBudget, ProviderError> {
    let estimated = estimate(system).saturating_add(estimate(user));
    let needed = estimated
        .saturating_add(cfg.num_predict)
        .saturating_add(BUDGET_HEADROOM_TOKENS);
    if needed > cfg.num_ctx {
        return Err(ProviderError::UnitOverBudget {
            estimated_tokens: estimated,
            ceiling: cfg.num_ctx,
        });
    }
    Ok(TokenBudget {
        estimated_prompt_tokens: estimated,
        reserved_output_tokens: cfg.num_predict,
        ceiling: cfg.num_ctx,
    })
}

// ─────────────────────── output shape ───────────────────────

/// Shallow, schema-driven shape check.
///
/// Reads the *caller's* schema for its required top-level keys rather
/// than embedding any knowledge of the curator's output shape. This is
/// the boundary the provider guarantees — a non-empty JSON object with
/// the required keys present. Types, nesting, enums and every semantic
/// contract belong to G00.
fn shallow_schema_check(
    schema: &serde_json::Value,
    value: &serde_json::Value,
) -> Result<(), MalformedKind> {
    let Some(obj) = value.as_object() else {
        return Err(MalformedKind::NotObject);
    };
    if obj.is_empty() {
        // Measured qwen3 collapse mode. Never abstention.
        return Err(MalformedKind::EmptyObject);
    }
    if let Some(required) = schema.get("required").and_then(|r| r.as_array()) {
        for key in required.iter().filter_map(|k| k.as_str()) {
            if !obj.contains_key(key) {
                return Err(MalformedKind::MissingRequiredKey);
            }
        }
    }
    Ok(())
}

/// Every string under an `evidence` array, at any depth. Used only by
/// the canary, so the provider can check the evidence contract without
/// knowing the schema's shape.
fn collect_evidence_ids(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                if key == "evidence" {
                    if let Some(items) = child.as_array() {
                        out.extend(items.iter().filter_map(|i| i.as_str().map(str::to_string)));
                    }
                }
                collect_evidence_ids(child, out);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_evidence_ids(item, out);
            }
        }
        _ => {}
    }
}

/// `<think>` leakage in content, belt to the canary's suspenders.
fn contains_think_tag(content: &str) -> bool {
    content.contains("<think>") || content.contains("</think>")
}

// ─────────────────────── the client ───────────────────────

/// One client per run. Only the connect timeout is global — every
/// request carries its own ceiling, so a two-minute inference cannot
/// trip a budget meant for a TCP handshake.
///
/// Proxies and redirects are both off: once [`ProviderConfig::base_url`]
/// has proven the endpoint is loopback, nothing may re-point the socket.
pub fn client(cfg: &ProviderConfig) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(cfg.timeout(cfg.timeout_connect_secs))
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("static reqwest client config")
}

/// Read a body with a hard cap enforced **while streaming**, so an
/// enormous or endless response is never buffered whole and never
/// reaches the JSON parser.
async fn read_capped(mut resp: reqwest::Response, cap: usize) -> Result<Vec<u8>, ProviderError> {
    let mut body = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > cap {
                    return Err(ProviderError::ResponseTooLarge { cap_bytes: cap });
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(map_transport(&e)),
        }
    }
    if body.is_empty() {
        return Err(ProviderError::EmptyBody);
    }
    Ok(body)
}

fn map_transport(e: &reqwest::Error) -> ProviderError {
    if e.is_timeout() {
        ProviderError::InferenceTimeout
    } else {
        ProviderError::OllamaUnreachable {
            detail: transport_detail(e),
        }
    }
}

/// A short, safe description — never the URL, which would put a port
/// (and with a Unix socket, a path) into a persisted receipt.
fn transport_detail(e: &reqwest::Error) -> String {
    if e.is_connect() {
        "connect".into()
    } else if e.is_timeout() {
        "timeout".into()
    } else if e.is_body() || e.is_decode() {
        "body".into()
    } else if e.is_redirect() {
        "redirect".into()
    } else {
        "transport".into()
    }
}

/// Non-success statuses, mapped once.
fn map_status(status: u16) -> Option<ProviderError> {
    match status {
        200..=299 => None,
        503 => Some(ProviderError::ServerBusy),
        other => Some(ProviderError::HttpStatus { status: other }),
    }
}

// ─────────────────────── session ───────────────────────

/// What preflight established, and the receipts it produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Preflight {
    pub runtime_version: String,
    /// The digest actually served — what ran, not what was asked for.
    pub model_digest: String,
    /// The model's own context window, from `/api/show`.
    pub context_length: u32,
    pub capabilities: Vec<String>,
    /// Whether `think: false` was sent (the model advertises `thinking`).
    pub think_control: bool,
    pub warmup_ms: u64,
    pub canary_ms: u64,
    /// The canary's own prefill/decode counters — the first honest
    /// measurement of this machine on this run.
    pub canary_counters: InferenceCounters,
}

/// The known-answer unit the canary sends.
///
/// The provider owns the *check*, not the text: `prompt.rs` owns the
/// system message and schema, `segment.rs` owns the rendering, and the
/// runner hands both over. Embedding prompt text here would let the
/// canary drift out of sync with production — the exact failure the
/// canary exists to catch.
pub struct CanarySpec<'a> {
    pub system: &'a str,
    /// A fixed, rendered, known-answer unit (spec §18: six sentences).
    pub user: &'a str,
    pub schema: &'a serde_json::Value,
    /// Sentence IDs the gold answer may cite. Empty = do not check;
    /// structure and think-leak are still checked.
    pub expected_evidence_ids: &'a [&'a str],
}

/// What `/api/ps` said after the unload request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UnloadReport {
    pub verified: bool,
    pub polls: u32,
    pub elapsed_ms: u64,
}

/// One generation request.
///
/// `estimate_tokens` is the caller's conservative token estimate
/// (`prompt.rs` owns it); `schema` is the caller's JSON schema; and
/// `output_schema_version` is stamped into the receipt. All three are
/// parameters, so this module owns no prompt or schema text and links
/// against no other slice's constants.
pub struct UnitRequest<'a> {
    pub system: &'a str,
    pub user: &'a str,
    pub schema: &'a serde_json::Value,
    /// Bumped by the caller on retry: an identical retry at temperature
    /// 0 reproduces the same failure.
    pub seed: u64,
    pub output_schema_version: u32,
    pub estimate_tokens: &'a dyn Fn(&str) -> u32,
}

/// A bounded, schema-shaped model answer plus its receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitReply {
    /// `message.content` — proven to be a non-empty JSON object with the
    /// schema's required top-level keys. Not otherwise validated.
    pub raw_json: String,
    pub counters: InferenceCounters,
    pub generation: GenerationReceipt,
}

/// One run's conversation with the user's Ollama.
///
/// Construction *is* preflight, so no code path can generate a unit
/// against an unverified model. `chat_unit` takes `&mut self`, which
/// makes "one request in flight per run" a compile-time property rather
/// than a convention.
#[derive(Debug)]
pub struct ProviderSession {
    cfg: ProviderConfig,
    base: String,
    client: reqwest::Client,
    preflight: Preflight,
    units_started: u32,
    started: Instant,
    unloaded: bool,
    /// How long [`ProviderSession::finish`] polls before calling the
    /// unload unverified. Always [`UNLOAD_POLL_TIMEOUT_SECS`] in a real
    /// run; shortened by tests so the suite does not spend half a minute
    /// proving a bounded loop is bounded.
    unload_deadline: Duration,
}

impl ProviderSession {
    /// Run the full preflight and open the batch.
    ///
    /// Order (spec §18 + guide §4.3): reachability and version floor →
    /// model installed (never pulled) → `/api/show` capabilities, context
    /// window and digest pin → **warm-up** under the long ceiling →
    /// **canary** under the first-unit ceiling. Every error out of this
    /// function is a run-abort; the watermark must not move.
    pub async fn start(
        cfg: &ProviderConfig,
        client: reqwest::Client,
        canary: &CanarySpec<'_>,
    ) -> Result<Self, ProviderError> {
        let base = cfg.base_url()?;
        let runtime_version = check_version(cfg, &client, &base).await?;
        let served_digest = check_model_installed(cfg, &client, &base).await?;
        if let Some(pinned) = cfg.model_digest.as_deref() {
            if !pinned.is_empty() && pinned != served_digest {
                return Err(ProviderError::ModelFingerprintMismatch {
                    pinned: pinned.to_string(),
                    served: served_digest,
                });
            }
        }
        let (capabilities, context_length) = check_show(cfg, &client, &base).await?;
        let think_control = capabilities.iter().any(|c| c == "thinking");
        if cfg.require_think_control && !think_control {
            return Err(ProviderError::ModelLacksThinkControl {
                model: cfg.model.clone(),
            });
        }
        if context_length > 0 && context_length < cfg.num_ctx {
            return Err(ProviderError::ContextWindowTooSmall {
                model_ctx: context_length,
                required: cfg.num_ctx,
            });
        }

        let warmup_ms = warm_up(cfg, &client, &base, think_control).await?;

        let clock = Instant::now();
        let (canary_counters, content, thinking) = run_chat(
            cfg,
            &client,
            &base,
            ChatCall {
                system: canary.system,
                user: canary.user,
                schema: Some(canary.schema),
                keep_alive: &cfg.keep_alive,
                think: think_control.then_some(false),
                seed: 0,
                num_predict: cfg.num_predict,
                timeout: cfg.timeout(cfg.timeout_first_unit_secs),
            },
        )
        .await
        .map_err(canary_transport)?;
        let canary_ms = clock.elapsed().as_millis() as u64;
        check_canary_output(canary, &content, thinking.as_deref())?;

        Ok(Self {
            cfg: cfg.clone(),
            base,
            client,
            preflight: Preflight {
                runtime_version,
                model_digest: served_digest,
                context_length,
                capabilities,
                think_control,
                warmup_ms,
                canary_ms,
                canary_counters,
            },
            units_started: 0,
            started: Instant::now(),
            unloaded: false,
            unload_deadline: Duration::from_secs(UNLOAD_POLL_TIMEOUT_SECS),
        })
    }

    /// What preflight established. The digest here is what actually ran.
    pub fn preflight(&self) -> &Preflight {
        &self.preflight
    }

    /// True once the batch has spent its wall-clock budget.
    pub fn deadline_exceeded(&self) -> bool {
        self.started.elapsed() >= Duration::from_secs(self.cfg.run_wall_clock_mins * 60)
    }

    /// True once the batch has generated `max_units_per_run` units.
    pub fn unit_budget_spent(&self) -> bool {
        self.units_started >= self.cfg.max_units_per_run
    }

    #[cfg(test)]
    fn with_unload_deadline(mut self, d: Duration) -> Self {
        self.unload_deadline = d;
        self
    }

    /// Generate one unit.
    ///
    /// `&mut self` is the one-in-flight guarantee. The token budget is
    /// checked before a byte goes out, because Ollama front-truncates
    /// rather than refusing.
    pub async fn chat_unit(&mut self, req: UnitRequest<'_>) -> Result<UnitReply, ProviderError> {
        if self.deadline_exceeded() {
            return Err(ProviderError::RunDeadlineExceeded);
        }
        check_token_budget(&self.cfg, req.system, req.user, req.estimate_tokens)?;

        let first = self.units_started == 0;
        self.units_started = self.units_started.saturating_add(1);
        let timeout = self.cfg.timeout(if first {
            self.cfg.timeout_first_unit_secs
        } else {
            self.cfg.timeout_unit_secs
        });

        let call = ChatCall {
            system: req.system,
            user: req.user,
            schema: Some(req.schema),
            keep_alive: &self.cfg.keep_alive,
            think: self.preflight.think_control.then_some(false),
            seed: req.seed,
            num_predict: self.cfg.num_predict,
            timeout,
        };
        let started_at = OffsetDateTime::now_utc()
            .format(&Rfc3339)
            .unwrap_or_default();
        let clock = Instant::now();
        let request_sha256 = sha256_hex(&render_request(&self.cfg, &call));
        let (counters, content, thinking) =
            run_chat(&self.cfg, &self.client, &self.base, call).await?;

        if thinking.is_some_and(|t| !t.trim().is_empty()) || contains_think_tag(&content) {
            return Err(ProviderError::ThinkLeak);
        }
        if counters.prompt_eval_count > 0
            && counters.prompt_eval_count + TRUNCATION_MARGIN_TOKENS >= self.cfg.num_ctx as u64
        {
            return Err(ProviderError::TruncationSuspected {
                prompt_eval_count: counters.prompt_eval_count,
                num_ctx: self.cfg.num_ctx,
            });
        }
        let parsed: serde_json::Value =
            serde_json::from_str(&content).map_err(|_| ProviderError::MalformedOutput {
                detail: MalformedKind::ContentNotJson,
            })?;
        shallow_schema_check(req.schema, &parsed)
            .map_err(|detail| ProviderError::MalformedOutput { detail })?;

        Ok(UnitReply {
            counters,
            generation: GenerationReceipt {
                provider: PROVIDER_NAME.to_string(),
                model_id: self.cfg.model.clone(),
                model_digest: self.preflight.model_digest.clone(),
                prompt_sha256: sha256_hex(req.user.as_bytes()),
                request_sha256,
                response_sha256: sha256_hex(content.as_bytes()),
                output_schema_version: req.output_schema_version,
                started_at,
                duration_ms: clock.elapsed().as_millis() as u64,
            },
            raw_json: content,
        })
    }

    /// Close the batch: `keep_alive: 0`, then poll `/api/ps` until the
    /// model is gone. Release is verified, never inferred — a successful
    /// unload *request* proves nothing about residency.
    ///
    /// Idempotent: a second call reports the first result.
    pub async fn finish(&mut self) -> Result<UnloadReport, ProviderError> {
        if self.unloaded {
            return Ok(UnloadReport {
                verified: true,
                polls: 0,
                elapsed_ms: 0,
            });
        }
        let clock = Instant::now();
        // An empty message list plus keep_alive 0 is the native unload.
        let unload = ChatCall {
            system: "",
            user: "",
            schema: None,
            keep_alive: "0",
            think: None,
            seed: 0,
            num_predict: 0,
            timeout: self.cfg.timeout(self.cfg.timeout_control_secs),
        };
        // The unload body is uninteresting, but a transport failure here
        // still means we cannot claim a release.
        if let Err(e) = run_unload(&self.cfg, &self.client, &self.base, unload).await {
            return Err(ProviderError::UnloadUnverified {
                detail: e.code().to_string(),
            });
        }

        let deadline = self.unload_deadline;
        let mut polls = 0u32;
        loop {
            polls = polls.saturating_add(1);
            match model_resident(&self.cfg, &self.client, &self.base).await {
                Ok(false) => {
                    self.unloaded = true;
                    return Ok(UnloadReport {
                        verified: true,
                        polls,
                        elapsed_ms: clock.elapsed().as_millis() as u64,
                    });
                }
                Ok(true) => {}
                Err(e) => {
                    return Err(ProviderError::UnloadUnverified {
                        detail: e.code().to_string(),
                    })
                }
            }
            if clock.elapsed() >= deadline {
                return Err(ProviderError::UnloadUnverified {
                    detail: "still_resident".to_string(),
                });
            }
            tokio::time::sleep(Duration::from_millis(UNLOAD_POLL_INTERVAL_MS)).await;
        }
    }
}

/// One native `/api/chat` invocation, fully specified. Nothing about a
/// request is left to a default anywhere below this struct.
struct ChatCall<'a> {
    system: &'a str,
    user: &'a str,
    schema: Option<&'a serde_json::Value>,
    keep_alive: &'a str,
    think: Option<bool>,
    seed: u64,
    num_predict: u32,
    timeout: Duration,
}

fn build_request<'a>(cfg: &'a ProviderConfig, call: &'a ChatCall<'a>) -> ChatRequest<'a> {
    let messages = if call.system.is_empty() && call.user.is_empty() {
        Vec::new()
    } else {
        vec![
            ChatMessage {
                role: "system",
                content: call.system,
            },
            ChatMessage {
                role: "user",
                content: call.user,
            },
        ]
    };
    ChatRequest {
        model: &cfg.model,
        messages,
        stream: false,
        think: call.think,
        format: call.schema,
        keep_alive: call.keep_alive,
        options: ChatOptions {
            num_ctx: cfg.num_ctx,
            num_predict: call.num_predict,
            temperature: 0.0,
            seed: call.seed,
        },
    }
}

fn render_request(cfg: &ProviderConfig, call: &ChatCall<'_>) -> Vec<u8> {
    serde_json::to_vec(&build_request(cfg, call)).unwrap_or_default()
}

/// Send one chat request and return counters, content, and any thinking
/// channel. Status and envelope faults are typed here; semantic checks
/// are the caller's.
async fn run_chat(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
    call: ChatCall<'_>,
) -> Result<(InferenceCounters, String, Option<String>), ProviderError> {
    let body = post_json(
        client,
        &format!("{base}/api/chat"),
        &build_request(cfg, &call),
        call.timeout,
    )
    .await?;
    let parsed: ChatResponse =
        serde_json::from_slice(&body).map_err(|_| ProviderError::MalformedOutput {
            detail: MalformedKind::EnvelopeNotJson,
        })?;
    if parsed.error.as_deref().is_some_and(|e| !e.is_empty()) {
        return Err(ProviderError::HttpStatus { status: 400 });
    }
    if parsed.done_reason.as_deref() == Some("length") {
        return Err(ProviderError::OutputTruncated);
    }
    let counters = parsed.counters();
    let message = parsed.message.ok_or(ProviderError::MalformedOutput {
        detail: MalformedKind::NoMessage,
    })?;
    Ok((counters, message.content, message.thinking))
}

/// The unload request. Its body need not be a usable answer — only the
/// transport has to succeed.
async fn run_unload(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
    call: ChatCall<'_>,
) -> Result<(), ProviderError> {
    match post_json(
        client,
        &format!("{base}/api/chat"),
        &build_request(cfg, &call),
        call.timeout,
    )
    .await
    {
        Ok(_) | Err(ProviderError::EmptyBody) => Ok(()),
        Err(e) => Err(e),
    }
}

async fn post_json<T: Serialize>(
    client: &reqwest::Client,
    url: &str,
    body: &T,
    timeout: Duration,
) -> Result<Vec<u8>, ProviderError> {
    let resp = client
        .post(url)
        .timeout(timeout)
        .json(body)
        .send()
        .await
        .map_err(|e| map_transport(&e))?;
    if let Some(err) = map_status(resp.status().as_u16()) {
        return Err(err);
    }
    read_capped(resp, MAX_RESPONSE_BYTES).await
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
) -> Result<Vec<u8>, ProviderError> {
    let resp = client
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| map_transport(&e))?;
    if let Some(err) = map_status(resp.status().as_u16()) {
        return Err(err);
    }
    read_capped(resp, MAX_RESPONSE_BYTES).await
}

async fn check_version(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
) -> Result<String, ProviderError> {
    let body = get_json(
        client,
        &format!("{base}/api/version"),
        cfg.timeout(cfg.timeout_control_secs),
    )
    .await
    .map_err(|e| match e {
        // At preflight a slow or refused control call means one thing to
        // the user: the runtime is not answering.
        ProviderError::InferenceTimeout => ProviderError::OllamaUnreachable {
            detail: "timeout".into(),
        },
        other => other,
    })?;
    let parsed: VersionResponse =
        serde_json::from_slice(&body).map_err(|_| ProviderError::OllamaUnreachable {
            detail: "version".into(),
        })?;
    if !version_at_least(&parsed.version, MIN_RUNTIME_VERSION) {
        return Err(ProviderError::VersionTooOld {
            got: parsed.version,
        });
    }
    Ok(parsed.version)
}

/// Leading numeric triple only, so a pre-release suffix (`0.9.0-rc1`)
/// does not read as ancient. An unparseable version fails closed.
fn version_at_least(got: &str, floor: (u32, u32, u32)) -> bool {
    let mut parts = got.trim().trim_start_matches('v').split('.');
    let mut next = || -> Option<u32> {
        let raw = parts.next()?;
        let digits: String = raw.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    };
    let (Some(major), Some(minor)) = (next(), next()) else {
        return false;
    };
    let patch = next().unwrap_or(0);
    (major, minor, patch) >= floor
}

/// Confirm the tag is installed and return its digest. **Never pulls.**
async fn check_model_installed(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
) -> Result<String, ProviderError> {
    let body = get_json(
        client,
        &format!("{base}/api/tags"),
        cfg.timeout(cfg.timeout_control_secs),
    )
    .await?;
    let parsed: TagsResponse =
        serde_json::from_slice(&body).map_err(|_| ProviderError::OllamaUnreachable {
            detail: "tags".into(),
        })?;
    parsed
        .models
        .into_iter()
        .find(|m| m.name == cfg.model || m.model == cfg.model)
        .map(|m| m.digest)
        .ok_or_else(|| ProviderError::ModelNotInstalled {
            model: cfg.model.clone(),
        })
}

async fn check_show(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
) -> Result<(Vec<String>, u32), ProviderError> {
    let body = post_json(
        client,
        &format!("{base}/api/show"),
        &serde_json::json!({ "model": cfg.model }),
        cfg.timeout(cfg.timeout_control_secs),
    )
    .await?;
    let parsed: ShowResponse =
        serde_json::from_slice(&body).map_err(|_| ProviderError::OllamaUnreachable {
            detail: "show".into(),
        })?;
    // `model_info` keys are architecture-prefixed
    // (`qwen3.context_length`), so match the suffix rather than
    // hardcoding a family.
    let context_length = parsed
        .model_info
        .iter()
        .find(|(k, _)| k.ends_with("context_length"))
        .and_then(|(_, v)| v.as_u64())
        .unwrap_or(0) as u32;
    Ok((parsed.capabilities, context_length))
}

/// A throwaway one-token generation under the long ceiling, so the cold
/// load is paid here instead of inside unit 1's budget. No `format`: a
/// schema-constrained single token is not a load test.
async fn warm_up(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
    think_control: bool,
) -> Result<u64, ProviderError> {
    let clock = Instant::now();
    run_chat(
        cfg,
        client,
        base,
        ChatCall {
            system: "",
            user: "ok",
            schema: None,
            keep_alive: &cfg.keep_alive,
            think: think_control.then_some(false),
            seed: 0,
            num_predict: 1,
            timeout: cfg.timeout(cfg.timeout_warmup_secs),
        },
    )
    .await
    .map_err(|e| ProviderError::WarmupFailed {
        detail: e.code().to_string(),
    })?;
    Ok(clock.elapsed().as_millis() as u64)
}

fn canary_transport(e: ProviderError) -> ProviderError {
    match e {
        ProviderError::OutputTruncated => ProviderError::CanaryFailed {
            reason: CanaryFailure::Truncated,
        },
        _ => ProviderError::CanaryFailed {
            reason: CanaryFailure::Transport,
        },
    }
}

/// The canary contract: `think: false` and `format` were **both**
/// honoured by this exact model tag, and the model can cite an expected
/// sentence ID on a known answer.
///
/// A `/api/tags` and `/api/show` success cannot substitute for this:
/// think-by-format drops are model-family-specific and silent. Failure
/// aborts the run — never a quiet fallback to unconstrained decoding.
fn check_canary_output(
    canary: &CanarySpec<'_>,
    content: &str,
    thinking: Option<&str>,
) -> Result<(), ProviderError> {
    if thinking.is_some_and(|t| !t.trim().is_empty()) || contains_think_tag(content) {
        return Err(ProviderError::CanaryFailed {
            reason: CanaryFailure::ThinkLeak,
        });
    }
    let parsed: serde_json::Value =
        serde_json::from_str(content).map_err(|_| ProviderError::CanaryFailed {
            reason: CanaryFailure::SchemaIgnored,
        })?;
    if shallow_schema_check(canary.schema, &parsed).is_err() {
        return Err(ProviderError::CanaryFailed {
            reason: CanaryFailure::SchemaIgnored,
        });
    }
    if canary.expected_evidence_ids.is_empty() {
        return Ok(());
    }
    let mut cited = Vec::new();
    collect_evidence_ids(&parsed, &mut cited);
    if cited
        .iter()
        .any(|id| canary.expected_evidence_ids.contains(&id.as_str()))
    {
        Ok(())
    } else {
        Err(ProviderError::CanaryFailed {
            reason: CanaryFailure::EvidenceMismatch,
        })
    }
}

async fn model_resident(
    cfg: &ProviderConfig,
    client: &reqwest::Client,
    base: &str,
) -> Result<bool, ProviderError> {
    let body = get_json(
        client,
        &format!("{base}/api/ps"),
        cfg.timeout(cfg.timeout_control_secs),
    )
    .await?;
    let parsed: TagsResponse =
        serde_json::from_slice(&body).map_err(|_| ProviderError::OllamaUnreachable {
            detail: "ps".into(),
        })?;
    Ok(parsed
        .models
        .iter()
        .any(|m| m.name == cfg.model || m.model == cfg.model))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut acc, b| {
            use fmt::Write as _;
            let _ = write!(acc, "{b:02x}");
            acc
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    const MODEL: &str = "qwen3:30b-a3b-instruct-2507-q4_K_M";
    const DIGEST: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

    // ───────── the mock Ollama: in-process axum, ephemeral port ─────────

    #[derive(Clone)]
    struct ChatScript {
        status: u16,
        delay_ms: u64,
        body: String,
    }

    impl Default for ChatScript {
        fn default() -> Self {
            Self {
                status: 200,
                delay_ms: 0,
                body: ok_chat(r#"{"proposals":[],"nothing_durable":true}"#),
            }
        }
    }

    struct Behavior {
        version: String,
        models: Vec<(String, String)>,
        capabilities: Vec<String>,
        context_length: u32,
        resident: bool,
        /// Simulate a runtime that ignores `keep_alive: 0`.
        refuse_unload: bool,
    }

    impl Default for Behavior {
        fn default() -> Self {
            Self {
                version: "0.9.3".into(),
                models: vec![(MODEL.into(), DIGEST.into())],
                capabilities: vec!["completion".into(), "thinking".into()],
                context_length: 32768,
                resident: false,
                refuse_unload: false,
            }
        }
    }

    #[derive(Default)]
    struct MockState {
        behavior: Mutex<Behavior>,
        chat_scripts: Mutex<VecDeque<ChatScript>>,
        chat_requests: Mutex<Vec<serde_json::Value>>,
    }

    impl MockState {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn script(self: &Arc<Self>, script: ChatScript) -> &Arc<Self> {
            self.chat_scripts.lock().unwrap().push_back(script);
            self
        }

        /// Warm-up + canary, both fine — the prelude every unit test needs.
        fn preflight_ok(self: &Arc<Self>) -> &Arc<Self> {
            self.script(ChatScript::default());
            self.script(ChatScript {
                body: ok_chat(CANARY_GOLD),
                ..Default::default()
            })
        }

        fn requests(&self) -> Vec<serde_json::Value> {
            self.chat_requests.lock().unwrap().clone()
        }
    }

    struct MockOllama {
        base: String,
        state: Arc<MockState>,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Drop for MockOllama {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    async fn mock(state: Arc<MockState>) -> MockOllama {
        let app = Router::new()
            .route("/api/version", get(h_version))
            .route("/api/tags", get(h_tags))
            .route("/api/show", post(h_show))
            .route("/api/chat", post(h_chat))
            .route("/api/ps", get(h_ps))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        MockOllama {
            base: format!("http://127.0.0.1:{port}"),
            state,
            handle,
        }
    }

    async fn h_version(State(st): State<Arc<MockState>>) -> axum::response::Response {
        let version = st.behavior.lock().unwrap().version.clone();
        Json(serde_json::json!({ "version": version })).into_response()
    }

    async fn h_tags(State(st): State<Arc<MockState>>) -> axum::response::Response {
        let models: Vec<serde_json::Value> = {
            let b = st.behavior.lock().unwrap();
            b.models
                .iter()
                .map(|(n, d)| serde_json::json!({ "name": n, "model": n, "digest": d }))
                .collect()
        };
        Json(serde_json::json!({ "models": models })).into_response()
    }

    async fn h_show(State(st): State<Arc<MockState>>) -> axum::response::Response {
        let (caps, ctx) = {
            let b = st.behavior.lock().unwrap();
            (b.capabilities.clone(), b.context_length)
        };
        Json(serde_json::json!({
            "capabilities": caps,
            "model_info": { "qwen3.context_length": ctx },
        }))
        .into_response()
    }

    async fn h_ps(State(st): State<Arc<MockState>>) -> axum::response::Response {
        let models: Vec<serde_json::Value> = {
            let b = st.behavior.lock().unwrap();
            if b.resident {
                vec![serde_json::json!({ "name": MODEL, "model": MODEL, "digest": DIGEST })]
            } else {
                Vec::new()
            }
        };
        Json(serde_json::json!({ "models": models })).into_response()
    }

    async fn h_chat(
        State(st): State<Arc<MockState>>,
        Json(body): Json<serde_json::Value>,
    ) -> axum::response::Response {
        st.chat_requests.lock().unwrap().push(body.clone());
        let keep_alive = body
            .get("keep_alive")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let script = {
            let mut q = st.chat_scripts.lock().unwrap();
            if q.len() > 1 {
                q.pop_front().unwrap()
            } else {
                q.front().cloned().unwrap_or_default()
            }
        };
        {
            let mut b = st.behavior.lock().unwrap();
            if keep_alive == "0" {
                if !b.refuse_unload {
                    b.resident = false;
                }
            } else {
                b.resident = true;
            }
        }
        if script.delay_ms > 0 {
            tokio::time::sleep(Duration::from_millis(script.delay_ms)).await;
        }
        (StatusCode::from_u16(script.status).unwrap(), script.body).into_response()
    }

    // ───────── fixtures ─────────

    const CANARY_GOLD: &str = r#"{"proposals":[{"type":"decision","statement":"Deploys move to Tuesday.","subject":"deploys","evidence":["S3"],"source_role":"user"}],"nothing_durable":false}"#;

    fn ok_chat(content: &str) -> String {
        serde_json::json!({
            "model": MODEL,
            "message": { "role": "assistant", "content": content },
            "done": true,
            "done_reason": "stop",
            "prompt_eval_count": 1200u64,
            "prompt_eval_duration": 3_000_000_000u64,
            "eval_count": 180u64,
            "eval_duration": 6_000_000_000u64,
            "load_duration": 0u64,
            "total_duration": 9_500_000_000u64,
        })
        .to_string()
    }

    fn schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "proposals": { "type": "array" },
                "nothing_durable": { "type": "boolean" },
            },
            "required": ["proposals", "nothing_durable"],
            "additionalProperties": false,
        })
    }

    fn canary_spec(schema: &serde_json::Value) -> CanarySpec<'_> {
        CanarySpec {
            system: "You extract durable memories.",
            user: "S1 [user]: We talked.\nS3 [user]: Deploys move to Tuesday.",
            schema,
            expected_evidence_ids: &["S3"],
        }
    }

    fn estimate(s: &str) -> u32 {
        (s.len() / 3) as u32
    }

    /// Every networked test goes through here, and it refuses any base
    /// URL that is not the in-process mock on an ephemeral port. Nothing
    /// in this suite can reach a real Ollama.
    fn cfg_for(base: &str) -> ProviderConfig {
        assert!(
            base.starts_with("http://127.0.0.1:"),
            "tests must target the in-process mock, got {base}"
        );
        assert!(
            !base.contains(":11434"),
            "tests must never dial the real Ollama port"
        );
        ProviderConfig {
            endpoint: base.to_string(),
            model: MODEL.into(),
            model_digest: Some(DIGEST.into()),
            num_ctx: 8192,
            num_predict: 256,
            timeout_connect_secs: 2,
            timeout_warmup_secs: 5,
            timeout_first_unit_secs: 5,
            timeout_unit_secs: 5,
            timeout_control_secs: 5,
            ..Default::default()
        }
    }

    fn unit_request<'a>(schema: &'a serde_json::Value, user: &'a str) -> UnitRequest<'a> {
        UnitRequest {
            system: "sys",
            user,
            schema,
            seed: 0,
            output_schema_version: 2,
            estimate_tokens: &estimate,
        }
    }

    async fn session(base: &str) -> Result<ProviderSession, ProviderError> {
        let cfg = cfg_for(base);
        let sch = schema();
        ProviderSession::start(&cfg, client(&cfg), &canary_spec(&sch)).await
    }

    // ───────── config ─────────

    /// A slice-1 consent file predates the provider block entirely. It
    /// must still parse, or shipping this module would break consent.
    #[test]
    fn a_slice_one_config_without_a_provider_block_still_parses() {
        let parsed =
            LocalCuratorFile::parse(r#"{"enabled":true,"transcript_access":true}"#).unwrap();
        assert!(parsed.enabled);
        assert!(parsed.transcript_access);
        assert!(parsed.provider.is_none());
        assert_eq!(parsed.provider(), Err(ProviderError::NotConfigured));
    }

    /// Unknown keys — from a newer build, or a field this module has not
    /// learned yet — are ignored at both levels.
    #[test]
    fn unknown_keys_are_tolerated_at_both_levels() {
        let parsed = LocalCuratorFile::parse(
            r#"{"enabled":true,"future_flag":7,"provider":{"model":"m","unheard_of":true}}"#,
        )
        .unwrap();
        let p = parsed.provider().unwrap();
        assert_eq!(p.model, "m");
        assert_eq!(p.endpoint, DEFAULT_ENDPOINT);
        assert_eq!(p.num_ctx, 8192);
        assert!(p.require_think_control);
    }

    /// `host` and `max_output_tokens` are the brief's names for the
    /// guide's `endpoint` and `num_predict`; both spellings decode.
    #[test]
    fn config_aliases_decode() {
        let parsed = LocalCuratorFile::parse(
            r#"{"provider":{"host":"http://127.0.0.1:1","model":"m","max_output_tokens":99}}"#,
        )
        .unwrap();
        let p = parsed.provider().unwrap();
        assert_eq!(p.endpoint, "http://127.0.0.1:1");
        assert_eq!(p.num_predict, 99);
    }

    #[test]
    fn config_round_trips_through_json() {
        let file = LocalCuratorFile {
            enabled: true,
            transcript_access: true,
            provider: Some(ProviderConfig {
                model: MODEL.into(),
                model_digest: Some(DIGEST.into()),
                ..Default::default()
            }),
        };
        let raw = serde_json::to_string(&file).unwrap();
        assert_eq!(LocalCuratorFile::parse(&raw).unwrap(), file);
    }

    /// The file is read from `NEUROVAULT_HOME`, never a real home.
    #[test]
    fn load_reads_the_server_owned_file_and_tolerates_its_absence() {
        let _guard = crate::memory::journal::TEST_HOME_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = std::env::temp_dir().join(format!(
            "nv-curator-provider-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("NEUROVAULT_HOME", &home);

        assert_eq!(LocalCuratorFile::load(), LocalCuratorFile::default());
        std::fs::write(
            home.join("local_curator.json"),
            r#"{"enabled":true,"transcript_access":true,"provider":{"model":"m"}}"#,
        )
        .unwrap();
        let loaded = LocalCuratorFile::load();
        assert!(loaded.enabled);
        assert_eq!(loaded.provider().unwrap().model, "m");

        std::env::remove_var("NEUROVAULT_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Spec §18: literal loopback IPs only. A DNS name can resolve
    /// anywhere, so `localhost` is refused too.
    #[test]
    fn only_a_literal_loopback_ip_is_accepted() {
        for good in [
            "http://127.0.0.1:11434",
            "http://127.0.0.1:11434/",
            "http://127.4.5.6:9",
            "http://[::1]:11434",
        ] {
            let cfg = ProviderConfig {
                endpoint: good.into(),
                model: MODEL.into(),
                ..Default::default()
            };
            assert!(cfg.base_url().is_ok(), "should accept {good}");
        }
        for bad in [
            "http://localhost:11434",
            "http://ollama.internal:11434",
            "http://10.0.0.4:11434",
            "http://0.0.0.0:11434",
            "http://192.168.1.9:11434",
            "http://[2001:db8::1]:11434",
        ] {
            let cfg = ProviderConfig {
                endpoint: bad.into(),
                model: MODEL.into(),
                ..Default::default()
            };
            assert_eq!(
                cfg.base_url(),
                Err(ProviderError::NonLoopbackEndpoint {
                    endpoint: bad.into()
                }),
                "should reject {bad}"
            );
        }
        for malformed in ["not a url", "unix:///tmp/ollama.sock", "ftp://127.0.0.1"] {
            let cfg = ProviderConfig {
                endpoint: malformed.into(),
                model: MODEL.into(),
                ..Default::default()
            };
            assert!(
                matches!(cfg.base_url(), Err(ProviderError::MalformedEndpoint { .. })),
                "should reject {malformed}"
            );
        }
    }

    #[test]
    fn a_config_without_a_model_is_not_usable() {
        let cfg = ProviderConfig::default();
        assert_eq!(cfg.base_url(), Err(ProviderError::ModelUnset));
    }

    // ───────── taxonomy ─────────

    /// The runner's whole contract with this module: error → what to do.
    #[test]
    fn every_error_has_the_disposition_the_runner_expects() {
        use Disposition::*;
        use ProviderError::*;
        let table: Vec<(ProviderError, Disposition)> = vec![
            (NotConfigured, RunAbort),
            (
                NonLoopbackEndpoint {
                    endpoint: "x".into(),
                },
                RunAbort,
            ),
            (
                MalformedEndpoint {
                    endpoint: "x".into(),
                },
                RunAbort,
            ),
            (ModelUnset, RunAbort),
            (VersionTooOld { got: "0.8".into() }, RunAbort),
            (ModelNotInstalled { model: "m".into() }, RunAbort),
            (ModelLacksThinkControl { model: "m".into() }, RunAbort),
            (
                ContextWindowTooSmall {
                    model_ctx: 2048,
                    required: 8192,
                },
                RunAbort,
            ),
            (
                ModelFingerprintMismatch {
                    pinned: "a".into(),
                    served: "b".into(),
                },
                RunAbort,
            ),
            (WarmupFailed { detail: "x".into() }, RunAbort),
            (
                CanaryFailed {
                    reason: CanaryFailure::ThinkLeak,
                },
                RunAbort,
            ),
            (
                OllamaUnreachable {
                    detail: "connect".into(),
                },
                DeferUnit,
            ),
            (ServerBusy, DeferUnit),
            (HttpStatus { status: 500 }, DeferUnit),
            (InferenceTimeout, DeferUnit),
            (OutputTruncated, DeferUnit),
            (
                TruncationSuspected {
                    prompt_eval_count: 8180,
                    num_ctx: 8192,
                },
                DeferUnit,
            ),
            (
                ResponseTooLarge {
                    cap_bytes: MAX_RESPONSE_BYTES,
                },
                DeferUnit,
            ),
            (EmptyBody, DeferUnit),
            (ThinkLeak, DeferUnit),
            (
                MalformedOutput {
                    detail: MalformedKind::EmptyObject,
                },
                DeferUnit,
            ),
            (RunDeadlineExceeded, DeferUnit),
            (
                UnitOverBudget {
                    estimated_tokens: 9000,
                    ceiling: 8192,
                },
                SkipUnit,
            ),
            (
                UnloadUnverified {
                    detail: "still_resident".into(),
                },
                RunFault,
            ),
        ];
        for (err, want) in &table {
            assert_eq!(err.disposition(), *want, "{}", err.code());
            match want {
                DeferUnit => assert_eq!(
                    err.unit_outcome(),
                    Some(UnitOutcome::Deferred(err.error_code())),
                    "{}",
                    err.code()
                ),
                SkipUnit => assert_eq!(
                    err.unit_outcome(),
                    Some(UnitOutcome::PermanentlyRejected),
                    "{}",
                    err.code()
                ),
                RunAbort | RunFault => assert_eq!(err.unit_outcome(), None, "{}", err.code()),
            }
        }
    }

    /// Codes go into receipts, which forbid prose, paths and quotes.
    #[test]
    fn error_codes_are_receipt_safe_tokens() {
        for err in [
            ProviderError::ServerBusy,
            ProviderError::ThinkLeak,
            ProviderError::MalformedOutput {
                detail: MalformedKind::EmptyObject,
            },
            ProviderError::UnloadUnverified { detail: "x".into() },
        ] {
            let code = err.code();
            assert!(super::super::receipts::is_safe_note(code), "{code}");
            assert!(!code.contains(' '), "{code}");
        }
    }

    /// A missing model is a prompt, never a download. Spec §18.
    #[test]
    fn a_missing_model_hint_refuses_to_promise_a_download() {
        let hint = ProviderError::ModelNotInstalled {
            model: MODEL.into(),
        }
        .user_hint();
        assert!(hint.contains(MODEL));
        assert!(hint.contains("not installed"));
        assert!(hint.contains("will not pull"));
    }

    #[test]
    fn the_version_floor_is_the_think_field_floor() {
        assert!(version_at_least("0.9.0", MIN_RUNTIME_VERSION));
        assert!(version_at_least("0.9.3", MIN_RUNTIME_VERSION));
        assert!(version_at_least("v1.2.0", MIN_RUNTIME_VERSION));
        assert!(version_at_least("0.10.0", MIN_RUNTIME_VERSION));
        assert!(version_at_least("0.9.0-rc1", MIN_RUNTIME_VERSION));
        assert!(!version_at_least("0.8.9", MIN_RUNTIME_VERSION));
        assert!(!version_at_least("0.5.0", MIN_RUNTIME_VERSION));
        assert!(!version_at_least("garbage", MIN_RUNTIME_VERSION));
    }

    // ───────── token budget ─────────

    /// Ollama front-truncates silently, so the only safe answer to an
    /// oversized unit is to refuse it before sending.
    #[test]
    fn an_oversized_unit_is_refused_before_a_byte_goes_out() {
        let cfg = ProviderConfig {
            num_ctx: 1024,
            num_predict: 256,
            ..Default::default()
        };
        let user = "x".repeat(3 * 1000);
        let err = check_token_budget(&cfg, "sys", &user, &estimate).unwrap_err();
        assert!(matches!(err, ProviderError::UnitOverBudget { .. }));
        assert_eq!(err.disposition(), Disposition::SkipUnit);

        let ok = check_token_budget(&cfg, "sys", "small", &estimate).unwrap();
        assert_eq!(ok.ceiling, 1024);
        assert_eq!(ok.reserved_output_tokens, 256);
    }

    // ───────── preflight ─────────

    #[tokio::test]
    async fn preflight_succeeds_and_reports_what_actually_ran() {
        let st = MockState::new();
        st.preflight_ok();
        let m = mock(st).await;
        let s = session(&m.base).await.unwrap();
        let p = s.preflight();
        assert_eq!(p.runtime_version, "0.9.3");
        assert_eq!(p.model_digest, DIGEST);
        assert_eq!(p.context_length, 32768);
        assert!(p.think_control);
        assert_eq!(p.canary_counters.prompt_eval_count, 1200);
    }

    /// Warm-up then canary: two chats before unit 1, the first
    /// unconstrained (a load test), the second the real contract.
    #[tokio::test]
    async fn preflight_warms_up_before_it_canaries() {
        let st = MockState::new();
        st.preflight_ok();
        let m = mock(st).await;
        session(&m.base).await.unwrap();
        let reqs = m.state.requests();
        assert_eq!(reqs.len(), 2, "warm-up + canary");
        assert!(
            reqs[0].get("format").is_none(),
            "warm-up is not constrained"
        );
        assert_eq!(reqs[0]["options"]["num_predict"], 1);
        assert_eq!(reqs[1]["format"], schema(), "canary carries the schema");
        assert_eq!(reqs[1]["think"], serde_json::json!(false));
    }

    /// An absent tag aborts the run. It is never pulled.
    #[tokio::test]
    async fn a_model_that_is_not_installed_aborts_the_run() {
        let st = MockState::new();
        st.behavior.lock().unwrap().models = vec![("some:other".into(), "sha256:0".into())];
        let m = mock(st).await;
        let err = session(&m.base).await.unwrap_err();
        assert_eq!(
            err,
            ProviderError::ModelNotInstalled {
                model: MODEL.into()
            }
        );
        assert_eq!(err.disposition(), Disposition::RunAbort);
        assert!(m.state.requests().is_empty(), "never generated anything");
    }

    #[tokio::test]
    async fn an_old_runtime_aborts_the_run() {
        let st = MockState::new();
        st.behavior.lock().unwrap().version = "0.8.9".into();
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::VersionTooOld {
                got: "0.8.9".into()
            }
        );
    }

    #[tokio::test]
    async fn a_re_pulled_model_aborts_until_the_user_re_pins_it() {
        let st = MockState::new();
        st.behavior.lock().unwrap().models = vec![(MODEL.into(), "sha256:9999".into())];
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::ModelFingerprintMismatch {
                pinned: DIGEST.into(),
                served: "sha256:9999".into(),
            }
        );
    }

    #[tokio::test]
    async fn a_model_with_no_thinking_channel_aborts_by_default() {
        let st = MockState::new();
        st.behavior.lock().unwrap().capabilities = vec!["completion".into()];
        st.preflight_ok();
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::ModelLacksThinkControl {
                model: MODEL.into()
            }
        );
    }

    /// Opting out is explicit, and then the field is omitted rather than
    /// sent as false — Ollama 400s on `think` for a non-thinking family.
    #[tokio::test]
    async fn opting_out_of_think_control_omits_the_field_entirely() {
        let st = MockState::new();
        st.behavior.lock().unwrap().capabilities = vec!["completion".into()];
        st.preflight_ok();
        let m = mock(st).await;
        let cfg = ProviderConfig {
            require_think_control: false,
            ..cfg_for(&m.base)
        };
        let sch = schema();
        let s = ProviderSession::start(&cfg, client(&cfg), &canary_spec(&sch))
            .await
            .unwrap();
        assert!(!s.preflight().think_control);
        for req in m.state.requests() {
            assert!(req.get("think").is_none(), "think must be omitted");
        }
    }

    #[tokio::test]
    async fn a_context_window_below_num_ctx_aborts_the_run() {
        let st = MockState::new();
        st.behavior.lock().unwrap().context_length = 4096;
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::ContextWindowTooSmall {
                model_ctx: 4096,
                required: 8192,
            }
        );
    }

    #[tokio::test]
    async fn an_unreachable_runtime_aborts_the_run() {
        // Bind then drop, so the port is closed but genuinely local.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = session(&format!("http://127.0.0.1:{port}"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::OllamaUnreachable { .. }),
            "{err:?}"
        );
    }

    // ───────── canary ─────────

    /// The failure the canary exists for: `think: false` accepted,
    /// reasoning emitted anyway. Abort — never a silent degrade.
    #[tokio::test]
    async fn a_thinking_leak_in_the_canary_aborts_the_run() {
        let st = MockState::new();
        st.script(ChatScript::default());
        st.script(ChatScript {
            body: serde_json::json!({
                "message": {
                    "role": "assistant",
                    "thinking": "Let me consider the sentences...",
                    "content": CANARY_GOLD,
                },
                "done_reason": "stop",
            })
            .to_string(),
            ..Default::default()
        });
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::CanaryFailed {
                reason: CanaryFailure::ThinkLeak
            }
        );
    }

    /// A `<think>` tag inside content is the same leak wearing a hat.
    #[tokio::test]
    async fn an_inline_think_tag_in_the_canary_aborts_the_run() {
        let st = MockState::new();
        st.script(ChatScript::default());
        st.script(ChatScript {
            body: ok_chat("<think>hmm</think>{\"proposals\":[],\"nothing_durable\":true}"),
            ..Default::default()
        });
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::CanaryFailed {
                reason: CanaryFailure::ThinkLeak
            }
        );
    }

    /// `format` silently dropped: prose comes back instead of an object.
    #[tokio::test]
    async fn a_canary_that_ignores_the_schema_aborts_the_run() {
        let st = MockState::new();
        st.script(ChatScript::default());
        st.script(ChatScript {
            body: ok_chat("Sure! Here are the durable memories I found."),
            ..Default::default()
        });
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::CanaryFailed {
                reason: CanaryFailure::SchemaIgnored
            }
        );
    }

    /// Valid JSON, wrong keys — still a dropped constraint.
    #[tokio::test]
    async fn a_canary_object_missing_required_keys_aborts_the_run() {
        let st = MockState::new();
        st.script(ChatScript::default());
        st.script(ChatScript {
            body: ok_chat(r#"{"answer":"deploys move to Tuesday"}"#),
            ..Default::default()
        });
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::CanaryFailed {
                reason: CanaryFailure::SchemaIgnored
            }
        );
    }

    /// Well-formed but citing a sentence the gold answer does not allow:
    /// the model cannot follow the evidence contract.
    #[tokio::test]
    async fn a_canary_citing_the_wrong_sentence_aborts_the_run() {
        let st = MockState::new();
        st.script(ChatScript::default());
        st.script(ChatScript {
            body: ok_chat(
                r#"{"proposals":[{"evidence":["S99"],"statement":"x"}],"nothing_durable":false}"#,
            ),
            ..Default::default()
        });
        let m = mock(st).await;
        assert_eq!(
            session(&m.base).await.unwrap_err(),
            ProviderError::CanaryFailed {
                reason: CanaryFailure::EvidenceMismatch
            }
        );
    }

    // ───────── the unit call path ─────────

    #[tokio::test]
    async fn a_unit_request_carries_the_whole_native_contract() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript::default());
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        s.chat_unit(unit_request(&sch, "S1 [user]: hello"))
            .await
            .unwrap();

        let req = m.state.requests().pop().unwrap();
        assert_eq!(req["model"], MODEL);
        assert_eq!(req["stream"], serde_json::json!(false));
        assert_eq!(req["think"], serde_json::json!(false));
        assert_eq!(req["format"], sch, "constrained decoding is permanent");
        assert_eq!(req["keep_alive"], "10m", "one load, N units");
        assert_eq!(req["options"]["temperature"], serde_json::json!(0.0));
        assert_eq!(req["options"]["num_ctx"], 8192);
        assert!(req.get("tools").is_none(), "no tools, ever");
        assert_eq!(req["messages"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_good_unit_returns_bounded_json_and_records_prefill_and_decode() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript::default());
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        let reply = s
            .chat_unit(unit_request(&sch, "S1 [user]: hello"))
            .await
            .unwrap();

        assert_eq!(reply.raw_json, r#"{"proposals":[],"nothing_durable":true}"#);
        // Prefill and decode are separable — the whole point of the
        // instrumentation ask.
        assert_eq!(reply.counters.prompt_eval_count, 1200);
        assert_eq!(reply.counters.eval_count, 180);
        assert_eq!(reply.counters.prefill_tokens_per_sec(), Some(400.0));
        assert_eq!(reply.counters.decode_tokens_per_sec(), Some(30.0));
        assert!(!reply.counters.model_was_loaded(), "keep_alive held");

        assert_eq!(reply.generation.provider, PROVIDER_NAME);
        assert_eq!(reply.generation.model_digest, DIGEST);
        assert_eq!(reply.generation.output_schema_version, 2);
        assert_eq!(reply.generation.prompt_sha256.len(), 64);
        assert_ne!(
            reply.generation.request_sha256,
            reply.generation.response_sha256
        );
    }

    /// 503 is the shared-Ollama queue. Back off and retry the unit.
    #[tokio::test]
    async fn a_busy_runtime_defers_the_unit() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            status: 503,
            body: r#"{"error":"server busy"}"#.into(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        let err = s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err();
        assert_eq!(err, ProviderError::ServerBusy);
        assert_eq!(err.disposition(), Disposition::DeferUnit);
        assert_eq!(err.retry_after(), Some(Duration::from_secs(30)));
    }

    #[tokio::test]
    async fn any_other_status_defers_the_unit() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            status: 500,
            body: r#"{"error":"boom"}"#.into(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::HttpStatus { status: 500 }
        );
    }

    /// The per-request ceiling is real: a hung inference does not hang
    /// the run.
    #[tokio::test]
    async fn a_hung_inference_hits_the_per_request_ceiling() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            delay_ms: 3_000,
            ..Default::default()
        });
        let m = mock(st).await;
        let cfg = ProviderConfig {
            timeout_first_unit_secs: 1,
            timeout_unit_secs: 1,
            ..cfg_for(&m.base)
        };
        let sch = schema();
        let mut s = ProviderSession::start(&cfg, client(&cfg), &canary_spec(&sch))
            .await
            .unwrap();
        let err = s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err();
        assert_eq!(err, ProviderError::InferenceTimeout);
        assert_eq!(err.error_code(), CuratorErrorCode::ProviderTimeout);
    }

    /// The measured qwen3 collapse mode. `{}` is malformed — it is NOT
    /// an abstention, and the provider must never let it read as one.
    #[tokio::test]
    async fn an_empty_object_is_malformed_never_abstention() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: ok_chat("{}"),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        let err = s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err();
        assert_eq!(
            err,
            ProviderError::MalformedOutput {
                detail: MalformedKind::EmptyObject
            }
        );
        assert_eq!(err.error_code(), CuratorErrorCode::InvalidResponse);
    }

    #[tokio::test]
    async fn content_that_is_not_json_is_malformed() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: ok_chat("I could not find anything durable."),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::MalformedOutput {
                detail: MalformedKind::ContentNotJson
            }
        );
    }

    #[tokio::test]
    async fn an_object_missing_a_required_key_is_malformed() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: ok_chat(r#"{"proposals":[]}"#),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::MalformedOutput {
                detail: MalformedKind::MissingRequiredKey
            }
        );
    }

    /// A leak that survives the canary still kills its own unit.
    #[tokio::test]
    async fn a_think_leak_mid_batch_defers_the_unit() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: serde_json::json!({
                "message": {
                    "role": "assistant",
                    "thinking": "wait, let me reconsider",
                    "content": r#"{"proposals":[],"nothing_durable":true}"#,
                },
                "done_reason": "stop",
            })
            .to_string(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        let err = s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err();
        assert_eq!(err, ProviderError::ThinkLeak);
        assert_eq!(err.disposition(), Disposition::DeferUnit);
    }

    /// `done_reason: length` — the grammar cannot rescue a cut object.
    #[tokio::test]
    async fn a_truncated_generation_is_typed_not_parsed() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: serde_json::json!({
                "message": { "role": "assistant", "content": r#"{"proposals":[{"stat"# },
                "done_reason": "length",
                "prompt_eval_count": 1200u64,
                "eval_count": 256u64,
            })
            .to_string(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::OutputTruncated
        );
    }

    /// Front-truncation: Ollama never says it clipped the prompt, so a
    /// `prompt_eval_count` grazing the ceiling is treated as suspect.
    #[tokio::test]
    async fn a_prompt_eval_count_at_the_ceiling_is_treated_as_front_truncation() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: serde_json::json!({
                "message": {
                    "role": "assistant",
                    "content": r#"{"proposals":[],"nothing_durable":true}"#,
                },
                "done_reason": "stop",
                "prompt_eval_count": 8160u64,
                "eval_count": 12u64,
            })
            .to_string(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::TruncationSuspected {
                prompt_eval_count: 8160,
                num_ctx: 8192,
            }
        );
    }

    #[tokio::test]
    async fn an_empty_body_defers_the_unit() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: String::new(),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::EmptyBody
        );
    }

    /// The cap is enforced on the stream, before deserialization.
    #[tokio::test]
    async fn an_oversized_response_never_reaches_the_json_parser() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript {
            body: ok_chat(&"x".repeat(MAX_RESPONSE_BYTES + 1024)),
            ..Default::default()
        });
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        assert_eq!(
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap_err(),
            ProviderError::ResponseTooLarge {
                cap_bytes: MAX_RESPONSE_BYTES
            }
        );
    }

    /// The budget guard runs before the socket, so an oversized unit
    /// costs zero requests.
    #[tokio::test]
    async fn an_over_budget_unit_never_reaches_the_wire() {
        let st = MockState::new();
        st.preflight_ok();
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let before = m.state.requests().len();
        let sch = schema();
        let huge = "x".repeat(3 * 9000);
        let err = s.chat_unit(unit_request(&sch, &huge)).await.unwrap_err();
        assert!(matches!(err, ProviderError::UnitOverBudget { .. }));
        assert_eq!(m.state.requests().len(), before, "nothing was sent");
    }

    // ───────── batch discipline ─────────

    /// Spec §18: release is verified through `/api/ps`, never inferred
    /// from a successful unload request.
    #[tokio::test]
    async fn the_batch_ends_with_a_verified_unload() {
        let st = MockState::new();
        st.preflight_ok();
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        assert!(
            m.state.behavior.lock().unwrap().resident,
            "loaded by preflight"
        );

        let report = s.finish().await.unwrap();
        assert!(report.verified);
        assert!(!m.state.behavior.lock().unwrap().resident);

        let unload = m.state.requests().pop().unwrap();
        assert_eq!(unload["keep_alive"], "0");
        assert_eq!(unload["messages"].as_array().unwrap().len(), 0);

        // Idempotent.
        assert!(s.finish().await.unwrap().verified);
    }

    /// A runtime that keeps the model resident is a reported fault, not
    /// a silent success.
    #[tokio::test]
    async fn a_model_that_stays_resident_is_a_reported_fault() {
        let st = MockState::new();
        st.behavior.lock().unwrap().refuse_unload = true;
        st.preflight_ok();
        let m = mock(st).await;
        let mut s = session(&m.base)
            .await
            .unwrap()
            .with_unload_deadline(Duration::from_millis(600));
        let err = tokio::time::timeout(Duration::from_secs(20), s.finish())
            .await
            .expect("finish must be bounded")
            .unwrap_err();
        assert!(
            matches!(err, ProviderError::UnloadUnverified { .. }),
            "{err:?}"
        );
        assert_eq!(err.disposition(), Disposition::RunFault);
    }

    /// `keep_alive` spans the batch, so the model loads once.
    #[tokio::test]
    async fn keep_alive_spans_the_batch() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript::default());
        let m = mock(st).await;
        let mut s = session(&m.base).await.unwrap();
        let sch = schema();
        for _ in 0..3 {
            s.chat_unit(unit_request(&sch, "S1 [user]: hi"))
                .await
                .unwrap();
        }
        for req in m.state.requests() {
            assert_eq!(req["keep_alive"], "10m");
        }
        assert!(!s.unit_budget_spent());
    }

    #[tokio::test]
    async fn the_unit_budget_is_bounded() {
        let st = MockState::new();
        st.preflight_ok();
        st.script(ChatScript::default());
        let m = mock(st).await;
        let cfg = ProviderConfig {
            max_units_per_run: 2,
            ..cfg_for(&m.base)
        };
        let sch = schema();
        let mut s = ProviderSession::start(&cfg, client(&cfg), &canary_spec(&sch))
            .await
            .unwrap();
        for _ in 0..2 {
            s.chat_unit(unit_request(&sch, "hi")).await.unwrap();
        }
        assert!(s.unit_budget_spent());
    }
}
