//! Graphify — parse a codebase into the local knowledge graph (Phase 1: Map).
//!
//! tree-sitter parses each source file **in-process** into a normalized
//! [`ParsedFile`] of symbols + imports + calls (no network, no model — the
//! user's source never leaves the machine), and [`graphify_into_brain`] writes
//! that into the brain DB via the (previously dormant) `variables` /
//! `variable_references` / `function_calls` tables plus a `kind='code'` engram
//! node per file. The query helpers ([`where_defined`], [`whats_in_file`],
//! [`who_calls`]) back the MCP tools. See `docs/designs/graphify.md`.
//!
//! Each language is a tree-sitter grammar crate + one [`LangProfile`] (a small
//! table of node-kind → meaning). Resolution is name-heuristic (not a full
//! type-resolver) — good enough for retrieval + graph edges, matching the
//! "no full AST diff" stance of the schema's rename-detection design.
//!
//! Code is a DERIVED index: the repo is the system of record; the brain stores
//! only the extracted graph. Rows are written directly, bypassing the note
//! save / vault write-back path, so source is never copied into the markdown
//! vault. Re-running graphify upserts the rows.
#![allow(dead_code)] // some query/handler seams are consumed in later phases

use std::path::Path;
use std::sync::Arc;

use rusqlite::{params, Connection};
use tree_sitter::{Node, Parser};

use crate::memory::db::BrainDb;

/// A named thing declared in source. Maps onto a `variables` row
/// (name, kind, scope, type_hint, language, line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// 1-based line of the declaration.
    pub line: usize,
    /// The declaration's first line (signature), e.g.
    /// `pub fn build(n: u32) -> Engine`. Cheap, language-agnostic context
    /// surfaced by `whats_in_file` so the agent sees shape, not just names.
    pub signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SymbolKind {
    Function,
    Class,
    Struct,
    Enum,
    Trait,
    Interface,
    Type,
    Constant,
    Module,
    Macro,
    Variable,
}

impl SymbolKind {
    /// The string stored in `variables.kind`
    /// (schema vocabulary: variable|constant|function|class|type|interface).
    pub fn as_schema_kind(self) -> &'static str {
        match self {
            SymbolKind::Function | SymbolKind::Macro => "function",
            SymbolKind::Class | SymbolKind::Struct | SymbolKind::Enum => "class",
            SymbolKind::Trait | SymbolKind::Interface => "interface",
            SymbolKind::Type => "type",
            SymbolKind::Constant => "constant",
            SymbolKind::Module => "module",
            SymbolKind::Variable => "variable",
        }
    }
}

/// A module/path this file pulls in (a `use` / `import` statement). Resolving
/// the raw path to a concrete file node is a later phase; Phase 1 captures text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Import {
    pub path: String,
    pub line: usize,
}

/// A call site: `callee` invoked, optionally from within `caller`.
/// Maps onto a `function_calls` row. Note: calls inside macro invocations
/// (`format!`, `vec!`, …) aren't captured — tree-sitter parses macro bodies as
/// opaque token trees, not expressions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Call {
    pub caller: Option<String>,
    pub callee: String,
    pub line: usize,
}

/// The normalized extraction for one source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFile {
    pub path: String,
    pub language: Lang,
    pub symbols: Vec<Symbol>,
    pub imports: Vec<Import>,
    pub calls: Vec<Call>,
}

/// Supported source languages. Adding one = a grammar crate + a `LangProfile` +
/// arms in [`Lang::from_path`] / [`Lang::ts_language`] / [`Lang::profile`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Rust,
    Python,
    TypeScript,
    Tsx,
    Go,
    Java,
    CSharp,
    Ruby,
}

impl Lang {
    /// Detect a language from a file path's extension. `None` ⇒ not code we
    /// graphify (skip it).
    pub fn from_path(path: &str) -> Option<Lang> {
        match Path::new(path).extension().and_then(|e| e.to_str()) {
            Some("rs") => Some(Lang::Rust),
            Some("py" | "pyi") => Some(Lang::Python),
            Some("ts" | "mts" | "cts") => Some(Lang::TypeScript),
            Some("tsx") => Some(Lang::Tsx),
            Some("go") => Some(Lang::Go),
            Some("java") => Some(Lang::Java),
            Some("cs") => Some(Lang::CSharp),
            Some("rb") => Some(Lang::Ruby),
            _ => None,
        }
    }

    /// Stored in `variables.language` / `function_calls.language`.
    pub fn name(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::Python => "python",
            Lang::TypeScript | Lang::Tsx => "typescript",
            Lang::Go => "go",
            Lang::Java => "java",
            Lang::CSharp => "csharp",
            Lang::Ruby => "ruby",
        }
    }

    fn ts_language(self) -> tree_sitter::Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Lang::Ruby => tree_sitter_ruby::LANGUAGE.into(),
        }
    }

    fn profile(self) -> &'static LangProfile {
        match self {
            Lang::Rust => &RUST_PROFILE,
            Lang::Python => &PY_PROFILE,
            Lang::TypeScript | Lang::Tsx => &TS_PROFILE,
            Lang::Go => &GO_PROFILE,
            Lang::Java => &JAVA_PROFILE,
            Lang::CSharp => &CSHARP_PROFILE,
            Lang::Ruby => &RUBY_PROFILE,
        }
    }
}

