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


def create_submission(
    client: TestClient,
    submission_id: str = "submission-1",
    **overrides: object,
) -> dict[str, object]:
    response = client.post(
        "/submissions", json=submission(submission_id, **overrides)
    )
    assert response.status_code == 200
    return response.json()


def enqueue(
    client: TestClient,
    submission_id: str = "submission-1",
    event_id: str | None = None,
) -> dict[str, object]:
    response = client.post(
        "/review-queue",
        json={
            "event_id": event_id or f"enqueue-{submission_id}",
            "submission_id": submission_id,
        },
    )
    assert response.status_code == 200
    return response.json()


def notification_payload(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "event_id": "notify-1",
        "recipient_id": "recipient-1",
        "kind": "rejection",
        "reference_event_id": "external-result-1",
        "message": "Workflow supplied this exact message.",
    }
    data.update(overrides)
    return data


def statement_payload(**overrides: object) -> dict[str, object]:
    data: dict[str, object] = {
        "event_id": "statement-1",
        "contributor_id": "contributor-1",
        "period": "2026-09",
        "usage_items": [
            {
                "content_id": "content-1",
                "usage_count": 10,
                "unit_price": 100,
                "amount": 1000,
            }
        ],
        "total": 777,
    }
    data.update(overrides)
    return data


def test_health(client: TestClient) -> None:
    assert client.get("/health").json() == {"status": "ok"}


def test_automation_endpoints_are_removed(client: TestClient) -> None:
    assert client.post("/submission-validations", json={}).status_code == 404
    assert client.post("/review-queue/sla-checks", json={}).status_code == 404
    assert client.post("/settlement-anomaly-checks", json={}).status_code == 404


def test_removed_models_are_absent_from_openapi(client: TestClient) -> None:
    schemas = client.get("/openapi.json").json()["components"]["schemas"]

    assert "ValidationCreate" not in schemas
    assert "SlaCheckCreate" not in schemas
    assert "AnomalyCheckCreate" not in schemas
    assert set(schemas["QueueCreate"]["properties"]) == {"event_id", "submission_id"}


def test_submission_stores_and_returns_raw_state(client: TestClient) -> None:
    created = create_submission(
        client,
        format="unexpected-but-stored",
        file_size_bytes=10_000_001,
        svg_attributes={"stroke": "#000"},
        element_count=1001,
        whitespace_ratio=0.51,
    )

    stored = client.get("/submissions/submission-1")
    assert stored.status_code == 200
    assert stored.json() == created["submission"]
    assert stored.json()["format"] == "unexpected-but-stored"
    assert stored.json()["element_count"] == 1001


def test_submission_requires_timezone(client: TestClient) -> None:
    response = client.post(
        "/submissions",
        json=submission(submitted_at="2026-09-01T00:00:00"),
    )

    assert response.status_code == 422


def test_submission_missing(client: TestClient) -> None:
    assert client.get("/submissions/missing").status_code == 404


