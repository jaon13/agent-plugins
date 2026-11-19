#!/usr/bin/env python3
"""Command & .NET ProjectReference dependency inspector for PreToolUse guards."""

from __future__ import annotations

import re
import shlex
import xml.etree.ElementTree as ET
from collections import deque
from collections.abc import Callable
from pathlib import Path

from lock_store import ModuleTarget, get_workspace_config, resolve_module_target

MIN_MODULE_ARGS = 2
MIN_TACH_ARGS = 3
MAX_PS_WRAPPER_DEPTH = 4
MIN_COND_TOKENS = 1

DOTNET_BUILD_RE = re.compile(
    r"\b(?:dotnet\s+(?:build|test|publish|pack|clean|restore|run)"
    r"|msbuild(?:\.exe)?)\b",
    re.IGNORECASE,
)
TOOL_BUILD_RE = re.compile(
    r"\b(?:build_installer\.ps1|verify_dotnet\.py)\b"
    r"|\bdotnet_xray\.py\b[^\n;|&]*--build\b",
    re.IGNORECASE,
)
NO_DEPS_RE = re.compile(
    r"--no-dependencies\b|[-/]p:BuildProjectReferences=false\b"
    r"|--no-build\b|-SkipPublish\b",
    re.IGNORECASE,
)
READ_ONLY_HEADS = {
    "rg",
    "rg.exe",
    "grep",
    "dir",
    "ls",
    "cat",
    "type",
    "where",
    "where.exe",
    "get-childitem",
    "gci",
    "get-content",
    "gc",
    "select-string",
    "sls",
    "get-item",
    "get-itemproperty",
    "get-process",
    "get-service",
    "get-ciminstance",
    "get-wmiobject",
    "get-command",
    "get-date",
    "get-location",
    "test-path",
    "resolve-path",
    "select-object",
    "where-object",
    "sort-object",
    "format-table",
    "format-list",
    "measure-object",
    "push-location",
    "pop-location",
    "split-path",
    "join-path",
    "convertfrom-json",
    "out-string",
    "format-custom",
    "xray-index",
    "xray-index.exe",
    "xray-grep",
    "xray-grep.exe",
    "structural-clone",
    "structural-clone.exe",
    "basedpyright",
    "basedpyright.exe",
    "basedpyright-langserver",
    "tach",
    "tach.exe",
    "echo",
    "write-host",
    "write-output",
}
GIT_READ_SUBCMDS = {
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "rev-parse",
    "ls-files",
    "merge-base",
    "ls-remote",
    "rev-list",
    "cat-file",
    "diff-tree",
    "describe",
    "show-ref",
    "for-each-ref",
    "check-ignore",
    "count-objects",
    "var",
}
GIT_VALUE_FLAGS = {"-c", "--git-dir", "--work-tree", "--namespace"}
DOCKER_READ_SUBCMDS = {"version", "info", "ps", "images", "stats", "inspect"}
DOCKER_SUBOBJ_READ_SUBCMDS = {"ls", "inspect"}
DOCKER_VALUE_FLAGS = {
    "-h",
    "--host",
    "--context",
    "-c",
    "--config",
    "-l",
    "--log-level",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
}
DOCKER_COMPOSE_READ_SUBCMDS = {
    "config",
    "ps",
    "ls",
    "images",
    "version",
    "logs",
}
DOCKER_COMPOSE_VALUE_FLAGS = {
    "-f",
    "--file",
    "-p",
    "--project-name",
    "--project-directory",
    "--env-file",
    "--profile",
    "--ansi",
    "--progress",
    "--parallel",
}
PS_SIMPLE_VAR_RE = re.compile(
    r"^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$"
)
PS_ASSIGN_RE = re.compile(
    r"^\$([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$", re.DOTALL
)
PS_COMP_OPS = {
    "-eq",
    "-ne",
    "-gt",
    "-ge",
    "-lt",
    "-le",
    "-like",
    "-notlike",
    "-match",
    "-notmatch",
    "-in",
    "-notin",
    "-contains",
    "-notcontains",
    "-is",
    "-isnot",
    "-ceq",
    "-cne",
    "-cgt",
    "-cge",
    "-clt",
    "-cle",
    "-ieq",
    "-ine",
    "-igt",
    "-ige",
    "-ilt",
    "-ile",
}
PS_CONTINUATION_RE = re.compile(
    r"^(?:else|elseif|catch|finally)\b", re.IGNORECASE
)
PS_BLOCK_START_RE = re.compile(r"^(?:if|try)\b", re.IGNORECASE)
STDERR_REDIR_RE = re.compile(r"\b[12]>\s*(?:\$null|/dev/null|&1)\b")
MUTATION_HINT_RE = re.compile(
    r"(?:(?:^|\s)(?:1?>>?)\s*[^\s&]|"
    r"\b(?:Out-File|Set-Content|Add-Content|Clear-Content|"
    r"Remove-Item|Move-Item|Copy-Item|Rename-Item|New-Item|"
    r"Set-Item|Clear-Item|Start-Process|Stop-Process|"
    r"Invoke-CimMethod|Invoke-Expression|Add-Type|Export-Csv|taskkill)\b|"
    r"\bInvoke-WebRequest\b[^\n;|&]*-OutFile\b|"
    r"\b(?:rm|mv|cp|mkdir|kill|iex)\b|"
    r"\bdotnet\s+(?:build|test|publish|pack|clean|restore|run)\b|"
    r"\bmsbuild(?:\.exe)?\b|"
    r"\bdocker\s+(?:build|compose\s+(?:up|build)|run|exec)\b|"
    r"\bgit\b[^\n;|&]*(?:\s|^)(?:add|commit|checkout|reset|clean|restore|"
    r"merge|rebase|cherry-pick|stash|pull|push|mv|rm)\b|"
    r"\bcargo\s+(?:build|test|check|clippy|fmt|run)\b)",
    re.IGNORECASE,
)
ABS_PATH_RE = re.compile(
    r'([A-Za-z]:[\\/][^\s"\';|&<>`]+|'
    r'(?:(?<=^)|(?<=[\s"\'(=@,:]))/[A-Za-z0-9._~+-]+/[^\s"\';|&<>`),]*)'
)


