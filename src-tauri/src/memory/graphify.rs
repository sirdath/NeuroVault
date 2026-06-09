//! Graphify — parse a codebase into the local knowledge graph (Phase 1: Map).
//!
//! tree-sitter parses each source file **in-process** into a normalized
//! [`ParsedFile`] of symbols + imports + calls. No network, no model — the
//! user's source never leaves the machine. The normalized shape maps onto the
//! (currently dormant) `variables` / `function_calls` / `variable_references`
//! tables in `schema.sql`; DB population, MCP query tools, and graph rendering
//! are wired in later phases. See `docs/designs/graphify.md`.
//!
//! Each language is a tree-sitter grammar crate + one [`LangProfile`] (a small
//! table of node-kind → meaning). Resolution is name-heuristic (not a full
//! type-resolver) — good enough for retrieval + graph edges, matching the
//! "no full AST diff" stance of the schema's rename-detection design.
#![allow(dead_code)] // scaffolding ahead of the DB/MCP/UI wiring (phases 1b–3)

use std::path::Path;
use tree_sitter::{Node, Parser};

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
}
