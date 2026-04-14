"""Tree-sitter backed extractors — accurate replacement for regex parsing.

Why this exists: the regex extractors in `variable_tracker.py` and
`call_graph.py` are fast and dependency-light, but they miss nested scopes,
mis-attribute calls inside lambdas, and produce false positives on tricky
syntax. Tree-sitter parses to a real CST, so we get exact node positions
and proper scope handling.

Soft-import: if `tree_sitter_language_pack` isn't installed, `AVAILABLE`
stays False and callers fall back to the regex path. Install with:
    uv sync --extra ast

Currently covers: python, javascript, typescript, tsx, rust, go, java.
"""

from __future__ import annotations

from typing import Iterator

from loguru import logger

try:
    from tree_sitter_language_pack import get_parser  # type: ignore
    AVAILABLE = True
except ImportError:
    AVAILABLE = False
    get_parser = None  # type: ignore


_PARSER_CACHE: dict[str, object] = {}


def _parser_for(language: str):
    """Lazy-cached parser. Returns None if tree-sitter unavailable or unsupported."""
    if not AVAILABLE:
        return None
    if language in _PARSER_CACHE:
        return _PARSER_CACHE[language]
    try:
        parser = get_parser(language)  # type: ignore[misc]
        _PARSER_CACHE[language] = parser
        return parser
    except Exception as e:
        logger.debug("tree-sitter parser unavailable for {}: {}", language, e)
        return None