def _cross_os_name(raw: str) -> str:
    cleaned = raw.strip("\"'").replace("\\", "/").rstrip("/")
    return cleaned.rsplit("/", 1)[-1]


def split_command_segments(cmd: str) -> list[str]:
    parts = re.split(r"(?:&&|\|\||;|\r?\n)+", cmd)
    return [seg.strip() for seg in parts if seg.strip()]


def is_dotnet_build_segment(seg: str) -> bool:
    if re.search(r"\bdotnet\s+vstest\b", seg, re.IGNORECASE):
        return False
    return bool(DOTNET_BUILD_RE.search(seg) or TOOL_BUILD_RE.search(seg))


def has_no_dependencies_flag(seg: str) -> bool:
    return bool(NO_DEPS_RE.search(seg))


def _git_subcommand(tokens: list[str]) -> str:
    skip_next = False
    for tok in tokens[1:]:
        clean = tok.strip("\"'")
        if skip_next:
            skip_next = False
            continue
        if clean.lower() in GIT_VALUE_FLAGS or clean == "-C":
            skip_next = True
            continue
        if clean.startswith("-"):
            continue
        return clean.lower()
    return ""


def _is_read_only_ruff(tokens: list[str], low: str) -> bool:
    sub = next(
        (t.strip("\"'").lower() for t in tokens[1:] if not t.startswith("-")),
        "",
    )
    if sub == "format":
        return "--check" in tokens or "--diff" in tokens
    return "--fix" not in low


def _is_read_only_python_module(
    tokens: list[str],
    clean_tokens: list[str],
    low: str,
) -> bool:
    mod = clean_tokens[1]
    if mod == "ruff":
        return _is_read_only_ruff(tokens[2:], low)
    if mod in {"basedpyright", "basedpyright-langserver"}:
        return True
    if mod == "tach":
        return len(clean_tokens) >= MIN_TACH_ARGS and clean_tokens[2] == "check"
    return False


_SCRIPT_READ_ONLY_RULES: dict[str, Callable[[set[str]], bool]] = {
    "project_lock.py": lambda args: bool(
        args & {"status", "unlock", "queue", "claim", "release"}
    ),
    "check_consistency.py": lambda _args: True,
    "xaml_style_xray.py": lambda _args: True,
    "codebase_map.py": lambda _args: True,
    "grep_review.py": lambda args: (
        "--apply" not in args and bool(args & {"list", "show"})
    ),
    "init_rust_governance.py": lambda args: "--apply-cargo" not in args,
    "dotnet_xray.py": lambda args: "--build" not in args,
    "polyglot_xray.py": lambda args: "--build" not in args,
    "rust_xray.py": lambda args: "--build" not in args,
    "verify_dotnet.py": lambda args: (
        "--no-build" in args
        and "--extra-test-project" not in args
        and "--build" not in args
    ),
    "verify_rust.py": lambda args: "--no-build" in args and "--no-test" in args,
}


def _is_read_only_script(script_name: str, arg_tokens: set[str]) -> bool:
    rule = _SCRIPT_READ_ONLY_RULES.get(script_name)
    return rule(arg_tokens) if rule is not None else False


def _is_read_only_python(tokens: list[str], low: str) -> bool:
    clean_tokens = [t.strip("\"'").lower() for t in tokens[1:]]
    if not clean_tokens or clean_tokens[0] in {"-c", "-"}:
        return False
    if clean_tokens[0] == "-m" and len(clean_tokens) >= MIN_MODULE_ARGS:
        return _is_read_only_python_module(tokens, clean_tokens, low)

    script_name = _cross_os_name(clean_tokens[0])
    if script_name == "xray_run.py" and len(clean_tokens) >= MIN_MODULE_ARGS:
        if clean_tokens[1] in {"-h", "--help"}:
            return True
        inner_name = _cross_os_name(clean_tokens[1])
        if inner_name in READ_ONLY_HEADS:
            return True
        return _is_read_only_script(inner_name, set(clean_tokens[2:]))
    return _is_read_only_script(script_name, set(clean_tokens[1:]))


