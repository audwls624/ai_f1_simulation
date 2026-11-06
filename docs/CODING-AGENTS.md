# 코딩 에이전트 팀 운영 안내

LLM 팀은 각 모델의 코딩 에이전트로 참가한다 (DESIGN.md 9절 "LLM 팀 = 코딩 에이전트"). 이 문서는 팀을 어떻게 띄우고 무엇을 시키는지 정리한다.

## 흐름

1. 러너가 팀마다 워크스페이스를 만든다 (기본: OS 임시 디렉터리 아래 `f1sim-workspaces/<시즌>-s<시드>-<실행 ID>/<팀>/`, 레포 밖). 실행할 때 경로를 출력한다.
2. 호출(프리시즌 설계 1회 + GP마다 플랜 1회 = 시즌 25회)마다 러너가 `TASK.md`와 `packet.json`을 새로 쓴다. `BRIEF.md`(게임 설명), `schemas/`, `./f1sim`은 처음부터 있다.
3. 에이전트는 `./f1sim status | wind-tunnel | strategy-sim | submit`만으로 일한다. 횟수와 검증은 러너가 한다.
4. 제출이 받아들여지면 그 호출은 끝이다. 거절되면 오류 목록을 보고 한 번 더 낼 수 있다. 제한 시간은 호출마다 `response_timeout_s` (현재 600초), `./f1sim status`가 남은 초를 알려 준다.
5. 같은 단계의 팀 호출은 동시에 돈다 (2절: 팀 간 독립). 결과는 순서와 무관하게 같다.

에이전트에게 줄 지시는 모든 팀이 같다. 헤드리스 팀은 러너가 아래 문장을 `{prompt}` 자리에 넣어 준다. 수동 팀은 이 문장을 그대로 보낸다 (`<팀>`만 바꿔서):

```
You are team "<팀>" in the f1sim racing game, and the current directory is your team workspace. Read TASK.md and BRIEF.md, then complete the task using the ./f1sim command. Work only inside this directory.
```

## 라인업 (`apps/runner/teams.example.yaml`)

| 팀 | 도구 | 모델 | 방식 |
| --- | --- | --- | --- |
| opus | Claude Code | claude-opus-5-5 | 헤드리스 |
| sonnet | Claude Code | claude-sonnet-5-5 | 헤드리스 |
| fable | Claude Code | claude-fable-5-1 | 헤드리스 |
| astra | Codex CLI | gpt-6-astra | 헤드리스 |
| sol | Codex CLI | gpt-6.1-sol | 헤드리스 |
| terra | Codex CLI | gpt-6.1-terra | 헤드리스 |
| nemotron | OpenCode | Nemotron 3.5 Super (`opencode/nemotron-3.5-super-vl-free`) | 헤드리스 |
| deepseek | OpenCode | DeepSeek V4.1 Flash (`opencode/deepseek-v4.1-flash-free`, 로그인하면 `-free` 빼기) | 헤드리스 |
| glm | OpenCode | GLM-5.3 Flash (`opencode/glm-5.3-flash-free`, 로그인하면 `-free` 빼기) | 헤드리스 |
| flash | Antigravity CLI (`agy`) | Gemini 3.8 Flash (`gemini-3.8-flash-high`) | 헤드리스 |
| heuristic-01 | 휴리스틱 | — | 기준선 |

같은 도구의 팀(opus·sonnet·fable, astra·sol·terra)은 레드불과 레이싱 불스처럼 별개 팀이다. 뷰어 색은 팀 파일 순서로 8팀까지 — 9·10번째 코딩 에이전트 팀(glm, flash)과 휴리스틱은 회색에 약칭으로 구분한다. Grok 4.7(Cursor)은 첫 스파 시험에서 Cursor 무료 한도에 걸려 Nemotron으로 바꿨다. OpenCode Zen 무료 모델은 전부 "기간 한정"이고 사용량 한도는 공개돼 있지 않다 (opencode.ai/docs/zen). 포인트·순위·워크스페이스가 따로이고, 서로의 워크스페이스를 보면 안 된다.

