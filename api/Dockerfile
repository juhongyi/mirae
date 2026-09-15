FROM ghcr.io/astral-sh/uv:0.12.5 AS uv

FROM python:3.13-slim

COPY --from=uv /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

COPY pyproject.toml uv.lock ./
COPY api/pyproject.toml api/pyproject.toml
RUN uv sync --frozen --package mirae-api

COPY api/src api/src

EXPOSE 8000

CMD ["uvicorn", "main:app", "--app-dir", "api/src", "--host", "0.0.0.0", "--port", "8000"]
