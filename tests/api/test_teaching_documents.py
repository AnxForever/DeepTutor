"""Source previews and report provenance require scope-local verified originals."""

from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
import io
import json
from pathlib import Path
import stat
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
import zipfile

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.testclient import TestClient
import pytest

from deeptutor.api.routers import auth, teaching_analysis, teaching_documents
from deeptutor.learning.teaching_analysis import document_proofs, documents, service, storage
from deeptutor.learning.teaching_analysis.document_models import DocumentExtraction
from deeptutor.learning.teaching_analysis.models import AssignmentInput
from deeptutor.services.auth import TokenPayload
from deeptutor.services.path_service import PathService

BASE = "/api/teaching-analysis"
SOURCE = "题目：计算8+7。\n\n学生作答：14\n过程：8+2=10，10+5=14。\n\n参考答案：15。"


@pytest.fixture
def document_client(tmp_path, monkeypatch):
    # Shared auth/catalog suites own actual JWT/workspace discovery. Retain
    # the real admin guard while injecting only test-local authorized roots.
    scope = ContextVar("document_api_test_scope", default=("local", "default"))
    tokens = {
        role: TokenPayload(username=role, role=role, user_id=role)
        for role in ("admin", "student", "teacher", "user")
    }
    monkeypatch.setattr(auth, "AUTH_ENABLED", False)

    async def scoped_auth(
        request: Request, authorization: str | None = Header(default=None)
    ) -> TokenPayload | None:
        payload = None
        if auth.AUTH_ENABLED:
            payload = tokens.get((authorization or "").removeprefix("Bearer "))
            if payload is None:
                raise HTTPException(401, "Not authenticated")
        workspace = request.query_params.get("dt_workspace", "default")
        if workspace not in {"default", "second"}:
            raise HTTPException(404, "Workspace unavailable")
        scope.set((payload.username if payload else "local", workspace))
        return payload

    def paths():
        account, workspace = scope.get()
        return PathService(tmp_path / account / workspace)

    monkeypatch.setattr(document_proofs, "get_path_service", paths)
    monkeypatch.setattr(storage, "get_path_service", paths)
    app = FastAPI()
    app.include_router(teaching_analysis.router, prefix=BASE)
    app.dependency_overrides[auth.require_auth] = scoped_auth
    with TestClient(app, raise_server_exceptions=False) as client:
        yield client, tmp_path


def _preview(client, **kwargs):
    return client.post(
        BASE + "/documents/preview",
        files={"file": ("synthetic-work.txt", SOURCE.encode(), "text/plain")},
        **kwargs,
    )


def _proposal():
    return {
        "items": [
            {
                "fields": [
                    {
                        "field": "question",
                        "citations": [{"block_id": "B1", "quote": "计算8+7。"}],
                    },
                    {
                        "field": "student_answer",
                        "citations": [{"block_id": "B2", "quote": "学生作答：14"}],
                    },
                    {
                        "field": "student_work",
                        "citations": [{"block_id": "B2", "quote": "8+2=10，10+5=14。"}],
                    },
                ]
            }
        ]
    }


def _analysis(assignment):
    item = assignment["items"][0]
    return {
        "summary": "Synthetic teacher review; no real model was used.",
        "items": [
            {
                "question_id": item["question_id"],
                "result": "ungraded",
                "observation": "Review this original response before inferring a cause.",
                "evidence": [
                    {
                        "question_id": item["question_id"],
                        "field": "student_answer",
                        "quote": item["student_answer"],
                    }
                ],
            }
        ],
        "priorities": [],
        "limitations": ["Synthetic offline data only."],
    }


def _save_payload(assignment):
    return {
        "report_id": str(uuid4()),
        "expected_revision": 0,
        "assignment": assignment,
        "analysis": _analysis(assignment),
        "source_fingerprint": service.fingerprint_assignment(
            AssignmentInput.model_validate(assignment)
        ),
        "status": "draft",
        "teacher_notes": "",
    }


