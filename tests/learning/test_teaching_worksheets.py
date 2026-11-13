"""Worksheet editions must whitelist export fields and preserve saved text."""

from __future__ import annotations

from copy import deepcopy
from html import escape
from html.parser import HTMLParser
from uuid import uuid4

from markdown_it import MarkdownIt
import pytest

from deeptutor.learning.teaching_analysis.followup_models import SavedFollowup, SaveFollowupRequest
from deeptutor.learning.teaching_analysis.followups import FollowupNotFound, FollowupStore
from deeptutor.learning.teaching_analysis.storage import TeachingAnalysisStore
from deeptutor.learning.teaching_analysis.worksheets import (
    WORKSHEET_CSP,
    render_worksheet_html,
    render_worksheet_markdown,
    worksheet_filename,
)

PRIVATE_ANSWER = "PRIVATEANSWER6734ONLY"
PRIVATE_RUBRIC = "PRIVATERUBRIC6734ONLY"
OTHER_PRIVATE = [
    "PRIVATESTUDENT6734ONLY",
    "PRIVATEREVIEW6734ONLY",
    "PRIVATEFEEDBACK6734ONLY",
    "PRIVATEORIGINALRESPONSE6734ONLY",
    "PRIVATEDIAGNOSIS6734ONLY",
    "d16b7306-96b4-4d15-afd2-abd85155bd63",
    "abcdef" * 10 + "abcd",
]


def snapshot() -> dict:
    return {
        "followup_id": str(uuid4()),
        "revision": 3,
        "report_id": OTHER_PRIVATE[5],
        "report_revision": 1,
        "priority_index": 0,
        "title": "分数加法练习",
        "questions": [
            {
                "question_id": "F1",
                "question": "计算 1/4 + 1/6，并写出过程。",
                "reference_answer": PRIVATE_ANSWER,
                "rubric": PRIVATE_RUBRIC,
            }
        ],
        "student_ref": OTHER_PRIVATE[0],
        "assignment_ref": "Original assignment",
        "subject": "Mathematics",
        "grade": "Grade 5",
        "source_fingerprint": OTHER_PRIVATE[6],
        "knowledge_point": OTHER_PRIVATE[4],
        "created_at": 1.0,
        "updated_at": 2.0,
        # Future/private keys must not appear merely because a template was
        # handed the complete stored object.
        "teacher_result": OTHER_PRIVATE[1],
        "teacher_feedback": OTHER_PRIVATE[2],
        "historical_answers": [OTHER_PRIVATE[3]],
    }


@pytest.mark.parametrize("render", [render_worksheet_html, render_worksheet_markdown])
def test_student_edition_never_contains_private_fields(render):
    material = snapshot()
    original = deepcopy(material)
    result = render(material)
    displayed = MarkdownIt().render(result) if render is render_worksheet_markdown else result
    assert "分数加法练习" in displayed and "F1" in displayed and "1/4 + 1/6" in displayed
    for marker in [PRIVATE_ANSWER, PRIVATE_RUBRIC, *OTHER_PRIVATE]:
        assert marker not in result
    assert "姓名" in result and "日期" in result
    assert material == original


@pytest.mark.parametrize("render", [render_worksheet_html, render_worksheet_markdown])
def test_teacher_edition_is_explicit_and_only_adds_reference_fields(render):
    result = render(snapshot(), audience="teacher")
    assert "教师版 · 含参考答案" in result
    assert PRIVATE_ANSWER in result and PRIVATE_RUBRIC in result
    for marker in OTHER_PRIVATE:
        assert marker not in result
    assert "参考答案" in result and "评分要点" in result


@pytest.mark.parametrize("render", [render_worksheet_html, render_worksheet_markdown])
def test_missing_teacher_answers_are_marked_pending(render):
    material = snapshot()
    material["questions"][0].update(reference_answer=None, rubric=" ")
    assert render(material, audience="teacher").count("待教师核对") == 2
    english = render(material, audience="teacher", language="en")
    assert english.count("Pending teacher review") == 2
    assert "TEACHER EDITION · CONTAINS ANSWER KEYS" in english


