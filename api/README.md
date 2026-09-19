| Method | Path | 도메인 | 설명 |
| --- | --- | --- | --- |
| `GET` | `/health` | 공통 | API 상태를 확인한다. |
| `POST` | `/submissions` | 업로드 | 제출물과 원천 메타데이터를 등록한다. |
| `GET` | `/submissions/{submission_id}` | 업로드 | 등록된 제출물을 조회한다. |
| `POST` | `/review-queue` | 심사 | 제출물을 심사 대기열에 추가한다. |
| `GET` | `/review-queue` | 심사 | 현재 심사 대기열을 조회한다. |
| `POST` | `/review-decisions` | 심사 | 심사 결과를 기록하고 대기열에서 제거한다. |
| `POST` | `/notifications` | 통보 | 완성된 메시지를 발송·저장한다. |
| `GET` | `/notifications` | 통보 | 발송된 알림을 조회한다. |
| `POST` | `/settlements` | 정산 | 기여자·주기별 정산 데이터를 등록한다. |
| `GET` | `/settlements` | 정산 | 정산 데이터를 조회한다. |
| `POST` | `/settlement-statements` | 정산 | 완성된 정산 명세를 저장한다. |
| `GET` | `/settlement-statements/{statement_id}` | 정산 | 저장된 명세를 조회한다. |
| `GET` | `/audit-events` | 공통 | 부수 효과 감사 기록을 조회한다. |
