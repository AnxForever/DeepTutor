"""Bounded, loss-refusing text preparation for device-local task read-aloud.

This is deliberately separate from the general TTS cleanup layer: a task may
not sound complete after its table, code, image or unknown maths was removed.
Only elementary arithmetic is verbalized; everything else either remains
ordinary prose or makes the entire question unavailable for read-aloud. No
model, provider, filesystem or synthesis operation belongs in this module.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal
import unicodedata

TaskSpeechLocale = Literal["en", "zh"]
TaskSpeechReason = Literal[
    "invalid_input",
    "invalid_locale",
    "invalid_unicode",
    "too_long",
    "unsupported_content",
    "unsupported_math",
    "malformed_markup",
    "no_text",
]

MAX_RAW_CHARS = 6000
MAX_SPOKEN_CHARS = 6000
MAX_GROUP_DEPTH = 12


class TaskSpeechUnsupported(ValueError):
    """A stable refusal code; the original text question is still usable."""

    def __init__(self, reason: TaskSpeechReason) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True, slots=True)
class TaskSpeechText:
    text: str
    locale: TaskSpeechLocale


@dataclass(frozen=True, slots=True)
class _Piece:
    text: str
    simple: bool = True
    grouped: bool = False
    literal: str | None = None


@dataclass(frozen=True, slots=True)
class _Token:
    kind: str
    value: str
    start: int
    end: int


class _MathSyntax(ValueError):
    pass


_WORDS = {
    "en": {
        "+": "plus",
        "-": "minus",
        "*": "times",
        "/": "over",
        "÷": "divided by",
        "=": "equals",
        "<": "less than",
        ">": "greater than",
        "≤": "less than or equal to",
        "≥": "greater than or equal to",
        "≠": "not equal to",
        "negative": "negative ",
        "positive": "positive ",
        "open": "open parenthesis",
        "close": "close parenthesis",
        "2": "squared",
        "3": "cubed",
        "?": "question mark",
        "blank": "blank",
    },
    "zh": {
        "+": "加",
        "-": "减",
        "*": "乘",
        "/": "分之",
        "÷": "除以",
        "=": "等于",
        "<": "小于",
        ">": "大于",
        "≤": "小于或等于",
        "≥": "大于或等于",
        "≠": "不等于",
        "negative": "负",
        "positive": "正",
        "open": "左括号",
        "close": "右括号",
        "2": "的平方",
        "3": "的立方",
        "?": "问号",
        "blank": "空格",
    },
}

_SYMBOLS = {
    "−": "-",
    "×": "*",
    "·": "*",
    "⋅": "*",
    "＋": "+",
    "－": "-",
    "＝": "=",
    "？": "?",
    "（": "(",
    "）": ")",
    **{chr(ord("０") + i): str(i) for i in range(10)},
}
_TRANSLATE_MATH = str.maketrans(_SYMBOLS)
_NUMBER = re.compile(r"(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)")
_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_COMMAND = re.compile(r"\\([A-Za-z]+)")
_SPACE_COMMANDS = frozenset({"quad", "qquad"})
_BINARY_COMMANDS = {"times": "*", "cdot": "*", "div": "÷"}
_FRACTION_COMMANDS = frozenset({"frac", "dfrac", "tfrac"})
_RELATIONS = frozenset({"=", "<", ">", "≤", "≥", "≠"})
_SUPPORTED_SYMBOLS = frozenset("+-−×÷=*<>≤≥≠·⋅＋－＝")
_OTHER_NUMBER_MATH = frozenset("¼½¾⅐⅑⅒⅓⅔⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞⁰¹⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉")

# These are prose, not fractions or subtraction. Preserve the complete token.
# Two-part dates need an explicit date label: an unlabelled 1/4 is otherwise
# indistinguishable from the elementary fraction this feature must support.
_PROTECTED = re.compile(
    r"(?:https?://|www\.)[^\s<>，。；！？、]+"
    r"|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}"
    r"|(?<![A-Za-z0-9_])(?:[A-Za-z]:[\\/]|\\\\)[^\s<>，。；！？、]+"
    r"|(?<![A-Za-z0-9_])(?:\.{0,2}/|[A-Za-z_][A-Za-z0-9_.\-]*/)[^\s<>()\[\]{}，。；！？、]+"
    r"|(?<![A-Za-z0-9_])(?:\d{4}[/\-−‐‑–]\d{1,2}[/\-−‐‑–]\d{1,2}"
    r"|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2})(?![0-9/\-])"
    r"|(?:\b[Dd]ate(?:d| is)?|日期(?:为|是)?)\s*[:：]?\s*[0-9]{1,2}/[0-9]{1,2}(?![0-9/])"
    r"|(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+(?![A-Za-z0-9_])"
)
_MATH_START = re.compile(r"[0-9０-９A-Za-z_(（?？□]|\.(?=[0-9])|[+\-−](?=\s*[0-9])")
_HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*|\s*)/?>")
_HTML_ENTITY = re.compile(r"&(?:#[xX]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);")
_MATH_REMNANTS = frozenset("+*/÷×·⋅=<>≤≥≠^²³{}＋＝")


def _bounded(text: str) -> str:
    if len(text) > MAX_SPOKEN_CHARS:
        raise TaskSpeechUnsupported("too_long")
    return text


def _joined(*parts: str) -> str:
    return _bounded(" ".join(part for part in parts if part))


class _Arithmetic:
    """A small iterative-expression parser with bounded recursive groups."""

    def __init__(self, source: str, locale: TaskSpeechLocale, *, explicit: bool) -> None:
        self.source = source.translate(_TRANSLATE_MATH)
        self.words = _WORDS[locale]
        self.locale = locale
        self.explicit = explicit
        self.offset = 0
        self.end = 0
        self.depth = 0
        self.saw_math = False

    def _peek(self) -> _Token:
        pos = self.offset
        while pos < len(self.source):
            if self.source[pos].isspace():
                pos += 1
                continue
            if self.source.startswith((r"\,", r"\;", r"\!", "\\ "), pos):
                pos += 2
                continue
            command = _COMMAND.match(self.source, pos)
            if command and command.group(1) in _SPACE_COMMANDS:
                pos = command.end()
                continue
            if command and command.group(1) in {"left", "right"}:
                after = command.end()
                while after < len(self.source) and self.source[after].isspace():
                    after += 1
                expected = "(" if command.group(1) == "left" else ")"
                if after >= len(self.source) or self.source[after] != expected:
                    raise _MathSyntax
                pos = after
            break
        if pos >= len(self.source):
            return _Token("end", "", pos, pos)
        char = self.source[pos]
        number = _NUMBER.match(self.source, pos)
        if number:
            return _Token("literal", number.group(), pos, number.end())
        if char == "_":
            blank = re.match(r"_{2,}(?![A-Za-z0-9_])", self.source[pos:])
            if blank:
                return _Token("blank", "blank", pos, pos + blank.end())
        name = _IDENTIFIER.match(self.source, pos)
        if name:
            if self.explicit and "_" in name.group():
                raise _MathSyntax
            return _Token("literal", name.group(), pos, name.end())
        command = _COMMAND.match(self.source, pos)
        if command:
            name = command.group(1)
            if name in _FRACTION_COMMANDS:
                return _Token("fraction", name, pos, command.end())
            if name in _BINARY_COMMANDS:
                return _Token("operator", _BINARY_COMMANDS[name], pos, command.end())
            raise _MathSyntax
        if char in "+-*/÷=<>≤≥≠":
            return _Token("operator", char, pos, pos + 1)
        if char in "(){}^":
            return _Token(char, char, pos, pos + 1)
        if char in "²³":
            return _Token("power", "2" if char == "²" else "3", pos, pos + 1)
        if char in "?□":
            return _Token("blank" if char == "□" else "question", char, pos, pos + 1)
        return _Token("stop", char, pos, pos + 1)

    def _take(self) -> _Token:
        token = self._peek()
        self.offset = token.end
        self.end = token.end
        return token

    def _accept(self, values: frozenset[str] | set[str]) -> _Token | None:
        token = self._peek()
        if token.kind == "operator" and token.value in values:
            self.saw_math = True
            return self._take()
        return None

    def _group(self, opener: str, *, argument: bool = False) -> _Piece:
        if self._take().kind != opener:
            raise _MathSyntax
        self.depth += 1
        if self.depth > MAX_GROUP_DEPTH:
            raise _MathSyntax
        piece = self._relation()
        closer = ")" if opener == "(" else "}"
        if self._take().kind != closer:
            raise _MathSyntax
        self.depth -= 1
        if argument:
            return piece
        return _Piece(
            _joined(self.words["open"], piece.text, self.words["close"]),
            simple=False,
            grouped=True,
            literal=piece.literal,
        )

    def _operand(self, piece: _Piece) -> str:
        if piece.simple or piece.grouped:
            return piece.text
        return _joined(self.words["open"], piece.text, self.words["close"])

    def _fraction(self, numerator: _Piece, denominator: _Piece) -> _Piece:
        top, bottom = self._operand(numerator), self._operand(denominator)
        if self.locale == "zh":
            # Keep simple fractions as the natural denominator-first unit.
            if denominator.simple and numerator.simple:
                spoken = _bounded(bottom + self.words["/"] + top)
            else:
                spoken = _joined(bottom, self.words["/"], top)
        else:
            spoken = _joined(top, self.words["/"], bottom)
        return _Piece(spoken, simple=False)

    def _atom(self) -> _Piece:
        token = self._peek()
        if token.kind == "literal":
            self._take()
            return _Piece(token.value, literal=token.value)
        if token.kind in {"question", "blank"}:
            self._take()
            if token.kind == "blank":
                self.saw_math = True
            return _Piece(self.words["?"] if token.kind == "question" else self.words["blank"])
        if token.kind in {"(", "{"}:
            return self._group(token.kind)
        if token.kind == "fraction":
            self.saw_math = True
            self._take()
            if self._peek().kind != "{":
                raise _MathSyntax
            numerator = self._group("{", argument=True)
            if self._peek().kind != "{":
                raise _MathSyntax
            return self._fraction(numerator, self._group("{", argument=True))
        raise _MathSyntax

    def _power(self) -> _Piece:
        piece = self._atom()
        token = self._peek()
        if token.kind not in {"^", "power"}:
            return piece
        self.saw_math = True
        self._take()
        if token.kind == "power":
            exponent = token.value
        elif self._peek().kind == "{":
            exponent = self._group("{", argument=True).literal
        else:
            exponent = self._take().value
        if exponent not in {"2", "3"}:
            raise _MathSyntax
        return _Piece(_joined(self._operand(piece), self.words[exponent]), simple=False)

    def _signed(self) -> _Piece:
        token = self._peek()
        if token.kind != "operator" or token.value not in {"+", "-"}:
            return self._power()
        self.saw_math = True
        self._take()
        # A repeated sign is outside this elementary subset, and must not
        # create recursion proportional to untrusted input length.
        piece = self._power()
        sign = self.words["negative" if token.value == "-" else "positive"]
        return _Piece(_bounded(sign + self._operand(piece)), simple=piece.simple)

    def _product(self) -> _Piece:
        piece = self._signed()
        while token := self._accept({"*", "/", "÷"}):
            right = self._signed()
            if token.value == "/":
                piece = self._fraction(piece, right)
            else:
                piece = _Piece(
                    _joined(piece.text, self.words[token.value], right.text), simple=False
                )
        return piece

    def _sum(self) -> _Piece:
        piece = self._product()
        while token := self._accept({"+", "-"}):
            piece = _Piece(
                _joined(piece.text, self.words[token.value], self._product().text), simple=False
            )
        return piece

    def _relation(self) -> _Piece:
        piece = self._sum()
        while token := self._accept(_RELATIONS):
            piece = _Piece(
                _joined(piece.text, self.words[token.value], self._sum().text), simple=False
            )
        return piece

    def parse(self) -> _Piece:
        piece = self._relation()
        if self.explicit and self._peek().kind != "end":
            raise _MathSyntax
        return piece


def _balanced_end(text: str, start: int, opener: str, closer: str) -> int:
    depth = 0
    pos = start
    while pos < len(text):
        char = text[pos]
        if char == "\\":
            pos += 2
            continue
        if char == opener:
            depth += 1
            if depth > MAX_GROUP_DEPTH:
                raise TaskSpeechUnsupported("malformed_markup")
        elif char == closer:
            depth -= 1
            if depth == 0:
                return pos
        pos += 1
    raise TaskSpeechUnsupported("malformed_markup")


def _unwrap_links(text: str) -> str:
    out: list[str] = []
    pos = 0
    while pos < len(text):
        protected = _PROTECTED.match(text, pos)
        if protected:
            out.append(protected.group())
            pos = protected.end()
            continue
        if text[pos] != "[" or (pos > 0 and text[pos - 1] == "\\"):
            out.append(text[pos])
            pos += 1
            continue
        end = _balanced_end(text, pos, "[", "]")
        if end + 1 >= len(text) or text[end + 1] != "(":
            out.append(text[pos : end + 1])
            pos = end + 1
            continue
        destination_end = _balanced_end(text, end + 1, "(", ")")
        label = text[pos + 1 : end]
        destination = text[end + 2 : destination_end].strip()
        if not label.strip() or not destination or "](" in label:
            raise TaskSpeechUnsupported("malformed_markup")
        if any(char.isspace() or char in "\"'" for char in destination):
            raise TaskSpeechUnsupported("unsupported_content")
        out.append(label)
        pos = destination_end + 1
    return "".join(out)


def _protect_math_markup(text: str) -> tuple[str, list[str]]:
    """Do not let Markdown emphasis or links rewrite a math island."""
    out: list[str] = []
    retained: list[str] = []
    pos = 0
    while pos < len(text):
        protected = _PROTECTED.match(text, pos)
        if protected:
            out.append(protected.group())
            pos = protected.end()
            continue
        if text.startswith(r"\$", pos):
            out.append(r"\$")
            pos += 2
            continue
        opener = next(
            (value for value in ("$$", "$", r"\(", r"\[") if text.startswith(value, pos)), None
        )
        if opener:
            closer = {"$$": "$$", "$": "$", r"\(": r"\)", r"\[": r"\]"}[opener]
            end = _math_end(text, pos + len(opener), closer) + len(closer)
            retained.append(text[pos:end])
            out.append(f"\ue100{len(retained) - 1}\ue101")
            pos = end
            continue
        out.append(text[pos])
        pos += 1
    return "".join(out), retained


def _unwrap_markdown(text: str) -> str:
    if (
        "`" in text
        or "~~~" in text
        or "|" in text
        or re.search(r"!\s*\[", text)
        or re.search(r"(?m)^(?: {4}|\t)\S", text)
        or re.search(r"(?m)^\s{0,3}[-+*]\s+\S", text)
        or re.search(r"(?m)^\s*\[[^\]\n]+\]:", text)
    ):
        raise TaskSpeechUnsupported("unsupported_content")
    # Autolinks are visible text, unlike HTML tags with hidden semantics.
    text = re.sub(r"<(https?://[^<>\s]+)>", r"\1", text)
    if _HTML_TAG.search(text) or _HTML_ENTITY.search(text):
        raise TaskSpeechUnsupported("unsupported_content")
    text, math_islands = _protect_math_markup(text)
    text = _unwrap_links(text)
    text = re.sub(r"(?m)^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$", r"\1", text)

    # Markdown-looking characters inside a URL/path are literal characters.
    # Input private-use characters are refused, so these local markers cannot
    # collide with text supplied by a caller.
    protected: list[str] = []

    def retain(match: re.Match[str]) -> str:
        protected.append(match.group())
        return f"\ue000{len(protected) - 1}\ue001"

    text = _PROTECTED.sub(retain, text)
    for _ in range(MAX_GROUP_DEPTH):
        changed = re.sub(
            r"(?<![A-Za-z0-9_\\])\*\*(?=\S)(.+?)(?<=\S)\*\*(?![A-Za-z0-9_])",
            r"\1",
            text,
        )
        changed = re.sub(r"(?<![A-Za-z0-9_\\])_(?!_)([^_\n]+)_(?![A-Za-z0-9_])", r"\1", changed)
        changed = re.sub(
            r"(?<![A-Za-z0-9_\\*])\*(?![\s*])([^*\n]+)(?<!\s)\*(?![A-Za-z0-9_*])",
            r"\1",
            changed,
        )
        if changed == text:
            break
        text = changed
    for index, value in enumerate(protected):
        text = text.replace(f"\ue000{index}\ue001", value)
    for index, value in enumerate(math_islands):
        text = text.replace(f"\ue100{index}\ue101", value)
    return text


def _prepare_plain(text: str, locale: TaskSpeechLocale) -> str:
    # Function calls are not in the elementary subset. In plain prose a
    # spaced parenthetical phrase remains untouched, unlike sin(x) or f(x).
    if re.search(r"\b[A-Za-z_][A-Za-z0-9_]*\(|\b(?:sqrt|sin|cos|tan|log|ln)\s+\(", text):
        raise TaskSpeechUnsupported("unsupported_math")
    for char in text:
        if (
            (unicodedata.category(char) == "Sm" and char not in _SUPPORTED_SYMBOLS)
            or char in _OTHER_NUMBER_MATH
            or "\u0370" <= char <= "\u03ff"
        ):
            raise TaskSpeechUnsupported("unsupported_math")
        if unicodedata.category(char) == "So" and char != "□":
            raise TaskSpeechUnsupported("unsupported_content")
    out: list[str] = []
    pos = 0
    while pos < len(text):
        match = _MATH_START.search(text, pos)
        if match is None:
            tail = text[pos:]
            if any(char in _MATH_REMNANTS for char in tail):
                raise TaskSpeechUnsupported("unsupported_math")
            out.append(tail)
            break
        between = text[pos : match.start()]
        if any(char in _MATH_REMNANTS for char in between):
            raise TaskSpeechUnsupported("unsupported_math")
        out.append(between)
        parser = _Arithmetic(text[match.start() :], locale, explicit=False)
        try:
            piece = parser.parse()
        except _MathSyntax:
            if parser.saw_math:
                raise TaskSpeechUnsupported("unsupported_math") from None
            # A parenthetical prose phrase is not an arithmetic expression.
            out.append(text[match.start()])
            pos = match.start() + 1
            continue
        raw = text[match.start() : match.start() + parser.end]
        out.append(piece.text if parser.saw_math else raw)
        pos = match.start() + parser.end
    return _bounded("".join(out))


def _math_end(text: str, start: int, closer: str) -> int:
    pos = start
    while pos < len(text):
        if text.startswith(closer, pos):
            return pos
        if text[pos] == "\\":
            pos += 2
        else:
            pos += 1
    raise TaskSpeechUnsupported("malformed_markup")


def _prepare_segments(text: str, locale: TaskSpeechLocale) -> str:
    protected = {match.start(): match for match in _PROTECTED.finditer(text)}
    out: list[str] = []
    plain: list[str] = []
    pos = 0

    def flush() -> None:
        if plain:
            out.append(_prepare_plain("".join(plain), locale))
            plain.clear()

    while pos < len(text):
        if pos in protected:
            flush()
            match = protected[pos]
            out.append(match.group())
            pos = match.end()
            continue
        opener = next(
            (value for value in ("$$", "$", r"\(", r"\[") if text.startswith(value, pos)), None
        )
        if opener:
            flush()
            closer = {"$$": "$$", "$": "$", r"\(": r"\)", r"\[": r"\]"}[opener]
            end = _math_end(text, pos + len(opener), closer)
            try:
                piece = _Arithmetic(text[pos + len(opener) : end], locale, explicit=True).parse()
            except _MathSyntax:
                raise TaskSpeechUnsupported("unsupported_math") from None
            if (
                out
                and out[-1]
                and (out[-1][-1].isalnum() or out[-1][-1] == "_")
                and (piece.text[0].isalnum() or piece.text[0] == ".")
            ):
                out.append(" ")
            out.append(piece.text)
            pos = end + len(closer)
            if pos < len(text) and text[pos].isalnum() and piece.text[-1].isalnum():
                out.append(" ")
            continue
        if text[pos] == "\\":
            if pos + 1 < len(text) and text[pos + 1] in "$*_#[]%!":
                flush()
                out.append(text[pos + 1])
                pos += 2
                continue
            raise TaskSpeechUnsupported("unsupported_math")
        plain.append(text[pos])
        pos += 1
    flush()
    return _bounded("".join(out))


def prepare_task_speech(question: str, locale: TaskSpeechLocale) -> TaskSpeechText:
    """Prepare a complete supported task, or refuse with a stable reason.

    Prose is not translated. Slash-containing URLs/paths and recognizable
    dates are protected; arithmetic words are introduced only by parsed
    elementary expressions. Fractions have denominator-first Chinese order.
    Any length overflow or unsupported content refuses the whole question.
    """
    if not isinstance(question, str):
        raise TaskSpeechUnsupported("invalid_input")
    if not isinstance(locale, str) or locale not in {"en", "zh"}:
        raise TaskSpeechUnsupported("invalid_locale")
    try:
        question.encode("utf-8", errors="strict")
    except UnicodeError:
        raise TaskSpeechUnsupported("invalid_unicode") from None
    if "\ufffd" in question:
        raise TaskSpeechUnsupported("invalid_unicode")
    if len(question) > MAX_RAW_CHARS:
        raise TaskSpeechUnsupported("too_long")
    if not question.strip():
        raise TaskSpeechUnsupported("no_text")
    if any(
        (unicodedata.category(char) == "Cc" and char not in "\n\r\t")
        or unicodedata.category(char) in {"Cf", "Co"}
        for char in question
    ):
        raise TaskSpeechUnsupported("unsupported_content")
    text = _prepare_segments(_unwrap_markdown(question), locale)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r" *\n *", "\n", text).strip()
    if not text:
        raise TaskSpeechUnsupported("no_text")
    return TaskSpeechText(_bounded(text), locale)
