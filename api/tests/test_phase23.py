from fastapi.testclient import TestClient


def create_settlement(
    client: TestClient,
    contributor_id: str,
    period: str,
    revenue: int,
    usage_count: int,
    content_statuses: dict[str, str] | None = None,
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
        },
    )
    assert response.status_code == 200


def test_revenue_drop_detected_when_usage_stable(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 5000, 100)

    response = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-1",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    )

    assert response.status_code == 200
    anomalies = response.json()["anomalies"]
    assert "c1" in anomalies
    assert [a["rule"] for a in anomalies["c1"]] == ["revenue_drop"]


def test_zero_revenue_detected(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 0, 100)

    response = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-2",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    )

    anomalies = response.json()["anomalies"]["c1"]
    assert [a["rule"] for a in anomalies] == ["zero_revenue"]


def test_unpublished_content_detected(client: TestClient) -> None:
    create_settlement(
        client,
        "c1",
        "2026-08",
        10000,
        100,
        content_statuses={"content-1": "published"},
    )
    create_settlement(
        client,
        "c1",
        "2026-09",
        10000,
        100,
        content_statuses={"content-1": "unpublished"},
    )

    response = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-3",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    )

    anomalies = response.json()["anomalies"]["c1"]
    assert [a["rule"] for a in anomalies] == ["content_unpublished"]


def test_no_anomaly_for_normal_data(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 12000, 120)

    response = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-4",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    )

    assert response.json()["anomalies"] == {}


def test_revenue_drop_uses_threshold_parameters(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 8000, 80)

    response = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-5",
            "period": "2026-09",
            "previous_period": "2026-08",
            "revenue_ratio_threshold": 0.9,
            "usage_ratio_threshold": 0.7,
        },
    )

    anomalies = response.json()["anomalies"]["c1"]
    assert [a["rule"] for a in anomalies] == ["revenue_drop"]


def test_anomaly_alert_notification(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 0, 100)

    check = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-6",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    ).json()

    response = client.post(
        "/notifications",
        json={
            "event_id": "notify-anomaly",
            "recipient_id": "c1",
            "kind": "anomaly_alert",
            "reference_event_id": check["event_id"],
        },
    )
    assert response.status_code == 200
    assert "정산 이상 징후" in response.json()["message"]
    assert "0원 급변" in response.json()["message"]


def test_anomaly_alert_rejects_unaffected_recipient(client: TestClient) -> None:
    create_settlement(client, "c1", "2026-08", 10000, 100)
    create_settlement(client, "c1", "2026-09", 0, 100)

    check = client.post(
        "/settlement-anomaly-checks",
        json={
            "event_id": "anomaly-7",
            "period": "2026-09",
            "previous_period": "2026-08",
        },
    ).json()

    response = client.post(
        "/notifications",
        json={
            "event_id": "notify-anomaly-2",
            "recipient_id": "c2",
            "kind": "anomaly_alert",
            "reference_event_id": check["event_id"],
        },
    )
    assert response.status_code == 409


def test_statement_generation_and_retrieval(client: TestClient) -> None:
    response = client.post(
        "/settlement-statements",
        json={
            "event_id": "statement-1",
            "contributor_id": "c1",
            "period": "2026-09",
            "usage_items": [
                {
                    "content_id": "content-1",
                    "usage_count": 10,
                    "unit_price": 100,
                    "amount": 1000,
                },
                {
                    "content_id": "content-2",
                    "usage_count": 5,
                    "unit_price": 200,
                    "amount": 1000,
                },
            ],
        },
    )
    assert response.status_code == 200
    statement = response.json()
    assert statement["total"] == 2000
    assert len(statement["usage_items"]) == 2

    fetched = client.get("/settlement-statements/statement-1")
    assert fetched.status_code == 200
    assert fetched.json()["contributor_id"] == "c1"


def test_statement_missing(client: TestClient) -> None:
    assert client.get("/settlement-statements/nonexistent").status_code == 404


def test_svg_conversion_success(client: TestClient) -> None:
    donut = "M 0 0 L 100 0 L 100 100 L 0 100 Z M 10 10 L 90 10 L 90 90 L 10 90 Z"
    response = client.post(
        "/svg-conversions",
        json={
            "event_id": "svg-1",
            "submission_id": "submission-1",
            "svg_content": donut,
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert result["success"] is True
    assert result["converted_content"] is not None
    assert result["error"] is None


def test_svg_conversion_single_shape_success(client: TestClient) -> None:
    response = client.post(
        "/svg-conversions",
        json={
            "event_id": "svg-2",
            "submission_id": "submission-1",
            "svg_content": "M 0 0 L 100 0 L 100 100 L 0 100 Z",
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert result["success"] is True
    assert result["converted_content"] is not None


def test_svg_conversion_parse_failure(client: TestClient) -> None:
    response = client.post(
        "/svg-conversions",
        json={
            "event_id": "svg-3",
            "submission_id": "submission-1",
            "svg_content": "not a valid svg path with evenodd",
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert result["success"] is False
    assert result["error"] is not None
