"""Do not echo uploaded student text in request-validation error responses."""

from __future__ import annotations

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute


def _safe_location(value):
    if isinstance(value, int):
        return value
    return str(value).encode("utf-8", errors="replace").decode("utf-8")[:200]


class TeachingAPIRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # Pydantic error inputs can hold entire answers, or unpaired
                # Unicode surrogates that cannot be encoded as UTF-8. Field
                # locations and error kinds are sufficient to repair a form.
                errors = [
                    {
                        "loc": [_safe_location(part) for part in error.get("loc", ())[:12]],
                        "type": _safe_location(error.get("type", "value_error")),
                        "msg": "Invalid field value or text encoding.",
                    }
                    for error in exc.errors()[:50]
                ]
                return JSONResponse(
                    {
                        "detail": errors,
                        "message": "Review the supplied fields and text encoding.",
                        "error_code": "teaching_invalid_request",
                        "retryable": False,
                    },
                    status_code=422,
                )

        return handle
