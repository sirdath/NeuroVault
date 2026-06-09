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
    /// Leading doc comment, if cheaply available (None in Phase 1).
    pub doc: Option<String>,
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
/// Maps onto a `function_calls` row.
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
            _ => None,
        }
    }

    /// Stored in `variables.language` / `function_calls.language`.
    pub fn name(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::Python => "python",
            Lang::TypeScript | Lang::Tsx => "typescript",
        }
    }

    fn ts_language(self) -> tree_sitter::Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        }
    }

    fn profile(self) -> &'static LangProfile {
        match self {
            Lang::Rust => &RUST_PROFILE,
            Lang::Python => &PY_PROFILE,
            Lang::TypeScript | Lang::Tsx => &TS_PROFILE,
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
/// every supported source file. Reading happens locally; nothing leaves.
pub fn graphify_repo(root: &Path) -> Vec<ParsedFile> {
    let mut out = Vec::new();
    for entry in ignore::WalkBuilder::new(root).build().flatten() {
        let p = entry.path();
        if !p.is_file() {
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
}

impl LangProfile {
    fn symbol_kind(&self, k: &str) -> Option<SymbolKind> {
        self.symbols.iter().find(|(n, _)| *n == k).map(|(_, sk)| *sk)
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
                doc: None,
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
                pf.imports.push(Import { path, line: line_of(node) });
            }
        }
    }

    if p.is_call(kind) {
        if let Some(func) = node.child_by_field_name("function") {
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
    s.rsplit(|c| c == ':' || c == '.')
        .next()
        .unwrap_or(s)
        .trim()
        .to_string()
}

// ── DB population + queries (Phase 1b) ─────────────────────────────────────

/// Counts from a graphify run.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GraphifyStats {
    pub files: usize,
    pub symbols: usize,
    pub calls: usize,
}

/// Walk `root`, parse every supported file, and write the derived graph into
/// the brain DB. Best-effort per file; local-only, no network.
pub fn graphify_into_brain(root: &Path, db: &Arc<BrainDb>) -> GraphifyStats {
    let files = graphify_repo(root);
    let mut stats = GraphifyStats::default();
    let conn = db.lock();
    for pf in &files {
        if write_parsed_file(&conn, pf).is_ok() {
            stats.files += 1;
            stats.symbols += pf.symbols.len();
            stats.calls += pf.calls.len();
        }
    }
    stats
}

/// Persist one parsed file's graph fragment. Idempotent (re-running upserts).
fn write_parsed_file(conn: &Connection, pf: &ParsedFile) -> rusqlite::Result<()> {
    let engram_id = format!("code-{}", short_hash(&pf.path));
    let lang = pf.language.name();
    let summary = format!(
        "[code:{}] {} — {} symbols, {} calls",
        lang,
        pf.path,
        pf.symbols.len(),
        pf.calls.len()
    );

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
            params![var_id, s.name, s.kind.as_schema_kind(), lang, s.doc],
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
            params![canon_id, engram_id, pf.path, s.line as i64, s.kind.as_schema_kind()],
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

/// Files + line a symbol is *defined* in: `(filepath, line)`.
pub fn where_defined(conn: &Connection, symbol: &str) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT r.filepath, r.line_number
           FROM variable_references r JOIN variables v ON v.id = r.variable_id
          WHERE v.name = ?1 AND r.ref_type = 'define'
          ORDER BY r.filepath, r.line_number",
    )?;
    let rows = stmt.query_map([symbol], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    rows.collect()
}

/// Symbols declared in a file: `(name, kind)`, in declaration order.
pub fn whats_in_file(conn: &Connection, path: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT v.name, v.kind
           FROM variable_references r JOIN variables v ON v.id = r.variable_id
          WHERE r.filepath = ?1 AND r.ref_type = 'define'
          ORDER BY r.line_number",
    )?;
    let rows = stmt.query_map([path], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
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
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
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
                line_number INTEGER, UNIQUE(caller_name, callee_name, filepath, line_number));",
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
        let names: Vec<String> = whats_in_file(&conn, "src/engine.rs")
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert!(names.contains(&"build".to_string()) && names.contains(&"make".to_string()));

        // idempotent: a second run must not duplicate the definition
        write_parsed_file(&conn, &pf).unwrap();
        assert_eq!(where_defined(&conn, "build").unwrap().len(), 1);
    }
}