def test_submission_is_idempotent_and_rejects_conflicting_event_reuse(
    client: TestClient,
) -> None:
    payload = submission()

    first = client.post("/submissions", json=payload)
    replay = client.post("/submissions", json=payload)
    conflict = client.post(
        "/submissions", json={**payload, "submission_id": "submission-2"}
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflict.status_code == 409


def test_review_queue_accepts_existing_submission_without_validation(
    client: TestClient,
) -> None:
    create_submission(client, format="not-api-policy", element_count=50_000)

    item = enqueue(client)

    assert item == {
        "event_id": "enqueue-submission-1",
        "submission_id": "submission-1",
        "contributor_id": "contributor-1",
        "submitted_at": "2026-09-01T00:00:00Z",
        "replayed": False,
    }
    assert client.get("/review-queue").json()["items"] == [
        {key: value for key, value in item.items() if key != "replayed"}
    ]


def test_review_queue_rejects_missing_submission(client: TestClient) -> None:
    response = client.post(
        "/review-queue",
        json={"event_id": "enqueue-missing", "submission_id": "missing"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "submission not found"
    assert client.get("/review-queue").json() == {"items": []}


def test_review_queue_is_idempotent_and_rejects_conflicting_event_reuse(
    client: TestClient,
) -> None:
    create_submission(client, "submission-1")
    create_submission(client, "submission-2")
    payload = {"event_id": "enqueue-1", "submission_id": "submission-1"}

    first = client.post("/review-queue", json=payload)
    replay = client.post("/review-queue", json=payload)
    conflict = client.post(
        "/review-queue", json={**payload, "submission_id": "submission-2"}
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflict.status_code == 409
    assert len(client.get("/review-queue").json()["items"]) == 1


def test_concurrent_review_queue_retries_have_one_side_effect(
    client: TestClient,
) -> None:
    create_submission(client)
    payload = {"event_id": "enqueue-concurrent", "submission_id": "submission-1"}

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(
            executor.map(lambda _: client.post("/review-queue", json=payload), range(8))
        )

    assert sum(not response.json()["replayed"] for response in responses) == 1
    assert len(client.get("/review-queue").json()["items"]) == 1
    audits = client.get("/audit-events").json()["items"]
    assert sum(event["action"] == "review.enqueued" for event in audits) == 1


@pytest.mark.parametrize(
    ("decision", "reasons"),
    [("rejected", []), ("approved", ["visual_quality"])],
)
def test_review_decision_enforces_reason_invariants(
    client: TestClient,
    decision: str,
    reasons: list[str],
) -> None:
    create_submission(client)
    enqueue(client)

    response = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-1",
            "submission_id": "submission-1",
            "decision": decision,
            "reasons": reasons,
        },
    )

    assert response.status_code == 422


def test_review_decision_returns_reason_codes_only(client: TestClient) -> None:
    create_submission(client)
    enqueue(client)

    response = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-1",
            "submission_id": "submission-1",
            "decision": "rejected",
            "reasons": ["copyright_risk", "visual_quality"],
        },
    )

    assert response.status_code == 200
    assert response.json()["reasons"] == ["copyright_risk", "visual_quality"]
    assert client.get("/review-queue").json() == {"items": []}


def test_review_decision_rejects_unknown_reason(client: TestClient) -> None:
    create_submission(client)
    enqueue(client)

    response = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-1",
            "submission_id": "submission-1",
            "decision": "rejected",
            "reasons": ["workflow_defined_reason"],
        },
    )

    assert response.status_code == 422


def test_review_decision_requires_queued_submission(client: TestClient) -> None:
    create_submission(client)

    response = client.post(
        "/review-decisions",
        json={
            "event_id": "decision-1",
            "submission_id": "submission-1",
            "decision": "approved",
            "reasons": [],
        },
    )

    assert response.status_code == 404


@pytest.mark.parametrize(
    "kind",
    [
        "rejection",
        "operator_alert",
        "anomaly_alert",
        "conversion_failure",
        "settlement_statement",
    ],
)
def test_notification_stores_exact_workflow_supplied_values(
    client: TestClient,
    kind: str,
) -> None:
    payload = notification_payload(
        event_id=f"notify-{kind}",
        kind=kind,
        recipient_id="unresolved-recipient",
        reference_event_id="unknown-external-reference",
        message=f"Exact {kind} message: do not rewrite.",
    )

    response = client.post("/notifications", json=payload)

    assert response.status_code == 200
    assert response.json() == {**payload, "replayed": False}
    assert client.get("/notifications").json()["items"] == [payload]


@pytest.mark.parametrize("message", [None, ""])
def test_notification_requires_non_empty_message(
    client: TestClient,
    message: str | None,
) -> None:
    payload = notification_payload()
    if message is None:
        del payload["message"]
    else:
        payload["message"] = message

    assert client.post("/notifications", json=payload).status_code == 422