def _first_positional_arg(
    tokens: list[str],
    value_flags: set[str],
) -> tuple[str, int, bool]:
    skip_next = False
    saw_version = False
    for idx, tok in enumerate(tokens):
        clean = tok.strip("\"'")
        low = clean.lower()
        if skip_next:
            skip_next = False
            continue
        if low in value_flags:
            skip_next = True
            continue
        if low in {"--version", "-v"}:
            saw_version = True
            continue
        if clean.startswith("-"):
            continue
        return low, idx, saw_version
    return "", -1, saw_version


def _is_read_only_docker_compose(tokens: list[str]) -> bool:
    sub, _, saw_version = _first_positional_arg(tokens, DOCKER_COMPOSE_VALUE_FLAGS)
    if not sub:
        return saw_version
    return sub in DOCKER_COMPOSE_READ_SUBCMDS


def _is_read_only_docker(tokens: list[str]) -> bool:
    sub, pos, saw_version = _first_positional_arg(tokens[1:], DOCKER_VALUE_FLAGS)
    if not sub:
        return saw_version
    if sub in DOCKER_READ_SUBCMDS:
        return True
    rest = tokens[pos + 2 :]
    if sub in {"volume", "network"}:
        sub2, _, _ = _first_positional_arg(rest, set())
        return sub2 in DOCKER_SUBOBJ_READ_SUBCMDS
    if sub == "compose":
        return _is_read_only_docker_compose(rest)
    return False


def _is_read_only_head(tokens: list[str], cleaned: str) -> bool:
    low = cleaned.lower()
    head_name = _cross_os_name(tokens[0]).lower()
    allowed = False
    if head_name in READ_ONLY_HEADS:
        allowed = True
    elif head_name in {"git", "git.exe"}:
        allowed = _git_subcommand(tokens) in GIT_READ_SUBCMDS
    elif head_name in {"docker", "docker.exe"}:
        allowed = _is_read_only_docker(tokens)
    elif head_name in {"docker-compose", "docker-compose.exe"}:
        allowed = _is_read_only_docker_compose(tokens[1:])
    elif head_name in {"ruff", "ruff.exe"}:
        allowed = _is_read_only_ruff(tokens, low)
    elif head_name in {"ast-grep", "ast-grep.exe", "sg", "sg.exe"}:
        allowed = "--update-all" not in low and " -u" not in f" {low} "
    elif head_name in {"python", "python3", "python.exe"}:
        allowed = _is_read_only_python(tokens, low)
    return allowed


def _skip_ps_single_quote(text: str, pos: int) -> int | None:
    idx = pos + 1
    n = len(text)
    while idx < n:
        if text[idx] == "'":
            if idx + 1 < n and text[idx + 1] == "'":
                idx += 2
                continue
            return idx + 1
        idx += 1
    return None


def _skip_ps_double_quote(text: str, pos: int) -> int | None:
    idx = pos + 1
    n = len(text)
    while idx < n:
        ch = text[idx]
        if ch == "`":
            idx += 2
            continue
        if ch == "$" and idx + 1 < n and text[idx + 1] == "(":
            extracted = _extract_balanced(text, idx + 1, "(", ")")
            if extracted is None:
                return None
            idx = extracted[1]
            continue
        if ch == '"':
            return idx + 1
        idx += 1
    return None


def _advance_ps_quote(text: str, idx: int) -> int | None:
    if text[idx] == "'":
        return _skip_ps_single_quote(text, idx)
    if text[idx] == '"':
        return _skip_ps_double_quote(text, idx)
    return idx + 1


def _extract_balanced(
    text: str,
    pos: int,
    open_ch: str,
    close_ch: str,
) -> tuple[str, int] | None:
    if pos >= len(text) or text[pos] != open_ch:
        return None
    pairs = {"(": ")", "{": "}"}
    stack: list[str] = [close_ch]
    idx = pos + 1
    n = len(text)
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return None
            idx = next_idx
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in {")", "}"}:
            if not stack or stack[-1] != ch:
                return None
            _ = stack.pop()
            if not stack:
                return text[pos + 1 : idx], idx + 1
        idx += 1
    return None


def _strip_outer_parens(text: str) -> str:
    cur = text.strip()
    while cur.startswith("(") and cur.endswith(")"):
        extracted = _extract_balanced(cur, 0, "(", ")")
        if extracted is None or extracted[1] != len(cur):
            break
        cur = extracted[0].strip()
    return cur


