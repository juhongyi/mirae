from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from functools import wraps
from threading import Lock
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from svg_conversion import convert_evenodd_to_nonzero, render_compare
from svgpathtools import parse_path


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


REASONS = {
    ReasonCode.FILE_SPECIFICATION: (
        "파일 규격",
        "지원 형식, 크기와 해상도 기준에 맞게 파일을 수정해 주세요.",
    ),
    ReasonCode.FORBIDDEN_ATTRIBUTE: (
        "금지 속성",
        "SVG의 evenodd 채우기 규칙과 stroke 속성을 패스로 변환해 주세요.",
    ),
    ReasonCode.ELEMENT_COUNT: (
        "요소 개수",
        "디자인 요소를 1,000개 이하로 줄여 주세요.",
    ),
    ReasonCode.WHITESPACE_RATIO: (
        "여백 비율",
        "피사체가 대지의 절반 이상을 차지하도록 여백을 줄여 주세요.",
    ),
    ReasonCode.COPYRIGHT_RISK: (
        "저작권 위험",
        "사용 권리를 확인하고 필요한 권리 증빙을 제출해 주세요.",
    ),
    ReasonCode.VISUAL_QUALITY: (
        "시각 품질 기준",
        "깨짐, 정렬과 마감 상태를 확인해 품질 문제를 수정해 주세요.",
    ),
}

MAX_FILE_BYTES = {ContentType.SVG: 150 * 1024, ContentType.IMAGE: 10 * 1024 * 1024}
ALLOWED_FORMATS = {ContentType.SVG: {"svg"}, ContentType.IMAGE: {"png", "jpg", "jpeg"}}
MIN_DIMENSION = 100
MAX_DIMENSION = 10_000
MAX_ELEMENTS = 1_000
MAX_WHITESPACE_RATIO = 0.5


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


class ValidationCreate(BaseModel):
    event_id: str
    submission_id: str


class QueueCreate(BaseModel):
    event_id: str
    submission_id: str
    validation_event_id: str


