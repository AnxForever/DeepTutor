"""In-memory, explicit-edition worksheets from saved practice snapshots.

The student edition reads only a title and question ids/stems. Answer keys,
rubrics, source metadata and historical responses are never serialized into
its document, even as hidden markup. Text intentionally written in a title or
stem is preserved and escaped; the teacher must review it before sharing.
"""

from __future__ import annotations

from html import escape
import re
from typing import Any, Literal
from uuid import UUID

from .followup_models import SavedFollowup

WorksheetAudience = Literal["student", "teacher"]
WorksheetFormat = Literal["html", "markdown"]
WorksheetLanguage = Literal["en", "zh"]

WORKSHEET_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"

_LABELS = {
    "en": {
        "student": "Student worksheet",
        "teacher": "TEACHER EDITION · CONTAINS ANSWER KEYS",
        "name": "Name",
        "date": "Date",
        "answer_space": "Response space",
        "reference": "Reference answer",
        "rubric": "Marking guidance",
        "pending": "Pending teacher review",
        "teacher_note": "Teacher-provided answers and marking guidance must be checked before use.",
    },
    "zh": {
        "student": "学生练习单",
        "teacher": "教师版 · 含参考答案",
        "name": "姓名",
        "date": "日期",
        "answer_space": "作答区",
        "reference": "参考答案",
        "rubric": "评分要点",
        "pending": "待教师核对",
        "teacher_note": "参考答案与评分要点由教师提供，请核对后使用。",
    },
}

_PRINT_STYLE = """
@page { size: A4; margin: 18mm 17mm; }
* { box-sizing: border-box; }
html { color-scheme: light; background: #fff; color: #111; }
body { margin: 0 auto; max-width: 180mm; padding: 10mm 4mm;
  font: 12pt/1.65 system-ui, -apple-system, 'Segoe UI', sans-serif; }
h1 { margin: 0 0 7mm; font-size: 21pt; line-height: 1.3; overflow-wrap: anywhere; }
.edition { margin: 0 0 4mm; font-size: 11pt; font-weight: 700; }
.teacher-edition { border: 2px solid #111; padding: 3mm; font-size: 18pt; }
.identity-fields { display: flex; flex-wrap: wrap; gap: 9mm; margin-bottom: 9mm; }
.identity-blank { display: inline-block; width: 48mm; border-bottom: 1px solid #555; }
.worksheet-question { margin: 0 0 10mm; break-inside: avoid; page-break-inside: avoid; }
.long-question { break-inside: auto; page-break-inside: auto; }
.question-id { margin: 0 0 2mm; font-weight: 700; break-after: avoid; page-break-after: avoid; }
.question-stem, .reference-content { white-space: pre-wrap; overflow-wrap: anywhere;
  tab-size: 4; orphans: 3; widows: 3; }
.answer-space { margin-top: 3mm; }
.answer-line { height: 9mm; border-bottom: 1px solid #aaa; }
.teacher-reference { margin-top: 4mm; padding-left: 3mm; border-left: 2px solid #777; }
.reference-label { margin: 3mm 0 1mm; font-size: 10pt; font-weight: 700; }
.teacher-note { border-top: 1px solid #aaa; padding-top: 3mm; font-size: 10pt; }
@media print {
  html, body { width: auto; max-width: none; background: #fff; }
  body { padding: 0; }
}
""".strip()


def _validate_options(audience: str, language: str) -> dict[str, str]:
    if audience not in {"student", "teacher"} or language not in _LABELS:
        raise ValueError("Choose a supported worksheet audience and language.")
    return _LABELS[language]


def _public_questions(
    snapshot: SavedFollowup | dict[str, Any], *, audience: WorksheetAudience
) -> tuple[str, list[dict[str, str | None]]]:
    # Select the export fields directly. Do not dump the complete snapshot or
    # pass it to a template that could accidentally expose future private keys.
    title = snapshot.title if isinstance(snapshot, SavedFollowup) else snapshot["title"]
    original = snapshot.questions if isinstance(snapshot, SavedFollowup) else snapshot["questions"]
    if not isinstance(title, str) or not title.strip() or not 1 <= len(original) <= 3:
        raise ValueError("A worksheet needs a saved title and one to three questions.")
    selected = []
    for question in original:
        source = question if isinstance(question, dict) else question.__dict__
        question_id, stem = source["question_id"], source["question"]
        if not isinstance(question_id, str) or not isinstance(stem, str):
            raise ValueError("Saved question text is invalid.")
        item = {"question_id": question_id, "question": stem}
        if audience == "teacher":
            for field in ("reference_answer", "rubric"):
                value = source.get(field)
                if value is not None and not isinstance(value, str):
                    raise ValueError("Saved marking guidance is invalid.")
                item[field] = value
        selected.append(item)
    return title, selected


