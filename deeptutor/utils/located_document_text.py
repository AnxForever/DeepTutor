"""Bounded text/OOXML extraction with logical locations and no disk or network I/O.

This shared module deliberately has no dependency on feature-owned models or
parser settings. Office math rendering and safe XML parsing are imported only
for DOCX files. It never opens Word, follows relationships or extracts images.
"""

from __future__ import annotations

from dataclasses import dataclass
import io
from pathlib import PurePosixPath
import stat
from typing import Any
import unicodedata
import zipfile

MAX_DOCUMENT_BYTES = 1_048_576
MAX_SOURCE_CHARS = 30_000
MAX_SOURCE_BLOCKS = 300
MAX_DOCX_PARTS = 1_000
MAX_DOCX_EXPANDED_BYTES = 10 * 1_048_576
MAX_DOCX_COMPRESSION_RATIO = 100
PARSER_VERSION = "located-text-v1"


class LocatedTextError(ValueError):
    """A document cannot provide a complete, bounded, readable text preview."""


@dataclass(frozen=True, slots=True)
class LocatedTextBlock:
    locator: str
    text: str


def _require_readable(text: str) -> None:
    if "\ufffd" in text or any(
        unicodedata.category(char) == "Cc" and char not in "\r\n\t" for char in text
    ):
        raise LocatedTextError("Document text contains unreadable or control characters.")


def _bounded(blocks: list[LocatedTextBlock]) -> tuple[LocatedTextBlock, ...]:
    if len(blocks) > MAX_SOURCE_BLOCKS:
        raise LocatedTextError(f"Document exceeds {MAX_SOURCE_BLOCKS} source blocks.")
    if sum(len(block.text) for block in blocks) > MAX_SOURCE_CHARS:
        raise LocatedTextError(f"Document exceeds {MAX_SOURCE_CHARS} source text characters.")
    if not blocks or not any(char.isalnum() for block in blocks for char in block.text):
        raise LocatedTextError("No readable text was found. Images and OCR are not supported.")
    for block in blocks:
        _require_readable(block.text)
    return tuple(blocks)


def _plain_text(data: bytes) -> tuple[LocatedTextBlock, ...]:
    try:
        text = (
            data.decode("utf-16")
            if data.startswith((b"\xff\xfe", b"\xfe\xff"))
            else data.decode("utf-8-sig")
        )
    except UnicodeError:
        raise LocatedTextError(
            "Save the text as UTF-8 or BOM-marked UTF-16 before importing."
        ) from None
    _require_readable(text)
    if len(text) > MAX_SOURCE_CHARS:
        raise LocatedTextError(f"Document exceeds {MAX_SOURCE_CHARS} source text characters.")
    blocks: list[LocatedTextBlock] = []
    paragraph: list[str] = []
    start = 0

    def flush(end: int) -> None:
        if paragraph:
            locator = f"Line {start}" if start == end else f"Lines {start}-{end}"
            blocks.append(LocatedTextBlock(locator, "\n".join(paragraph)))
            paragraph.clear()

    number = 0
    for number, line in enumerate(text.splitlines(), start=1):
        if line.strip():
            if not paragraph:
                start = number
            paragraph.append(line)
        else:
            flush(number - 1)
    flush(number)
    return _bounded(blocks)


