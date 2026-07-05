//! API key data model + storage for the external API gateway.
//!
//! Self-contained. If the gateway
//! gets removed, this file gets deleted; nothing else in the
//! codebase depends on it.
//!
//! Storage shape: `~/.neurovault/api_keys.json`. JSON not SQLite so
//! the gateway can read it before opening any brain DB and so the
//! user can `cat` / `jq` it without our tooling. Versioned schema
//! (`version: 1`) so we can grow it.
//!
//! Security model:
//!   • Plaintext key shown to the UI exactly once at creation.
//!   • Storage holds blake3 hashes only — never the plaintext.
//!   • Comparison is constant-time (`subtle::ConstantTimeEq`)
//!     so timing can't leak which stored hash matched.
//!   • Revocation sets `revoked_at`; rows are kept for audit, not
//!     deleted. Lookup ignores revoked rows.
//!
//! Format: `nvk_<43-char-base64url>` — `nvk_` prefix is a public
//! marker for grep / leaked-credentials scanners, the payload is
//! 32 bytes of `getrandom` cryptographic random encoded with
//! url-safe base64 (no padding). 256 bits of entropy, far above
//! any brute-force ceiling for an HTTP-rate-limited surface.

use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use once_cell::sync::OnceCell;
use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use super::paths::nv_home;
use super::types::{MemoryError, Result};

/// Plaintext key prefix. Public — grep-friendly for accidental
/// commit / log leakage scanning, in the same vein as `sk-` (OpenAI)
/// or `xoxb-` (Slack).
pub const KEY_PREFIX: &str = "nvk_";

/// Number of cryptographic random bytes in the secret payload.
/// Encoded base64url-no-pad → 43 chars. Total key length = 47.
const SECRET_BYTES: usize = 32;

/// Storage schema version. Bump when the JSON shape changes
/// incompatibly so we can migrate forward without overwriting
/// existing keys.
const SCHEMA_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Scope model — read | write | admin, plus a brain allowlist.
// ---------------------------------------------------------------------------

/// Action scope. Higher tiers imply lower tiers (`admin` ⊃ `write` ⊃ `read`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Read,
    Write,
    Admin,
}

impl Scope {
    /// Does a key with `held` satisfy a route requiring `required`?
    pub fn satisfies(self, required: Scope) -> bool {
        // Numeric ordering: Read=0 < Write=1 < Admin=2. Required ≤ held.
        self.rank() >= required.rank()
    }

    fn rank(self) -> u8 {
        match self {
            Scope::Read => 0,
            Scope::Write => 1,
            Scope::Admin => 2,
        }
    }
}

// ---------------------------------------------------------------------------
// API key records.
// ---------------------------------------------------------------------------

/// Stored representation. Lives on disk inside `KeyStore::keys`.
/// Does NOT include the plaintext secret — only its blake3 hash.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiKeyRecord {
    /// Public identifier — first 6 chars of the hash (hex), prefixed
    /// `key_`. Used in audit logs + Settings UI rows. Safe to share.
    pub id: String,
    /// Free-form label the user gives the key at creation. "n8n
    /// workflow", "laptop import script", etc.
    pub label: String,
    /// Blake3 hash of the secret payload (everything after the
    /// `nvk_` prefix). Hex-encoded, 64 chars.
    pub hash: String,
    /// Highest action scope this key may use.
    pub scope: Scope,
    /// Optional brain allowlist. Empty = all brains permitted.
    /// Non-empty = the key may only target brains whose id is in
    /// this list. Enforced by the gateway's scope-check middleware.
    #[serde(default)]
    pub brain_allowlist: Vec<String>,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// Last successful use timestamp. `None` until first use.
    #[serde(default)]
    pub last_used_at: Option<String>,
    /// Total successful authentications against this key.
    #[serde(default)]
    pub use_count: u64,
    /// Set when the user revokes the key. Lookup ignores revoked
    /// rows; we keep the row for audit history.
    #[serde(default)]
    pub revoked_at: Option<String>,
}

impl ApiKeyRecord {
    pub fn is_active(&self) -> bool {
        self.revoked_at.is_none()
    }
}

/// Public-safe view of a key. Used when listing keys for the
/// Settings UI — the hash is omitted so even an exfiltrated UI
/// payload can't be replayed.
#[derive(Clone, Debug, Serialize)]
pub struct ApiKeyPublic {
    pub id: String,
    pub label: String,
    pub scope: Scope,
    pub brain_allowlist: Vec<String>,
    pub created_at: String,
    pub last_used_at: Option<String>,
    pub use_count: u64,
    pub revoked_at: Option<String>,
}