def _split_top_level_pipes(text: str) -> list[str] | None:
    parts: list[str] = []
    start = 0
    idx = 0
    n = len(text)
    stack: list[str] = []
    pairs = {"(": ")", "{": "}"}
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return None
            idx = next_idx
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in {")", "}"}:
            if not stack or stack[-1] != ch:
                return None
            _ = stack.pop()
        elif not stack and ch == "|":
            if idx + 1 < n and text[idx + 1] == "|":
                return None
            part = text[start:idx].strip()
            if not part:
                return None
            parts.append(part)
            start = idx + 1
        idx += 1
    if stack:
        return None
    tail = text[start:].strip()
    if not tail:
        return None
    parts.append(tail)
    return parts


def _split_top_level_items(
    text: str,
    *,
    allow_newlines: bool = True,
    handle_comments: bool = False,
) -> list[str] | None:
    parts: list[str] = []
    start = 0
    idx = 0
    n = len(text)
    stack: list[str] = []
    pairs = {"(": ")", "{": "}"}
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return None
            idx = next_idx
            continue
        if handle_comments and not stack and ch == "#" and (
            idx == 0 or text[idx - 1].isspace() or text[idx - 1] in {";", "{", "("}
        ):
            nl = text.find("\n", idx)
            if nl == -1:
                parts.append(text[start:idx].strip())
                return [p for p in parts if p]
            parts.append(text[start:idx].strip())
            start = nl + 1
            idx = nl + 1
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in {")", "}"}:
            if not stack or stack[-1] != ch:
                return None
            _ = stack.pop()
        elif not stack and (ch in {",", ";"} or (allow_newlines and ch in {"\r", "\n"})):
            parts.append(text[start:idx].strip())
            start = idx + 1
        idx += 1
    if stack:
        return None
    parts.append(text[start:].strip())
    return [p for p in parts if p]


def _match_stmt_sep(text: str, idx: int, last_non_ws: str) -> int:
    ch = text[idx]
    if ch in {";", "\r"}:
        return 1
    if ch == "\n":
        return 0 if last_non_ws == "|" else 1
    if text[idx : idx + 2] in {"&&", "||"}:
        return 2
    return 0


def _merge_continuation_clauses(raw_parts: list[str]) -> list[str]:
    merged: list[str] = []
    for part in raw_parts:
        if (
            merged
            and PS_CONTINUATION_RE.match(part)
            and PS_BLOCK_START_RE.match(merged[-1])
        ):
            merged[-1] = f"{merged[-1]} {part}"
        else:
            merged.append(part)
    return merged


def _split_top_level_statements(text: str) -> list[str] | None:
    parts: list[str] = []
    start = 0
    idx = 0
    n = len(text)
    stack: list[str] = []
    pairs = {"(": ")", "{": "}"}
    last_non_ws = ""
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return None
            last_non_ws = ch
            idx = next_idx
            continue
        if not stack and ch == "#" and (
            idx == 0 or text[idx - 1].isspace() or text[idx - 1] in {";", "{", "("}
        ):
            chunk = text[start:idx].strip()
            if chunk:
                parts.append(chunk)
            nl = text.find("\n", idx)
            if nl == -1:
                return _merge_continuation_clauses(parts)
            start = nl + 1
            idx = nl + 1
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in {")", "}"}:
            if not stack or stack[-1] != ch:
                return None
            _ = stack.pop()
        elif not stack:
            sep_len = _match_stmt_sep(text, idx, last_non_ws)
            if sep_len > 0:
                chunk = text[start:idx].strip()
                if chunk:
                    parts.append(chunk)
                start = idx + sep_len
                idx += sep_len
                if sep_len > 1 or ch != "\n":
                    last_non_ws = ""
                continue
        if not ch.isspace():
            last_non_ws = ch
        idx += 1
    if stack:
        return None
    tail = text[start:].strip()
    if tail:
        parts.append(tail)
    return _merge_continuation_clauses(parts)


def _validate_subexpressions(text: str, depth: int) -> bool:
    idx = 0
    n = len(text)
    in_dq = False
    while idx < n:
        ch = text[idx]
        if not in_dq and ch == "'":
            next_idx = _skip_ps_single_quote(text, idx)
            if next_idx is None:
                return False
            idx = next_idx
            continue
        if ch == "`" and in_dq:
            idx += 2
            continue
        if ch == '"':
            in_dq = not in_dq
            idx += 1
            continue
        if ch == "$" and idx + 1 < n and text[idx + 1] == "(":
            extracted = _extract_balanced(text, idx + 1, "(", ")")
            if extracted is None:
                return False
            inner, next_idx = extracted
            inner_clean = inner.strip()
            if not inner_clean:
                return False
            if not PS_SIMPLE_VAR_RE.match(inner_clean) and (
                depth >= MAX_PS_WRAPPER_DEPTH
                or not _is_read_only_ps_block(inner_clean, depth + 1)
            ):
                return False
            idx = next_idx
            continue
        idx += 1
    return not in_dq


