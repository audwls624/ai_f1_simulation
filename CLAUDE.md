# f1sim — AI 팀 F1 전략 시뮬레이션

## 이 프로젝트
AI 모델(나중에는 사람)이 팀이 되어 같은 규정으로 차를 설계하고 GP 전에 셋업과 전략을 제출하면,
결정적 엔진이 예선과 레이스를 돌린다. 레이스 중 AI 호출은 없다.
상세 설계는 docs/DESIGN.md. 문서와 코드가 다르면 문서가 기준이다.
문서가 틀렸다고 판단되면 코드를 바꾸지 말고 먼저 말할 것.

## 불변 규칙
- packages/core는 순수 함수만. window, document, process, fs, fetch, console,
  Date, Math.random 금지. 난수는 core/rng만.
- 같은 시드 + 같은 입력 = 바이트 단위로 같은 출력. 모든 반복은 결정적 순서
  (차량 인덱스 순, 객체 키 순회 금지).
- 레이스 중 에이전트 호출 없음. 분기는 strategy.ts의 규칙 평가로만.
- 숫자 상수는 data/regulations/2026.yaml에. 코드에 매직 넘버 금지.
- 스키마는 zod 단일 소스. 타입은 z.infer로만 파생. 알 수 없는 필드는 거부(strict).
- 공개 API나 스키마를 바꾸면 docs/DESIGN.md의 해당 절도 같이 수정.

## 작업 방식
- 마일스톤 단위 (DESIGN.md 13절). 현재: M2.
- 모듈마다 테스트를 함께. pnpm test와 pnpm lint가 통과하기 전에는 완료 아님.
- 모르는 값은 추측하지 말고 yaml에 기본값 + `// TODO(balance)` 주석. 하네스가 조정한다.
- 작업 끝에 3–5줄로: 무엇을 만들었나, 문서와 달라진 점, 다음 세션 제안.

## 명령
pnpm install · pnpm test · pnpm lint · pnpm -F @f1sim/core build
하네스: pnpm -F @f1sim/harness design (12절 설계 탐색 → packages/harness/reports/) · pnpm -F @f1sim/harness gen-tracks

## 하지 말 것
- core에 I/O, 로깅, console.
- 테스트를 통과시키려고 테스트를 약화.
- 문서에 없는 규정·파라미터·DSL 어휘 추가. 제안은 환영, 구현은 승인 후.
- 현재 마일스톤 밖의 모듈 만들기.
