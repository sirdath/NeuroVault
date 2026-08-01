//! Consent-gated binding of mutable host transcripts to immutable
//! journal evidence receipts.
//!
//! This module deliberately stops at bytes and hashes. Parsing,
//! redaction, model access, proposal creation, and memory writes are
//! later phases. A capture failure never invalidates the outcome event.

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::path::Component;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use sha2::{Digest, Sha256};

use crate::memory::journal::{
    ApprovedTranscriptRoot, EvidenceCaptureCode, EvidenceCaptureReceipt, EvidenceCaptureStatus,
    EvidenceReference,
};

/// A bounded prefix keeps a malformed local request from turning the
/// Stop endpoint into an unbounded disk-read job. The parser adds
/// smaller per-unit and per-run limits in the next Phase-A slice.
pub const MAX_TRANSCRIPT_PREFIX_BYTES: u64 = 32 * 1024 * 1024;
#[cfg(unix)]
const HASH_BUFFER_BYTES: usize = 64 * 1024;
#[cfg(unix)]
const MAX_WIRE_PATH_BYTES: usize = 4 * 1024;

/// Untrusted hook-to-server input. The server supplies the root and
/// digest; neither can be asserted by the caller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutcomeEvidenceInput {
    Transcript {
        absolute_path: String,
        observed_prefix_len: u64,
    },
}

/// Trusted event scope resolved by the server before evidence capture.
#[derive(Debug, Clone, Copy)]
pub struct CaptureContext<'a> {
    pub event_type: &'a str,
    pub host: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub room: Option<&'a str>,
    pub privacy_label: Option<&'a str>,
}

#[derive(Debug, Clone)]
struct CapturePolicy {
    curator_enabled: bool,
    transcript_access: bool,
    /// The server-owned path as configured. This alias is used only for
    /// lexical containment so a hook reporting a symlinked `$HOME` path
    /// can still be related to the approved root without canonicalizing
    /// the untrusted transcript path.
    configured_claude_projects_root: PathBuf,
    /// The approved root resolved once when the enabled policy is loaded.
    /// All filesystem traversal starts from this target; symlinks below
    /// it remain forbidden and are opened with `O_NOFOLLOW`.
    resolved_claude_projects_root: Option<PathBuf>,
    max_prefix_bytes: u64,
}

impl CapturePolicy {
    fn load(
        curator_enabled: bool,
        transcript_access: bool,
        configured_claude_projects_root: PathBuf,
        max_prefix_bytes: u64,
    ) -> Self {
        // Consent checks must remain earlier than every transcript-root
        // filesystem operation. A disabled or partially enabled policy
        // therefore does not even resolve the configured root.
        let resolved_claude_projects_root = (curator_enabled
            && transcript_access
            && configured_claude_projects_root.is_absolute()
            && cfg!(unix))
        .then(|| fs::canonicalize(&configured_claude_projects_root).ok())
        .flatten();
        Self {
            curator_enabled,
            transcript_access,
            configured_claude_projects_root,
            resolved_claude_projects_root,
            max_prefix_bytes,
        }
    }
}

/// The reference is present only after every check and both hash passes
/// succeed. The receipt is safe to persist or return: it contains no
/// submitted path or transcript bytes.
#[derive(Debug, Clone)]
pub struct CaptureResult {
    pub reference: Option<EvidenceReference>,
    pub receipt: EvidenceCaptureReceipt,
}

impl CaptureResult {
    fn captured(reference: EvidenceReference) -> Self {
        Self {
            reference: Some(reference),
            receipt: EvidenceCaptureReceipt {
                status: EvidenceCaptureStatus::Captured,
                code: None,
            },
        }
    }

    fn disabled(code: EvidenceCaptureCode) -> Self {
        Self {
            reference: None,
            receipt: EvidenceCaptureReceipt {
                status: EvidenceCaptureStatus::Disabled,
                code: Some(code),
            },
        }
    }