def _is_safe_ps_scalar(expr: str, depth: int) -> bool:
    cur = expr.strip()
    if not cur:
        return False
    if cur.startswith("'") and cur.endswith("'"):
        return _skip_ps_single_quote(cur, 0) == len(cur)
    if cur.startswith('"') and cur.endswith('"'):
        if _skip_ps_double_quote(cur, 0) != len(cur):
            return False
        return _validate_subexpressions(cur, depth)
    if re.fullmatch(r"-?\d+(?:\.\d+)?", cur):
        return True
    if re.fullmatch(r"\d+\.\.\d+", cur):
        return True
    return bool(PS_SIMPLE_VAR_RE.match(cur))


def _is_safe_ps_array_literal(expr: str, depth: int) -> bool:
    cur = expr.strip()
    if not cur.startswith("@("):
        return False
    extracted = _extract_balanced(cur, 1, "(", ")")
    if extracted is None or extracted[1] != len(cur):
        return False
    inner = extracted[0].strip()
    if not inner:
        return True
    items = _split_top_level_items(inner, allow_newlines=True, handle_comments=True)
    if items is not None and items and all(
        _is_safe_ps_scalar(item, depth)
        or (depth < MAX_PS_WRAPPER_DEPTH and _is_safe_ps_array_literal(item, depth + 1))
        for item in items
    ):
        return True
    return depth < MAX_PS_WRAPPER_DEPTH and _is_read_only_ps_block(inner, depth + 1)


def _is_safe_ps_value_expr(expr: str, depth: int) -> bool:
    cur = _strip_outer_parens(expr)
    if not cur:
        return False
    if _is_safe_ps_scalar(cur, depth) or _is_safe_ps_array_literal(cur, depth):
        return True
    items = _split_top_level_items(cur, allow_newlines=False)
    if items is not None and len(items) > 1 and all(
        _is_safe_ps_scalar(item, depth) for item in items
    ):
        return True
    return _is_read_only_pipeline(cur, depth)


def _split_top_level_keyword(text: str, pattern: re.Pattern[str]) -> list[str] | None:
    parts: list[str] = []
    start = 0
    idx = 0
    n = len(text)
    stack: list[str] = []
    pairs = {"(": ")", "{": "}"}
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return None
            idx = next_idx
            continue
        if ch in pairs:
            stack.append(pairs[ch])
        elif ch in {")", "}"}:
            if not stack or stack[-1] != ch:
                return None
            _ = stack.pop()
        elif not stack:
            m = pattern.match(text, idx)
            if m is not None:
                parts.append(text[start:idx].strip())
                start = m.end()
                idx = m.end()
                continue
        idx += 1
    if stack:
        return None
    parts.append(text[start:].strip())
    return parts


_PS_BOOL_JOIN_RE = re.compile(r"\s+(?:-and|-or|-xor)\s+", re.IGNORECASE)
_PS_IN_OP_RE = re.compile(r"\s+in\s+", re.IGNORECASE)


def _tokenize_ps_simple(text: str) -> list[str] | None:
    tokens: list[str] = []
    idx = 0
    n = len(text)
    while idx < n:
        if text[idx].isspace():
            idx += 1
            continue
        if text[idx] in {"'", '"'}:
            end = _advance_ps_quote(text, idx)
            if end is None:
                return None
            tokens.append(text[idx:end])
            idx = end
            continue
        end = idx
        while end < n and not text[end].isspace():
            if text[end] in {"(", ")", "{", "}", ";", "|", "&", "'", '"'}:
                return None
            end += 1
        tokens.append(text[idx:end])
        idx = end
    return tokens


def _is_safe_ps_condition(cond: str, depth: int) -> bool:
    if depth > MAX_PS_WRAPPER_DEPTH:
        return False
    cur = _strip_outer_parens(cond)
    if not cur:
        return False
    if cur.startswith("!"):
        return _is_safe_ps_condition(cur[1:], depth)
    not_m = re.match(r"^-not\s+(.+)$", cur, re.IGNORECASE | re.DOTALL)
    if not_m is not None:
        return _is_safe_ps_condition(not_m.group(1), depth)

    parts = _split_top_level_keyword(cur, _PS_BOOL_JOIN_RE)
    if parts is None:
        return False
    if len(parts) > 1:
        return all(p and _is_safe_ps_condition(p, depth) for p in parts)

    tokens = _tokenize_ps_simple(cur)
    if tokens is not None and len(tokens) >= MIN_COND_TOKENS:
        has_operand = False
        all_safe = True
        for tok in tokens:
            if "::" in tok:
                all_safe = False
                break
            if tok.lower() in PS_COMP_OPS:
                continue
            if _is_safe_ps_scalar(tok, depth):
                has_operand = True
                continue
            all_safe = False
            break
        if all_safe and has_operand:
            return True

    return _is_read_only_pipeline(cur, depth)


