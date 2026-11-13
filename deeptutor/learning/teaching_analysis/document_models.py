"""Source blocks and exact extraction provenance for teacher review."""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .models import AssignmentInput


class _DocumentModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, revalidate_instances="always")


def validate_document_filename(filename: str) -> str:
    if (
        not filename
        or len(filename) > 200
        or filename in {".", ".."}
        or PureWindowsPath(filename).drive
        or PurePosixPath(filename).is_absolute()
        or "/" in filename
        or "\\" in filename
        or any(ord(char) < 32 or char in '<>:"|?*' for char in filename)
        or not filename.strip()
    ):
        raise ValueError("Use a document filename without paths or control characters.")
    return filename


class LocatedBlock(_DocumentModel):
    block_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    locator: str = Field(min_length=1, max_length=500)
    text: str = Field(min_length=1, max_length=30_000)

    @field_validator("locator", "text")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Source blocks require a location and readable text")
        return value


class LocatedDocument(_DocumentModel):
    filename: str = Field(min_length=1, max_length=200)
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    parser_version: str = Field(min_length=1, max_length=100)
    blocks: list[LocatedBlock] = Field(min_length=1, max_length=300)
    warnings: list[str] = Field(default_factory=list, max_length=20)

    _filename = field_validator("filename")(validate_document_filename)

    @model_validator(mode="after")
    def bounded_unique_source(self) -> LocatedDocument:
        ids = [block.block_id for block in self.blocks]
        if len(ids) != len(set(ids)):
            raise ValueError("Source block ids must be unique")
        if sum(len(block.text) for block in self.blocks) > 30_000:
            raise ValueError("Source text exceeds 30000 characters")
        if any(len(warning) > 1_000 for warning in self.warnings):
            raise ValueError("Source warnings exceed their size limit")
        return self


class DocumentCitation(_DocumentModel):
    block_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    quote: str = Field(min_length=1, max_length=8_000)

    @field_validator("quote")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Document citations must quote actual text")
        return value


ExtractedFieldName = Literal[
    "question", "student_answer", "student_work", "reference_answer", "rubric"
]


class ExtractedField(_DocumentModel):
    question_id: str = Field(min_length=1, max_length=128)
    field: ExtractedFieldName
    citations: list[DocumentCitation] = Field(min_length=1, max_length=6)


class DocumentExtraction(_DocumentModel):
    assignment: AssignmentInput
    document: LocatedDocument
    provenance: list[ExtractedField] = Field(max_length=200)
    warnings: list[str] = Field(max_length=25)


__all__ = [
    "DocumentCitation",
    "DocumentExtraction",
    "ExtractedField",
    "ExtractedFieldName",
    "LocatedBlock",
    "LocatedDocument",
    "validate_document_filename",
]
