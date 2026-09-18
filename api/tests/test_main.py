from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


def submission(
    submission_id: str = "submission-1",
    **overrides: object,
) -> dict[str, object]:
    data: dict[str, object] = {
        "event_id": f"create-{submission_id}",
        "submission_id": submission_id,
        "contributor_id": "contributor-1",
        "content_type": "svg",
        "format": "svg",
        "width": 1000,
        "height": 1000,
        "file_size_bytes": 100_000,
        "svg_attributes": {},
        "element_count": 100,
        "whitespace_ratio": 0.2,
        "submitted_at": "2026-09-01T00:00:00Z",
    }
    data.update(overrides)
    return data


def create_and_validate(
    client: TestClient,
    submission_id: str = "submission-1",
    **overrides: object,
) -> dict[str, object]:
    assert (
        client.post(
            "/submissions", json=submission(submission_id, **overrides)
        ).status_code
        == 200
    )
    response = client.post(
        "/submission-validations",
        json={"event_id": f"validate-{submission_id}", "submission_id": submission_id},
    )
    assert response.status_code == 200
    return response.json()


def enqueue(
    client: TestClient, submission_id: str = "submission-1"
) -> dict[str, object]:
    response = client.post(
        "/review-queue",
        json={
            "event_id": f"enqueue-{submission_id}",
            "submission_id": submission_id,
            "validation_event_id": f"validate-{submission_id}",
        },
    )
    assert response.status_code == 200
    return response.json()


def create_settlement(
    client: TestClient,
    contributor_id: str,
    period: str,
    revenue: int,
    usage_count: int,
    content_statuses: dict[str, str] | None = None,
    usage_items: list[dict[str, int | float | str]] | None = None,
    event_id: str | None = None,
) -> None:
    response = client.post(
        "/settlements",
        json={
            "event_id": event_id or f"settle-{contributor_id}-{period}",
            "contributor_id": contributor_id,
            "period": period,
            "revenue": revenue,
            "usage_count": usage_count,
            "content_statuses": content_statuses or {},
            "usage_items": usage_items or [],
        },
    )
    assert response.status_code == 200


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_validation_returns_every_violation_in_rule_order(client: TestClient) -> None:
    result = create_and_validate(
        client,
        format="png",
        file_size_bytes=153_601,
        svg_attributes={"fill-rule": "evenodd", "stroke": "#000"},
        element_count=1001,
        whitespace_ratio=0.51,
    )

    assert result["valid"] is False
    assert [violation["rule"] for violation in result["violations"]] == [
        "file_specification",
        "forbidden_attribute",
        "element_count",
        "whitespace_ratio",
    ]
    assert all(
        violation["name"] and violation["guidance"]
        for violation in result["violations"]
    )


def test_validation_accepts_policy_boundaries(client: TestClient) -> None:
    result = create_and_validate(
        client,
        file_size_bytes=153_600,
        element_count=1000,
        whitespace_ratio=0.5,
    )

    assert result["valid"] is True
    assert result["violations"] == []


def test_image_ignores_svg_only_rules(client: TestClient) -> None:
    result = create_and_validate(
        client,
        content_type="image",
        format="png",
        svg_attributes={"fill-rule": "evenodd", "stroke": "#000"},
        element_count=1001,
    )

    assert result["valid"] is True


def test_timestamps_require_timezone(client: TestClient) -> None:
    response = client.post(
        "/submissions",
        json=submission(submitted_at="2026-09-01T00:00:00"),
    )
    assert response.status_code == 422

    create_and_validate(client, "aware")
    enqueue(client, "aware")
    response = client.post(
        "/review-queue/sla-checks",
        json={"event_id": "sla-naive", "checked_at": "2026-09-12T00:00:00"},
    )
    assert response.status_code == 422


def test_only_validated_submissions_enter_review_queue(client: TestClient) -> None:
    valid_result = create_and_validate(client, "valid")
    invalid_result = create_and_validate(client, "invalid", element_count=1001)

    assert valid_result["valid"] is True
    assert enqueue(client, "valid")["submission_id"] == "valid"

    response = client.post(
        "/review-queue",
        json={
            "event_id": "enqueue-invalid",
            "submission_id": "invalid",
            "validation_event_id": invalid_result["event_id"],
        },
    )
    assert response.status_code == 409
    assert [
        item["submission_id"] for item in client.get("/review-queue").json()["items"]
    ] == ["valid"]