def _is_read_only_foreach_object(stage: str, depth: int) -> bool:
    if depth >= MAX_PS_WRAPPER_DEPTH:
        return False
    m = re.match(r"^(?:foreach-object|foreach)\b\s*(.*)$", stage, re.IGNORECASE | re.DOTALL)
    if m is None:
        return False
    rest = m.group(1).strip()
    if not rest:
        return False
    idx = 0
    n = len(rest)
    blocks: list[str] = []
    while idx < n:
        while idx < n and rest[idx].isspace():
            idx += 1
        if idx >= n:
            break
        flag_m = re.match(r"^-(?:Begin|Process|End)\b\s*", rest[idx:], re.IGNORECASE)
        if flag_m is not None:
            idx += flag_m.end()
            continue
        extracted = _extract_balanced(rest, idx, "{", "}")
        if extracted is None:
            return False
        blocks.append(extracted[0])
        idx = extracted[1]
    return bool(blocks) and all(
        _is_read_only_ps_block(blk, depth + 1) for blk in blocks
    )


def _is_read_only_where_object(stage: str, depth: int) -> bool:
    m = re.match(r"^(?:where-object|\?)\b\s*(.*)$", stage, re.IGNORECASE | re.DOTALL)
    if m is None:
        return False
    rest = m.group(1).strip()
    if not rest:
        return False
    if "{" not in rest:
        return _is_read_only_single_segment(stage)
    idx = 0
    flag_m = re.match(r"^-FilterScript\b\s*", rest, re.IGNORECASE)
    if flag_m is not None:
        idx = flag_m.end()
    extracted = _extract_balanced(rest, idx, "{", "}")
    if extracted is None or rest[extracted[1] :].strip():
        return False
    return _is_safe_ps_condition(extracted[0], depth + 1)


def _has_unquoted_shell_ops(text: str) -> bool:
    idx = 0
    n = len(text)
    while idx < n:
        ch = text[idx]
        if ch in {"'", '"'}:
            next_idx = _advance_ps_quote(text, idx)
            if next_idx is None:
                return True
            idx = next_idx
            continue
        if ch in {"&", ">"}:
            return True
        idx += 1
    return False


def _is_read_only_single_segment(seg: str) -> bool:
    cleaned = STDERR_REDIR_RE.sub("", seg)
    if MUTATION_HINT_RE.search(cleaned):
        return False
    if _has_unquoted_shell_ops(cleaned):
        return False
    if not _validate_subexpressions(cleaned, 0):
        return False
    try:
        tokens = shlex.split(cleaned, posix=False)
    except ValueError:
        tokens = cleaned.split()
    if not tokens:
        return True
    return _is_read_only_head(tokens, cleaned)


def is_read_only_segment(seg: str) -> bool:
    cleaned = STDERR_REDIR_RE.sub("", seg)
    if MUTATION_HINT_RE.search(cleaned):
        return False
    stages = _split_top_level_pipes(cleaned)
    if stages is None:
        return False
    for idx, stage in enumerate(stages):
        if len(stages) > 1 and idx == 0 and _is_safe_ps_scalar(stage, 0):
            continue
        if re.match(r"^(?:where-object|\?)\b", stage, re.IGNORECASE):
            if not _is_read_only_where_object(stage, 0):
                return False
            continue
        if not _is_read_only_single_segment(stage):
            return False
    return True


def _is_read_only_pipeline(stmt: str, depth: int) -> bool:
    stages = _split_top_level_pipes(stmt)
    if stages is None:
        return False
    for idx, stage in enumerate(stages):
        if len(stages) > 1 and idx == 0 and (
            _is_safe_ps_scalar(stage, depth)
            or _is_safe_ps_array_literal(stage, depth)
        ):
            continue
        if re.match(r"^(?:foreach-object|foreach)\b", stage, re.IGNORECASE):
            if not _is_read_only_foreach_object(stage, depth):
                return False
            continue
        if re.match(r"^(?:where-object|\?)\b", stage, re.IGNORECASE):
            if not _is_read_only_where_object(stage, depth):
                return False
            continue
        if not _is_read_only_single_segment(stage):
            return False
    return True


def _is_read_only_foreach(stmt: str, depth: int) -> bool:
    if depth >= MAX_PS_WRAPPER_DEPTH:
        return False
    m = re.match(r"^foreach\b\s*", stmt, re.IGNORECASE)
    if m is None:
        return False
    header_ext = _extract_balanced(stmt, m.end(), "(", ")")
    if header_ext is None:
        return False
    header, idx = header_ext
    while idx < len(stmt) and stmt[idx].isspace():
        idx += 1
    body_ext = _extract_balanced(stmt, idx, "{", "}")
    if body_ext is None or stmt[body_ext[1] :].strip():
        return False
    parts = _split_top_level_keyword(header.strip(), _PS_IN_OP_RE)
    if parts is None or len(parts) != MIN_MODULE_ARGS:
        return False
    var_part, iter_part = parts
    if not re.fullmatch(r"\$[A-Za-z_][A-Za-z0-9_]*", var_part):
        return False
    if not _is_safe_ps_value_expr(iter_part, depth):
        return False
    return _is_read_only_ps_block(body_ext[0], depth + 1)