def _node_text(node, source: bytes) -> str:
    return source[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def _walk(node):
    """Pre-order CST walk."""
    yield node
    for child in node.children:
        yield from _walk(child)


# --- Variable extraction ---

# Maps tree-sitter node types → our (kind, name_field) for definitions worth tracking.
# Each language has its own grammar so the node names differ.
PYTHON_DEFS = {
    "function_definition": ("function", "name"),
    "class_definition": ("class", "name"),
    "assignment": ("variable", None),  # handled specially
}

JS_DEFS = {
    "function_declaration": ("function", "name"),
    "method_definition": ("function", "name"),
    "class_declaration": ("class", "name"),
    "lexical_declaration": ("variable", None),
    "variable_declaration": ("variable", None),
}

TS_DEFS = {
    **JS_DEFS,
    "interface_declaration": ("type", "name"),
    "type_alias_declaration": ("type", "name"),
    "enum_declaration": ("type", "name"),
}

RUST_DEFS = {
    "function_item": ("function", "name"),
    "struct_item": ("class", "name"),
    "enum_item": ("type", "name"),
    "trait_item": ("type", "name"),
    "let_declaration": ("variable", None),
    "const_item": ("constant", "name"),
    "static_item": ("constant", "name"),
}

GO_DEFS = {
    "function_declaration": ("function", "name"),
    "method_declaration": ("function", "name"),
    "type_declaration": ("type", None),
    "var_declaration": ("variable", None),
    "const_declaration": ("constant", None),
}

JAVA_DEFS = {
    "method_declaration": ("function", "name"),
    "class_declaration": ("class", "name"),
    "interface_declaration": ("type", "name"),
    "field_declaration": ("variable", None),
}

DEF_TABLES = {
    "python": PYTHON_DEFS,
    "javascript": JS_DEFS,
    "typescript": TS_DEFS,
    "tsx": TS_DEFS,
    "rust": RUST_DEFS,
    "go": GO_DEFS,
    "java": JAVA_DEFS,
}


def _identifier_in(node) -> str | None:
    """Find the first child that looks like an identifier."""
    for child in node.children:
        if child.type in ("identifier", "type_identifier", "property_identifier", "field_identifier"):
            return child
    return None


def extract_variables_ast(content: str, language: str) -> list[dict]:
    """Tree-sitter backed variable extraction. Returns [] if unavailable."""
    parser = _parser_for(language)
    if parser is None:
        return []

    table = DEF_TABLES.get(language)
    if not table:
        return []

    source = content.encode("utf-8")
    try:
        tree = parser.parse(source)
    except Exception as e:
        logger.debug("tree-sitter parse failed for {}: {}", language, e)
        return []

    results: list[dict] = []

    for node in _walk(tree.root_node):
        spec = table.get(node.type)
        if not spec:
            continue
        kind, name_field = spec

        # Try the named child first; fall back to scanning for an identifier
        name_node = node.child_by_field_name(name_field) if name_field else None
        if name_node is None:
            name_node = _identifier_in(node)

        if name_node is not None:
            name = _node_text(name_node, source)
            if not name or name.startswith("_") and not name.startswith("__"):
                continue
            results.append({
                "name": name,
                "kind": kind,
                "type_hint": None,
                "line_number": node.start_point[0] + 1,
                "context": _node_text(node, source).split("\n", 1)[0][:150],
            })
            continue

        # Multi-binder declarations (e.g. `let a = 1, b = 2;` or `const x: T = …`)
        for sub in _walk(node):
            if sub is node:
                continue
            if sub.type in ("variable_declarator", "init_declarator", "short_var_declaration"):
                ident = _identifier_in(sub)
                if ident is not None:
                    name = _node_text(ident, source)
                    if not name:
                        continue
                    results.append({
                        "name": name,
                        "kind": kind,
                        "type_hint": None,
                        "line_number": sub.start_point[0] + 1,
                        "context": _node_text(sub, source).split("\n", 1)[0][:150],
                    })

    return results


# --- Call edge extraction ---

CALL_NODES = {
    "python": {"call"},
    "javascript": {"call_expression"},
    "typescript": {"call_expression"},
    "tsx": {"call_expression"},
    "rust": {"call_expression", "macro_invocation"},
    "go": {"call_expression"},
    "java": {"method_invocation"},
}

# Definition node types whose body is a "scope" we want to attribute calls to.
SCOPE_NODES = {
    "python": {"function_definition", "class_definition"},
    "javascript": {"function_declaration", "method_definition", "arrow_function", "function"},
    "typescript": {"function_declaration", "method_definition", "arrow_function", "function"},
    "tsx": {"function_declaration", "method_definition", "arrow_function", "function"},
    "rust": {"function_item", "impl_item"},
    "go": {"function_declaration", "method_declaration"},
    "java": {"method_declaration", "constructor_declaration"},
}


def _enclosing_function_name(node, source: bytes, scope_types: set[str]) -> str | None:
    """Walk up to find the nearest enclosing function/method definition."""
    cur = node.parent
    while cur is not None:
        if cur.type in scope_types:
            ident = _identifier_in(cur)
            if ident is not None:
                return _node_text(ident, source)
            return None
        cur = cur.parent
    return None


def _called_name(call_node, source: bytes) -> str | None:
    """Extract the called function's name from a call node."""
    func = call_node.child_by_field_name("function")
    if func is None and call_node.children:
        func = call_node.children[0]
    if func is None:
        return None

    # Drill down through member expressions to the rightmost identifier
    for sub in reversed(list(_walk(func))):
        if sub.type in ("identifier", "property_identifier", "field_identifier"):
            return _node_text(sub, source)
    return None


def extract_calls_ast(content: str, language: str) -> Iterator[dict]:
    """Tree-sitter backed call edge extraction."""
    parser = _parser_for(language)
    if parser is None:
        return

    call_types = CALL_NODES.get(language)
    scope_types = SCOPE_NODES.get(language)
    if not call_types or not scope_types:
        return

    source = content.encode("utf-8")
    try:
        tree = parser.parse(source)
    except Exception as e:
        logger.debug("tree-sitter parse failed for {}: {}", language, e)
        return

    for node in _walk(tree.root_node):
        if node.type not in call_types:
            continue
        callee = _called_name(node, source)
        if not callee:
            continue
        caller = _enclosing_function_name(node, source, scope_types)
        if caller == callee:
            continue
        yield {
            "caller": caller,
            "callee": callee,
            "line_number": node.start_point[0] + 1,
        }