@pytest.mark.parametrize("role", ["student", "teacher", "user"])
def test_non_admins_cannot_preview_or_extract_documents(document_client, monkeypatch, role):
    client, root = document_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    headers = {"Authorization": f"Bearer {role}"}
    assert _preview(client, headers=headers).status_code == 403
    document = documents.preview_document(SOURCE.encode(), "synthetic-work.txt")
    response = client.post(
        BASE + "/documents/extract",
        json={"document": document.model_dump(mode="json"), "document_token": "0" * 64},
        headers=headers,
    )
    assert response.status_code == 403
    assert not list(root.rglob(".document-signing.db"))


def test_document_preview_requires_auth_when_enabled(document_client, monkeypatch):
    client, root = document_client
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    assert _preview(client).status_code == 401
    assert not list(root.rglob(".document-signing.db"))


def test_preview_is_local_and_persists_only_a_stable_key(document_client, monkeypatch):
    client, root = document_client
    model = AsyncMock(side_effect=AssertionError("Preview must not call a model"))
    monkeypatch.setattr(documents, "_request_document_model", model)
    first = _preview(client)
    assert first.status_code == 200, first.text
    second = _preview(client)
    assert second.json() == first.json()
    assert first.json()["document"]["blocks"][0]["locator"] == "Line 1"
    model.assert_not_awaited()
    stored_files = [path for path in root.rglob("*") if path.is_file()]
    assert [path.name for path in stored_files] == [".document-signing.db"]
    assert SOURCE.encode() not in stored_files[0].read_bytes()
    assert not list(root.rglob("reports.sqlite3"))


@pytest.mark.parametrize(
    "raw,filename,status",
    [
        (b"x" * 1_048_577, "large.txt", 413),
        (b"PK\x03\x04broken", "broken.docx", 422),
        (b"legacy Word content", "legacy.doc", 422),
        (b"%PDF fake", "scan.pdf", 422),
    ],
)
def test_oversized_and_invalid_documents_are_rejected_before_key_creation(
    document_client, raw, filename, status
):
    client, root = document_client
    response = client.post(BASE + "/documents/preview", files={"file": (filename, raw)})
    assert response.status_code == status
    assert not list(root.rglob(".document-signing.db"))


def test_unsafe_docx_archive_does_not_extract_any_files(document_client):
    client, root = document_client
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../escaped.xml", b"<body>Not an accepted document</body>")
    response = client.post(
        BASE + "/documents/preview", files={"file": ("unsafe.docx", stream.getvalue())}
    )
    assert response.status_code == 422
    assert list(root.rglob("*")) == []


@pytest.mark.parametrize(
    "change", ["token", "filename", "source_hash", "text", "locator", "parser_version", "order"]
)
def test_altered_preview_never_reaches_the_model(document_client, monkeypatch, change):
    client, _ = document_client
    preview = _preview(client).json()
    payload = deepcopy(preview)
    if change == "token":
        payload["document_token"] = "0" * 64
    elif change == "text":
        payload["document"]["blocks"][0]["text"] = "A fabricated original."
    elif change == "locator":
        payload["document"]["blocks"][0]["locator"] = "Page 999"
    elif change == "order":
        payload["document"]["blocks"].reverse()
    else:
        payload["document"][change] = {
            "filename": "another-work.txt",
            "source_hash": "f" * 64,
            "parser_version": "modified-parser",
        }[change]
    model = AsyncMock(side_effect=AssertionError("Changed preview must fail before model"))
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(BASE + "/documents/extract", json=payload)
    assert response.status_code == 422, response.text
    assert response.json()["detail"]["error_code"] == "teaching_document_token_invalid"
    model.assert_not_awaited()