## 도구별 준비

모든 헤드리스 도구는 미리 로그인해 둔다. 러너는 API 키를 다루지 않는다 — 인증은 각 도구의 것이다.

**Claude Code** (`claude`)
- 명령: `claude -p "{prompt}" --model <모델> --permission-mode acceptEdits --allowedTools "Bash(./f1sim:*)" "Bash(python3:*)" "Bash(node:*)"`
- 파일 편집은 자동 승인, 셸은 `./f1sim`과 분석 스크립트(python3·node)만. 다른 셸 명령은 거부된다.

**Codex CLI** (`codex`)
- 명령: `codex exec -m <모델> -s workspace-write --skip-git-repo-check "{prompt}"`
- `-m`에 astra / sol / terra의 실제 모델 이름을 넣는다 (`teams.example.yaml`의 TODO). 워크스페이스는 git 저장소가 아니라 `--skip-git-repo-check`가 필요하다. `workspace-write` 샌드박스는 워크스페이스 안에만 쓴다 — `./f1sim`은 파일로 통신하므로 네트워크가 막혀도 된다.

**Gemini CLI** (`gemini`) — 이번 라인업의 Flash는 Antigravity(수동)로 간다. 같은 모델을 헤드리스로 돌릴 때의 대안.
- 명령: `gemini -m <Flash 모델 ID> --approval-mode yolo -p "{prompt}"`
- `./f1sim` 실행에 셸 승인이 필요해 `yolo`다. 모든 도구 호출이 자동 승인되므로 이 팀은 지시(“이 디렉터리 안에서만”)에 더 기댄다. `-s`(샌드박스)를 쓸 수 있으면 붙인다.

**Grok** — Cursor에서 Grok 4.7로 (아래 Cursor 항목).

**Cursor** — IDE(수동) 또는 Cursor CLI(헤드리스).
- 수동: 팀 파일에서 `command`를 뺀다. 러너가 경로를 출력하면 Cursor에서 그 폴더를 열고(File → Open Folder) Agent 채팅에서 모델을 고른 뒤 지시 문장을 보낸다. 터미널 명령마다 승인을 묻는 설정이면 `./f1sim`을 허용 목록에 넣거나 자동 실행을 켠다 — 풍동 20회를 10분 안에 써야 한다.
- 헤드리스: Cursor CLI를 설치하고 로그인한 뒤 `command: [cursor-agent, -p, --force, --model, <모델>, "{prompt}"]`. (이 머신에 설치돼 있지 않아 플래그는 확인하지 못했다 — 1GP 시험으로 확인.)

**Antigravity** — 명령줄 도구 `agy`로 헤드리스 (IDE로 수동도 된다).
- 명령: `agy -p "{prompt}" --model gemini-3.8-flash-high --mode accept-edits --settings '{"permissions":{"allow":["command(./f1sim)","command(python3)","command(node)"]}}'`
- 헤드리스에서는 셸 명령 승인을 물을 수 없어 자동 거부된다. `--settings`의 허용 규칙(`command(<프로그램>)`, 인자는 무엇이든)은 그 실행에만 적용되고 settings.json에 저장되지 않는다. `--mode auto`는 이 계정에서 쓸 수 없었다. 모델 목록: `agy models`.
- IDE로 수동으로 할 때: 팀 파일에서 `command`를 빼고, 러너가 경로를 출력하면 Antigravity에서 그 폴더를 열어 모델을 고른 뒤 지시 문장을 보낸다. 터미널 명령마다 승인을 물으면 `./f1sim` 실행을 자동 허용으로 바꾼다 (설정 이름은 버전마다 다르다).