def _is_read_only_try(stmt: str, depth: int) -> bool:
    if depth >= MAX_PS_WRAPPER_DEPTH:
        return False
    m = re.match(r"^try\b\s*", stmt, re.IGNORECASE)
    if m is None:
        return False
    try_ext = _extract_balanced(stmt, m.end(), "{", "}")
    if try_ext is None:
        return False
    blocks = [try_ext[0]]
    idx = try_ext[1]
    n = len(stmt)
    while idx < n:
        while idx < n and stmt[idx].isspace():
            idx += 1
        if idx >= n:
            break
        catch_m = re.match(r"^catch\b\s*(?:\[[A-Za-z0-9_.]+\]\s*)?", stmt[idx:], re.IGNORECASE)
        if catch_m is not None:
            blk_ext = _extract_balanced(stmt, idx + catch_m.end(), "{", "}")
            if blk_ext is None:
                return False
            blocks.append(blk_ext[0])
            idx = blk_ext[1]
            continue
        fin_m = re.match(r"^finally\b\s*", stmt[idx:], re.IGNORECASE)
        if fin_m is not None:
            blk_ext = _extract_balanced(stmt, idx + fin_m.end(), "{", "}")
            if blk_ext is None or stmt[blk_ext[1] :].strip():
                return False
            blocks.append(blk_ext[0])
            idx = blk_ext[1]
            break
        return False
    return all(_is_read_only_ps_block(blk, depth + 1) for blk in blocks)


def _is_read_only_if(stmt: str, depth: int) -> bool:
    if depth >= MAX_PS_WRAPPER_DEPTH:
        return False
    m = re.match(r"^if\b\s*", stmt, re.IGNORECASE)
    if m is None:
        return False
    cond_ext = _extract_balanced(stmt, m.end(), "(", ")")
    if cond_ext is None:
        return False
    idx = cond_ext[1]
    while idx < len(stmt) and stmt[idx].isspace():
        idx += 1
    body_ext = _extract_balanced(stmt, idx, "{", "}")
    if body_ext is None:
        return False
    if not _is_safe_ps_condition(cond_ext[0], depth + 1):
        return False
    if not _is_read_only_ps_block(body_ext[0], depth + 1):
        return False

    idx = body_ext[1]
    n = len(stmt)
    while idx < n:
        while idx < n and stmt[idx].isspace():
            idx += 1
        if idx >= n:
            break
        elif_m = re.match(r"^elseif\b\s*", stmt[idx:], re.IGNORECASE)
        if elif_m is not None:
            econd_ext = _extract_balanced(stmt, idx + elif_m.end(), "(", ")")
            if econd_ext is None:
                return False
            eidx = econd_ext[1]
            while eidx < n and stmt[eidx].isspace():
                eidx += 1
            ebody_ext = _extract_balanced(stmt, eidx, "{", "}")
            if ebody_ext is None:
                return False
            if not _is_safe_ps_condition(econd_ext[0], depth + 1):
                return False
            if not _is_read_only_ps_block(ebody_ext[0], depth + 1):
                return False
            idx = ebody_ext[1]
            continue
        else_m = re.match(r"^else\b\s*", stmt[idx:], re.IGNORECASE)
        if else_m is not None:
            ebody_ext = _extract_balanced(stmt, idx + else_m.end(), "{", "}")
            if ebody_ext is None or stmt[ebody_ext[1] :].strip():
                return False
            return _is_read_only_ps_block(ebody_ext[0], depth + 1)
        return False
    return True


def _is_read_only_ps_statement(stmt: str, depth: int) -> bool:
    if not _validate_subexpressions(stmt, depth):
        return False
    if re.match(r"^foreach\b\s*\(", stmt, re.IGNORECASE):
        return _is_read_only_foreach(stmt, depth)
    if re.match(r"^try\b\s*\{", stmt, re.IGNORECASE):
        return _is_read_only_try(stmt, depth)
    if re.match(r"^if\b\s*\(", stmt, re.IGNORECASE):
        return _is_read_only_if(stmt, depth)
    assign_m = PS_ASSIGN_RE.match(stmt)
    if assign_m is not None:
        rhs = assign_m.group(2).strip()
        if not rhs or rhs.startswith("="):
            return False
        return _is_safe_ps_value_expr(rhs, depth)
    return _is_read_only_pipeline(stmt, depth)


def _is_read_only_ps_block(body: str, depth: int) -> bool:
    if depth > MAX_PS_WRAPPER_DEPTH:
        return False
    if not body.strip():
        return True
    stmts = _split_top_level_statements(body)
    if stmts is None:
        return False
    return all(_is_read_only_ps_statement(stmt, depth) for stmt in stmts)


def is_read_only_command(cmd: str) -> bool:
    if not cmd.strip():
        return True
    cleaned = STDERR_REDIR_RE.sub("", cmd)
    if MUTATION_HINT_RE.search(cleaned):
        return False
    return _is_read_only_ps_block(cleaned, 0)