def test_preview_token_cannot_cross_workspaces_or_accounts(document_client, monkeypatch):
    client, root = document_client
    preview = _preview(client).json()
    model = AsyncMock(side_effect=AssertionError("Foreign scope must fail before model"))
    monkeypatch.setattr(documents, "_request_document_model", model)
    workspace = client.post(BASE + "/documents/extract?dt_workspace=second", json=preview)
    assert workspace.status_code == 422
    assert not list((root / "local" / "second").rglob(".document-signing.db"))
    monkeypatch.setattr(auth, "AUTH_ENABLED", True)
    account = client.post(
        BASE + "/documents/extract", json=preview, headers={"Authorization": "Bearer admin"}
    )
    assert account.status_code == 422
    assert not list((root / "admin").rglob(".document-signing.db"))
    model.assert_not_awaited()


def test_verified_extraction_has_server_signed_original_quotes(document_client, monkeypatch):
    client, root = document_client
    preview = _preview(client).json()
    model = AsyncMock(return_value=json.dumps(_proposal()))
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(BASE + "/documents/extract", json=preview | {"language": "en"})
    assert response.status_code == 200, response.text
    value = response.json()
    model.assert_awaited_once()
    assert json.loads(model.call_args.kwargs["prompt"]) == preview["document"]
    assert value["document"] == preview["document"]
    item = value["assignment"]["items"][0]
    assert item["student_answer"] == "学生作答：14"
    assert item["transcription_status"] == "uncertain"
    original = value["assignment"]["document_provenance"]
    assert len(original["signature"]) == 64
    answer = next(field for field in original["fields"] if field["field"] == "student_answer")
    assert answer["citations"] == [
        {"block_id": "B2", "locator": "Lines 3-4", "quote": "学生作答：14"}
    ]
    assert not list(root.rglob("reports.sqlite3"))
    assert sorted(path.name for path in root.rglob("*") if path.is_file()) == [
        ".document-signing.db"
    ]


def test_empty_extraction_returns_a_warning_without_inventing_provenance(
    document_client, monkeypatch
):
    client, _ = document_client
    preview = _preview(client).json()
    model = AsyncMock(return_value='{"items": []}')
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(BASE + "/documents/extract", json=preview)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["assignment"]["items"] == value["provenance"] == []
    assert value["assignment"]["document_provenance"] is None
    assert any("未从当前" in warning for warning in value["warnings"])
    model.assert_awaited_once()


def test_api_refuses_to_sign_an_unverifiable_adapter_result(document_client, monkeypatch):
    client, _ = document_client
    preview = _preview(client).json()
    document = preview["document"]
    fake = DocumentExtraction.model_validate(
        {
            "document": document,
            "assignment": {
                "assignment_ref": document["filename"],
                "items": [{"question_id": "Q1", "question": "A fabricated question"}],
            },
            "provenance": [
                {
                    "question_id": "Q1",
                    "field": "question",
                    "citations": [{"block_id": "B1", "quote": "计算8+7。"}],
                }
            ],
            "warnings": [],
        }
    )
    monkeypatch.setattr(teaching_documents, "extract_assignment", AsyncMock(return_value=fake))
    # Pin the same authorized proof root, but observe whether signing is tried.
    real_proof = document_proofs.get_document_proof_store()
    observed = SimpleNamespace(verify=real_proof.verify, sign=Mock(wraps=real_proof.sign))
    monkeypatch.setattr(teaching_documents, "get_document_proof_store", lambda: observed)
    response = client.post(BASE + "/documents/extract", json=preview)
    assert response.status_code == 502, response.text
    observed.sign.assert_not_called()