/// Parse one source file's content into its normalized graph fragment.
/// Returns `None` if the path isn't a supported language or the grammar fails
/// to load (ABI mismatch) — never panics, never makes a network call.
pub fn parse_source(path: &str, source: &str) -> Option<ParsedFile> {
    let lang = Lang::from_path(path)?;
    let mut parser = Parser::new();
    parser.set_language(&lang.ts_language()).ok()?;
    let tree = parser.parse(source, None)?;

    let mut pf = ParsedFile {
        path: path.to_string(),
        language: lang,
        symbols: Vec::new(),
        imports: Vec::new(),
        calls: Vec::new(),
    };
    walk(tree.root_node(), source, &mut pf, None, lang.profile());
    Some(pf)
}

/// Walk a repo, respecting `.gitignore` (ripgrep's `ignore` engine), and parse
/// every supported source file. Also skips common vendor/build dirs even when
/// they aren't git-ignored, and oversized/generated files. Reading happens
/// locally; nothing leaves.
pub fn graphify_repo(root: &Path) -> Vec<ParsedFile> {
    // Vendored / build output not always in .gitignore. Hidden dirs (.git,
    // .venv, .next, …) are already skipped by the walker's default.
    const SKIP_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        "out",
        "vendor",
        "venv",
        "__pycache__",
        "coverage",
        ".git",
    ];
    // Parsing a 2 MB minified bundle is pure noise; 512 KB clears any
    // hand-written source with room to spare.
    const MAX_BYTES: u64 = 512 * 1024;

    let mut out = Vec::new();
    for entry in ignore::WalkBuilder::new(root).build().flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        if p.components().any(|c| {
            c.as_os_str()
                .to_str()
                .map(|s| SKIP_DIRS.contains(&s))
                .unwrap_or(false)
        }) {
            continue;
        }
        if entry
            .metadata()
            .map(|m| m.len() > MAX_BYTES)
            .unwrap_or(false)
        {
            continue;
        }
        let rel = p
            .strip_prefix(root)
            .unwrap_or(p)
            .to_string_lossy()
            .replace('\\', "/");
        if Lang::from_path(&rel).is_none() {
            continue;
        }
        if let Ok(src) = std::fs::read_to_string(p) {
            if let Some(pf) = parse_source(&rel, &src) {
                out.push(pf);
            }
        }
    }
    out
}

// ── Generic, profile-driven extractor ─────────────────────────────────────

/// A per-language table mapping tree-sitter node kinds to graph meaning.
struct LangProfile {
    /// node kind → symbol kind (declarations).
    symbols: &'static [(&'static str, SymbolKind)],
    /// node kinds that establish a caller context for nested calls.
    fn_defs: &'static [&'static str],
    /// node kinds that are import/use statements.
    imports: &'static [&'static str],
    /// node kinds that are call sites (callee read from the `function` field).
    calls: &'static [&'static str],
    /// prefixes stripped from an import's raw text (e.g. `"use "` for Rust).
    strip_prefixes: &'static [&'static str],
    /// the field on a call node holding the callee: `"function"` for most
    /// C-family grammars, `"name"` for Java's `method_invocation`, `"method"`
    /// for Ruby's `call`.
    call_fn_field: &'static str,
}

impl LangProfile {
    fn symbol_kind(&self, k: &str) -> Option<SymbolKind> {
        self.symbols
            .iter()
            .find(|(n, _)| *n == k)
            .map(|(_, sk)| *sk)
    }
    fn is_fn_def(&self, k: &str) -> bool {
        self.fn_defs.contains(&k)
    }
    fn is_import(&self, k: &str) -> bool {
        self.imports.contains(&k)
    }
    fn is_call(&self, k: &str) -> bool {
        self.calls.contains(&k)
    }
}

const RUST_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("function_item", SymbolKind::Function),
        ("struct_item", SymbolKind::Struct),
        ("enum_item", SymbolKind::Enum),
        ("trait_item", SymbolKind::Trait),
        ("type_item", SymbolKind::Type),
        ("const_item", SymbolKind::Constant),
        ("static_item", SymbolKind::Constant),
        ("mod_item", SymbolKind::Module),
        ("macro_definition", SymbolKind::Macro),
    ],
    fn_defs: &["function_item"],
    imports: &["use_declaration"],
    calls: &["call_expression"],
    strip_prefixes: &["use "],
    call_fn_field: "function",
};

const PY_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("function_definition", SymbolKind::Function),
        ("class_definition", SymbolKind::Class),
    ],
    fn_defs: &["function_definition"],
    imports: &["import_statement", "import_from_statement"],
    calls: &["call"],
    strip_prefixes: &[],
    call_fn_field: "function",
};

const TS_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("function_declaration", SymbolKind::Function),
        ("generator_function_declaration", SymbolKind::Function),
        ("method_definition", SymbolKind::Function),
        ("class_declaration", SymbolKind::Class),
        ("abstract_class_declaration", SymbolKind::Class),
        ("interface_declaration", SymbolKind::Interface),
        ("type_alias_declaration", SymbolKind::Type),
        ("enum_declaration", SymbolKind::Enum),
    ],
    fn_defs: &[
        "function_declaration",
        "generator_function_declaration",
        "method_definition",
    ],
    imports: &["import_statement"],
    calls: &["call_expression"],
    strip_prefixes: &[],
    call_fn_field: "function",
};

const GO_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("function_declaration", SymbolKind::Function),
        ("method_declaration", SymbolKind::Function),
        ("type_spec", SymbolKind::Type),
    ],
    fn_defs: &["function_declaration", "method_declaration"],
    imports: &["import_declaration"],
    calls: &["call_expression"],
    strip_prefixes: &["import "],
    call_fn_field: "function",
};

