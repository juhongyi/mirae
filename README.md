# mirae

미리캔버스 디자인허브 기여자 파이프라인 자동화 PoC. 목표와 범위는 [PRD.md](./PRD.md), 배경 문제는 [PROBLEM.md](./PROBLEM.md)를 참고한다.

이 저장소는 제품 기능을 한 번에 구현하지 않고, Phase별로 점진적으로 채워 넣을 수 있는 모노레포 골격만 제공한다. 현재 단계에는 실행 가능한 제품 코드가 없다.

## 구조

```text
.
├── api/                        # 내부 API 계약을 모사하는 스텁 서버 (Python)
│   ├── pyproject.toml
│   ├── src/                    # 구현 위치 (비어 있음)
│   └── tests/                  # 스텁 서버 테스트 위치 (비어 있음)
├── n8n/                        # 오케스트레이션 (n8n)
│   ├── workflows/              # 워크플로우 정의 위치 (비어 있음)
│   └── tests/                  # 워크플로우 검증 위치 (비어 있음)
├── compose.yaml                # 개발 환경
├── pyproject.toml              # uv workspace 및 도구 설정
└── uv.lock
```

각 경계의 책임은 하나로 유지한다.

| 경계 | 책임 |
| --- | --- |
| `api/` | 규칙 검증, 이상치 판정, SVG 변환처럼 입력에 대해 결정적인 결과를 내는 로직과 그 계약 |
| `n8n/` | "언제 무엇을 호출해 무엇을 연결하는가"라는 오케스트레이션 |

## 개발 환경

모든 개발은 [compose.yaml](./compose.yaml)의 Compose 환경에서 실행한다.

```sh
docker compose up -d
docker compose exec api uv sync --all-packages
docker compose exec api uv run ruff check .
docker compose exec api uv run pytest
```

- `api` 서비스는 Python 3.13과 uv가 설치된 개발 컨테이너다.
- `n8n` 서비스는 http://localhost:5678 에서 접근하며, `n8n/workflows/`를 `/workflows`로 마운트한다.
- 포트가 충돌하면 다른 컨테이너에 영향을 주지 않도록 임시 포트로 덮어쓴다.

```sh
API_PORT=18000 N8N_PORT=15678 docker compose up -d
```

## 확장 원칙

- Phase별 기능은 `api/src`, `api/tests`, `n8n/workflows`, `n8n/tests`에 추가한다.
- 결정 로직은 n8n 워크플로우가 아니라 `api/`에 두고 단위 테스트로 검증한다.
- 자동화 실패·보류 시 사람 처리로 원복할 수 있는 폴백 경로를 유지한다.
