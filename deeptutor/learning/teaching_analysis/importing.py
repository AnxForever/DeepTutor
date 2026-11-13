"""Parse bounded JSON/CSV/TSV without recording grades or touching any store."""

from __future__ import annotations

import csv
import io
import json
from pathlib import PurePath
from typing import Any

from pydantic import ValidationError

from .models import MAX_ITEMS, AssignmentInput

MAX_IMPORT_BYTES = 1_048_576

_ALIASES = {
    "student_ref": ("student_ref", "student_id", "学生编号", "学生代号", "学生标识"),
    "assignment_ref": ("assignment_ref", "作业编号", "作业代号", "作业标识"),
    "subject": ("subject", "学科", "科目"),
    "grade": ("grade", "年级"),
    "teacher_context": ("teacher_context", "教师说明", "教学背景", "老师说明"),
    "question_id": ("question_id", "题号", "题目编号"),
    "question": ("question", "题目", "题干"),
    "student_answer": ("student_answer", "user_answer", "学生答案", "学生作答", "作答"),
    "student_work": ("student_work", "学生过程", "解题过程", "学生步骤", "过程"),
    "reference_answer": ("reference_answer", "correct_answer", "参考答案", "标准答案", "答案"),
    "rubric": ("rubric", "评分标准", "评分要求"),
    "knowledge_points": ("knowledge_points", "知识点", "知识点标签"),
    "source_locator": ("source_locator", "来源位置", "出处", "页码位置"),
    "answer_status": ("answer_status", "作答状态"),
    "transcription_status": ("transcription_status", "转录状态"),
    "assistance": ("assistance", "辅助情况", "提示情况"),
}
_HEADERS = {alias.casefold(): key for key, aliases in _ALIASES.items() for alias in aliases}
_METADATA = ("student_ref", "assignment_ref", "subject", "grade", "teacher_context")
_STATUS_ALIASES = {
    "answer_status": {
        "已提供": "present",
        "有作答": "present",
        "确认空白": "confirmed_blank",
        "已确认空白": "confirmed_blank",
        "未知": "unknown",
        "未提供": "unknown",
    },
    "transcription_status": {
        "已确认": "confirmed",
        "不确定": "uncertain",
        "不适用": "not_applicable",
    },
    "assistance": {"独立": "independent", "辅助": "assisted", "未知": "unknown"},
}


def _json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("JSON contains duplicate object keys")
        result[key] = value
    return result


def _invalid_constant(_value: str) -> None:
    raise ValueError("JSON must not contain NaN or Infinity")


def _validate(payload: Any, *, location: str = "Input") -> AssignmentInput:
    try:
        return AssignmentInput.model_validate(payload)
    except ValidationError as exc:
        # Avoid including the student's raw text or complete model payload in
        # import errors. Field locations are enough to repair an invalid row.
        error = exc.errors(include_input=False)[0]
        field = ".".join(str(part) for part in error["loc"])
        raise ValueError(f"{location}: invalid {field or 'assignment'} ({error['type']})") from None


def _parse_json(text: str) -> AssignmentInput:
    try:
        payload = json.loads(text, object_pairs_hook=_json_object, parse_constant=_invalid_constant)
    except (json.JSONDecodeError, RecursionError) as exc:
        line = getattr(exc, "lineno", None)
        raise ValueError(f"Invalid JSON{f' at line {line}' if line else ''}") from None
    if isinstance(payload, list):
        # A bare question array has no assignment metadata. The teacher fills
        # it in during preview, before invoking analysis.
        items = []
        for index, item in enumerate(payload, start=1):
            if not isinstance(item, dict):
                raise ValueError(f"JSON question {index} must be an object")
            items.append({"question_id": f"Q{index}", **item})
        payload = {"items": items}
    if not isinstance(payload, dict):
        raise ValueError("JSON must be one assignment object or a question array")
    # Strict validation rejects fixture wrappers (cases/expected) and unknown
    # item fields. Never search inside arbitrary JSON for an input object.
    return _validate(payload, location="JSON")


