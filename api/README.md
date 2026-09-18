# DesignHub Mock API

이 서비스는 n8n 워크플로우가 호출할 미리디 내부 애플리케이션을 모사한다. 제출물·심사 대기열·정산 원천 데이터를 제공하고, 워크플로우가 결정한 대기열 등록·심사 결과 기록·알림 발송·정산 명세 저장을 수행한다. 규칙 검증, SLA 계산, 정산 이상치 탐지, 메시지와 명세 생성은 n8n 워크플로우의 책임이다.

상태는 프로세스 메모리에만 저장되며 프로세스를 다시 시작하면 초기화된다.

## 책임 경계

| 구성요소 | 책임 |
| --- | --- |
| mock API | 원천 데이터 저장·조회, 요청된 부수 효과 실행, 멱등성, API 감사 기록 |
| n8n | 규칙 평가, 집계, 임계값 판정, 메시지·명세 생성, 분기와 후속 작업 선택 |

## 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/health` | API 상태를 확인한다. |
| `POST` | `/submissions` | 제출물과 자동화에 필요한 원천 메타데이터를 등록한다. |
| `GET` | `/submissions/{submission_id}` | 등록된 제출물을 조회한다. |
| `POST` | `/review-queue` | 워크플로우가 선택한 제출물을 심사 대기열에 추가한다. |
| `GET` | `/review-queue` | 현재 심사 대기열 원천 데이터를 조회한다. |
| `POST` | `/review-decisions` | 사람 심사 결과를 기록하고 대기열에서 제거한다. |
| `POST` | `/notifications` | 워크플로우가 완성한 메시지를 발송·저장한다. |
| `GET` | `/notifications` | 발송된 알림을 조회한다. |
| `POST` | `/settlements` | 기여자·주기별 정산 원천 데이터를 등록한다. |
| `GET` | `/settlements` | 정산 원천 데이터를 조회한다. `period` 쿼리로 필터링할 수 있다. |
| `POST` | `/settlement-statements` | 워크플로우가 완성한 상세 명세를 저장한다. |
| `GET` | `/settlement-statements/{statement_id}` | 저장된 명세를 조회한다. |
| `GET` | `/audit-events` | API가 수행한 부수 효과의 감사 기록을 조회한다. |

`/submission-validations`, `/review-queue/sla-checks`, `/settlement-anomaly-checks`는 제공하지 않는다. 해당 판단은 n8n 워크플로우가 원천 데이터를 이용해 수행한다.

## 주요 계약

### 심사 대기열

`POST /review-queue`는 `event_id`와 `submission_id`를 받는다. API는 제출물의 존재를 확인하고 대기열에 저장하며, 자동 검증 통과 여부를 다시 판정하지 않는다.

### 심사 결정

`POST /review-decisions`는 `approved` 또는 `rejected` 결정을 기록한다. 반려에는 하나 이상의 사유 코드가 필요하고 승인에는 반려 사유를 포함할 수 없다. API는 사유 코드를 그대로 반환하며, 구체적인 안내 문구는 n8n이 구성한다.

지원하는 사유 코드는 `file_specification`, `forbidden_attribute`, `element_count`, `whitespace_ratio`, `copyright_risk`, `visual_quality`다.

### 알림

`POST /notifications`는 다음 값을 받는다.

| 필드 | 설명 |
| --- | --- |
| `event_id` | 멱등성 식별자 |
| `recipient_id` | 수신자 식별자 |
| `kind` | `rejection`, `operator_alert`, `anomaly_alert`, `conversion_failure`, `settlement_statement` 중 하나 |
| `reference_event_id` | 워크플로우 실행 결과나 도메인 이벤트의 상관관계 식별자 |
| `message` | 워크플로우가 완성한 비어 있지 않은 메시지 |

API는 참조 이벤트를 해석하거나 메시지를 다시 작성하지 않는다.

### 정산 데이터와 명세

정산 데이터에는 기여자, 주기, 수익, 사용 횟수, 콘텐츠 공개 상태와 건별 사용 내역이 포함된다. n8n은 현재·과거 데이터를 비교해 이상 징후를 찾고 건별 `amount`를 합산해 명세를 완성한다.

`POST /settlement-statements`는 `event_id`, `contributor_id`, `period`, `usage_items`, `total`을 받으며 전달된 명세를 그대로 저장한다. `total`은 0 이상의 정수다.

## 멱등성과 오류

모든 `POST` 요청은 전역적으로 고유한 `event_id`를 사용한다. 같은 `event_id`와 같은 본문을 재전송하면 기존 결과와 `replayed: true`를 반환한다. 이미 사용한 `event_id`를 다른 요청이나 본문에 사용하면 `409 Conflict`를 반환한다.

| 상태 | 의미 |
| --- | --- |
| `404 Not Found` | 제출물, 심사 대상 또는 명세가 존재하지 않음 |
| `409 Conflict` | 식별자나 저장 상태가 충돌함 |
| `422 Unprocessable Entity` | 필수 필드, 값 범위, timezone 또는 도메인 불변식이 올바르지 않음 |

전체 요청 및 응답 스키마는 `/docs` 또는 `/openapi.json`에서 확인할 수 있다.