def test_notification_is_idempotent_and_rejects_event_reuse(client: TestClient) -> None:
    payload = notification_payload()

    first = client.post("/notifications", json=payload)
    replay = client.post("/notifications", json=payload)
    conflict = client.post(
        "/notifications", json={**payload, "message": "Different message"}
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflict.status_code == 409
    assert len(client.get("/notifications").json()["items"]) == 1


def test_concurrent_notification_retries_have_one_side_effect(
    client: TestClient,
) -> None:
    payload = notification_payload(event_id="notify-concurrent")

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(
            executor.map(
                lambda _: client.post("/notifications", json=payload), range(8)
            )
        )

    assert sum(not response.json()["replayed"] for response in responses) == 1
    assert len(client.get("/notifications").json()["items"]) == 1
    audits = client.get("/audit-events").json()["items"]
    assert sum(event["action"] == "notification.sent" for event in audits) == 1


def test_settlement_stores_raw_data_and_lists_by_period(client: TestClient) -> None:
    august = {
        "event_id": "settlement-august",
        "contributor_id": "contributor-1",
        "period": "2026-08",
        "revenue": 1000,
        "usage_count": 10,
        "content_statuses": {"content-1": "published"},
        "usage_items": [{"content_id": "content-1", "amount": 1000}],
    }
    september = {
        **august,
        "event_id": "settlement-september",
        "period": "2026-09",
        "revenue": 0,
        "usage_count": 20,
        "content_statuses": {"content-1": "unpublished"},
    }

    assert client.post("/settlements", json=august).status_code == 200
    assert client.post("/settlements", json=september).status_code == 200

    assert client.get("/settlements", params={"period": "2026-09"}).json() == {
        "items": [{key: value for key, value in september.items() if key != "event_id"}]
    }
    assert len(client.get("/settlements").json()["items"]) == 2


def test_settlement_is_idempotent_and_rejects_conflicting_record(
    client: TestClient,
) -> None:
    payload = {
        "event_id": "settlement-1",
        "contributor_id": "contributor-1",
        "period": "2026-09",
        "revenue": 1000,
        "usage_count": 10,
    }

    first = client.post("/settlements", json=payload)
    replay = client.post("/settlements", json=payload)
    conflicting_record = client.post(
        "/settlements",
        json={**payload, "event_id": "settlement-2", "revenue": 2000},
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflicting_record.status_code == 409


def test_statement_stores_exact_completed_statement(client: TestClient) -> None:
    payload = statement_payload(total=777)

    response = client.post("/settlement-statements", json=payload)

    assert response.status_code == 200
    assert response.json() == {
        "statement_id": "statement-1",
        "contributor_id": "contributor-1",
        "period": "2026-09",
        "usage_items": payload["usage_items"],
        "total": 777,
        "replayed": False,
    }
    fetched = client.get("/settlement-statements/statement-1")
    assert fetched.json() == {
        key: value for key, value in response.json().items() if key != "replayed"
    }


@pytest.mark.parametrize("total", [-1, 1.5, "1"])
def test_statement_total_requires_nonnegative_integer(
    client: TestClient,
    total: object,
) -> None:
    response = client.post(
        "/settlement-statements", json=statement_payload(total=total)
    )

    assert response.status_code == 422


def test_statement_accepts_zero_total_and_empty_usage_items(client: TestClient) -> None:
    payload = statement_payload(total=0, usage_items=[])

    response = client.post("/settlement-statements", json=payload)

    assert response.status_code == 200
    assert response.json()["total"] == 0
    assert response.json()["usage_items"] == []


def test_statement_missing(client: TestClient) -> None:
    assert client.get("/settlement-statements/missing").status_code == 404


def test_statement_is_idempotent_and_rejects_event_reuse(client: TestClient) -> None:
    payload = statement_payload()

    first = client.post("/settlement-statements", json=payload)
    replay = client.post("/settlement-statements", json=payload)
    conflict = client.post(
        "/settlement-statements", json={**payload, "total": 778}
    )

    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert conflict.status_code == 409
    assert client.get("/settlement-statements/statement-1").status_code == 200


def test_concurrent_statement_retries_have_one_side_effect(client: TestClient) -> None:
    payload = statement_payload(event_id="statement-concurrent")

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(
            executor.map(
                lambda _: client.post("/settlement-statements", json=payload), range(8)
            )
        )

    assert sum(not response.json()["replayed"] for response in responses) == 1
    audits = client.get("/audit-events").json()["items"]
    assert sum(event["action"] == "statement.generated" for event in audits) == 1


def test_api_owned_side_effects_are_auditable(client: TestClient) -> None:
    create_submission(client)
    enqueue(client)
    client.post(
        "/review-decisions",
        json={
            "event_id": "decision-1",
            "submission_id": "submission-1",
            "decision": "approved",
            "reasons": [],
        },
    )
    client.post("/notifications", json=notification_payload())
    client.post(
        "/settlements",
        json={
            "event_id": "settlement-1",
            "contributor_id": "contributor-1",
            "period": "2026-09",
            "revenue": 1000,
            "usage_count": 10,
        },
    )
    client.post("/settlement-statements", json=statement_payload())

    actions = [
        event["action"] for event in client.get("/audit-events").json()["items"]
    ]
    assert actions == [
        "submission.created",
        "review.enqueued",
        "review.decided",
        "notification.sent",
        "settlement.recorded",
        "statement.generated",
    ]