def find_explicit_build_targets(seg: str, cwd: Path) -> list[Path]:
    targets: list[Path] = []
    try:
        tokens = shlex.split(seg, posix=False)
    except ValueError:
        tokens = seg.split()
    for tok in tokens:
        clean = tok.strip("\"'")
        if clean.lower().endswith((".slnx", ".sln", ".csproj")):
            p = Path(clean)
            if not p.is_absolute():
                p = cwd / p
            if p.exists():
                targets.append(p.resolve())
    if not targets:
        slnx = list(cwd.glob("*.slnx")) + list(cwd.glob("*.sln"))
        if slnx:
            targets.append(slnx[0].resolve())
        else:
            csprojs = list(cwd.glob("*.csproj"))
            if csprojs:
                targets.append(csprojs[0].resolve())
    return targets


def projects_from_solution(sln_path: Path) -> list[Path]:
    projects: list[Path] = []
    try:
        text = sln_path.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return projects
    if sln_path.suffix.lower() == ".slnx":
        try:
            root = ET.fromstring(text)
            for elem in root.iter():
                if elem.tag.endswith("Project"):
                    rel = elem.attrib.get("Path", "")
                    if rel:
                        p = (sln_path.parent / rel.replace("\\", "/")).resolve()
                        if p.is_file():
                            projects.append(p)
        except ET.ParseError:
            pass
    else:
        for m in re.finditer(r'"([^"]+\.csproj)"', text, re.IGNORECASE):
            p = (sln_path.parent / m.group(1).replace("\\", "/")).resolve()
            if p.is_file():
                projects.append(p)
    return projects


def collect_build_own_modules(
    build_targets: list[Path],
    cwd: Path,
) -> list[ModuleTarget]:
    mods: dict[str, ModuleTarget] = {}
    for bt in build_targets:
        m = resolve_module_target(bt, cwd)
        if m:
            mods[m.key] = m
        if bt.suffix.lower() in (".slnx", ".sln"):
            for proj in projects_from_solution(bt):
                pm = resolve_module_target(proj, cwd)
                if pm:
                    mods[pm.key] = pm
    if not mods:
        cm = resolve_module_target(cwd)
        if cm:
            mods[cm.key] = cm
    return list(mods.values())


def _extract_project_references(proj: Path) -> list[Path]:
    try:
        tree = ET.parse(proj)
    except (ET.ParseError, OSError):
        return []
    refs: list[Path] = []
    for elem in tree.iter():
        if not elem.tag.endswith("ProjectReference"):
            continue
        inc = elem.attrib.get("Include", "")
        if inc:
            refs.append((proj.parent / inc.replace("\\", "/")).resolve(strict=False))
    return refs


def collect_external_shared_dependencies(
    build_targets: list[Path],
    own_keys: set[str],
) -> tuple[list[ModuleTarget], list[Path]]:
    csprojs: list[Path] = []
    for t in build_targets:
        if t.suffix.lower() == ".csproj":
            csprojs.append(t)
        elif t.suffix.lower() in (".slnx", ".sln"):
            csprojs.extend(projects_from_solution(t))

    seen_proj: set[Path] = set()
    queue: deque[Path] = deque(csprojs)
    shared_mods: dict[str, ModuleTarget] = {}
    dll_candidates: list[Path] = []

    ws_cfg = get_workspace_config()
    while queue:
        proj = queue.popleft()
        if proj in seen_proj or not proj.is_file():
            continue
        seen_proj.add(proj)
        for ref_path in _extract_project_references(proj):
            mod = resolve_module_target(ref_path)
            if mod and mod.is_shared and mod.key not in own_keys:
                shared_mods[mod.key] = mod
                for check_key, dll_rel in ws_cfg.os_lock_checks:
                    if mod.key.lower() == check_key.lower():
                        base_dir = (
                            mod.root.parent.parent
                            if mod.root.parent.name.lower() == "src"
                            else mod.root
                        )
                        dll_candidates.append(
                            base_dir / dll_rel.replace("\\", "/")
                        )
            if ref_path.is_file() and ref_path not in seen_proj:
                queue.append(ref_path)

    return list(shared_mods.values()), dll_candidates


def collect_mutating_module_targets(seg: str, cwd: Path) -> list[ModuleTarget]:
    found: dict[str, ModuleTarget] = {}
    cwd_mod = resolve_module_target(cwd)
    if cwd_mod:
        found[cwd_mod.key] = cwd_mod

    ignored_frags = get_workspace_config().ignored_script_fragments
    for m in ABS_PATH_RE.finditer(seg):
        raw_p = m.group(0).rstrip(".,:)'\"")
        norm_p = raw_p.replace("\\", "/").lower()
        if any(frag in norm_p for frag in ignored_frags):
            continue
        mod = resolve_module_target(raw_p, cwd)
        if mod:
            found[mod.key] = mod
    return list(found.values())