const JAVA_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("class_declaration", SymbolKind::Class),
        ("interface_declaration", SymbolKind::Interface),
        ("enum_declaration", SymbolKind::Enum),
        ("record_declaration", SymbolKind::Class),
        ("method_declaration", SymbolKind::Function),
        ("constructor_declaration", SymbolKind::Function),
    ],
    fn_defs: &["method_declaration", "constructor_declaration"],
    imports: &["import_declaration"],
    calls: &["method_invocation"],
    strip_prefixes: &["import "],
    call_fn_field: "name",
};

const CSHARP_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("class_declaration", SymbolKind::Class),
        ("interface_declaration", SymbolKind::Interface),
        ("struct_declaration", SymbolKind::Struct),
        ("enum_declaration", SymbolKind::Enum),
        ("record_declaration", SymbolKind::Class),
        ("method_declaration", SymbolKind::Function),
        ("constructor_declaration", SymbolKind::Function),
    ],
    fn_defs: &["method_declaration", "constructor_declaration"],
    imports: &["using_directive"],
    calls: &["invocation_expression"],
    strip_prefixes: &["using "],
    call_fn_field: "function",
};

const RUBY_PROFILE: LangProfile = LangProfile {
    symbols: &[
        ("method", SymbolKind::Function),
        ("singleton_method", SymbolKind::Function),
        ("class", SymbolKind::Class),
        ("module", SymbolKind::Module),
    ],
    fn_defs: &["method", "singleton_method"],
    imports: &[],
    calls: &["call"],
    strip_prefixes: &[],
    call_fn_field: "method",
};

fn walk(node: Node, src: &str, pf: &mut ParsedFile, current_fn: Option<String>, p: &LangProfile) {
    // Caller context handed to children (a function body's calls attribute to it).
    let mut child_fn = current_fn.clone();
    let kind = node.kind();

    if let Some(sk) = p.symbol_kind(kind) {
        if let Some(name) = field_text(node, "name", src) {
            pf.symbols.push(Symbol {
                name: name.clone(),
                kind: sk,
                line: line_of(node),
                signature: signature_of(node, src),
            });
            if p.is_fn_def(kind) {
                child_fn = Some(name);
            }
        }
    }

    if p.is_import(kind) {
        if let Ok(text) = node.utf8_text(src.as_bytes()) {
            let mut path = text.trim().to_string();
            for pre in p.strip_prefixes {
                if let Some(rest) = path.strip_prefix(pre) {
                    path = rest.to_string();
                }
            }
            let path = path.trim().trim_end_matches(';').trim().to_string();
            if !path.is_empty() {
                pf.imports.push(Import {
                    path,
                    line: line_of(node),
                });
            }
        }
    }

    if p.is_call(kind) {
        if let Some(func) = node.child_by_field_name(p.call_fn_field) {
            if let Ok(text) = func.utf8_text(src.as_bytes()) {
                let callee = last_segment(text);
                if !callee.is_empty() {
                    pf.calls.push(Call {
                        caller: current_fn.clone(),
                        callee,
                        line: line_of(node),
                    });
                }
            }
        }
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, src, pf, child_fn.clone(), p);
    }
}

fn field_text(node: Node, field: &str, src: &str) -> Option<String> {
    node.child_by_field_name(field)
        .and_then(|n| n.utf8_text(src.as_bytes()).ok())
        .map(|s| s.to_string())
}

fn line_of(node: Node) -> usize {
    node.start_position().row + 1
}

/// Last identifier segment of a (possibly qualified) callee:
/// `Foo::bar` → `bar`, `self.run` → `run`, `go` → `go`.
fn last_segment(s: &str) -> String {
    s.rsplit([':', '.']).next().unwrap_or(s).trim().to_string()
}

/// The declaration's first line — up to the first `{` or newline — collapsed to
/// single spaces. A cheap, language-agnostic "signature": for
/// `pub fn build(n: u32) -> Engine { … }` it yields `pub fn build(n: u32) -> Engine`.
fn signature_of(node: Node, src: &str) -> String {
    let text = node.utf8_text(src.as_bytes()).unwrap_or("");
    let end = match (text.find('{'), text.find('\n')) {
        (Some(a), Some(b)) => a.min(b),
        (Some(a), None) => a,
        (None, Some(b)) => b,
        (None, None) => text.len(),
    };
    let sig = text[..end].split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&sig, 200)
}

/// Truncate to at most `max` chars on a char boundary, adding `…` if cut.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

// ── DB population + queries (Phase 1b) ─────────────────────────────────────

/// Counts from a graphify run.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GraphifyStats {
    pub files: usize,
    pub symbols: usize,
    pub calls: usize,
    pub edges: usize,
}

