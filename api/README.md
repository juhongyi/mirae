# DesignHub Phase 1 API

기여자 콘텐츠의 기계적 사전 검증, 심사 대기열 관리, SLA 초과 감지, 심사 결정 및 알림을 제공하는 Phase 1 스텁 API다. 창작성과 품질에 대한 판단은 자동화하지 않으며, 상태는 프로세스 메모리에 저장된다.

## 처리 흐름

1. `POST /submissions`로 제출물을 등록한다.
2. `POST /submission-validations`로 등록된 제출물을 검증한다.
3. 검증을 통과하면 `POST /review-queue`로 심사 대기열에 추가한다.
4. 검증에 실패하면 검증 이벤트를 참조해 `POST /notifications`로 반려 알림을 생성한다.
5. `POST /review-queue/sla-checks`로 대기 시간과 대기열 크기를 확인하고, 임계값을 초과한 경우 검사 이벤트를 참조해 운영자 알림을 생성한다.
6. `POST /review-decisions`로 사람 심사 결과를 기록하고, 반려된 경우 결정 이벤트를 참조해 반려 알림을 생성한다.

## 엔드포인트

| Method | Path | 설명 |
| --- | --- | --- |
| `GET` | `/health` | API 상태를 확인한다. |
| `POST` | `/submissions` | 제출물과 검증에 필요한 메타데이터를 등록한다. |
| `GET` | `/submissions/{submission_id}` | 등록된 제출물을 조회한다. |
| `POST` | `/submission-validations` | 파일 규격, 금지 속성, 요소 개수, 여백 비율을 검증한다. |
| `POST` | `/review-queue` | 검증을 통과한 제출물을 심사 대기열에 추가한다. |
| `GET` | `/review-queue` | 현재 심사 대기열을 조회한다. |
| `POST` | `/review-queue/sla-checks` | 최장 대기 시간과 대기열 크기의 임계값 초과 여부를 판정한다. |
| `POST` | `/review-decisions` | 승인 또는 구체적인 반려 사유를 기록하고 대기열에서 제거한다. |
| `POST` | `/notifications` | 반려 결과 또는 SLA 초과 결과를 템플릿 메시지로 생성한다. |
| `GET` | `/notifications` | 생성된 알림을 조회한다. |
| `GET` | `/audit-events` | 제출, 검증, 대기열, 심사, 알림 처리 이력을 조회한다. |

FastAPI가 생성하는 전체 요청 및 응답 스키마는 `/docs` 또는 `/openapi.json`에서 확인할 수 있다.

## 제출물 필드

`POST /submissions`는 다음 핵심 값을 받는다.

| 필드 | 설명 |
| --- | --- |
| `event_id` | 멱등성 판정에 사용하는 이벤트 식별자 |
| `submission_id` | 제출물 식별자 |
| `contributor_id` | 제출한 기여자 식별자 |
| `content_type` | `svg` 또는 `image` |
| `format` | 파일 형식 |
| `width`, `height` | 픽셀 기준 크기 |
| `file_size_bytes` | 바이트 기준 파일 크기 |
| `svg_attributes` | SVG 속성 이름과 값 |
| `element_count` | SVG 디자인 요소 개수 |
| `whitespace_ratio` | `0`부터 `1` 사이의 여백 비율 |
| `submitted_at` | timezone을 포함한 ISO 8601 제출 시각 |

## 검증 정책

| 항목 | SVG | 이미지 |
| --- | --- | --- |
| 허용 형식 | `svg` | `png`, `jpg`, `jpeg` |
| 최대 파일 크기 | 150 KiB | 10 MiB |
| 가로·세로 범위 | 100~10,000 px | 100~10,000 px |
| 금지 속성 | `fill-rule="evenodd"`, `stroke` | 적용하지 않음 |
| 최대 요소 개수 | 1,000 | 적용하지 않음 |
| 최대 여백 비율 | 0.5 | 0.5 |

검증은 중단 없이 모든 위반을 정의된 순서대로 반환한다. 검증을 통과한 결과를 참조한 요청만 심사 대기열에 추가할 수 있다.

## SLA 정책

`POST /review-queue/sla-checks`의 기본 임계값은 최장 대기 10일, 대기열 20건이다. 실제 값이 임계값을 초과할 때만 `breaches`에 `longest_wait_days` 또는 `queue_size`가 포함된다. 요청의 `checked_at`은 timezone을 포함해야 한다.

## 반려 사유

| 코드 | 명칭 |
| --- | --- |
| `file_specification` | 파일 규격 |
| `forbidden_attribute` | 금지 속성 |
| `element_count` | 요소 개수 |
| `whitespace_ratio` | 여백 비율 |
| `copyright_risk` | 저작권 위험 |
| `visual_quality` | 시각 품질 기준 |

반려 결정에는 하나 이상의 사유가 필요하고 승인 결정에는 반려 사유를 포함할 수 없다. 반려 알림은 검증 또는 심사 결정에 저장된 사유의 명칭과 수정 안내를 동일한 템플릿으로 조합한다. 알림 수신자는 해당 제출물의 `contributor_id`와 일치해야 한다.

## 멱등성과 상태

모든 `POST` 요청은 전역적으로 고유한 `event_id`를 사용한다. 성공한 요청과 같은 `event_id`, 같은 요청 본문을 다시 보내면 기존 결과와 `replayed: true`를 반환한다. 성공한 요청에 사용한 `event_id`를 다른 요청에 사용하면 `409 Conflict`를 반환한다.

제출물, 검증 결과, 대기열, 심사 결정, 알림, 감사 기록과 멱등성 정보는 프로세스 메모리에만 유지되며 프로세스를 다시 시작하면 초기화된다.

## 오류

| 상태 | 의미 |
| --- | --- |
| `404 Not Found` | 제출물, 검증 결과, 심사 대상 또는 참조 이벤트가 존재하지 않음 |
| `409 Conflict` | 식별자 충돌, 검증 실패 제출물의 대기열 등록, 잘못된 알림 대상 또는 알림 조건 불충족 |
| `422 Unprocessable Entity` | 필수 필드, 값 범위, timezone 또는 심사 결정 규칙이 올바르지 않음 |