class DocumentTags(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def test_html_escapes_title_ids_stems_and_teacher_reference_markup():
    payload = (
        '<img src="https://invalid.example/x" onerror="alert(1)"></style><script>alert(2)</script>'
    )
    material = snapshot()
    material["title"] = payload
    material["questions"][0] = {
        "question_id": payload,
        "question": payload,
        "reference_answer": payload,
        "rubric": payload,
    }
    rendered = render_worksheet_html(material, audience="teacher")
    parser = DocumentTags()
    parser.feed(rendered)
    assert escape(payload) in rendered
    assert "<script" not in rendered and "<img" not in rendered
    assert sum(tag == "style" for tag, _ in parser.tags) == 1
    assert not any(
        tag in {"script", "img", "link", "iframe", "object", "form", "base"}
        for tag, _ in parser.tags
    )
    assert not any(
        key in {"src", "href", "srcset", "action", "onerror", "onclick"}
        for _, attrs in parser.tags
        for key in attrs
    )
    assert '<meta http-equiv="Content-Security-Policy"' in rendered
    assert WORKSHEET_CSP in rendered
    assert "@page { size: A4;" in rendered


def test_markdown_does_not_interpret_raw_html_or_images_as_markup():
    material = snapshot()
    material["title"] = "A student's worksheet"
    material["questions"][0]["question"] = (
        "<script>alert(1)</script> ![image](https://invalid.example/image)"
    )
    rendered = render_worksheet_markdown(material)
    assert "<script" not in rendered and "&lt;script&gt;" in rendered
    assert "![image]" not in rendered
    assert r"\!\[image\]" in rendered
    assert "A student's worksheet" in rendered


def test_long_question_is_preserved_and_can_flow_across_pages():
    material = snapshot()
    stem = ("较长的题目正文，需要完整保留。\n" * 180) + "最后一行不能截断。"
    material["questions"][0]["question"] = stem
    rendered = render_worksheet_html(material)
    assert escape(stem) in rendered
    assert 'class="worksheet-question long-question"' in rendered
    assert ".long-question { break-inside: auto;" in rendered
    assert "overflow: hidden" not in rendered and "line-clamp" not in rendered


def test_typed_snapshot_is_supported_without_exporting_source_metadata():
    material = snapshot()
    for field in ("teacher_result", "teacher_feedback", "historical_answers"):
        material.pop(field)
    saved = SavedFollowup.model_validate(material)
    result = render_worksheet_html(saved)
    assert "分数加法练习" in result
    assert saved.student_ref not in result and str(saved.report_id) not in result


def test_title_or_stem_content_is_not_silently_removed():
    material = snapshot()
    material["title"] = "姓名：教师有意写入的标题"
    material["questions"][0]["question"] = "本题题干明确包含答案提示 5/12，请解释它。"
    rendered = render_worksheet_html(material)
    assert escape(material["title"]) in rendered
    assert escape(material["questions"][0]["question"]) in rendered


def test_safe_filename_uses_only_saved_identity_revision_and_edition():
    identifier = str(uuid4())
    assert (
        worksheet_filename(identifier, 101, "student", "html")
        == f"practice-{identifier}-v101-student.html"
    )
    assert (
        worksheet_filename(identifier, 2, "teacher", "markdown")
        == f"practice-{identifier}-v2-teacher.md"
    )
    for args in (
        ("../../unsafe", 1, "student", "html"),
        (identifier, 0, "student", "html"),
        (identifier, 1, "student\r\nX-Injected: yes", "html"),
        (identifier, 1, "student", "../html"),
    ):
        with pytest.raises(ValueError):
            worksheet_filename(*args)


def test_exact_old_revision_is_read_even_outside_latest_hundred(tmp_path):
    root = tmp_path / "workspace"
    reports = TeachingAnalysisStore(root)
    report_id = str(uuid4())
    reports.save_report(
        report_id,
        0,
        {
            "assignment": {
                "student_ref": "Private student",
                "assignment_ref": "Work",
                "subject": "Math",
                "grade": "Grade 5",
            },
            "analysis": {"priorities": [{"knowledge_point": "Addition"}]},
            "source_fingerprint": "a" * 64,
            "status": "confirmed",
        },
    )
    store = FollowupStore(root)
    followup_id = str(uuid4())
    for revision in range(1, 106):
        store.save_followup(
            SaveFollowupRequest.model_validate(
                {
                    "followup_id": followup_id,
                    "expected_revision": revision - 1,
                    "report_id": report_id,
                    "report_revision": 1,
                    "priority_index": 0,
                    "title": f"Worksheet version {revision}",
                    "questions": [
                        {"question_id": "F1", "question": f"Version {revision}: compute 1 + 1."}
                    ],
                }
            )
        )
    assert len(store.revisions(followup_id)) == 100
    assert store.get_revision(followup_id, 1)["title"] == "Worksheet version 1"
    assert store.get_revision(followup_id, 101)["title"] == "Worksheet version 101"
    assert store.get_followup(followup_id)["revision"] == 105
    with pytest.raises(FollowupNotFound):
        store.get_revision(followup_id, 106)