/// Walk `root`, parse every supported file, and write the derived graph into
/// the brain DB. Best-effort per file; local-only, no network.
pub fn graphify_into_brain(root: &Path, db: &Arc<BrainDb>) -> GraphifyStats {
    let files = graphify_repo(root);
    let mut stats = GraphifyStats::default();
    let conn = db.lock();
    // One transaction for the whole write pass: per-statement autocommit
    // fsyncs dominate otherwise (measured ~10x slower on a 1.9k-file repo).
    let _ = conn.execute_batch("BEGIN");
    for pf in &files {
        if write_parsed_file(&conn, pf).is_ok() {
            stats.files += 1;
            stats.symbols += pf.symbols.len();
        }
    }
    // The COMMIT result used to be discarded, so the counts below came
    // purely from the in-memory parse: a user saw {"files": 1900,
    // "symbols": 41000} whether or not a single row landed. Worse, a
    // failed COMMIT left the transaction OPEN on this shared cached
    // connection, so the next `unchecked_transaction()` in ingest rolled
    // the whole graphify pass back on drop — and `where_defined` /
    // `who_calls` / `blast_radius` then returned nothing against a graph
    // we had just reported as successfully built.
    if let Err(e) = conn.execute_batch("COMMIT") {
        eprintln!("[graphify] COMMIT failed, rolling back: {e}");
        // Close the transaction explicitly rather than leaving it open
        // for an unrelated caller to inherit.
        let _ = conn.execute_batch("ROLLBACK");
        // Nothing was persisted — say so instead of reporting the parse.
        return GraphifyStats::default();
    }
    // Now that every symbol is in the DB, drop calls to names defined nowhere in
    // the codebase (stdlib/builtin noise) so who_calls / blast_radius stay about
    // THIS code, then count what remains.
    let _ = prune_unresolved_calls(&conn);
    stats.calls = conn
        .query_row("SELECT COUNT(*) FROM function_calls", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize;
    // Second pass: resolve each surviving call to the file that DEFINES the
    // callee and write file→file 'calls' edges into engram_links — this connects
    // the code nodes in the graph view.
    if let Ok(n) = compute_code_edges(&conn) {
        stats.edges = n;
    }
    stats
}

/// Persist one parsed file's graph fragment. Idempotent (re-running upserts).
fn write_parsed_file(conn: &Connection, pf: &ParsedFile) -> rusqlite::Result<()> {
    let engram_id = format!("code-{}", short_hash(&pf.path));
    let lang = pf.language.name();
    // The engram body = the file's API surface (path + every symbol's
    // signature), so a graphified file reads as a meaningful graph node AND is
    // keyword-searchable by symbol name through the normal recall path.
    let mut summary = format!("{} ({})\n", pf.path, lang);
    for s in &pf.symbols {
        if !s.signature.is_empty() {
            summary.push_str(&s.signature);
            summary.push('\n');
        }
    }

    // Code engram (kind='code') = a graph node for the file, inserted directly
    // so the vault write-back never sees it and the repo stays canonical.
    conn.execute(
        "INSERT INTO engrams (id, filename, title, content, content_hash, kind,
                              created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'code',
                 strftime('%Y-%m-%d %H:%M:%f','now'),
                 strftime('%Y-%m-%d %H:%M:%f','now'))
         ON CONFLICT(id) DO UPDATE SET
           content=excluded.content,
           content_hash=excluded.content_hash,
           updated_at=strftime('%Y-%m-%d %H:%M:%f','now')",
        params![engram_id, pf.path, pf.path, summary, short_hash(&summary)],
    )?;

    for s in &pf.symbols {
        let var_id = format!("var-{}", short_hash(&format!("{}|module|{}", s.name, lang)));
        conn.execute(
            "INSERT OR IGNORE INTO variables (id, name, scope, kind, language, description)
             VALUES (?1, ?2, 'module', ?3, ?4, ?5)",
            params![var_id, s.name, s.kind.as_schema_kind(), lang, s.signature],
        )?;
        let canon_id: String = conn.query_row(
            "SELECT id FROM variables WHERE name=?1 AND scope='module' AND language=?2",
            params![s.name, lang],
            |r| r.get(0),
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO variable_references
               (variable_id, engram_id, filepath, line_number, context, ref_type)
             VALUES (?1, ?2, ?3, ?4, ?5, 'define')",
            params![canon_id, engram_id, pf.path, s.line as i64, s.signature],
        )?;
    }

    for c in &pf.calls {
        conn.execute(
            "INSERT OR IGNORE INTO function_calls
               (caller_name, callee_name, language, engram_id, filepath, line_number)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![c.caller, c.callee, lang, engram_id, pf.path, c.line as i64],
        )?;
    }
    Ok(())
}

/// Resolve calls to the file that defines the callee and write file→file
/// `'calls'` edges into `engram_links`. Run after all files are written so
/// cross-file callees resolve. Returns the number of edges inserted.
fn compute_code_edges(conn: &Connection) -> rusqlite::Result<usize> {
    // Normalise orientation (from < to) because the graph view treats
    // engram_links as undirected and keeps only the from<to row. Direction is
    // preserved in `function_calls` (read by `who_calls`); here we only need
    // the file pair to be connected in the graph.
    //
    // Edge weight = COUPLING STRENGTH, not a constant: a real repo produces
    // one cross-file pair per shared call, and rendering them all at
    // similarity 1.0 is an unreadable hairball (112-file repo → 793
    // max-strength edges). Instead, similarity = 0.7 + 0.3·ln(1+calls)/
    // ln(1+max_calls): the most-coupled pair scores 1.0, single-call pairs
    // sit near 0.7 — BELOW the graph's default 0.85 similarity floor, so
    // the default view shows the architectural skeleton and the existing
    // similarity slider reveals progressively weaker coupling on demand.
    // INSERT OR REPLACE so re-graphify updates weights as the code evolves.
    let mut stmt = conn.prepare(
        "SELECT MIN(fc.engram_id, vr.engram_id), MAX(fc.engram_id, vr.engram_id), COUNT(*)
           FROM function_calls fc
           JOIN variables v ON v.name = fc.callee_name
           JOIN variable_references vr ON vr.variable_id = v.id AND vr.ref_type = 'define'
          WHERE fc.engram_id IS NOT NULL AND fc.engram_id <> vr.engram_id
          GROUP BY 1, 2",
    )?;
    let pairs: Vec<(String, String, i64)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let max_calls = pairs.iter().map(|(_, _, c)| *c).max().unwrap_or(1).max(1) as f64;
    let mut inserted = 0usize;
    for (a, b, c) in &pairs {
        let sim = 0.7 + 0.3 * ((1.0 + *c as f64).ln() / (1.0 + max_calls).ln());
        inserted += conn.execute(
            "INSERT OR REPLACE INTO engram_links (from_engram, to_engram, similarity, link_type)
             VALUES (?1, ?2, ?3, 'calls')",
            params![a, b, sim],
        )?;
    }
    Ok(inserted)
}