    fn ineligible(code: EvidenceCaptureCode) -> Self {
        Self {
            reference: None,
            receipt: EvidenceCaptureReceipt {
                status: EvidenceCaptureStatus::Ineligible,
                code: Some(code),
            },
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct LocalCuratorConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    transcript_access: bool,
}

/// Phase A is developer-only and defaults closed. Consent is read from
/// a server-owned local config, never from request fields:
/// `~/.neurovault/local_curator.json`.
fn production_policy() -> CapturePolicy {
    let raw = fs::read_to_string(crate::memory::paths::nv_home().join("local_curator.json"));
    let config = decode_local_config(raw.as_deref().ok());
    CapturePolicy::load(
        config.enabled,
        config.transcript_access,
        crate::memory::paths::claude_projects_dir(),
        MAX_TRANSCRIPT_PREFIX_BYTES,
    )
}

fn decode_local_config(raw: Option<&str>) -> LocalCuratorConfig {
    raw.and_then(|body| serde_json::from_str::<LocalCuratorConfig>(body).ok())
        .unwrap_or_default()
}

/// Production entry point. It never returns an error because evidence
/// capture must not prevent the primary outcome from being journaled.
pub fn capture_outcome_evidence(
    input: &OutcomeEvidenceInput,
    context: CaptureContext<'_>,
) -> CaptureResult {
    capture_with_policy(input, context, &production_policy())
}

fn capture_with_policy(
    input: &OutcomeEvidenceInput,
    context: CaptureContext<'_>,
    policy: &CapturePolicy,
) -> CaptureResult {
    capture_with_policy_and_hash_hook(input, context, policy, || {})
}

fn capture_with_policy_and_hash_hook(
    input: &OutcomeEvidenceInput,
    context: CaptureContext<'_>,
    policy: &CapturePolicy,
    between_hash_passes: impl FnOnce(),
) -> CaptureResult {
    // These checks precede every transcript filesystem operation. With
    // consent off, a caller cannot use this endpoint as a path oracle.
    if !policy.curator_enabled {
        return CaptureResult::disabled(EvidenceCaptureCode::CuratorDisabled);
    }
    if !policy.transcript_access {
        return CaptureResult::disabled(EvidenceCaptureCode::TranscriptAccessDisabled);
    }
    if context.event_type != "assistant_response_completed" || context.host != Some("claude_code") {
        return CaptureResult::ineligible(EvidenceCaptureCode::UnsupportedOutcome);
    }
    let (Some(session_id), Some(_turn_id)) = (context.session_id, context.turn_id) else {
        return CaptureResult::ineligible(EvidenceCaptureCode::MissingScope);
    };
    if context
        .privacy_label
        .is_some_and(|label| label.eq_ignore_ascii_case("sensitive"))
        || context.room.is_some_and(contains_private_value)
    {
        return CaptureResult::ineligible(EvidenceCaptureCode::PrivatePath);
    }

    match input {
        OutcomeEvidenceInput::Transcript {
            absolute_path,
            observed_prefix_len,
        } => capture_transcript(
            absolute_path,
            *observed_prefix_len,
            session_id,
            policy,
            between_hash_passes,
        ),
    }
}

fn contains_private_value(value: &str) -> bool {
    value.split(['/', '\\']).any(|segment| {
        segment.eq_ignore_ascii_case("_private")
            || segment.eq_ignore_ascii_case(".private")
            || segment.starts_with('.')
    })
}

#[cfg(unix)]
fn contains_private_path_component(value: &str) -> bool {
    // Claude flattens a project cwd into one directory name (for
    // example `/Users/alex/_private/work` becomes a hyphen-delimited
    // component). Check both the literal component and those encoded
    // path tokens so a private source is still excluded before open.
    contains_private_value(value) || value.split('-').any(contains_private_value)
}

#[cfg(not(unix))]
fn capture_transcript(
    _absolute_path: &str,
    _observed_prefix_len: u64,
    _session_id: &str,
    _policy: &CapturePolicy,
    _between_hash_passes: impl FnOnce(),
) -> CaptureResult {
    // Windows needs handle-relative traversal plus file-ID comparison
    // before it can make this guarantee. Phase A fails closed there
    // instead of shipping a check-then-open reparse-point race.
    let _ = _policy.max_prefix_bytes;
    CaptureResult::ineligible(EvidenceCaptureCode::PlatformUnsupported)
}

#[cfg(unix)]
fn capture_transcript(
    absolute_path: &str,
    observed_prefix_len: u64,
    session_id: &str,
    policy: &CapturePolicy,
    between_hash_passes: impl FnOnce(),
) -> CaptureResult {
    if absolute_path.len() > MAX_WIRE_PATH_BYTES {
        return CaptureResult::ineligible(EvidenceCaptureCode::InvalidPath);
    }
    if observed_prefix_len == 0 {
        return CaptureResult::ineligible(EvidenceCaptureCode::EmptyPrefix);
    }
    if observed_prefix_len > policy.max_prefix_bytes {
        return CaptureResult::ineligible(EvidenceCaptureCode::PrefixTooLarge);
    }

    let submitted = Path::new(absolute_path);
    if !submitted.is_absolute()
        || submitted
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || !policy.configured_claude_projects_root.is_absolute()
    {
        return CaptureResult::ineligible(EvidenceCaptureCode::InvalidPath);
    }

    // First require lexical containment. `canonicalize` alone would
    // resolve an escaping symlink and erase the evidence that it was a
    // symlink in the first place.
    let relative_lexical = submitted
        .strip_prefix(&policy.configured_claude_projects_root)
        .ok()
        .or_else(|| {
            policy
                .resolved_claude_projects_root
                .as_deref()
                .and_then(|root| submitted.strip_prefix(root).ok())
        });
    let Some(relative_lexical) = relative_lexical else {
        return CaptureResult::ineligible(EvidenceCaptureCode::OutsideApprovedRoot);
    };
    if relative_lexical.as_os_str().is_empty() {
        return CaptureResult::ineligible(EvidenceCaptureCode::InvalidPath);
    }
    if submitted.extension().and_then(|v| v.to_str()) != Some("jsonl")
        || submitted.file_stem().and_then(|v| v.to_str()) != Some(session_id)
    {
        return CaptureResult::ineligible(EvidenceCaptureCode::UnsupportedFile);
    }

    let relative_path = match portable_relative_path(relative_lexical) {
        Ok(path) => path,
        Err(code) => return CaptureResult::ineligible(code),
    };
    let Some(resolved_root) = policy.resolved_claude_projects_root.as_deref() else {
        return CaptureResult::ineligible(EvidenceCaptureCode::SourceUnavailable);
    };
    if let Err(code) = reject_descendant_links(resolved_root, relative_lexical) {
        return CaptureResult::ineligible(code);
    }
    let root = match open_absolute_directory_no_links(resolved_root) {
        Ok(root) => root,
        Err(code) => return CaptureResult::ineligible(code),
    };
    let mut file = match open_relative_no_links(root, relative_lexical) {
        Ok(file) => file,
        Err(code) => return CaptureResult::ineligible(code),
    };
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() => metadata,
        Ok(_) => return CaptureResult::ineligible(EvidenceCaptureCode::UnsupportedFile),
        Err(_) => return CaptureResult::ineligible(EvidenceCaptureCode::SourceUnavailable),
    };
    if metadata.len() < observed_prefix_len {
        return CaptureResult::ineligible(EvidenceCaptureCode::SourceShorterThanObserved);
    }

    let source_prefix_sha256 =
        match stable_prefix_hash_with(&mut file, observed_prefix_len, between_hash_passes) {
            Ok(Some(hash)) => hash,
            Ok(None) | Err(_) => {
                return CaptureResult::ineligible(EvidenceCaptureCode::SourceChangedDuringCapture)
            }
        };

    if !matches!(file.metadata(), Ok(metadata) if metadata.len() >= observed_prefix_len) {
        return CaptureResult::ineligible(EvidenceCaptureCode::SourceChangedDuringCapture);
    }

    CaptureResult::captured(EvidenceReference::Transcript {
        root: ApprovedTranscriptRoot::ClaudeProjects,
        relative_path,
        observed_prefix_len,
        source_prefix_sha256,
    })
}

#[cfg(unix)]
fn portable_relative_path(path: &Path) -> Result<String, EvidenceCaptureCode> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(segment) = component else {
            return Err(EvidenceCaptureCode::InvalidPath);
        };
        let Some(segment) = segment.to_str() else {
            return Err(EvidenceCaptureCode::InvalidPath);
        };
        // A backslash is a valid Unix filename byte but a separator on
        // Windows. Reject it rather than persist a locator whose meaning
        // changes across replay platforms.
        if segment.contains('\\') || segment.contains('\0') {
            return Err(EvidenceCaptureCode::InvalidPath);
        }
        if contains_private_path_component(segment) {
            return Err(EvidenceCaptureCode::PrivatePath);
        }
        parts.push(segment);
    }
    if parts.is_empty() {
        return Err(EvidenceCaptureCode::InvalidPath);
    }
    Ok(parts.join("/"))
}