def test_contained_question_variants_with_the_same_answer_do_not_count_twice(
    document_client, monkeypatch
):
    client, root = document_client
    preview = _preview(client).json()
    proposal = _proposal()
    second = deepcopy(proposal["items"][0])
    proposal["items"][0]["fields"][0]["citations"][0]["quote"] = "题目：计算8+7。"
    proposal["items"].append(second)
    model = AsyncMock(return_value=json.dumps(proposal))
    monkeypatch.setattr(documents, "_request_document_model", model)
    real_proof = document_proofs.get_document_proof_store()
    observed = SimpleNamespace(verify=real_proof.verify, sign=Mock(wraps=real_proof.sign))
    monkeypatch.setattr(teaching_documents, "get_document_proof_store", lambda: observed)

    response = client.post(BASE + "/documents/extract", json=preview)

    assert response.status_code == 502, response.text
    model.assert_awaited_once()
    observed.sign.assert_not_called()
    assert not list(root.rglob("reports.sqlite3"))


def test_shared_reading_context_with_distinct_questions_and_answers_is_not_a_duplicate(
    document_client, monkeypatch
):
    client, _ = document_client
    raw = (
        "材料：树上原有三只小鸟。\n\n问题一：原有几只小鸟？\n\n学生答案一：3只。\n\n"
        "问题二：又飞来两只，现在几只？\n\n学生答案二：5只。"
    )
    preview = client.post(
        BASE + "/documents/preview", files={"file": ("synthetic-reading.txt", raw.encode())}
    ).json()
    common = {"block_id": "B1", "quote": "材料：树上原有三只小鸟。"}
    proposal = {
        "items": [
            {
                "fields": [
                    {
                        "field": "question",
                        "citations": [common, {"block_id": "B2", "quote": "原有几只小鸟？"}],
                    },
                    {
                        "field": "student_answer",
                        "citations": [{"block_id": "B3", "quote": "3只。"}],
                    },
                ]
            },
            {
                "fields": [
                    {
                        "field": "question",
                        "citations": [
                            common,
                            {"block_id": "B4", "quote": "又飞来两只，现在几只？"},
                        ],
                    },
                    {
                        "field": "student_answer",
                        "citations": [{"block_id": "B5", "quote": "5只。"}],
                    },
                ]
            },
        ]
    }
    model = AsyncMock(return_value=json.dumps(proposal))
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(BASE + "/documents/extract", json=preview)
    assert response.status_code == 200, response.text
    items = response.json()["assignment"]["items"]
    assert [item["student_answer"] for item in items] == ["3只。", "5只。"]
    assert all(item["question"].startswith(common["quote"]) for item in items)
    assert response.json()["assignment"]["document_provenance"] is not None
    model.assert_awaited_once()