class SlaCheckCreate(BaseModel):
    event_id: str
    checked_at: datetime
    max_wait_days: int = Field(default=10, ge=0)
    max_queue_size: int = Field(default=20, ge=0)

    @field_validator("checked_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("checked_at must include a timezone")
        return value


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
    kind: Literal["rejection", "operator_alert", "anomaly_alert", "conversion_failure"]
    reference_event_id: str


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


class AnomalyCheckCreate(BaseModel):
    event_id: str
    period: str
    previous_period: str
    revenue_ratio_threshold: float = Field(default=0.7, gt=0, le=1)
    usage_ratio_threshold: float = Field(default=0.8, ge=0)


class SettlementStatementCreate(BaseModel):
    event_id: str
    contributor_id: str
    period: str
    usage_items: list[dict[str, int | float | str]] = Field(min_length=1)


class SvgConversionCreate(BaseModel):
    event_id: str
    submission_id: str
    svg_content: str


@dataclass
class Store:
    submissions: dict[str, dict[str, Any]] = field(default_factory=dict)
    validations: dict[str, dict[str, Any]] = field(default_factory=dict)
    review_queue: dict[str, dict[str, Any]] = field(default_factory=dict)
    sla_checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    notifications: dict[str, dict[str, Any]] = field(default_factory=dict)
    settlements: dict[str, dict[str, Any]] = field(default_factory=dict)
    anomaly_checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    statements: dict[str, dict[str, Any]] = field(default_factory=dict)
    svg_conversions: dict[str, dict[str, Any]] = field(default_factory=dict)
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


def reason(code: ReasonCode) -> dict[str, str]:
    name, guidance = REASONS[code]
    return {"rule": code.value, "name": name, "guidance": guidance}


def validate_submission(submission: dict[str, Any]) -> list[dict[str, str]]:
    content_type = ContentType(submission["content_type"])
    file_format = submission["format"].lower().removeprefix(".")
    violations = []

    if (
        file_format not in ALLOWED_FORMATS[content_type]
        or submission["file_size_bytes"] > MAX_FILE_BYTES[content_type]
        or not MIN_DIMENSION <= submission["width"] <= MAX_DIMENSION
        or not MIN_DIMENSION <= submission["height"] <= MAX_DIMENSION
    ):
        violations.append(reason(ReasonCode.FILE_SPECIFICATION))

    attributes = {
        key.lower(): value.lower()
        for key, value in submission["svg_attributes"].items()
    }
    if content_type == ContentType.SVG and (
        attributes.get("fill-rule") == "evenodd" or "stroke" in attributes
    ):
        violations.append(reason(ReasonCode.FORBIDDEN_ATTRIBUTE))

    if content_type == ContentType.SVG and submission["element_count"] > MAX_ELEMENTS:
        violations.append(reason(ReasonCode.ELEMENT_COUNT))

    if submission["whitespace_ratio"] > MAX_WHITESPACE_RATIO:
        violations.append(reason(ReasonCode.WHITESPACE_RATIO))

    return violations


def create_app() -> FastAPI:
    app = FastAPI(title="DesignHub Phase 1 API")
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

    @app.post("/submission-validations")
    @synchronized
    def create_validation(request: ValidationCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("submission.validate", request.event_id, payload):
            return replay
        submission = store.submissions.get(request.submission_id)
        if submission is None:
            raise HTTPException(status_code=404, detail="submission not found")
        violations = validate_submission(submission)
        response = {
            "event_id": request.event_id,
            "submission_id": request.submission_id,
            "valid": not violations,
            "violations": violations,
        }
        store.validations[request.event_id] = response
        store.audit("submission.validated", request.event_id, request.submission_id)
        return store.remember(
            "submission.validate", request.event_id, payload, response
        )

    @app.post("/review-queue")
    @synchronized
    def add_to_review_queue(request: QueueCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("review.enqueue", request.event_id, payload):
            return replay
        validation = store.validations.get(request.validation_event_id)
        if validation is None or validation["submission_id"] != request.submission_id:
            raise HTTPException(status_code=404, detail="validation not found")
        if not validation["valid"]:
            raise HTTPException(
                status_code=409, detail="submission did not pass validation"
            )
        submission = store.submissions[request.submission_id]
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

    @app.post("/review-queue/sla-checks")
    @synchronized
    def check_review_queue_sla(request: SlaCheckCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("review.sla_checked", request.event_id, payload):
            return replay
        waits = [
            max(
                0.0,
                (request.checked_at - item["submitted_at"]).total_seconds() / 86_400,
            )
            for item in store.review_queue.values()
        ]
        longest_wait_days = max(waits, default=0.0)
        queue_size = len(store.review_queue)
        breaches = []
        if longest_wait_days > request.max_wait_days:
            breaches.append(
                {
                    "metric": "longest_wait_days",
                    "actual": longest_wait_days,
                    "threshold": request.max_wait_days,
                }
            )
        if queue_size > request.max_queue_size:
            breaches.append(
                {
                    "metric": "queue_size",
                    "actual": queue_size,
                    "threshold": request.max_queue_size,
                }
            )
        response = {
            "event_id": request.event_id,
            "longest_wait_days": longest_wait_days,
            "queue_size": queue_size,
            "breaches": breaches,
        }
        store.sla_checks[request.event_id] = response
        store.audit("review.sla_checked", request.event_id, "review-queue")
        return store.remember("review.sla_checked", request.event_id, payload, response)

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
            "reasons": [reason(code) for code in request.reasons],
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

        if request.kind == "rejection":
            reference = store.validations.get(
                request.reference_event_id
            ) or store.decisions.get(request.reference_event_id)
            if reference is None:
                raise HTTPException(
                    status_code=404, detail="rejection result not found"
                )
            submission = store.submissions[reference["submission_id"]]
            if request.recipient_id != submission["contributor_id"]:
                raise HTTPException(
                    status_code=409, detail="recipient does not own the submission"
                )
            reasons = reference.get("violations") or reference.get("reasons")
            if not reasons:
                raise HTTPException(
                    status_code=409, detail="reference has no rejection reasons"
                )
            details = " ".join(
                f"[{item['name']}] {item['guidance']}" for item in reasons
            )
            message = f"반려 사유: {details}"
        elif request.kind == "operator_alert":
            reference = store.sla_checks.get(request.reference_event_id)
            if reference is None:
                raise HTTPException(status_code=404, detail="SLA check not found")
            if not reference["breaches"]:
                raise HTTPException(status_code=409, detail="SLA check has no breaches")
            metrics = ", ".join(item["metric"] for item in reference["breaches"])
            message = f"심사 대기열 SLA 임계값을 초과했습니다: {metrics}"
        elif request.kind == "conversion_failure":
            reference = store.svg_conversions.get(request.reference_event_id)
            if reference is None:
                raise HTTPException(
                    status_code=404, detail="SVG conversion result not found"
                )
            if reference["success"]:
                raise HTTPException(
                    status_code=409, detail="SVG conversion did not fail"
                )
            submission = store.submissions.get(reference["submission_id"])
            if (
                submission is not None
                and request.recipient_id != submission["contributor_id"]
            ):
                raise HTTPException(
                    status_code=409, detail="recipient does not own the submission"
                )
            message = f"SVG 변환에 실패했습니다: {reference['error']}"
        else:
            reference = store.anomaly_checks.get(request.reference_event_id)
            if reference is None:
                raise HTTPException(status_code=404, detail="anomaly check not found")
            anomalies = reference["anomalies"].get(request.recipient_id)
            if not anomalies:
                raise HTTPException(
                    status_code=409, detail="recipient has no detected anomalies"
                )
            details = " ".join(
                f"[{item['name']}] {item['guidance']}" for item in anomalies
            )
            message = f"정산 이상 징후가 감지되었습니다: {details}"
        notification = {
            "event_id": request.event_id,
            "recipient_id": request.recipient_id,
            "kind": request.kind,
            "reference_event_id": request.reference_event_id,
            "message": message,
        }
        store.notifications[request.event_id] = notification
        store.audit("notification.sent", request.event_id, request.recipient_id)
        return store.remember(
            "notification.sent", request.event_id, payload, notification
        )

    @app.get("/notifications")
    def get_notifications() -> dict[str, list[dict[str, Any]]]:
        return {"items": list(store.notifications.values())}

    def detect_settlement_anomalies(
        current: dict[str, Any],
        previous: dict[str, Any] | None,
        revenue_ratio_threshold: float,
        usage_ratio_threshold: float,
    ) -> list[dict[str, str]]:
        anomalies: list[dict[str, str]] = []

        if previous is not None:
            previous_revenue = previous["revenue"]
            previous_usage = previous["usage_count"]

            if previous_usage > 0 and previous_revenue > 0 and current["revenue"] > 0:
                usage_ratio = current["usage_count"] / previous_usage
                revenue_ratio = current["revenue"] / previous_revenue
                if (
                    usage_ratio >= usage_ratio_threshold
                    and revenue_ratio <= revenue_ratio_threshold
                ):
                    anomalies.append(
                        {
                            "rule": "revenue_drop",
                            "name": "수익 급감",
                            "guidance": (
                                "이전 주기 대비 사용량은 유지되는데 수익이 급감했습니다. "
                                "정산 내역을 확인해 주세요."
                            ),
                        }
                    )

            if previous_revenue > 0 and current["revenue"] == 0:
                anomalies.append(
                    {
                        "rule": "zero_revenue",
                        "name": "0원 급변",
                        "guidance": (
                            "기존에 수익이 발생하던 콘텐츠가 이번 주기에 0원으로 "
                            "집계되었습니다."
                        ),
                    }
                )

        previous_statuses = (
            previous.get("content_statuses", {}) if previous is not None else {}
        )
        for content_id, status in current.get("content_statuses", {}).items():
            if (
                status == "unpublished"
                and previous_statuses.get(content_id) == "published"
            ):
                anomalies.append(
                    {
                        "rule": "content_unpublished",
                        "name": "비공개 처리",
                        "guidance": f"콘텐츠 '{content_id}'가 비공개 처리되었습니다.",
                    }
                )

        return anomalies

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

    @app.post("/settlement-anomaly-checks")
    @synchronized
    def check_settlement_anomalies(request: AnomalyCheckCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay(
            "settlement.anomaly_checked", request.event_id, payload
        ):
            return replay
        anomalies_by_contributor: dict[str, list[dict[str, str]]] = {}
        for (contributor_id, period), current in store.settlements.items():
            if period != request.period:
                continue
            previous = store.settlements.get((contributor_id, request.previous_period))
            anomalies = detect_settlement_anomalies(
                current,
                previous,
                request.revenue_ratio_threshold,
                request.usage_ratio_threshold,
            )
            if anomalies:
                anomalies_by_contributor[contributor_id] = anomalies
        response = {
            "event_id": request.event_id,
            "period": request.period,
            "anomalies": anomalies_by_contributor,
        }
        store.anomaly_checks[request.event_id] = response
        store.audit("settlement.anomaly_checked", request.event_id, request.period)
        return store.remember(
            "settlement.anomaly_checked", request.event_id, payload, response
        )

    @app.post("/settlement-statements")
    @synchronized
    def create_settlement_statement(
        request: SettlementStatementCreate,
    ) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("statement.generated", request.event_id, payload):
            return replay
        total = sum(int(item["amount"]) for item in request.usage_items)
        statement = {
            "statement_id": request.event_id,
            "contributor_id": request.contributor_id,
            "period": request.period,
            "usage_items": request.usage_items,
            "total": total,
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

    @app.post("/svg-conversions")
    @synchronized
    def create_svg_conversion(request: SvgConversionCreate) -> dict[str, Any]:
        payload = request.model_dump(mode="json")
        if replay := store.replay("svg.converted", request.event_id, payload):
            return replay
        svg_content = request.svg_content
        try:
            parse_path(svg_content)
        except ValueError as error:
            response = {
                "event_id": request.event_id,
                "submission_id": request.submission_id,
                "success": False,
                "converted_content": None,
                "error": f"SVG 경로를 파싱할 수 없습니다: {error}",
            }
            store.svg_conversions[request.event_id] = response
            store.audit("svg.converted", request.event_id, request.submission_id)
            return store.remember("svg.converted", request.event_id, payload, response)
        converted = convert_evenodd_to_nonzero(svg_content)
        mismatches = render_compare(svg_content, converted)
        if mismatches > 0:
            response = {
                "event_id": request.event_id,
                "submission_id": request.submission_id,
                "success": False,
                "converted_content": None,
                "error": "변환 전후 렌더링이 일치하지 않아 사람 검토가 필요합니다.",
            }
        else:
            response = {
                "event_id": request.event_id,
                "submission_id": request.submission_id,
                "success": True,
                "converted_content": converted,
                "error": None,
            }
        store.svg_conversions[request.event_id] = response
        store.audit("svg.converted", request.event_id, request.submission_id)
        return store.remember("svg.converted", request.event_id, payload, response)

    @app.get("/audit-events")
    def get_audit_events() -> dict[str, list[dict[str, str]]]:
        return {"items": store.audit_events}

    return app


app = create_app()