def render_worksheet_html(
    snapshot: SavedFollowup | dict[str, Any],
    *,
    audience: WorksheetAudience = "student",
    language: WorksheetLanguage = "zh",
) -> str:
    labels = _validate_options(audience, language)
    title, questions = _public_questions(snapshot, audience=audience)
    edition_class = "edition teacher-edition" if audience == "teacher" else "edition"
    sections = []
    for question in questions:
        stem = question["question"]
        assert isinstance(stem, str)
        # Ordinary questions stay together. Oversized stems are permitted to
        # flow across pages; no fixed height, clipping, or truncation is used.
        long_question = len(stem) > 1_000 or stem.count("\n") > 14
        question_class = (
            "worksheet-question long-question" if long_question else "worksheet-question"
        )
        reference = ""
        if audience == "teacher":
            blocks = []
            for field, label in (("reference_answer", "reference"), ("rubric", "rubric")):
                value = question[field]
                display = value if isinstance(value, str) and value.strip() else labels["pending"]
                blocks.append(
                    f'<div class="reference-label">{escape(labels[label])}</div>'
                    f'<div class="reference-content">{escape(display)}</div>'
                )
            reference = '<aside class="teacher-reference">' + "".join(blocks) + "</aside>"
        sections.append(
            f'<section class="{question_class}">'
            f'<div class="question-id">{escape(str(question["question_id"]))}</div>'
            f'<div class="question-stem">{escape(stem)}</div>'
            f'<div class="answer-space" aria-label="{escape(labels["answer_space"])}">'
            '<div class="answer-line"></div><div class="answer-line"></div>'
            '<div class="answer-line"></div><div class="answer-line"></div></div>'
            f"{reference}</section>"
        )
    note = (
        f'<footer class="teacher-note">{escape(labels["teacher_note"])}</footer>'
        if audience == "teacher"
        else ""
    )
    return (
        "<!doctype html>\n"
        f'<html lang="{language}"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<meta http-equiv="Content-Security-Policy" content="{WORKSHEET_CSP}">'
        f"<title>{escape(labels[audience])} — {escape(title)}</title>"
        f"<style>{_PRINT_STYLE}</style></head><body>"
        f'<div class="{edition_class}">{escape(labels[audience])}</div>'
        f"<h1>{escape(title)}</h1>"
        '<div class="identity-fields">'
        f'<span>{escape(labels["name"])}：<span class="identity-blank"></span></span>'
        f'<span>{escape(labels["date"])}：<span class="identity-blank"></span></span></div>'
        + "".join(sections)
        + note
        + "</body></html>\n"
    )


def _markdown_text(value: str) -> str:
    # Preserve the text while preventing raw HTML, images, or Markdown syntax
    # in the teacher's question from turning into executable/embedded content.
    return re.sub(r"([\\`*_{}\[\]()#+.!|>~\-])", r"\\\1", escape(value, quote=False))


def render_worksheet_markdown(
    snapshot: SavedFollowup | dict[str, Any],
    *,
    audience: WorksheetAudience = "student",
    language: WorksheetLanguage = "zh",
) -> str:
    labels = _validate_options(audience, language)
    title, questions = _public_questions(snapshot, audience=audience)
    heading = (
        [f"# {labels['teacher']}", "", f"## {_markdown_text(title)}"]
        if audience == "teacher"
        else [f"# {_markdown_text(title)}", "", f"**{labels['student']}**"]
    )
    lines = [
        *heading,
        "",
        f"{labels['name']}：________________　　{labels['date']}：________________",
        "",
    ]
    for question in questions:
        lines.extend(
            [
                f"## {_markdown_text(str(question['question_id']))}",
                "",
                _markdown_text(str(question["question"])),
                "",
                f"{labels['answer_space']}：",
                "",
                "____________________________________________________________",
                "",
                "____________________________________________________________",
                "",
                "____________________________________________________________",
                "",
            ]
        )
        if audience == "teacher":
            for field, label in (("reference_answer", "reference"), ("rubric", "rubric")):
                value = question[field]
                display = value if isinstance(value, str) and value.strip() else labels["pending"]
                lines.extend([f"**{labels[label]}**", "", _markdown_text(display), ""])
    if audience == "teacher":
        lines.extend([labels["teacher_note"], ""])
    return "\n".join(lines)


def worksheet_filename(
    followup_id: str | UUID,
    revision: int,
    audience: WorksheetAudience,
    format: WorksheetFormat,
) -> str:
    identifier = str(UUID(str(followup_id)))
    if (
        not isinstance(revision, int)
        or isinstance(revision, bool)
        or revision < 1
        or audience not in {"student", "teacher"}
        or format not in {"html", "markdown"}
    ):
        raise ValueError("Worksheet filename requires a saved revision and explicit edition.")
    suffix = "html" if format == "html" else "md"
    return f"practice-{identifier}-v{revision}-{audience}.{suffix}"


__all__ = [
    "WORKSHEET_CSP",
    "render_worksheet_html",
    "render_worksheet_markdown",
    "worksheet_filename",
]