#[cfg(unix)]
fn open_absolute_directory_no_links(path: &Path) -> Result<File, EvidenceCaptureCode> {
    let mut current = File::open("/").map_err(|_| EvidenceCaptureCode::SourceUnavailable)?;
    for component in path.components() {
        match component {
            Component::RootDir => continue,
            Component::Normal(segment) => {
                current = openat_child(&current, segment, true)?;
            }
            _ => return Err(EvidenceCaptureCode::InvalidPath),
        }
    }
    let metadata = current
        .metadata()
        .map_err(|_| EvidenceCaptureCode::SourceUnavailable)?;
    if !metadata.is_dir() {
        return Err(EvidenceCaptureCode::UnsupportedFile);
    }
    Ok(current)
}

#[cfg(unix)]
fn open_relative_no_links(mut current: File, path: &Path) -> Result<File, EvidenceCaptureCode> {
    let components: Vec<_> = path.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(segment) = component else {
            return Err(EvidenceCaptureCode::InvalidPath);
        };
        let directory = index + 1 < components.len();
        current = openat_child(&current, segment, directory)?;
        let metadata = current
            .metadata()
            .map_err(|_| EvidenceCaptureCode::SourceUnavailable)?;
        if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
            return Err(EvidenceCaptureCode::UnsupportedFile);
        }
    }
    Ok(current)
}