def test_sla_check_alerts_only_above_thresholds(client: TestClient) -> None:
    create_and_validate(client)
    enqueue(client)

    boundary = client.post(
        "/review-queue/sla-checks",
        json={
            "event_id": "sla-boundary",
            "checked_at": "2026-09-11T00:00:00Z",
            "max_wait_days": 10,
            "max_queue_size": 1,
        },
    ).json()
    breached = client.post(
        "/review-queue/sla-checks",
        json={
            "event_id": "sla-breached",
            "checked_at": "2026-09-12T00:00:00Z",
            "max_wait_days": 10,
            "max_queue_size": 0,
        },
    ).json()

    assert boundary["breaches"] == []
    assert [breach["metric"] for breach in breached["breaches"]] == [
        "longest_wait_days",
        "queue_size",
    ]

    fractional_breach = client.post(
        "/review-queue/sla-checks",
        json={
            "event_id": "sla-fractional-breach",
            "checked_at": "2026-09-11T00:00:01Z",
            "max_wait_days": 10,
            "max_queue_size": 1,
        },
    ).json()
    assert [breach["metric"] for breach in fractional_breach["breaches"]] == [
        "longest_wait_days"
    ]

    no_alert = client.post(
        "/notifications",
        json={
            "event_id": "notify-normal-sla",
            "recipient_id": "operator",
            "kind": "operator_alert",
            "reference_event_id": "sla-boundary",
        },
    )
    alert = client.post(
        "/notifications",
        json={
            "event_id": "notify-breached-sla",
            "recipient_id": "operator",
            "kind": "operator_alert",
            "reference_event_id": "sla-breached",
        },
    )
    assert no_alert.status_code == 409
    assert alert.status_code == 200


def test_automatic_and_human_rejections_use_notification_templates(
    client: TestClient,
) -> None:
    automatic = create_and_validate(client, "automatic", element_count=1001)
    wrong_recipient = client.post(
        "/notifications",
        json={
            "event_id": "notify-wrong-recipient",
            "recipient_id": "contributor-2",
            "kind": "rejection",
            "reference_event_id": automatic["event_id"],
        },
    )
    assert wrong_recipient.status_code == 409

    automatic_notification = client.post(
        "/notifications",
        json={
            "event_id": "notify-automatic",
            "recipient_id": "contributor-1",
            "kind": "rejection",
            "reference_event_id": automatic["event_id"],
        },
    )
    assert automatic_notification.status_code == 200
    assert "요소 개수" in automatic_notification.json()["message"]

    same_reason = create_and_validate(client, "same-reason", element_count=1001)
    same_notification = client.post(
        "/notifications",
        json={
            "event_id": "notify-same-reason",
            "recipient_id": "contributor-1",
            "kind": "rejection",
            "reference_event_id": same_reason["event_id"],
        },
    )
    assert (
        same_notification.json()["message"] == automatic_notification.json()["message"]
    )

    create_and_validate(client, "human")
    enqueue(client, "human")
    decision = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-human",
            "submission_id": "human",
            "decision": "rejected",
            "reasons": ["copyright_risk"],
        },
    )
    assert decision.status_code == 200
    human_notification = client.post(
        "/notifications",
        json={
            "event_id": "notify-human",
            "recipient_id": "contributor-1",
            "kind": "rejection",
            "reference_event_id": "decision-human",
        },
    )
    assert human_notification.status_code == 200
    assert "저작권 위험" in human_notification.json()["message"]


def test_approved_decision_rejects_rejection_reasons(client: TestClient) -> None:
    create_and_validate(client)
    enqueue(client)

    response = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-approved",
            "submission_id": "submission-1",
            "decision": "approved",
            "reasons": ["visual_quality"],
        },
    )

    assert response.status_code == 422


