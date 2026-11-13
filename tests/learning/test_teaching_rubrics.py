"""Rubric versions stay immutable, scoped, idempotent and explicitly adopted."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar
import os
from pathlib import Path
import sqlite3
import stat
from types import SimpleNamespace
from uuid import uuid4

from pydantic import ValidationError
import pytest

from deeptutor.learning.teaching_analysis import rubrics
from deeptutor.learning.teaching_analysis.rubric_models import (
    RubricSnapshot,
    RubricTemplate,
    SaveRubricRequest,
)
from deeptutor.learning.teaching_analysis.rubrics import RubricConflict, RubricNotFound, RubricStore


def request(template_id=None, expected_revision=0, **changes):
    return SaveRubricRequest(
        **{
            "template_id": template_id or str(uuid4()),
            "expected_revision": expected_revision,
            "name": "分数加法评分标准",
            "subject": "数学",
            "grade": "五年级",
            "criteria": "检查通分过程和计算结果。\n结果与推理分别记录。",
            **changes,
        }
    )


def snapshot(template):
    return RubricSnapshot.model_validate(
        template.model_dump(mode="json", include=set(RubricSnapshot.model_fields))
    )


def test_first_reads_and_missing_versions_do_not_create_storage(tmp_path):
    store = RubricStore(tmp_path / "missing" / "teaching-analysis")
    assert store.list_templates() == []
    template_id = str(uuid4())
    for read in (
        lambda: store.get_latest(template_id),
        lambda: store.get_revision(template_id, 1),
        lambda: store.revisions(template_id),
    ):
        with pytest.raises(RubricNotFound):
            read()
    assert not store.root.exists()


def test_create_edit_retry_and_latest_queries_preserve_immutable_versions(tmp_path):
    store = RubricStore(tmp_path / "scope")
    first_request = request()
    first = store.save_template(first_request)
    assert first.revision == 1
    assert store.save_template(first_request) == first
    edit = request(first.template_id, 1, criteria="使用新标准，检查单位统一与解释。")
    second = store.save_template(edit)
    assert second.revision == 2
    assert second.created_at == first.created_at
    assert store.save_template(edit) == second
    assert store.save_template(request(first.template_id, 2, criteria=second.criteria)) == second
    assert store.list_templates() == [second]
    assert store.get_latest(first.template_id) == second
    assert store.get_revision(first.template_id, 1) == first
    assert store.revisions(first.template_id) == [second, first]
    assert store.db_path.name == "rubrics.sqlite3"
    assert not (store.root / "reports.sqlite3").exists()


def test_stale_or_future_edits_cannot_overwrite_the_current_version(tmp_path):
    store = RubricStore(tmp_path / "scope")
    first = store.save_template(request())
    second = store.save_template(request(first.template_id, 1, criteria="另一份标准。"))
    for expected_revision in (0, 1, 3):
        with pytest.raises(RubricConflict):
            store.save_template(
                request(first.template_id, expected_revision, criteria="陈旧修改。")
            )
    assert store.get_latest(first.template_id) == second
    assert len(store.revisions(first.template_id)) == 2


def test_old_retry_cannot_skip_intervening_edits_when_text_later_matches_again(tmp_path):
    store = RubricStore(tmp_path / "scope")
    original = request()
    first = store.save_template(original)
    store.save_template(request(first.template_id, 1, criteria="暂时改为另一版。"))
    restored = store.save_template(request(first.template_id, 2))
    assert restored.revision == 3 and restored.criteria == first.criteria
    with pytest.raises(RubricConflict):
        store.save_template(original)
    assert store.get_latest(first.template_id) == restored


def test_missing_template_rejects_nonzero_expected_version(tmp_path):
    store = RubricStore(tmp_path / "scope")
    with pytest.raises(RubricConflict):
        store.save_template(request(expected_revision=1))
    assert store.list_templates() == []


def test_concurrent_distinct_edits_have_one_cas_winner(tmp_path):
    store = RubricStore(tmp_path / "scope")
    first = store.save_template(request())

    def edit(criteria):
        try:
            return store.save_template(request(first.template_id, 1, criteria=criteria))
        except RubricConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as executor:
        values = list(executor.map(edit, ("修改甲。", "修改乙。")))
    assert sum(value is not None for value in values) == 1
    assert store.get_latest(first.template_id).revision == 2
    assert len(store.revisions(first.template_id)) == 2


def test_concurrent_same_payload_retries_create_only_one_revision(tmp_path):
    store = RubricStore(tmp_path / "scope")
    initial = request()
    with ThreadPoolExecutor(max_workers=3) as executor:
        values = list(executor.map(lambda _: store.save_template(initial), range(3)))
    assert all(value.revision == 1 for value in values)
    assert len(store.revisions(initial.template_id)) == 1


def test_scoped_factory_and_snapshot_verification_follow_current_workspace(tmp_path, monkeypatch):
    selected = ContextVar("rubric_test_scope", default="account-a/default")

    def paths():
        return SimpleNamespace(get_workspace_dir=lambda: tmp_path / selected.get())

    monkeypatch.setattr(rubrics, "get_path_service", paths)
    first = rubrics.get_rubric_store().save_template(request())
    adopted = snapshot(first)
    assert rubrics.verify_rubric_snapshot(adopted) == adopted
    for other_scope in ("account-a/second", "account-b/default"):
        selected.set(other_scope)
        store = rubrics.get_rubric_store()
        assert store.list_templates() == []
        with pytest.raises(ValueError, match="not found"):
            rubrics.verify_rubric_snapshot(adopted)
        assert not store.db_path.exists()
    selected.set("account-a/default")
    assert rubrics.verify_rubric_snapshot(adopted) == adopted


def test_adopted_snapshot_remains_valid_when_template_is_edited(tmp_path, monkeypatch):
    store = RubricStore(tmp_path / "scope")
    monkeypatch.setattr(rubrics, "get_rubric_store", lambda: store)
    first = store.save_template(request())
    adopted = snapshot(first)
    second = store.save_template(
        request(first.template_id, 1, name="新标准", criteria="新的评分要求。")
    )
    assert second.revision == 2
    assert rubrics.verify_rubric_snapshot(adopted) == adopted
    assert adopted.criteria == first.criteria
    assert adopted.name == first.name
    assert rubrics.verify_rubric_snapshot(snapshot(second)).criteria == second.criteria


@pytest.mark.parametrize(
    "field,value",
    [
        ("name", "篡改名称"),
        ("subject", "语文"),
        ("grade", "六年级"),
        ("criteria", "篡改标准。"),
        ("criteria", "检查通分过程和计算结果。\n结果与推理分别记录。 "),
    ],
)
def test_snapshot_fields_must_match_the_exact_stored_version(tmp_path, monkeypatch, field, value):
    store = RubricStore(tmp_path / "scope")
    monkeypatch.setattr(rubrics, "get_rubric_store", lambda: store)
    saved = store.save_template(request())
    altered = snapshot(saved).model_dump()
    altered[field] = value
    with pytest.raises(ValueError, match="does not match"):
        rubrics.verify_rubric_snapshot(RubricSnapshot.model_validate(altered))


@pytest.mark.parametrize(
    "changes",
    [
        {"template_id": "../outside"},
        {"expected_revision": -1},
        {"expected_revision": True},
        {"expected_revision": "0"},
        {"name": " "},
        {"name": "a" * 201},
        {"subject": "a" * 201},
        {"grade": "a" * 201},
        {"criteria": "\n "},
        {"criteria": "a" * 6001},
        {"criteria": 42},
        {"revision": 2},
    ],
)
def test_request_validation_does_not_create_files(tmp_path, changes):
    store = RubricStore(tmp_path / "scope")
    payload = request().model_dump() | changes
    with pytest.raises(ValidationError):
        store.save_template(payload)
    assert not store.root.exists()


def test_snapshots_are_frozen_and_reject_invalid_revisions():
    fields = request().model_dump(exclude={"expected_revision"})
    adopted = RubricSnapshot(**fields, revision=1)
    with pytest.raises(ValidationError):
        adopted.criteria = "不能原地修改旧版本。"
    for revision in (0, -1, True, "1"):
        with pytest.raises(ValidationError):
            RubricSnapshot(**fields, revision=revision)
    with pytest.raises(ValidationError):
        RubricTemplate(**adopted.model_dump(), created_at=float("nan"), updated_at=1.0)


def test_reparse_point_is_rejected_before_creating_storage(tmp_path, monkeypatch):
    target = tmp_path / "redirected"
    original_lstat = Path.lstat

    def lstat(path, *args, **kwargs):
        if path == target:
            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        return original_lstat(path, *args, **kwargs)

    monkeypatch.setattr(Path, "lstat", lstat)
    monkeypatch.setattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400, raising=False)
    with pytest.raises(ValueError, match="redirected"):
        RubricStore(target)
    assert not target.exists()


@pytest.mark.parametrize("suffix", ["", "-journal", "-wal", "-shm"])
def test_linked_database_or_sidecar_is_rejected_without_touching_target(tmp_path, suffix):
    store = RubricStore(tmp_path / "scope")
    store.root.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_bytes(b"untouched")
    redirected = Path(str(store.db_path) + suffix)
    try:
        redirected.symlink_to(elsewhere)
    except OSError:
        pytest.skip("Creating symlinks is unavailable in this test environment")
    with pytest.raises(ValueError, match="redirected"):
        store.save_template(request())
    assert elsewhere.read_bytes() == b"untouched"


def test_corrupt_existing_database_is_preserved(tmp_path):
    store = RubricStore(tmp_path / "scope")
    store.root.mkdir()
    store.db_path.write_bytes(b"not a database")
    with pytest.raises(sqlite3.Error):
        store.save_template(request())
    assert store.db_path.read_bytes() == b"not a database"


@pytest.mark.skipif(os.name == "nt", reason="Windows access is controlled by its filesystem ACLs")
def test_database_and_feature_directory_use_private_modes(tmp_path):
    store = RubricStore(tmp_path / "scope")
    store.save_template(request())
    assert stat.S_IMODE(store.root.stat().st_mode) == 0o700
    assert stat.S_IMODE(store.db_path.stat().st_mode) == 0o600