#[cfg(unix)]
fn openat_child(
    parent: &File,
    name: &std::ffi::OsStr,
    directory: bool,
) -> Result<File, EvidenceCaptureCode> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name = CString::new(name.as_bytes()).map_err(|_| EvidenceCaptureCode::InvalidPath)?;
    let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
    if directory {
        flags |= libc::O_DIRECTORY;
    } else {
        // Opening a FIFO read-only blocks until a writer appears. The
        // file-type check necessarily happens after open, so make the
        // final open non-blocking; O_NONBLOCK has no effect on regular
        // transcript reads.
        flags |= libc::O_NONBLOCK;
    }
    // SAFETY: `parent` owns a live directory descriptor for the duration
    // of the call; `name` is NUL-terminated; successful descriptors are
    // transferred exactly once into `File`.
    let descriptor = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if descriptor < 0 {
        return Err(EvidenceCaptureCode::SourceUnavailable);
    }
    // SAFETY: `openat` returned a fresh owned descriptor above.
    Ok(unsafe { File::from_raw_fd(descriptor) })
}

#[cfg(unix)]
fn reject_descendant_links(root: &Path, relative: &Path) -> Result<(), EvidenceCaptureCode> {
    let mut cursor = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(EvidenceCaptureCode::InvalidPath);
        };
        cursor.push(segment);
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|_| EvidenceCaptureCode::SourceUnavailable)?;
        if metadata.file_type().is_symlink() {
            return Err(EvidenceCaptureCode::SymlinkNotAllowed);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn hash_exact_prefix(file: &mut File, len: u64) -> std::io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut remaining = len;
    let mut buffer = [0u8; HASH_BUFFER_BYTES];
    let mut hasher = Sha256::new();
    while remaining > 0 {
        let want =
            usize::try_from(remaining.min(HASH_BUFFER_BYTES as u64)).unwrap_or(HASH_BUFFER_BYTES);
        let read = file.read(&mut buffer[..want])?;
        if read == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "transcript prefix changed during capture",
            ));
        }
        hasher.update(&buffer[..read]);
        remaining -= read as u64;
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(unix)]
fn stable_prefix_hash_with(
    file: &mut File,
    len: u64,
    between_passes: impl FnOnce(),
) -> std::io::Result<Option<String>> {
    let first = hash_exact_prefix(file, len)?;
    between_passes();
    let second = hash_exact_prefix(file, len)?;
    Ok((first == second).then_some(first))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let requested_root = std::env::temp_dir().join(format!(
            "nv-curator-evidence-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&requested_root).unwrap();
        // macOS exposes /var and /tmp through symlinks. Return the
        // canonical fixture root so tests exercise the same no-link
        // invariant required of the production approved root.
        let root = fs::canonicalize(requested_root).unwrap();
        let project = root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        (root, project)
    }

    fn policy(root: &Path) -> CapturePolicy {
        CapturePolicy::load(true, true, root.to_path_buf(), 1024)
    }

    fn context<'a>(session_id: &'a str) -> CaptureContext<'a> {
        CaptureContext {
            event_type: "assistant_response_completed",
            host: Some("claude_code"),
            session_id: Some(session_id),
            turn_id: Some("turn-1"),
            room: Some("project-a"),
            privacy_label: None,
        }
    }

    fn input(path: &Path, len: u64) -> OutcomeEvidenceInput {
        OutcomeEvidenceInput::Transcript {
            absolute_path: path.to_string_lossy().into_owned(),
            observed_prefix_len: len,
        }
    }

    #[test]
    fn local_consent_config_defaults_closed_and_requires_both_switches() {
        for raw in [
            None,
            Some("not json"),
            Some("{}"),
            Some(r#"{"enabled":true}"#),
        ] {
            let config = decode_local_config(raw);
            assert!(!config.enabled || !config.transcript_access);
        }
        let enabled = decode_local_config(Some(r#"{"enabled":true,"transcript_access":true}"#));
        assert!(enabled.enabled && enabled.transcript_access);
    }

    #[cfg(unix)]
    #[test]
    fn captures_exact_prefix_and_never_persists_absolute_path() {
        let (root, project) = fixture("prefix");
        let transcript = project.join("s-1.jsonl");
        let original = b"abcdef-newer-suffix";
        fs::write(&transcript, original).unwrap();

        let result = capture_with_policy(&input(&transcript, 6), context("s-1"), &policy(&root));
        assert_eq!(result.receipt.status, EvidenceCaptureStatus::Captured);
        let reference = result.reference.unwrap();
        assert_eq!(
            reference,
            EvidenceReference::Transcript {
                root: ApprovedTranscriptRoot::ClaudeProjects,
                relative_path: "project-a/s-1.jsonl".into(),
                observed_prefix_len: 6,
                source_prefix_sha256:
                    "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721".into(),
            }
        );
        let stored = serde_json::to_string(&reference).unwrap();
        assert!(!stored.contains(root.to_string_lossy().as_ref()));
        assert!(!stored.contains("abcdef"));
        assert_eq!(fs::read(&transcript).unwrap(), original);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn same_length_prefix_mutation_between_hash_passes_is_rejected() {
        let (root, project) = fixture("mutation");
        let transcript = project.join("s-1.jsonl");
        fs::write(&transcript, b"abcdef").unwrap();
        let result = capture_with_policy_and_hash_hook(
            &input(&transcript, 6),
            context("s-1"),
            &policy(&root),
            || {
                fs::write(&transcript, b"abcXef").unwrap();
            },
        );
        assert!(result.reference.is_none());
        assert_eq!(result.receipt.status, EvidenceCaptureStatus::Ineligible);
        assert_eq!(
            result.receipt.code,
            Some(EvidenceCaptureCode::SourceChangedDuringCapture)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn disabled_policy_touches_no_transcript_path() {
        let (root, _) = fixture("disabled");
        let missing = root.join("does-not-exist").join("s-1.jsonl");
        let mut disabled = policy(&root);
        disabled.curator_enabled = false;
        let result = capture_with_policy(&input(&missing, 10), context("s-1"), &disabled);
        assert_eq!(
            result.receipt.code,
            Some(EvidenceCaptureCode::CuratorDisabled)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn prefix_bounds_and_short_sources_fail_closed() {
        let (root, project) = fixture("bounds");
        let transcript = project.join("s-1.jsonl");
        fs::write(&transcript, b"small").unwrap();
        let p = policy(&root);

        let empty = capture_with_policy(&input(&transcript, 0), context("s-1"), &p);
        assert_eq!(empty.receipt.code, Some(EvidenceCaptureCode::EmptyPrefix));
        let huge = capture_with_policy(&input(&transcript, 1025), context("s-1"), &p);
        assert_eq!(huge.receipt.code, Some(EvidenceCaptureCode::PrefixTooLarge));
        let short = capture_with_policy(&input(&transcript, 6), context("s-1"), &p);
        assert_eq!(
            short.receipt.code,
            Some(EvidenceCaptureCode::SourceShorterThanObserved)
        );

        fs::write(&transcript, vec![b'x'; 1024]).unwrap();
        let exact_cap = capture_with_policy(&input(&transcript, 1024), context("s-1"), &p);
        assert_eq!(exact_cap.receipt.status, EvidenceCaptureStatus::Captured);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn outside_private_and_unsupported_files_are_ineligible() {
        let (root, project) = fixture("paths");
        let outside = root.parent().unwrap().join(format!(
            "outside-{}-s-1.jsonl",
            uuid::Uuid::new_v4().simple()
        ));
        fs::write(&outside, b"x").unwrap();
        let p = policy(&root);
        assert_eq!(
            capture_with_policy(&input(&outside, 1), context("s-1"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::OutsideApprovedRoot)
        );

        let inside = project.join("s-1.jsonl");
        fs::write(&inside, b"x").unwrap();
        let parent_component = project.join("subdir").join("..").join("s-1.jsonl");
        assert_eq!(
            capture_with_policy(&input(&parent_component, 1), context("s-1"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::InvalidPath)
        );

        let private = root.join(".private");
        fs::create_dir_all(&private).unwrap();
        let private_file = private.join("s-1.jsonl");
        fs::write(&private_file, b"x").unwrap();
        assert_eq!(
            capture_with_policy(&input(&private_file, 1), context("s-1"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::PrivatePath)
        );

        let encoded_private = root.join("-Users-alex-_PRIVATE-work");
        fs::create_dir_all(&encoded_private).unwrap();
        let encoded_private_file = encoded_private.join("s-encoded.jsonl");
        fs::write(&encoded_private_file, b"x").unwrap();
        assert_eq!(
            capture_with_policy(&input(&encoded_private_file, 1), context("s-encoded"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::PrivatePath)
        );

        let wrong_type = project.join("s-1.txt");
        fs::write(&wrong_type, b"x").unwrap();
        assert_eq!(
            capture_with_policy(&input(&wrong_type, 1), context("s-1"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::UnsupportedFile)
        );
        assert_eq!(
            capture_with_policy(&input(&inside, 1), context("another-session"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::UnsupportedFile)
        );
        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn unavailable_source_is_visible_without_a_reference() {
        let (root, project) = fixture("source-unavailable");
        let missing = project.join("s-missing.jsonl");
        let result = capture_with_policy(&input(&missing, 1), context("s-missing"), &policy(&root));
        assert!(result.reference.is_none());
        assert_eq!(result.receipt.status, EvidenceCaptureStatus::Ineligible);
        assert_eq!(
            result.receipt.code,
            Some(EvidenceCaptureCode::SourceUnavailable)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_path_byte_cases_fail_before_source_access() {
        use std::ffi::{OsStr, OsString};
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        let (root, _) = fixture("invalid-bytes");
        let p = policy(&root);

        let overlong = format!("/{}/s-long.jsonl", "x".repeat(MAX_WIRE_PATH_BYTES));
        let overlong_input = OutcomeEvidenceInput::Transcript {
            absolute_path: overlong,
            observed_prefix_len: 1,
        };
        assert_eq!(
            capture_with_policy(&overlong_input, context("s-long"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::InvalidPath)
        );

        let backslash = root.join("project\\alias").join("s-backslash.jsonl");
        assert_eq!(
            capture_with_policy(&input(&backslash, 1), context("s-backslash"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::InvalidPath)
        );

        let nul = format!("{}/project-a/bad\0/s-nul.jsonl", root.display());
        let nul_input = OutcomeEvidenceInput::Transcript {
            absolute_path: nul,
            observed_prefix_len: 1,
        };
        assert_eq!(
            capture_with_policy(&nul_input, context("s-nul"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::InvalidPath)
        );

        let non_utf8 = PathBuf::from(OsString::from_vec(vec![0xff]));
        assert_eq!(
            portable_relative_path(&non_utf8),
            Err(EvidenceCaptureCode::InvalidPath)
        );

        let root_file = File::open(&root).unwrap();
        assert_eq!(
            openat_child(&root_file, OsStr::from_bytes(b"bad\0name"), false).unwrap_err(),
            EvidenceCaptureCode::InvalidPath
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn descendant_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let (root, project) = fixture("symlinks");
        let real = project.join("s-1.jsonl");
        fs::write(&real, b"x").unwrap();
        let final_link = project.join("s-2.jsonl");
        symlink(&real, &final_link).unwrap();
        let p = policy(&root);
        assert_eq!(
            capture_with_policy(&input(&final_link, 1), context("s-2"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::SymlinkNotAllowed)
        );

        let real_dir = root.join("real-project");
        fs::create_dir_all(&real_dir).unwrap();
        fs::write(real_dir.join("s-3.jsonl"), b"x").unwrap();
        let dir_link = root.join("linked-project");
        symlink(&real_dir, &dir_link).unwrap();
        assert_eq!(
            capture_with_policy(&input(&dir_link.join("s-3.jsonl"), 1), context("s-3"), &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::SymlinkNotAllowed)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_approved_root_resolves_once_and_captures() {
        use std::os::unix::fs::symlink;

        let (root, project) = fixture("root-symlink");
        let transcript = project.join("s-root.jsonl");
        fs::write(&transcript, b"root-alias").unwrap();
        let root_link = root.parent().unwrap().join(format!(
            "nv-curator-root-link-{}",
            uuid::Uuid::new_v4().simple()
        ));
        symlink(&root, &root_link).unwrap();
        let linked_policy = policy(&root_link);
        let result = capture_with_policy(
            &input(&root_link.join("project-a/s-root.jsonl"), 10),
            context("s-root"),
            &linked_policy,
        );
        assert_eq!(result.receipt.status, EvidenceCaptureStatus::Captured);
        assert_eq!(result.receipt.code, None);
        assert!(matches!(
            result.reference,
            Some(EvidenceReference::Transcript {
                root: ApprovedTranscriptRoot::ClaudeProjects,
                relative_path,
                observed_prefix_len: 10,
                ..
            }) if relative_path == "project-a/s-root.jsonl"
        ));
        let _ = fs::remove_file(root_link);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn special_files_are_rejected_without_blocking() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let (root, project) = fixture("special-file");
        let fifo = project.join("s-fifo.jsonl");
        let name = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: `name` is a valid NUL-terminated path and the fixture
        // is exclusively owned by this test.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        let result = capture_with_policy(&input(&fifo, 1), context("s-fifo"), &policy(&root));
        assert_eq!(
            result.receipt.code,
            Some(EvidenceCaptureCode::UnsupportedFile)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wrong_host_event_or_missing_turn_never_reads_evidence() {
        let (root, project) = fixture("scope");
        let missing = project.join("s-1.jsonl");
        let p = policy(&root);
        let wrong_host = CaptureContext {
            host: Some("spoofed"),
            ..context("s-1")
        };
        assert_eq!(
            capture_with_policy(&input(&missing, 1), wrong_host, &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::UnsupportedOutcome)
        );
        let missing_turn = CaptureContext {
            turn_id: None,
            ..context("s-1")
        };
        assert_eq!(
            capture_with_policy(&input(&missing, 1), missing_turn, &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::MissingScope)
        );
        #[cfg(unix)]
        {
            let relative = OutcomeEvidenceInput::Transcript {
                absolute_path: "project-a/s-1.jsonl".into(),
                observed_prefix_len: 1,
            };
            assert_eq!(
                capture_with_policy(&relative, context("s-1"), &p)
                    .receipt
                    .code,
                Some(EvidenceCaptureCode::InvalidPath)
            );
        }
        let private_room = CaptureContext {
            room: Some("clients/_PRIVATE"),
            ..context("s-1")
        };
        assert_eq!(
            capture_with_policy(&input(&missing, 1), private_room, &p)
                .receipt
                .code,
            Some(EvidenceCaptureCode::PrivatePath)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(not(unix))]
    #[test]
    fn unsupported_platform_fails_closed_before_source_access() {
        let (root, project) = fixture("unsupported-platform");
        let missing = project.join("s-1.jsonl");
        let result = capture_with_policy(&input(&missing, 1), context("s-1"), &policy(&root));
        assert_eq!(
            result.receipt.code,
            Some(EvidenceCaptureCode::PlatformUnsupported)
        );
        let _ = fs::remove_dir_all(root);
    }
}