def test_unpaired_unicode_in_a_forged_preview_is_a_validation_error_not_a_model_call(
    document_client, monkeypatch
):
    client, root = document_client
    preview = _preview(client).json()
    preview["document"]["blocks"][0]["text"] = "\ud800"
    model = AsyncMock(side_effect=AssertionError("Malformed preview must fail before extraction"))
    monkeypatch.setattr(documents, "_request_document_model", model)
    # Send an explicit JSON escape: this is a forged request, not a UTF-8
    # source file or an httpx encoder failure on the client side.
    response = client.post(
        BASE + "/documents/extract",
        content=json.dumps(preview, ensure_ascii=True).encode("ascii"),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert "detail" in response.json()
    assert "\\ud800" not in response.text.lower()
    model.assert_not_awaited()
    assert not list(root.rglob("reports.sqlite3"))


@pytest.mark.parametrize("mode", ["invalid_text_type", "invalid_extra_field_name"])
def test_validation_errors_do_not_echo_source_content_or_bad_field_names(
    document_client, monkeypatch, mode
):
    client, _ = document_client
    preview = _preview(client).json()
    marker = "synthetic-private-student-source-not-for-validation-response"
    if mode == "invalid_text_type":
        preview["document"]["blocks"][0]["text"] = {"original_answer": marker}
    else:
        preview["\ud800"] = marker
    model = AsyncMock(side_effect=AssertionError("Invalid input must not reach the model"))
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(
        BASE + "/documents/extract",
        content=json.dumps(preview, ensure_ascii=True).encode("ascii"),
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422, response.text
    assert marker not in response.text and "\\ud800" not in response.text.lower()
    assert isinstance(response.json()["detail"], list)
    for error in response.json()["detail"]:
        assert "input" not in error and "ctx" not in error
    model.assert_not_awaited()


def test_teacher_corrections_keep_signed_originals_and_can_be_reviewed_and_saved(
    document_client, monkeypatch
):
    client, _ = document_client
    monkeypatch.setattr(
        documents, "_request_document_model", AsyncMock(return_value=json.dumps(_proposal()))
    )
    extraction = client.post(BASE + "/documents/extract", json=_preview(client).json()).json()
    assignment = extraction["assignment"]
    proof = deepcopy(assignment["document_provenance"])
    assignment.update(student_ref="synthetic-student", subject="math")
    assignment["items"][0].update(
        question="Calculate 8 + 7 and explain.",
        student_answer="15",
        student_work="8 + 7 = 15",
        transcription_status="confirmed",
        source_locator="Teacher-corrected location label",
    )
    model = AsyncMock(return_value=json.dumps(_analysis(assignment)))
    monkeypatch.setattr(service, "_request_model", model)
    generated = client.post(BASE + "/analyze", json=assignment)
    assert generated.status_code == 200, generated.text
    assert "document_provenance" not in json.loads(model.call_args.kwargs["prompt"])
    saved = client.post(BASE + "/reports", json=_save_payload(assignment))
    assert saved.status_code == 200, saved.text
    assert saved.json()["assignment"]["document_provenance"] == proof
    assert saved.json()["assignment"]["items"][0]["student_answer"] == "15"
    answer_source = next(field for field in proof["fields"] if field["field"] == "student_answer")
    assert answer_source["citations"][0]["quote"] == "学生作答：14"
    history = client.get(BASE + f"/reports/{saved.json()['report_id']}/revisions")
    assert history.status_code == 200
    assert history.json()[0]["assignment"]["document_provenance"] == proof


@pytest.mark.parametrize("change", ["quote", "locator", "signature", "filename"])
def test_changed_original_proof_never_reaches_analysis_or_report_storage(
    document_client, monkeypatch, change
):
    client, root = document_client
    monkeypatch.setattr(
        documents, "_request_document_model", AsyncMock(return_value=json.dumps(_proposal()))
    )
    assignment = client.post(BASE + "/documents/extract", json=_preview(client).json()).json()[
        "assignment"
    ]
    assignment.update(student_ref="synthetic-student", subject="math")
    original = assignment["document_provenance"]
    if change in {"quote", "locator"}:
        original["fields"][0]["citations"][0][change] = "Altered original source"
    elif change == "signature":
        original["signature"] = "0" * 64
    else:
        original["filename"] = "another-source.txt"
    model = AsyncMock(side_effect=AssertionError("Bad source must fail before analysis"))
    monkeypatch.setattr(service, "_request_model", model)
    generated = client.post(BASE + "/analyze", json=assignment)
    assert generated.status_code == 422, generated.text
    assert generated.json()["detail"]["error_code"] == "teaching_document_source_invalid"
    saved = client.post(BASE + "/reports", json=_save_payload(assignment))
    assert saved.status_code == 422, saved.text
    model.assert_not_awaited()
    assert not list(root.rglob("reports.sqlite3"))


def test_valid_original_proof_is_not_another_workspaces_access_credential(
    document_client, monkeypatch
):
    client, root = document_client
    monkeypatch.setattr(
        documents, "_request_document_model", AsyncMock(return_value=json.dumps(_proposal()))
    )
    assignment = client.post(BASE + "/documents/extract", json=_preview(client).json()).json()[
        "assignment"
    ]
    assignment.update(student_ref="synthetic-student", subject="math")
    model = AsyncMock(side_effect=AssertionError("Wrong scope must fail before analysis"))
    monkeypatch.setattr(service, "_request_model", model)
    assert client.post(BASE + "/analyze?dt_workspace=second", json=assignment).status_code == 422
    assert (
        client.post(
            BASE + "/reports?dt_workspace=second", json=_save_payload(assignment)
        ).status_code
        == 422
    )
    model.assert_not_awaited()
    assert not list((root / "local" / "second").rglob("*.db"))
    assert not list(root.rglob("reports.sqlite3"))


def test_preview_storage_failure_is_actionable_without_leaking_paths(document_client, monkeypatch):
    client, _ = document_client

    class FailedProof:
        def sign(self, *args):
            raise OSError("private key path and uploaded student transcript")

    monkeypatch.setattr(teaching_documents, "get_document_proof_store", lambda: FailedProof())
    response = _preview(client)
    assert response.status_code == 503
    assert "private" not in response.text and "transcript" not in response.text


def test_reparse_key_is_rejected_at_api_without_writing_anything(document_client, monkeypatch):
    client, root = document_client
    original_lstat = Path.lstat

    def linked_key(path, *args, **kwargs):
        if path.name == ".document-signing.db":
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", linked_key)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    response = _preview(client)
    assert response.status_code == 503, response.text
    assert list(root.rglob("*")) == []


@pytest.mark.parametrize("operation", ["extract", "analyze", "save"])
def test_existing_reparse_key_fails_before_model_or_report_save(
    document_client, monkeypatch, operation
):
    client, root = document_client
    preview = _preview(client).json()
    extraction_model = AsyncMock(return_value=json.dumps(_proposal()))
    monkeypatch.setattr(documents, "_request_document_model", extraction_model)
    extraction = client.post(BASE + "/documents/extract", json=preview)
    assert extraction.status_code == 200
    assignment = extraction.json()["assignment"]
    assignment.update(student_ref="synthetic-student", subject="math")
    extraction_model.reset_mock()
    analysis_model = AsyncMock(side_effect=AssertionError("A redirected key must fail first"))
    monkeypatch.setattr(service, "_request_model", analysis_model)
    original_lstat = Path.lstat
    key = next(root.rglob(".document-signing.db"))
    original_bytes = key.read_bytes()

    def linked_key(path, *args, **kwargs):
        if path == key:
            return SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", linked_key)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    if operation == "extract":
        response = client.post(BASE + "/documents/extract", json=preview)
    elif operation == "analyze":
        response = client.post(BASE + "/analyze", json=assignment)
    else:
        response = client.post(BASE + "/reports", json=_save_payload(assignment))
    assert response.status_code == 503, response.text
    extraction_model.assert_not_awaited()
    analysis_model.assert_not_awaited()
    assert key.read_bytes() == original_bytes
    assert not list(root.rglob("reports.sqlite3"))


@pytest.mark.parametrize("kind", ["not_configured", "provider", "invalid_quote"])
def test_extraction_failure_is_actionable_and_does_not_sign_or_save_a_report(
    document_client, monkeypatch, kind
):
    client, root = document_client
    preview = _preview(client).json()
    if kind == "not_configured":
        from deeptutor.services.llm.exceptions import LLMConfigError

        model = AsyncMock(side_effect=LLMConfigError("private model configuration"))
    elif kind == "provider":
        model = AsyncMock(side_effect=RuntimeError("private provider token and student answer"))
    else:
        proposal = _proposal()
        proposal["items"][0]["fields"][0]["citations"][0]["quote"] = "A fabricated question"
        model = AsyncMock(return_value=json.dumps(proposal))
    monkeypatch.setattr(documents, "_request_document_model", model)
    response = client.post(BASE + "/documents/extract", json=preview)
    assert response.status_code == (503 if kind == "not_configured" else 502), response.text
    if kind == "not_configured":
        assert response.json()["detail"]["error_code"] == "teaching_model_not_configured"
    assert "private" not in response.text and "token and student" not in response.text
    model.assert_awaited_once()
    assert not list(root.rglob("reports.sqlite3"))