**OpenCode** (`opencode`) — 헤드리스. 명령줄용 `opencode`가 동작해야 한다 — 데스크톱 앱(`OpenCode.app`)만으로는 러너가 띄울 수 없다 (그때는 Cursor처럼 수동으로). 첫 스파 시험에서 이 머신의 `~/.opencode/bin/opencode`(2026-01 설치본)는 아무 출력 없이 바로 끝나 공식 설치 스크립트로 1.19.5를 다시 깔았다. 로그인(`opencode auth login`) 없이는 OpenCode Zen 무료판(`opencode/deepseek-v4.1-flash-free`, `opencode/glm-5.3-flash-free`)만 쓸 수 있고 유료 ID는 서버 오류로 실패한다.
- `command: [opencode, run, -m, <provider/model>, "{prompt}"]` (예: xAI 모델이면 `xai/<모델>`). 비대화 모드에서 셸·편집 권한 확인이 막히지 않도록 OpenCode 설정에서 이 워크스페이스의 bash·edit을 허용한다.
- 이 머신의 opencode는 비TTY에서 도움말을 출력하지 않아 플래그를 확인하지 못했다 — 1GP 시험으로 확인.

**수동 팀을 편하게:** `--workspaces <폴더>`로 워크스페이스 위치를 정하면 팀 폴더가 실행 내내 같다. IDE 창을 그 폴더에 열어 두고 호출마다 새 대화만 시작하면 된다 (`TASK.md`·`packet.json`이 호출마다 바뀐다). 시즌마다 새 폴더를 쓸 것 — 지난 시즌 메모가 남는다.

## 수동 팀 진행 (Cursor·Antigravity 같은 IDE 에이전트)

1. 러너 출력에서 그 팀 줄을 기다린다 (같은 단계의 수동 팀 줄은 동시에 나온다): `· grok GP 3 (...): open <경로> in the team's coding agent and ask it to follow TASK.md (time limit 10 min)`
2. 그 경로를 에이전트로 열고 위의 지시 문장을 보낸다. 시계는 러너가 이 줄을 낸 순간부터 돈다.
3. 에이전트가 `./f1sim submit`으로 내고 `Accepted`를 받으면 끝. 러너가 다음 단계로 간다.
4. 호출마다 새 대화로 시작한다. 헤드리스 팀도 매번 새 세션이라, 같은 대화를 이어 쓰면 기억에서 이득을 본다. 시즌 동안 남기고 싶은 것은 워크스페이스에 메모로 남긴다 (모든 팀이 같은 조건).

## 실행

```bash
# 시험: 스파 1 GP (호출 2회 × 팀). 루트에서 pnpm race = pnpm -F @f1sim/runner season --teams-file teams.example.yaml
pnpm race --tracks spa

# 시즌 전체 (24전, 팀당 25회)
pnpm -F @f1sim/runner season --teams-file teams.example.yaml

# 같은 계정으로 여러 팀을 동시에 돌리다 rate limit에 걸리면 동시 호출 수를 줄인다
pnpm -F @f1sim/runner season --teams-file teams.example.yaml --concurrency 4
```

- 결과: `runs/2026-s<시드>/` — `season.json`, GP별 `race.json`, `agents/<팀>.jsonl`(제출물·툴 호출·검증·지연).
- 에이전트 출력: 워크스페이스의 `.f1sim/logs/<번호>-<호출>.log`. 팀이 남긴 메모·스크립트도 워크스페이스에 있다.
- 재생: `agents/*.jsonl`의 제출물만으로 시즌이 바이트 단위로 재현된다 (`ReplayAgent`, 11절).

## 공정성 체크

- 모든 팀이 같은 `BRIEF.md`, 같은 패킷, 같은 지시 문장, 같은 툴 예산과 제한 시간을 받는다.
- 격리는 지시와 각 도구의 권한·샌드박스에 기댄다. 도구마다 막는 범위가 다르다 (Claude Code는 허용한 셸 명령만, Codex는 쓰기만 워크스페이스로 제한, Gemini `yolo`는 제한 없음). 다른 팀 워크스페이스나 레포(엔진 모델 계수)를 읽지 못하게 강제하려면 컨테이너 격리가 필요하다 — 나중 단계.
- 전략 시뮬의 라이벌은 아직 규정의 기본 스펙 + 기본 전략이다 (9절 "지난 GP 스펙 추정치"는 미구현). 순위 분포는 낙관적이고, 플랜 비교에는 평균 레이스 시간이 더 믿을 만하다.