def _knowledge_points(text: str, *, row: int) -> list[str]:
    if not text.strip():
        return []
    if text.lstrip().startswith("["):
        try:
            value = json.loads(text)
        except (ValueError, RecursionError):
            raise ValueError(f"Row {row}: knowledge_points must be a string array") from None
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            raise ValueError(f"Row {row}: knowledge_points must be a string array")
        return value
    return [part.strip() for part in text.replace("；", ";").split(";") if part.strip()]


def _parse_table(text: str, *, delimiter: str) -> AssignmentInput:
    try:
        rows = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
        raw_headers = next(rows, None)
        if not raw_headers:
            raise ValueError("Row 1: a header row is required")
        headers = []
        for raw in raw_headers:
            header = _HEADERS.get(raw.strip().casefold())
            if header is None:
                raise ValueError("Row 1: unsupported column name")
            if header in headers:
                raise ValueError("Row 1: duplicate columns resolve to the same field")
            headers.append(header)
        if "question" not in headers:
            raise ValueError("Row 1: question column is required")
        metadata = dict.fromkeys(_METADATA, "")
        items = []
        for cells in rows:
            row_number = rows.line_num
            if not cells or all(not cell.strip() for cell in cells):
                continue
            if len(cells) != len(headers):
                raise ValueError(f"Row {row_number}: column count does not match the header")
            if len(items) >= MAX_ITEMS:
                raise ValueError(f"Row {row_number}: at most {MAX_ITEMS} questions are allowed")
            fields = dict(zip(headers, cells, strict=True))
            for key in _METADATA:
                value = fields.pop(key, "").strip()
                if value:
                    if metadata[key] and metadata[key] != value:
                        raise ValueError(f"Row {row_number}: {key} must be consistent across rows")
                    metadata[key] = value
            item: dict[str, Any] = {
                "question_id": fields.pop("question_id", "").strip() or f"Q{len(items) + 1}",
                "question": fields.pop("question", ""),
                "knowledge_points": _knowledge_points(
                    fields.pop("knowledge_points", ""), row=row_number
                ),
            }
            for key in ("answer_status", "transcription_status", "assistance"):
                raw = fields.pop(key, "").strip()
                if raw:
                    item[key] = _STATUS_ALIASES[key].get(raw, raw)
            for key in ("student_answer", "student_work", "reference_answer", "rubric"):
                raw = fields.pop(key, "")
                item[key] = raw if raw.strip() else None
            if item.get("answer_status") == "confirmed_blank":
                for key in ("student_answer", "student_work"):
                    if item[key] is None:
                        item[key] = ""
            item["source_locator"] = fields.pop("source_locator", "").strip()
            # Validate each row separately to give a useful line number; the
            # aggregate validation still enforces uniqueness and total size.
            validated = _validate({"items": [item]}, location=f"Row {row_number}")
            items.append(validated.items[0])
    except csv.Error:
        raise ValueError("Invalid delimited file; check quoting and row sizes") from None
    return _validate({**metadata, "items": items}, location="Table")


def preview_import(data: bytes, filename: str) -> AssignmentInput:
    """Return parsed data for review; this function never saves or grades it."""
    if not isinstance(data, bytes) or not data:
        raise ValueError("An import file must contain bytes")
    if len(data) > MAX_IMPORT_BYTES:
        raise ValueError(f"Import exceeds {MAX_IMPORT_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise ValueError("Import must use UTF-8 encoding") from None
    suffix = PurePath(filename).suffix.lower()
    if suffix == ".json":
        return _parse_json(text)
    if suffix in {".csv", ".tsv"}:
        return _parse_table(text, delimiter="\t" if suffix == ".tsv" else ",")
    raise ValueError("Only JSON, CSV and TSV imports are supported")