def _local_name(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _safe_xml(raw: bytes) -> Any:
    from defusedxml import ElementTree
    from defusedxml.common import DefusedXmlException

    try:
        root = ElementTree.fromstring(
            raw, forbid_dtd=True, forbid_entities=True, forbid_external=True
        )
    except (ElementTree.ParseError, DefusedXmlException, UnicodeError):
        raise LocatedTextError("DOCX contains invalid or prohibited XML.") from None
    stack = [(root, 0)]
    count = 0
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > 30_000 or depth > 64:
            raise LocatedTextError("DOCX XML structure is too complex to preview safely.")
        stack.extend((child, depth + 1) for child in node)
    return root


def _docx(data: bytes) -> tuple[tuple[LocatedTextBlock, ...], tuple[str, ...]]:
    from deeptutor.utils.document_images import render_docx_text

    warnings: list[str] = []
    if not data.startswith(b"PK\x03\x04"):
        raise LocatedTextError("Use a standard, unencrypted DOCX file; legacy Word is unsupported.")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            infos = archive.infolist()
            if len(infos) > MAX_DOCX_PARTS:
                raise LocatedTextError("DOCX contains too many archive parts.")
            names: set[str] = set()
            expanded = 0
            for info in infos:
                name = info.filename
                path = PurePosixPath(name)
                if (
                    name in names
                    or "\\" in name
                    or ":" in name
                    or path.is_absolute()
                    or ".." in path.parts
                    or "\x00" in name
                    or stat.S_ISLNK(info.external_attr >> 16)
                ):
                    raise LocatedTextError("DOCX contains duplicate or unsafe archive paths.")
                names.add(name)
                if info.flag_bits & 1:
                    raise LocatedTextError("Encrypted DOCX files are not supported.")
                if name.lower().endswith("vbaproject.bin"):
                    raise LocatedTextError("Macro-enabled documents are not supported.")
                expanded += info.file_size
                if expanded > MAX_DOCX_EXPANDED_BYTES or info.file_size > MAX_DOCX_EXPANDED_BYTES:
                    raise LocatedTextError("DOCX expanded content exceeds 10 MiB.")
                if info.file_size / max(1, info.compress_size) > MAX_DOCX_COMPRESSION_RATIO:
                    raise LocatedTextError("DOCX compression ratio exceeds the safe import limit.")
            if not {"word/document.xml", "[Content_Types].xml"}.issubset(names):
                raise LocatedTextError("The ZIP file is not a standard DOCX document.")

            body_root = None
            for info in infos:
                if not info.filename.lower().endswith((".xml", ".rels")):
                    continue
                root = _safe_xml(archive.read(info))
                if info.filename == "[Content_Types].xml":
                    if any(
                        "macroenabled" in value.lower() or "vbaproject" in value.lower()
                        for node in root.iter()
                        for value in node.attrib.values()
                    ):
                        raise LocatedTextError("Macro-enabled documents are not supported.")
                elif info.filename == "word/document.xml":
                    body_root = root
                if info.filename.endswith(".rels") and any(
                    node.attrib.get("TargetMode", "").lower() == "external" for node in root.iter()
                ):
                    warnings.append("External relationships were not followed or downloaded.")
                if info.filename.startswith(
                    (
                        "word/header",
                        "word/footer",
                        "word/footnotes",
                        "word/endnotes",
                        "word/comments",
                    )
                ):
                    warnings.append(
                        "Only the document body is included; headers, footers, notes and comments are excluded."
                    )
    except LocatedTextError:
        raise
    except (zipfile.BadZipFile, RuntimeError, OSError, ValueError, NotImplementedError):
        raise LocatedTextError("DOCX could not be read as a valid document package.") from None

    body = (
        next((node for node in body_root if _local_name(node.tag) == "body"), None)
        if body_root is not None
        else None
    )
    if body is None:
        raise LocatedTextError("DOCX has no readable document body.")
    if any(_local_name(node.tag) in {"ins", "del", "moveFrom", "moveTo"} for node in body.iter()):
        raise LocatedTextError(
            "Accept or reject tracked changes in Word before importing this DOCX."
        )
    if any(_local_name(node.tag) in {"drawing", "pict", "object"} for node in body.iter()):
        warnings.append(
            "Images and embedded objects were not read; verify any questions that depend on them."
        )
    blocks: list[LocatedTextBlock] = []

    def walk(container: Any, prefix: str) -> None:
        paragraph_number = table_number = 0
        for index, child in enumerate(container, 1):
            kind = _local_name(child.tag)
            if kind == "p":
                paragraph_number += 1
                text = render_docx_text(child)
                if text.strip():
                    if "[unsupported equation:" in text:
                        warnings.append(
                            "Some equation structures are unsupported; verify them against the original document."
                        )
                    blocks.append(LocatedTextBlock(f"{prefix}, paragraph {paragraph_number}", text))
                    if len(blocks) > MAX_SOURCE_BLOCKS:
                        raise LocatedTextError(
                            f"Document exceeds {MAX_SOURCE_BLOCKS} source blocks."
                        )
            elif kind == "tbl":
                table_number += 1
                rows = [node for node in child if _local_name(node.tag) == "tr"]
                for row_number, row in enumerate(rows, 1):
                    cells = [node for node in row if _local_name(node.tag) == "tc"]
                    for cell_number, cell in enumerate(cells, 1):
                        walk(
                            cell,
                            f"{prefix}, table {table_number}, row {row_number}, cell {cell_number}",
                        )
            elif kind in {"sdt", "sdtContent", "customXml"}:
                # Keep the wrapper path in the locator so counters from nested
                # content controls cannot impersonate a top-level paragraph.
                walk(child, f"{prefix}, {kind} {index}")

    walk(body, "Body")
    return _bounded(blocks), tuple(dict.fromkeys(warnings))


def extract_located_text(
    data: bytes, suffix: str
) -> tuple[tuple[LocatedTextBlock, ...], tuple[str, ...]]:
    """Extract a complete bounded preview; never truncate or start OCR."""
    if not isinstance(data, bytes) or not data:
        raise LocatedTextError("The document is empty.")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise LocatedTextError("Choose a document up to 1 MiB.")
    if suffix in {".txt", ".md"}:
        return _plain_text(data), ()
    if suffix == ".docx":
        return _docx(data)
    raise LocatedTextError(
        "Only TXT, Markdown and DOCX are supported; PDF and OCR are unavailable."
    )
