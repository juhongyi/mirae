from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from functools import wraps
from threading import Lock
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator


class ContentType(StrEnum):
    SVG = "svg"
    IMAGE = "image"


class ReasonCode(StrEnum):
    FILE_SPECIFICATION = "file_specification"
    FORBIDDEN_ATTRIBUTE = "forbidden_attribute"
    ELEMENT_COUNT = "element_count"
    WHITESPACE_RATIO = "whitespace_ratio"
    COPYRIGHT_RISK = "copyright_risk"
    VISUAL_QUALITY = "visual_quality"


class SubmissionCreate(BaseModel):
    event_id: str
    submission_id: str
    contributor_id: str
    content_type: ContentType
    format: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    file_size_bytes: int = Field(ge=0)
    svg_attributes: dict[str, str] = Field(default_factory=dict)
    element_count: int = Field(ge=0)
    whitespace_ratio: float = Field(ge=0, le=1)
    submitted_at: datetime

    @field_validator("submitted_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("submitted_at must include a timezone")
        return value


class QueueCreate(BaseModel):
    event_id: str
    submission_id: str


class ReviewDecisionCreate(BaseModel):
    event_id: str
    submission_id: str
    decision: Literal["approved", "rejected"]
    reasons: list[ReasonCode] = Field(default_factory=list)

    @model_validator(mode="after")
    def require_rejection_reasons(self) -> "ReviewDecisionCreate":
        if self.decision == "rejected" and not self.reasons:
            raise ValueError("A rejected decision requires at least one reason")
        if self.decision == "approved" and self.reasons:
            raise ValueError("An approved decision cannot include rejection reasons")
        return self


class NotificationCreate(BaseModel):
    event_id: str
    recipient_id: str
    kind: Literal[
        "rejection",
        "operator_alert",
        "anomaly_alert",
        "conversion_failure",
        "settlement_statement",
    ]
    reference_event_id: str
    message: str = Field(min_length=1)


class SettlementCreate(BaseModel):
    event_id: str
    contributor_id: str
    period: str
    revenue: int = Field(ge=0)
    usage_count: int = Field(ge=0)
    content_statuses: dict[str, Literal["published", "unpublished"]] = Field(
        default_factory=dict
    )
    usage_items: list[dict[str, int | float | str]] = Field(default_factory=list)


class SettlementStatementCreate(BaseModel):
    event_id: str
    contributor_id: str
    period: str
    usage_items: list[dict[str, int | float | str]]
    total: int = Field(ge=0, strict=True)


@dataclass
class Store:
    submissions: dict[str, dict[str, Any]] = field(default_factory=dict)
    review_queue: dict[str, dict[str, Any]] = field(default_factory=dict)
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    notifications: dict[str, dict[str, Any]] = field(default_factory=dict)
    settlements: dict[str, dict[str, Any]] = field(default_factory=dict)
    statements: dict[str, dict[str, Any]] = field(default_factory=dict)
    audit_events: list[dict[str, str]] = field(default_factory=list)
    idempotency: dict[str, tuple[str, dict[str, Any], dict[str, Any]]] = field(
        default_factory=dict
    )

    def replay(
        self, operation: str, event_id: str, payload: dict[str, Any]
    ) -> dict[str, Any] | None:
        previous = self.idempotency.get(event_id)
        if previous is None:
            return None
        previous_operation, previous_payload, previous_response = previous
        if previous_operation != operation or previous_payload != payload:
            raise HTTPException(status_code=409, detail="event_id was already used")
        return {**previous_response, "replayed": True}

    def remember(
        self,
        operation: str,
        event_id: str,
        payload: dict[str, Any],
        response: dict[str, Any],
    ) -> dict[str, Any]:
        self.idempotency[event_id] = (operation, payload, response)
        return {**response, "replayed": False}

    def audit(self, action: str, event_id: str, subject_id: str) -> None:
        self.audit_events.append(
            {"action": action, "event_id": event_id, "subject_id": subject_id}
        )


def create_app() -> FastAPI:
    app = FastAPI(title="DesignHub Mock API")
    store = Store()
    write_lock = Lock()

    def synchronized(handler: Any) -> Any:
        @wraps(handler)
        def wrapped(*args: Any, **kwargs: Any) -> Any:
            with write_lock:
                return handler(*args, **kwargs)

        return wrapped

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/submissions")
    @synchronized
    def create_submission(request: SubmissionCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("submission.create", request.event_id, payload):
            return replay
        existing = store.submissions.get(request.submission_id)
        submission = request.model_dump(mode="python", exclude={"event_id"})
        if existing is not None and existing != submission:
            raise HTTPException(status_code=409, detail="submission_id already exists")
        store.submissions[request.submission_id] = submission
        response = {"event_id": request.event_id, "submission": submission}
        store.audit("submission.created", request.event_id, request.submission_id)
        return store.remember("submission.create", request.event_id, payload, response)

    @app.get("/submissions/{submission_id}")
    def get_submission(submission_id: str) -> dict[str, Any]:
        if submission_id not in store.submissions:
            raise HTTPException(status_code=404, detail="submission not found")
        return store.submissions[submission_id]

    @app.post("/review-queue")
    @synchronized
    def add_to_review_queue(request: QueueCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("review.enqueue", request.event_id, payload):
            return replay
        submission = store.submissions.get(request.submission_id)
        if submission is None:
            raise HTTPException(status_code=404, detail="submission not found")
        item = {
            "event_id": request.event_id,
            "submission_id": request.submission_id,
            "contributor_id": submission["contributor_id"],
            "submitted_at": submission["submitted_at"],
        }
        store.review_queue[request.submission_id] = item
        store.audit("review.enqueued", request.event_id, request.submission_id)
        return store.remember("review.enqueue", request.event_id, payload, item)

    @app.get("/review-queue")
    def get_review_queue() -> dict[str, list[dict[str, Any]]]:
        return {"items": list(store.review_queue.values())}

    @app.post("/review-decisions")
    @synchronized
    def create_review_decision(request: ReviewDecisionCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("review.decided", request.event_id, payload):
            return replay
        if request.submission_id not in store.review_queue:
            raise HTTPException(
                status_code=404, detail="submission is not in the review queue"
            )
        response = {
            "event_id": request.event_id,
            "submission_id": request.submission_id,
            "decision": request.decision,
            "reasons": [code.value for code in request.reasons],
        }
        del store.review_queue[request.submission_id]
        store.decisions[request.event_id] = response
        store.audit("review.decided", request.event_id, request.submission_id)
        return store.remember("review.decided", request.event_id, payload, response)

    @app.post("/notifications")
    @synchronized
    def create_notification(request: NotificationCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("notification.sent", request.event_id, payload):
            return replay
        notification = {
            "event_id": request.event_id,
            "recipient_id": request.recipient_id,
            "kind": request.kind,
            "reference_event_id": request.reference_event_id,
            "message": request.message,
        }
        store.notifications[request.event_id] = notification
        store.audit("notification.sent", request.event_id, request.recipient_id)
        return store.remember(
            "notification.sent", request.event_id, payload, notification
        )

    @app.get("/notifications")
    def get_notifications() -> dict[str, list[dict[str, Any]]]:
        return {"items": list(store.notifications.values())}

    @app.post("/settlements")
    @synchronized
    def create_settlement(request: SettlementCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("settlement.recorded", request.event_id, payload):
            return replay
        key = (request.contributor_id, request.period)
        existing = store.settlements.get(key)
        settlement = request.model_dump(mode="python", exclude={"event_id"})
        if existing is not None and existing != settlement:
            raise HTTPException(status_code=409, detail="settlement already exists")
        store.settlements[key] = settlement
        response = {"event_id": request.event_id, "settlement": settlement}
        store.audit("settlement.recorded", request.event_id, request.contributor_id)
        return store.remember(
            "settlement.recorded", request.event_id, payload, response
        )

    @app.get("/settlements")
    def get_settlements(period: str | None = None) -> dict[str, list[dict[str, Any]]]:
        items = [
            {**settlement, "contributor_id": contributor_id, "period": period_key}
            for (contributor_id, period_key), settlement in store.settlements.items()
            if period is None or period_key == period
        ]
        return {"items": items}

    @app.post("/settlement-statements")
    @synchronized
    def create_settlement_statement(
        request: SettlementStatementCreate,
    ) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("statement.generated", request.event_id, payload):
            return replay
        statement = {
            "statement_id": request.event_id,
            "contributor_id": request.contributor_id,
            "period": request.period,
            "usage_items": request.usage_items,
            "total": request.total,
        }
        store.statements[request.event_id] = statement
        store.audit("statement.generated", request.event_id, request.contributor_id)
        return store.remember(
            "statement.generated", request.event_id, payload, statement
        )

    @app.get("/settlement-statements/{statement_id}")
    def get_settlement_statement(statement_id: str) -> dict[str, Any]:
        if statement_id not in store.statements:
            raise HTTPException(status_code=404, detail="statement not found")
        return store.statements[statement_id]

    @app.get("/audit-events")
    def get_audit_events() -> dict[str, list[dict[str, str]]]:
        return {"items": store.audit_events}

    return app


app = create_app()