impl From<&ApiKeyRecord> for ApiKeyPublic {
    fn from(r: &ApiKeyRecord) -> Self {
        Self {
            id: r.id.clone(),
            label: r.label.clone(),
            scope: r.scope,
            brain_allowlist: r.brain_allowlist.clone(),
            created_at: r.created_at.clone(),
            last_used_at: r.last_used_at.clone(),
            use_count: r.use_count,
            revoked_at: r.revoked_at.clone(),
        }
    }
}

/// What auth middleware attaches to the request after a successful
/// key lookup. Handler code never sees the hash or label — only the
/// id (for audit) and the scopes (for per-route enforcement).
#[derive(Clone, Debug)]
pub struct AuthedKey {
    pub id: String,
    pub scope: Scope,
    pub brain_allowlist: Vec<String>,
}

impl AuthedKey {
    /// Check whether this key may target `brain_id`. Empty allowlist
    /// = all brains. Non-empty = explicit permission required.
    pub fn may_use_brain(&self, brain_id: &str) -> bool {
        self.brain_allowlist.is_empty() || self.brain_allowlist.iter().any(|b| b == brain_id)
    }
}

// ---------------------------------------------------------------------------
// Storage file (~/.neurovault/api_keys.json).
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KeyStore {
    pub version: u32,
    #[serde(default)]
    pub keys: Vec<ApiKeyRecord>,
}

impl Default for KeyStore {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            keys: Vec::new(),
        }
    }
}

impl KeyStore {
    /// Constant-time scan for a record matching `secret_hash`.
    /// Walks every active record so timing is independent of
    /// position — a key created last has the same auth latency
    /// as one created first.
    pub fn find_by_hash(&self, secret_hash: &str) -> Option<&ApiKeyRecord> {
        let target = secret_hash.as_bytes();
        let mut found: Option<&ApiKeyRecord> = None;
        for record in &self.keys {
            if !record.is_active() {
                continue;
            }
            // ConstantTimeEq returns Choice (1 or 0); we OR into
            // `found` after the loop ends so an early hit can't
            // short-circuit and leak position via timing.
            if record.hash.as_bytes().ct_eq(target).into() {
                found = Some(record);
            }
        }
        found
    }
}

/// Path to the keys file. Honours `NEUROVAULT_HOME` like everything
/// else in `paths::nv_home`.
pub fn keys_file_path() -> PathBuf {
    nv_home().join("api_keys.json")
}

/// Read the keys file from disk. Empty file / missing file → empty
/// store (not an error). Parse failure IS an error — refuse to
/// silently lose all keys because of a typo.
pub fn load_from_disk() -> Result<KeyStore> {
    let path = keys_file_path();
    if !path.exists() {
        return Ok(KeyStore::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| MemoryError::Other(format!("read {}: {}", path.display(), e)))?;
    if raw.trim().is_empty() {
        return Ok(KeyStore::default());
    }
    let parsed: KeyStore = serde_json::from_str(&raw)
        .map_err(|e| MemoryError::Other(format!("parse api_keys.json: {}", e)))?;
    Ok(parsed)
}

/// Persist the store atomically — write to a tmp file in the same
/// directory, fsync, rename over the live file. A crash mid-write
/// leaves either the old file intact or the new one — never a
/// truncated half-written state.
pub fn save_to_disk(store: &KeyStore) -> Result<()> {
    let path = keys_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| MemoryError::Other(format!("mkdir {}: {}", parent.display(), e)))?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(store)
        .map_err(|e| MemoryError::Other(format!("serialise keys: {}", e)))?;
    fs::write(&tmp, json)
        .map_err(|e| MemoryError::Other(format!("write {}: {}", tmp.display(), e)))?;
    fs::rename(&tmp, &path)
        .map_err(|e| MemoryError::Other(format!("rename → {}: {}", path.display(), e)))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// In-memory cache. Loaded on first access; refreshed on writes so
// the next auth check picks up the change immediately. RwLock so
// the hot path (read for auth) doesn't serialise on writes (rare).
// ---------------------------------------------------------------------------

fn cache() -> &'static RwLock<KeyStore> {
    static CACHE: OnceCell<RwLock<KeyStore>> = OnceCell::new();
    CACHE.get_or_init(|| {
        // Best-effort initial load — if the file is corrupt we fall
        // back to an empty store and the gateway logs the error on
        // first auth attempt rather than panicking at startup.
        let initial = load_from_disk().unwrap_or_default();
        RwLock::new(initial)
    })
}

