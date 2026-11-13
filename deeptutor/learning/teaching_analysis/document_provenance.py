"""A compact, signed snapshot of the original document fragments used in a draft."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

DocumentField = Literal["question", "student_answer", "student_work", "reference_answer", "rubric"]


class DocumentSourceCitation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    block_id: str = Field(min_length=1, max_length=128)
    locator: str = Field(min_length=1, max_length=500)
    quote: str = Field(min_length=1, max_length=8000)


class DocumentFieldSource(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    question_id: str = Field(min_length=1, max_length=128)
    field: DocumentField
    citations: list[DocumentSourceCitation] = Field(min_length=1, max_length=6)


class DocumentProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    filename: str = Field(min_length=1, max_length=255)
    source_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    parser_version: str = Field(min_length=1, max_length=120)
    fields: list[DocumentFieldSource] = Field(min_length=1, max_length=200)
    signature: str = Field(pattern=r"^[a-f0-9]{64}$")