def test_notification_is_idempotent_and_rejects_event_reuse(client: TestClient) -> None:
    validation = create_and_validate(client, element_count=1001)
    payload = {
        "event_id": "notify-1",
        "recipient_id": "contributor-1",
        "kind": "rejection",
        "reference_event_id": validation["event_id"],
    }

    first = client.post("/notifications", json=payload)
    replay = client.post("/notifications", json=payload)
    conflict = client.post(
        "/notifications", json={**payload, "recipient_id": "contributor-2"}
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflict.status_code == 409
    assert len(client.get("/notifications").json()["items"]) == 1


def test_concurrent_notification_retries_have_one_side_effect(
    client: TestClient,
) -> None:
    validation = create_and_validate(client, element_count=1001)
    payload = {
        "event_id": "notify-concurrent",
        "recipient_id": "contributor-1",
        "kind": "rejection",
        "reference_event_id": validation["event_id"],
    }

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(
            executor.map(
                lambda _: client.post("/notifications", json=payload), range(8)
            )
        )

    assert sum(not response.json()["replayed"] for response in responses) == 1
    assert len(client.get("/notifications").json()["items"]) == 1
    notification_audits = [
        event
        for event in client.get("/audit-events").json()["items"]
        if event["action"] == "notification.sent"
    ]
    assert len(notification_audits) == 1


def test_actions_are_auditable(client: TestClient) -> None:
    create_and_validate(client)
    enqueue(client)

    events = client.get("/audit-events").json()["items"]
    assert [event["action"] for event in events] == [
        "submission.created",
        "submission.validated",
        "review.enqueued",
    ]


def test_settlements_list_by_period(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c2", "2026-08", 5000, 50)
    create_settlement(client, "c1", "2026-09", 8000, 80)

    august = client.get("/settlements", params={"period": "2026-08"})
    assert august.status_code == 200
    assert {item["contributor_id"] for item in august.json()["items"]} == {"c1", "c2"}

    all_items = client.get("/settlements")
    assert len(all_items.json()["items"]) == 3


def test_anomaly_alert_notification(client: TestClient) -> None:
    response = client.post(
        "/notifications",
        json={
            "event_id": "notify-anomaly",
            "recipient_id": "c1",
            "kind": "anomaly_alert",
            "detail": "[0원 급변] 콘텐츠 'content-1'가 이번 주기에 0원으로 집계되었습니다.",
        },
    )
    assert response.status_code == 200
    assert "정산 이상 징후" in response.json()["message"]
    assert "0원 급변" in response.json()["message"]


def test_anomaly_alert_requires_detail(client: TestClient) -> None:
    response = client.post(
        "/notifications",
        json={
            "event_id": "notify-anomaly-missing-detail",
            "recipient_id": "c1",
            "kind": "anomaly_alert",
        },
    )
    assert response.status_code == 422


def test_settlement_statement_notification(client: TestClient) -> None:
    response = client.post(
        "/notifications",
        json={
            "event_id": "statement-1",
            "recipient_id": "c1",
            "kind": "settlement_statement",
            "detail": "2026-08 정산 명세 (합계 2000원)\ncontent-1 x10 @100 = 1000",
        },
    )
    assert response.status_code == 200
    assert "2026-08 정산 명세" in response.json()["message"]
    assert "content-1 x10 @100 = 1000" in response.json()["message"]


def test_settlement_statement_requires_detail(client: TestClient) -> None:
    response = client.post(
        "/notifications",
        json={
            "event_id": "statement-missing-detail",
            "recipient_id": "c1",
            "kind": "settlement_statement",
        },
    )
    assert response.status_code == 422


def test_conversion_failure_notification_accepts_workflow_error(
    client: TestClient,
) -> None:
    response = client.post(
        "/notifications",
        json={
            "event_id": "svg-1:conversion-failure",
            "recipient_id": "contributor-1",
            "kind": "conversion_failure",
            "detail": "SVG 경로를 파싱할 수 없습니다.",
        },
    )

    assert response.status_code == 200
    assert response.json()["message"] == (
        "SVG 변환에 실패했습니다: SVG 경로를 파싱할 수 없습니다."
    )