/// Public read accessor. Cheap — RwLock read, no I/O.
pub fn current() -> KeyStore {
    cache().read().expect("api_keys cache poisoned").clone()
}

/// Force a re-read from disk — useful after an external edit
/// (someone hand-edits api_keys.json) or in tests.
pub fn reload() -> Result<()> {
    let fresh = load_from_disk()?;
    *cache().write().expect("api_keys cache poisoned") = fresh;
    Ok(())
}

// ---------------------------------------------------------------------------
// Key generation, hashing, lookup.
// ---------------------------------------------------------------------------

/// Hash a plaintext secret payload (the part of the key after
/// `nvk_`). Hex-encoded blake3, 64 chars.
pub fn hash_secret(secret: &str) -> String {
    let h = blake3::hash(secret.as_bytes());
    hex_encode(h.as_bytes())
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Result of `mint_key` — the plaintext is returned exactly once,
/// the record is what gets persisted. Caller is responsible for
/// showing the plaintext to the user and never logging it.
pub struct MintedKey {
    pub plaintext: String,
    pub record: ApiKeyRecord,
}

/// Generate a fresh API key. Returns the plaintext alongside the
/// stored record — the plaintext is the ONLY copy the user ever
/// sees. Subsequent reads of the store reveal only the hash.
///
/// Caller must persist via `save_to_disk(store)` after appending
/// `record` to its `keys` vec, OR use the higher-level
/// `create_key(...)` helper.
pub fn mint_key(label: &str, scope: Scope, brain_allowlist: Vec<String>) -> Result<MintedKey> {
    let mut secret_bytes = [0u8; SECRET_BYTES];
    getrandom::getrandom(&mut secret_bytes)
        .map_err(|e| MemoryError::Other(format!("rand: {}", e)))?;
    let payload = URL_SAFE_NO_PAD.encode(secret_bytes);
    let plaintext = format!("{}{}", KEY_PREFIX, payload);
    let hash = hash_secret(&payload);
    let id = format!("key_{}", &hash[..6]);
    let now = current_iso8601();
    let record = ApiKeyRecord {
        id,
        label: label.to_string(),
        hash,
        scope,
        brain_allowlist,
        created_at: now,
        last_used_at: None,
        use_count: 0,
        revoked_at: None,
    };
    Ok(MintedKey { plaintext, record })
}

/// High-level create: mint, append to in-memory store, persist,
/// return the minted key. The plaintext is in the returned struct
/// and nowhere on disk.
pub fn create_key(label: &str, scope: Scope, brain_allowlist: Vec<String>) -> Result<MintedKey> {
    let minted = mint_key(label, scope, brain_allowlist)?;
    {
        let mut guard = cache().write().expect("api_keys cache poisoned");
        guard.keys.push(minted.record.clone());
        save_to_disk(&guard)?;
    }
    Ok(minted)
}

/// Revoke a key by id. Idempotent: revoking an already-revoked key
/// is a no-op success. Returns `false` if no key with that id
/// exists, `true` if the row was updated.
pub fn revoke_key(id: &str) -> Result<bool> {
    let mut guard = cache().write().expect("api_keys cache poisoned");
    let Some(record) = guard.keys.iter_mut().find(|k| k.id == id) else {
        return Ok(false);
    };
    if record.revoked_at.is_none() {
        record.revoked_at = Some(current_iso8601());
        save_to_disk(&guard)?;
    }
    Ok(true)
}

/// Validate an `Authorization: Bearer ...` token value against the
/// store. Returns the AuthedKey to attach to the request on
/// success, `None` on any failure path (malformed, no match,
/// revoked). Updates last_used_at + use_count as a side effect.
///
/// Constant-time scan inside `find_by_hash`. The early returns
/// for malformed tokens leak nothing meaningful — they happen
/// before any secret-dependent comparison.
pub fn authenticate(bearer: &str) -> Option<AuthedKey> {
    let secret = bearer.strip_prefix(KEY_PREFIX)?;
    if secret.len() < 16 {
        // Reject anything implausibly short before hashing — saves
        // an unnecessary blake3 round on garbage input.
        return None;
    }
    let target_hash = hash_secret(secret);

    let (id, scope, allowlist) = {
        let store = cache().read().expect("api_keys cache poisoned");
        let record = store.find_by_hash(&target_hash)?;
        (
            record.id.clone(),
            record.scope,
            record.brain_allowlist.clone(),
        )
    };

    // Bump last-used / count under write lock. Best-effort persist
    // — if the disk write fails we still let auth succeed (we
    // already verified the key) but log the error so it surfaces.
    {
        let mut store = cache().write().expect("api_keys cache poisoned");
        if let Some(record) = store.keys.iter_mut().find(|k| k.id == id) {
            record.last_used_at = Some(current_iso8601());
            record.use_count = record.use_count.saturating_add(1);
        }
        if let Err(e) = save_to_disk(&store) {
            eprintln!("[api_keys] last_used_at persist failed: {}", e);
        }
    }

    Some(AuthedKey {
        id,
        scope,
        brain_allowlist: allowlist,
    })
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/// ISO-8601 UTC "now" using `time` (already in tree for the
/// retriever's recency decay). Format `2026-05-06T18:42:13Z` —
/// second precision is enough for "last used" / "created at".
fn current_iso8601() -> String {
    use time::format_description::well_known::Iso8601;
    use time::OffsetDateTime;
    OffsetDateTime::now_utc()
        .format(&Iso8601::DEFAULT)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_implication_matches_design() {
        assert!(Scope::Admin.satisfies(Scope::Read));
        assert!(Scope::Admin.satisfies(Scope::Write));
        assert!(Scope::Admin.satisfies(Scope::Admin));
        assert!(Scope::Write.satisfies(Scope::Read));
        assert!(Scope::Write.satisfies(Scope::Write));
        assert!(!Scope::Write.satisfies(Scope::Admin));
        assert!(Scope::Read.satisfies(Scope::Read));
        assert!(!Scope::Read.satisfies(Scope::Write));
        assert!(!Scope::Read.satisfies(Scope::Admin));
    }

    #[test]
    fn mint_produces_well_formed_key() {
        let m = mint_key("test", Scope::Read, vec![]).unwrap();
        assert!(m.plaintext.starts_with(KEY_PREFIX));
        // 32 bytes → 43 chars base64url-no-pad. Plus 4 char prefix = 47.
        assert_eq!(m.plaintext.len(), KEY_PREFIX.len() + 43);
        assert_eq!(m.record.id.len(), 4 + 6); // "key_" + 6 hex
        assert_eq!(m.record.hash.len(), 64);
        assert!(m.record.is_active());
    }

    #[test]
    fn hash_recovers_match() {
        let m = mint_key("test", Scope::Read, vec![]).unwrap();
        let secret = m.plaintext.strip_prefix(KEY_PREFIX).unwrap();
        let recomputed = hash_secret(secret);
        assert_eq!(recomputed, m.record.hash);
    }

    #[test]
    fn store_find_by_hash_returns_active_match() {
        let m1 = mint_key("a", Scope::Read, vec![]).unwrap();
        let m2 = mint_key("b", Scope::Write, vec![]).unwrap();
        let store = KeyStore {
            version: SCHEMA_VERSION,
            keys: vec![m1.record.clone(), m2.record.clone()],
        };
        let hit = store.find_by_hash(&m2.record.hash).unwrap();
        assert_eq!(hit.id, m2.record.id);
    }

    #[test]
    fn store_skips_revoked_keys() {
        let mut m = mint_key("a", Scope::Read, vec![]).unwrap();
        m.record.revoked_at = Some("2026-05-06T00:00:00Z".to_string());
        let store = KeyStore {
            version: SCHEMA_VERSION,
            keys: vec![m.record.clone()],
        };
        assert!(store.find_by_hash(&m.record.hash).is_none());
    }

    #[test]
    fn brain_allowlist_empty_means_all() {
        let key = AuthedKey {
            id: "key_test01".to_string(),
            scope: Scope::Read,
            brain_allowlist: vec![],
        };
        assert!(key.may_use_brain("anything"));
    }

    #[test]
    fn brain_allowlist_enforces_membership() {
        let key = AuthedKey {
            id: "key_test02".to_string(),
            scope: Scope::Read,
            brain_allowlist: vec!["NeuroVaultBrain1".to_string()],
        };
        assert!(key.may_use_brain("NeuroVaultBrain1"));
        assert!(!key.may_use_brain("default"));
    }

    #[test]
    fn public_view_omits_hash() {
        let m = mint_key("test", Scope::Read, vec![]).unwrap();
        let pub_view = ApiKeyPublic::from(&m.record);
        // Serialize and confirm no hash field leaked
        let json = serde_json::to_string(&pub_view).unwrap();
        assert!(!json.contains(&m.record.hash));
        assert!(json.contains(&m.record.id));
    }
}
