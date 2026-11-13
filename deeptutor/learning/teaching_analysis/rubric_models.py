"""Immutable contracts for teacher-owned, versioned scoring criteria."""

from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class _RubricFields(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, revalidate_instances="always"
    )

    template_id: str = Field(min_length=36, max_length=36, json_schema_extra={"format": "uuid"})
    name: str = Field(min_length=1, max_length=200)
    subject: str = Field(default="", max_length=200)
    grade: str = Field(default="", max_length=200)
    criteria: str = Field(min_length=1, max_length=6_000)

    @field_validator("template_id")
    @classmethod
    def canonical_template_id(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("name", "criteria")
    @classmethod
    def require_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Rubric name and criteria must contain text")
        # The adopted version is an exact snapshot, including the teacher's
        # intentional whitespace. Do not normalize criteria after adoption.
        return value


class RubricSnapshot(_RubricFields):
    revision: int = Field(ge=1)


class RubricTemplate(RubricSnapshot):
    created_at: float = Field(ge=0, allow_inf_nan=False)
    updated_at: float = Field(ge=0, allow_inf_nan=False)


class SaveRubricRequest(_RubricFields):
    expected_revision: int = Field(ge=0)


__all__ = ["RubricSnapshot", "RubricTemplate", "SaveRubricRequest"]