/// Drop calls whose callee isn't defined anywhere in the graphified code —
/// stdlib/builtin/constructor noise (`Some`, `to_string`, `println`, …). Keeps
/// the call graph (`who_calls` / `blast_radius`) about THIS codebase, not the
/// standard library. Returns the number of rows removed. (Imports already
/// capture external dependencies; this is about intra-codebase structure.)
fn prune_unresolved_calls(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM function_calls
          WHERE callee_name NOT IN (SELECT name FROM variables)",
        [],
    )
}

/// Phase 3 — **fuse notes to code**. Link any note (kind != 'code') to the code
/// file(s) that define a symbol the note references in `inline code`. This is
/// the thing the headless competitors can't do: "why is this written this way?"
/// walks from a function to the decision note about it. Conservative by design —
/// only backticked identifiers of 4+ chars count, so prose mentions of common
/// words don't manufacture edges. Returns the number of note↔code links created.
pub fn fuse_notes_to_code(conn: &Connection) -> rusqlite::Result<usize> {
    use std::collections::{HashMap, HashSet};

    // symbol name → code-file engram ids that DEFINE it.
    let mut defs: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT v.name, vr.engram_id
               FROM variables v JOIN variable_references vr
                 ON vr.variable_id = v.id AND vr.ref_type = 'define'",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (name, eng) = row?;
            defs.entry(name).or_default().push(eng);
        }
    }
    if defs.is_empty() {
        return Ok(0);
    }

    let ident = regex::Regex::new(r"`([A-Za-z_][A-Za-z0-9_]{3,})`").expect("valid regex");

    let notes: Vec<(String, String)> = {
        let mut stmt =
            conn.prepare("SELECT id, content FROM engrams WHERE COALESCE(kind,'note') != 'code'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut created = 0usize;
    for (note_id, content) in &notes {
        let mut seen: HashSet<&str> = HashSet::new();
        for cap in ident.captures_iter(content) {
            let name = cap.get(1).unwrap().as_str();
            if !seen.insert(name) {
                continue; // one link per (note, symbol), even if mentioned twice
            }
            let Some(files) = defs.get(name) else {
                continue;
            };
            for code_id in files {
                if code_id == note_id {
                    continue;
                }
                // Normalise orientation so the undirected graph view keeps it.
                let (a, b) = if note_id < code_id {
                    (note_id, code_id)
                } else {
                    (code_id, note_id)
                };
                created += conn.execute(
                    "INSERT OR IGNORE INTO engram_links
                       (from_engram, to_engram, similarity, link_type)
                     VALUES (?1, ?2, 1.0, 'references')",
                    params![a, b],
                )?;
            }
        }
    }
    Ok(created)
}

/// Files + line a symbol is *defined* in: `(filepath, line)`.
pub fn where_defined(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT r.filepath, r.line_number
           FROM variable_references r JOIN variables v ON v.id = r.variable_id
          WHERE v.name = ?1 AND r.ref_type = 'define'
          ORDER BY r.filepath, r.line_number",
    )?;
    let rows = stmt.query_map([symbol], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

/// Symbols declared in a file: `(name, kind, signature)`, in declaration order.
pub fn whats_in_file(
    conn: &Connection,
    path: &str,
) -> rusqlite::Result<Vec<(String, String, String)>> {
    let mut stmt = conn.prepare(
        // Match the exact path, or any stored path ending in `/<query>` so an
        // agent can pass a basename or partial path and still resolve the file.
        "SELECT v.name, v.kind, COALESCE(r.context, '')
           FROM variable_references r JOIN variables v ON v.id = r.variable_id
          WHERE (r.filepath = ?1 OR r.filepath LIKE '%/' || ?1) AND r.ref_type = 'define'
          ORDER BY r.line_number",
    )?;
    let rows = stmt.query_map([path], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    rows.collect()
}

/// Callers of a symbol: `(caller, filepath, line)`; caller is `<module>` for
/// top-level calls.
pub fn who_calls(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<(String, String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(caller_name,'<module>'), filepath, line_number
           FROM function_calls WHERE callee_name = ?1
          ORDER BY filepath, line_number",
    )?;
    let rows = stmt.query_map([symbol], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    rows.collect()
}

/// One impacted symbol from a blast-radius walk:
/// `(symbol_name, defining_file, defining_line)`.
type BlastRadiusRow = (String, Option<String>, Option<i64>);

/// Transitive callers of a symbol — the **blast radius** of changing it. Walks
/// the `function_calls` graph upward (callee → caller) with a recursive CTE;
/// `UNION` dedups so cycles terminate. Returns each impacted symbol with the
/// file/line it's defined in (when known), ordered by name.
pub fn blast_radius(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<BlastRadiusRow>> {
    let mut stmt = conn.prepare(
        "WITH RECURSIVE impact(name) AS (
             SELECT DISTINCT caller_name FROM function_calls
              WHERE callee_name = ?1 AND caller_name IS NOT NULL
             UNION
             SELECT DISTINCT fc.caller_name FROM function_calls fc
               JOIN impact i ON fc.callee_name = i.name
              WHERE fc.caller_name IS NOT NULL
         )
         SELECT i.name, MIN(vr.filepath), MIN(vr.line_number)
           FROM impact i
           LEFT JOIN variables v ON v.name = i.name
           LEFT JOIN variable_references vr
             ON vr.variable_id = v.id AND vr.ref_type = 'define'
          GROUP BY i.name
          ORDER BY i.name",
    )?;
    let rows = stmt.query_map([symbol], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })?;
    rows.collect()
}

/// Non-cryptographic, stable id hash for derived rows.
fn short_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_symbols_imports_calls() {
        let src = r#"
use crate::foo::Bar;

pub struct Engine { name: String }

pub fn build(n: u32) -> Engine { make_engine(n) }

fn make_engine(n: u32) -> Engine { Engine { name: n.to_string() } }
"#;
        let pf = parse_source("src/engine.rs", src).expect("rust parses");
        assert_eq!(pf.language, Lang::Rust);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Engine"));
        assert!(names.contains(&"build"));
        assert!(names.contains(&"make_engine"));
        assert!(pf.imports.iter().any(|i| i.path.contains("foo::Bar")));
        let c = pf.calls.iter().find(|c| c.callee == "make_engine").unwrap();
        assert_eq!(c.caller.as_deref(), Some("build"));
    }

    #[test]
    fn python_symbols_imports_calls() {
        let src = r#"
import os
from app.engine import Engine

class Service:
    def run(self):
        return build(1)

def build(n):
    return Service()
"#;
        let pf = parse_source("svc.py", src).expect("python parses");
        assert_eq!(pf.language, Lang::Python);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Service"), "{names:?}");
        assert!(names.contains(&"run"), "{names:?}");
        assert!(names.contains(&"build"), "{names:?}");
        assert!(pf.imports.iter().any(|i| i.path.contains("app.engine")));
        let c = pf.calls.iter().find(|c| c.callee == "build").unwrap();
        assert_eq!(c.caller.as_deref(), Some("run"));
    }

    #[test]
    fn typescript_symbols_imports_calls() {
        let src = r#"
import { Foo } from "./foo";

interface Shape { area(): number; }

export class Circle implements Shape {
  area(): number { return compute(this.r); }
}

function compute(r: number): number { return r * r; }
"#;
        let pf = parse_source("circle.ts", src).expect("ts parses");
        assert_eq!(pf.language, Lang::TypeScript);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Shape"), "{names:?}");
        assert!(names.contains(&"Circle"), "{names:?}");
        assert!(names.contains(&"compute"), "{names:?}");
        assert!(names.contains(&"area"), "{names:?}");
        assert!(pf.imports.iter().any(|i| i.path.contains("./foo")));
        let c = pf.calls.iter().find(|c| c.callee == "compute").unwrap();
        assert_eq!(c.caller.as_deref(), Some("area"));
    }

    #[test]
    fn go_symbols_calls() {
        let src = "package main\n\nfunc build() int { return helper() }\nfunc helper() int { return 1 }\n";
        let pf = parse_source("main.go", src).expect("go parses");
        assert_eq!(pf.language, Lang::Go);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"build"), "{names:?}");
        assert!(names.contains(&"helper"), "{names:?}");
        let c = pf.calls.iter().find(|c| c.callee == "helper").unwrap();
        assert_eq!(c.caller.as_deref(), Some("build"));
    }

    #[test]
    fn java_symbols_calls() {
        let src =
            "class A {\n  int build() { return helper(); }\n  int helper() { return 1; }\n}\n";
        let pf = parse_source("A.java", src).expect("java parses");
        assert_eq!(pf.language, Lang::Java);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"A"), "{names:?}");
        assert!(names.contains(&"build"), "{names:?}");
        assert!(names.contains(&"helper"), "{names:?}");
        let c = pf.calls.iter().find(|c| c.callee == "helper").unwrap();
        assert_eq!(c.caller.as_deref(), Some("build"));
    }

    #[test]
    fn csharp_symbols_calls() {
        let src =
            "class A {\n  int Build() { return Helper(); }\n  int Helper() { return 1; }\n}\n";
        let pf = parse_source("A.cs", src).expect("c# parses");
        assert_eq!(pf.language, Lang::CSharp);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"A"), "{names:?}");
        assert!(names.contains(&"Build"), "{names:?}");
        assert!(names.contains(&"Helper"), "{names:?}");
        let c = pf.calls.iter().find(|c| c.callee == "Helper").unwrap();
        assert_eq!(c.caller.as_deref(), Some("Build"));
    }

    #[test]
    fn ruby_symbols_calls() {
        let src =
            "class A\n  def build\n    helper(1)\n  end\n  def helper(n)\n    n\n  end\nend\n";
        let pf = parse_source("a.rb", src).expect("ruby parses");
        assert_eq!(pf.language, Lang::Ruby);
        let names: Vec<&str> = pf.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"A"), "{names:?}");
        assert!(names.contains(&"build"), "{names:?}");
        assert!(names.contains(&"helper"), "{names:?}");
        let c = pf.calls.iter().find(|c| c.callee == "helper").unwrap();
        assert_eq!(c.caller.as_deref(), Some("build"));
    }

    #[test]
    fn kind_maps_to_schema_vocabulary() {
        assert_eq!(SymbolKind::Struct.as_schema_kind(), "class");
        assert_eq!(SymbolKind::Interface.as_schema_kind(), "interface");
        assert_eq!(SymbolKind::Function.as_schema_kind(), "function");
    }

    #[test]
    fn non_code_is_skipped() {
        assert!(parse_source("notes.md", "# hello").is_none());
    }

    /// Minimal in-memory schema covering only the tables graphify writes
    /// (avoids pulling in the sqlite-vec `vec0` virtual tables from schema.sql).
    fn code_schema(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE engrams (id TEXT PRIMARY KEY, filename TEXT UNIQUE NOT NULL,
                title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
                kind TEXT DEFAULT 'note', created_at TEXT, updated_at TEXT);
             CREATE TABLE variables (id TEXT PRIMARY KEY, name TEXT NOT NULL,
                scope TEXT DEFAULT 'module', kind TEXT DEFAULT 'variable', type_hint TEXT,
                language TEXT NOT NULL, description TEXT,
                first_seen TEXT DEFAULT (datetime('now')),
                last_seen TEXT DEFAULT (datetime('now')), removed_at TEXT,
                UNIQUE(name, scope, language));
             CREATE TABLE variable_references (variable_id TEXT NOT NULL, engram_id TEXT NOT NULL,
                filepath TEXT, line_number INTEGER, context TEXT, ref_type TEXT DEFAULT 'use',
                PRIMARY KEY (variable_id, engram_id, line_number));
             CREATE TABLE function_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, caller_name TEXT,
                callee_name TEXT NOT NULL, language TEXT NOT NULL, engram_id TEXT, filepath TEXT,
                line_number INTEGER, UNIQUE(caller_name, callee_name, filepath, line_number));
             CREATE TABLE engram_links (from_engram TEXT NOT NULL, to_engram TEXT NOT NULL,
                similarity REAL NOT NULL, link_type TEXT DEFAULT 'semantic',
                PRIMARY KEY (from_engram, to_engram));",
        )
        .unwrap();
    }

    #[test]
    fn writes_and_queries_code_graph() {
        let conn = Connection::open_in_memory().unwrap();
        code_schema(&conn);

        let src = "pub fn build() -> u8 { make() }\nfn make() -> u8 { 1 }";
        let pf = parse_source("src/engine.rs", src).unwrap();
        write_parsed_file(&conn, &pf).unwrap();

        // where is `build` defined?
        assert_eq!(
            where_defined(&conn, "build").unwrap(),
            vec![("src/engine.rs".to_string(), 1)]
        );
        // who calls `make`? → build, line 1
        assert_eq!(
            who_calls(&conn, "make").unwrap(),
            vec![("build".to_string(), "src/engine.rs".to_string(), 1)]
        );
        // what's in the file?
        let in_file = whats_in_file(&conn, "src/engine.rs").unwrap();
        let names: Vec<&str> = in_file.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(names.contains(&"build") && names.contains(&"make"));
        // the signature carries the declaration line, not just the name
        let build_sig = &in_file.iter().find(|(n, _, _)| n == "build").unwrap().2;
        assert!(build_sig.contains("fn build"), "signature: {build_sig}");
        // passing just the basename still resolves the file (suffix match)
        let by_base = whats_in_file(&conn, "engine.rs").unwrap();
        assert!(
            by_base.iter().any(|(n, _, _)| n == "build"),
            "basename should match"
        );

        // idempotent: a second run must not duplicate the definition
        write_parsed_file(&conn, &pf).unwrap();
        assert_eq!(where_defined(&conn, "build").unwrap().len(), 1);
    }

    #[test]
    fn code_edges_link_caller_to_callee_file() {
        let conn = Connection::open_in_memory().unwrap();
        code_schema(&conn);
        // a.rs::build calls make, which is defined in b.rs.
        let a = parse_source("a.rs", "pub fn build() -> u8 { make() }").unwrap();
        let b = parse_source("b.rs", "pub fn make() -> u8 { 1 }").unwrap();
        write_parsed_file(&conn, &a).unwrap();
        write_parsed_file(&conn, &b).unwrap();

        let n = compute_code_edges(&conn).unwrap();
        assert!(n >= 1, "expected at least one file→file call edge");

        let a_id = format!("code-{}", short_hash("a.rs"));
        let b_id = format!("code-{}", short_hash("b.rs"));
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM engram_links WHERE link_type='calls' \
                 AND ((from_engram=?1 AND to_engram=?2) OR (from_engram=?2 AND to_engram=?1))",
                params![a_id, b_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 1,
            "a.rs and b.rs should be linked via a 'calls' edge"
        );
    }

    #[test]
    fn blast_radius_walks_transitive_callers() {
        let conn = Connection::open_in_memory().unwrap();
        code_schema(&conn);
        // top → mid → leaf
        let src = "fn top() { mid() }\nfn mid() { leaf() }\nfn leaf() {}";
        let pf = parse_source("chain.rs", src).unwrap();
        write_parsed_file(&conn, &pf).unwrap();

        let radius = |s: &str| {
            let mut names: Vec<String> = blast_radius(&conn, s)
                .unwrap()
                .into_iter()
                .map(|(n, _, _)| n)
                .collect();
            names.sort();
            names
        };
        // changing leaf can break mid and (transitively) top
        assert_eq!(radius("leaf"), vec!["mid".to_string(), "top".to_string()]);
        assert_eq!(radius("mid"), vec!["top".to_string()]);
        assert!(radius("top").is_empty());
    }

    #[test]
    fn graphify_repo_skips_vendor_and_parses_source() {
        use std::fs;
        let dir =
            std::env::temp_dir().join(format!("nv_graphify_{}_{}", std::process::id(), line!()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn hello() {}").unwrap();
        fs::write(dir.join("node_modules/dep.rs"), "pub fn vendored() {}").unwrap();

        let files = graphify_repo(&dir);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"src/lib.rs"), "should parse src: {paths:?}");
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "node_modules must be skipped: {paths:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fuse_links_notes_to_code() {
        let conn = Connection::open_in_memory().unwrap();
        code_schema(&conn);
        // a code file that defines `charge`
        let pf = parse_source("billing.rs", "pub fn charge() {}").unwrap();
        write_parsed_file(&conn, &pf).unwrap();
        // a decision note that references `charge` in inline code
        conn.execute(
            "INSERT INTO engrams (id, filename, title, content, content_hash, kind)
             VALUES ('note-1','adr.md','ADR','We decided `charge` must be idempotent.','h','note')",
            [],
        )
        .unwrap();

        assert!(
            fuse_notes_to_code(&conn).unwrap() >= 1,
            "expected a note→code link"
        );
        let code_id = format!("code-{}", short_hash("billing.rs"));
        let linked: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM engram_links WHERE link_type='references' \
                 AND ((from_engram='note-1' AND to_engram=?1) OR (from_engram=?1 AND to_engram='note-1'))",
                params![code_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            linked, 1,
            "note-1 should link to billing.rs via 'references'"
        );

        // A bare prose mention (no backticks) must NOT manufacture a link.
        conn.execute(
            "INSERT INTO engrams (id, filename, title, content, content_hash, kind)
             VALUES ('note-2','x.md','X','we should charge the customer','h','note')",
            [],
        )
        .unwrap();
        let total = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT COUNT(*) FROM engram_links WHERE link_type='references'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let before = total(&conn);
        fuse_notes_to_code(&conn).unwrap();
        assert_eq!(before, total(&conn), "bare prose 'charge' must not link");
    }

    /// Verify the whole pipeline against NeuroVault's own real Rust source
    /// (not toy snippets) — a smoke test that the parser + DB + queries hold up
    /// on a real codebase. Run with `-- --nocapture` to eyeball the output.
    #[test]
    fn verify_against_real_source() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/memory");
        let files = graphify_repo(&dir);
        let total_syms: usize = files.iter().map(|f| f.symbols.len()).sum();
        let total_calls: usize = files.iter().map(|f| f.calls.len()).sum();
        eprintln!(
            "\nVERIFY src/memory: {} files, {} symbols, {} calls",
            files.len(),
            total_syms,
            total_calls
        );

        assert!(
            files.len() >= 20,
            "expected many files, got {}",
            files.len()
        );
        assert!(total_syms >= 100, "expected many symbols, got {total_syms}");

        let me = files
            .iter()
            .find(|f| f.path.ends_with("graphify.rs"))
            .expect("graphify.rs should be parsed");
        let names: Vec<&str> = me.symbols.iter().map(|s| s.name.as_str()).collect();
        eprintln!("graphify.rs: {} symbols {names:?}", names.len());
        for s in me.symbols.iter().take(10) {
            eprintln!("  [{}] {}", s.kind.as_schema_kind(), s.signature);
        }
        eprintln!("graphify.rs calls (first 10):");
        for c in me.calls.iter().take(10) {
            eprintln!(
                "  {} -> {} @{}",
                c.caller.as_deref().unwrap_or("<mod>"),
                c.callee,
                c.line
            );
        }
        assert!(names.contains(&"parse_source"));
        assert!(names.contains(&"graphify_repo"));
        assert!(names.contains(&"blast_radius"));

        // DB round-trip + queries on the real corpus
        let conn = Connection::open_in_memory().unwrap();
        code_schema(&conn);
        for f in &files {
            let _ = write_parsed_file(&conn, f);
        }
        let raw: i64 = conn
            .query_row("SELECT COUNT(*) FROM function_calls", [], |r| r.get(0))
            .unwrap();
        let pruned = prune_unresolved_calls(&conn).unwrap();
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM function_calls", [], |r| r.get(0))
            .unwrap();
        eprintln!("calls: {raw} raw → pruned {pruned} stdlib/noise → {kept} intra-codebase");
        let edges = compute_code_edges(&conn).unwrap();
        eprintln!("code edges: {edges}");

        let defs = where_defined(&conn, "parse_source").unwrap();
        eprintln!("where_defined(parse_source): {defs:?}");
        eprintln!(
            "who_calls(write_parsed_file): {} sites",
            who_calls(&conn, "write_parsed_file").unwrap().len()
        );
        eprintln!(
            "blast_radius(compute_code_edges): {} impacted",
            blast_radius(&conn, "compute_code_edges").unwrap().len()
        );

        assert!(!defs.is_empty(), "parse_source should be defined somewhere");
        assert!(
            kept < raw,
            "prune should drop stdlib noise ({kept} vs {raw})"
        );
        assert!(
            who_calls(&conn, "Some").unwrap().is_empty(),
            "Some is a constructor, not a codebase fn — must be pruned"
        );
    }
}
