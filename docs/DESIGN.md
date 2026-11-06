# AI F1 게임 — 공통 컴포넌트 설계

Nov 4, 2026 · @myeongjin yang

## 1. 개요와 설계 원칙

AI 모델(나중에는 사람)이 팀이 되어, 같은 규정과 같은 정보로 차를 설계하고 레이스 전략을 사전에 제출하면, 결정적 시뮬레이션 엔진이 시즌을 돌려 승부를 가리는 게임이다. 운전 실력이 아니라 설계와 작전의 판단력으로 겨룬다.

이 문서는 모든 팀이 공유하는 공통 컴포넌트만 다룬다: 규정, 차량 스키마, 트랙·날씨 모델, 랩타임·레이스 엔진, 사전 전략 DSL, 에이전트 프로토콜, 로그 포맷. LLM 어댑터와 프롬프트, 3D 렌더러, 사람 팀 UI는 이 위에 얹는 별도 레이어다.

**설계 원칙**

1. **엔진은 순수 함수.** 입력(차량 스펙, 셋업, 전략, 시드) → 출력(결과, 로그). 엔진 안에는 I/O도 LLM 호출도 없다. 그래서 LLM 없이 수천 번 돌려 밸런스를 잡을 수 있다.
2. **레이스 중 에이전트 개입 없음.** 설계·셋업·전략은 전부 GP 전(예선 전)에 제출한다. 예선 결과에 따른 분기도 플랜 안에 미리 적는다. 세이프티카나 비 같은 상황 분기는 전략 DSL의 조건 규칙으로만 표현하고, 엔진이 그 규칙을 실행한다.
3. **같은 정보, 같은 툴.** 모든 팀은 동일한 정보 패킷과 동일한 횟수의 풍동·전략 시뮬 툴을 받는다. 팀 간 차이는 판단에서만 나온다.
4. **같은 시드 + 같은 입력 = 같은 결과.** 리플레이, 디버깅, 공정성 시비 해결의 전제다.
5. **공통 컴포넌트는 팀의 종류를 모른다.** LLM, 휴리스틱, 사람은 에이전트 프로토콜 뒤에서만 구분된다. 사람 팀 추가는 에이전트 구현체 하나를 더하는 일이어야 한다.

원칙 2는 비용과 단순성을 사는 대신 표현력을 내준다. 레이스 중 즉흥 판단은 불가능하고, 팀이 예상하지 못한 상황은 엔진 폴백이 처리한다. 이 제약이 게임을 "전략 프로그래밍" 쪽으로 밀어주며, 사람 팀에게도 같은 규칙이 적용된다.

## 2. 시즌 흐름과 에이전트 개입 시점

에이전트는 시즌에 세 종류의 호출만 받는다: 설계 1회, 업그레이드 2회, GP 직전 사전 플랜 1회. 24전 기준 팀당 27회이고, GP 주말(예선·레이스)은 호출 없이 엔진만 돌아간다.

| 단계 | 엔진이 하는 일 | 에이전트 호출 | 입력 | 출력 |
| --- | --- | --- | --- | --- |
| 프리시즌 | 규정·캘린더 공개, 풍동 20회 제공 | `design_car` | 규정, 트랙 프로파일 24개, 풍동 툴 | `CarSpec` |
| 업그레이드 윈도우 (GP 8, 16 직전) | 남은 크레딧 사용 허용, 풍동 5회 | `upgrade_car` | 현재 스펙, 순위, 남은 예산 | `CarSpec` (연속 항목만 변경) |
| GP 직전 | 트랙·날씨 예보·타이어 배분 공개, 전략 시뮬 5회 제공 | `plan_gp` | 트랙 프로파일, 예보, 타이어 배분, 자기 차 풍동 요약, 현재 순위 | `GPPlan` = `Setup` + 그리드 조건별 `RacePlan` 변형 |
| GP 주말 ① 예선 | 1랩 페이스 계산 → 그리드 | 없음 |  | 그리드 |
| GP 주말 ② 레이스 | 그리드로 변형 선택 → 랩 루프, 규칙 평가, 이벤트 실현 | 없음 |  | `RaceLog`, 결과 |
| 시즌 집계 | 포인트 합산, 순위 | 없음 |  | `Standings` |

예선 결과를 보고 전략을 고치는 호출은 없다. 대신 `GPPlan`이 그리드 위치 조건별 전략 변형을 담는다: "5위 이내면 A, 아니면 B". 엔진이 예선 후 첫 매치 변형을 고른다. 라이벌의 예선 타임은 제출 시점에 모르므로 변형 조건은 자기 그리드 위치만 쓴다. "예선 잘 타면 지키고, 못 타면 다른 타이어로 역전"이라는 판단이 이 구조 안에서 그대로 표현된다.

모든 호출은 팀 간 독립이다. 엔진은 전 팀의 제출물을 모두 받은 뒤에만 다음 단계를 실행하므로, 호출 순서나 응답 속도가 결과에 영향을 주지 않는다. 응답 제한 시간(기본 10분)을 넘기면 폴백 제출물로 처리한다.

## 3. 규정 (Regulations)

규정은 코스트 캡 100 크레딧과 항목별 볼록 비용 곡선으로 설계 공간을 제한하고, 나머지는 연료 유량·최소 무게·타이어 의무 같은 고정 제약이다. 값은 시즌 단위로만 바꾸고 두 파일에 둔다: 팀이 알고 계획하는 공개 규정은 `regulations/2026.yaml`(정보 패킷의 "규정 전문"은 이것뿐), 엔진 안쪽의 물리·확률 계수는 `model/2026.yaml`(비공개 — 4절의 파생치·5절의 세그먼트처럼 풍동과 전략 시뮬로만 간접 노출).

**코스트 캡과 비용 곡선**

- 총 예산 100 크레딧. 프리시즌 설계와 시즌 중 업그레이드를 합산한다. 남기는 것도 전략이다.
- 연속 파라미터는 0.0–1.0. 비용은 `w_i · x^p` (초기값 p = 2). 낮은 수준은 싸고 마지막 구간이 비싸서 "몰빵 vs 고르게"가 실제 선택이 된다. p는 밸런스 하네스가 정한다.
- 아키텍처 선택(에어로 철학, 휠베이스)은 비용 0, 시즌 중 변경 불가.

| 파라미터 | 가중치 w (크레딧, x=1.0 기준) | 업그레이드 가능 |
| --- | --- | --- |
| aero\_efficiency | 34 | 예 |
| thermal\_efficiency | 31 | 예 |
| weight\_reduction | 24 | 예 |
| mech\_grip | 20 | 예 |
| tire\_management | 17 | 예 |
| ers\_capacity | 14 | 예 |
| reliability | 14 | 예 |
| cooling | 10 | 예 |
| dirty\_air\_resistance | 10 | 예 |
| drs\_effect | 7 | 예 |
| philosophy (floor/wing) | 0 | 아니오 |
| wheelbase (short/long) | 0 | 아니오 |

가중치 합은 181이므로 전부 1.0은 불가능하고, 모든 항목을 같은 값으로 두면 0.74에서 캡(100)에 닿는다. 이 값들은 밸런스 하네스(12절)가 조정한다 — M2에서 출발값(합 106, 비율은 그대로)을 ×1.7 했다. 합 106이면 cooling 하나만 빼고 전부 1.0이 가능해서 배분 선택이 사라졌다 (harness/reports/2026-11-06-design-baseline.md).

**고정 제약**

- 연료 유량 상한 100 kg/h. 출력은 여기에 걸려 있어서 `thermal_efficiency`가 출력과 연비를 동시에 결정한다.
- 최소 무게 798 kg. `weight_reduction` 1.0이 최소 무게, 0.0은 +30 kg.
- 건조 레이스에서 두 종류 이상의 드라이 컴파운드 사용 의무. 위반 시 +30초.
- 타이어 배분: GP당 soft 8, medium 3, hard 2, inter 4, wet 3 세트. 예선은 soft 1세트 소모.
- 풍동 20회(프리시즌), 5회(업그레이드 윈도우마다), 전략 시뮬 5회(GP마다). 실제 F1의 ATR처럼 횟수 자체가 규정이다.

**포인트와 벌점**

- 포인트: 25-18-15-12-10-8-6-4-2-1. 패스티스트 랩 포인트는 없다.
- 스펙 검증 실패(예산 초과, 범위 이탈, 스키마 오류): 오류 메시지와 함께 1회 재제출 → 그래도 실패면 기본 스펙 + 첫 GP 그리드 최후위.
- 전략 검증 실패: 1회 재제출 → 실패 시 기본 전략(1스톱 medium→hard).
- 응답 시간 초과: 검증 실패와 동일 처리.

벌점을 게임의 일부로 두는 이유는, 어떤 모델은 스키마를 잘 안 지키고 그것도 팀 역량의 일부로 보는 게 공정하기 때문이다.

## 4. 차량 스펙 (CarSpec)과 셋업 (Setup)

차량은 연속 파라미터 10개와 아키텍처 선택 2개로 정의한다. 엔진은 이 입력을 파생 성능치로 변환하고, 랩타임 모델은 파생치만 본다. 파생치는 에이전트에게 직접 노출하지 않고 풍동 결과로만 간접 노출한다.

**파워트레인**

| 파라미터 | 올리면 | 대가 |
| --- | --- | --- |
| thermal\_efficiency | 출력↑, 랩당 연료↓ (시작 무게↓) | 비용 급증, 고장률 소폭↑ |
| reliability | 랩당 고장 확률↓ | 비용, 출력 약간↓ (보수적 맵) |
| ers\_capacity | 랩당 회수/방출 에너지↑ → 추월·방어 보너스 | 배터리 무게↑ |
| cooling | 기온 30°C 이상에서 출력 유지 | 라디에이터 개구부 → 드래그↑ |

**섀시**

| 파라미터 | 올리면 | 대가 |
| --- | --- | --- |
| weight\_reduction | 최소 무게까지 감량 (kg당 0.03 s/lap) | 비용 볼록 곡선 |
| mech\_grip | 저속 코너, 트랙션, 연석·범프 대응 | 비용 |
| tire\_management | 마모율↓ → 긴 스틴트 | 워밍업 느림 → 예선 1랩과 레이스 초반 2랩 페널티 |
| wheelbase (short / long) | long: 고속 안정성 + 에어로 플랫폼 / short: 저속 민첩 | 서킷마다 유불리 반전, 변경 불가 |

**에어로**

| 파라미터 | 올리면 | 대가 |
| --- | --- | --- |
| aero\_efficiency | 같은 다운포스에서 드래그↓ (L/D 곡선 자체가 좋아짐) | 가장 비싼 항목 |
| philosophy (floor / wing) | floor: 효율 좋음 / wing: 안정적 | floor는 셋업 윈도우가 좁고 범프·지상고에 민감, 변경 불가 |
| dirty\_air\_resistance | 앞차 뒤에서 다운포스 손실↓ → 추월 능력 | 비용 |
| drs\_effect | DRS 열었을 때 드래그 감소폭↑ | 효율 약간↓ |

**셋업 (GP마다)**

| 항목 | 범위 | 효과 |
| --- | --- | --- |
| wing\_level | 0–10 | 다운포스와 드래그를 효율 곡선 위에서 동시에 올림 |
| ride\_height | low / mid / high | floor는 low에서만 효율 발휘, 범피 트랙에서 low는 불안정 페널티 |
| ers\_mode | harvest / balanced / attack | attack: 랩타임↓ 추월↑, 에너지 고갈 시 랩 후반 손실 |

**파생 성능치 (엔진 내부)**

`derive(spec, setup, track) → DerivedPerf`: `power_kw`, `mass_kg`, `drag_coeff`, `downforce_coeff`, `mech_grip`, `fuel_per_lap_kg`, `deg_multiplier`, `warmup_penalty_s`, `failure_rate_per_lap`, `heat_derate`, `dirty_air_loss`, `drs_gain`, `ers_boost`. 랩타임·레이스 모델은 이 구조체만 입력으로 받는다. 스펙 파라미터가 바뀌어도 파생치 인터페이스가 같으면 하위 모델은 안 건드린다.

**상호작용 (초기 3개만)**

1. `cooling` × 기온: 30°C 이상에서 `cooling` 부족분만큼 출력 디레이팅 + 고장률↑. 캘린더를 보고 판단해야 하는 이유가 생긴다.
2. `philosophy=floor` × (`mech_grip` < 0.5 또는 범피 트랙): 불안정 페널티 (랩타임 +, 마모 ×1.15). "플로어 차는 섀시도 좋아야 한다"를 풍동으로 발견하거나, 모르고 지르거나.
3. `tire_management` × 예선: 높을수록 워밍업이 느려 예선 페이스를 잊는다. 레이스 페이스와 예선 페이스를 분리하는 전략 축.

상호작용은 밸런스가 잡힌 뒤에만 추가한다. 처음부터 많이 넣으면 밸런스 잡다가 끝난다.

**제출 예시**

```json
{
  "powertrain": {"thermal_efficiency": 0.72, "reliability": 0.60, "ers_capacity": 0.80, "cooling": 0.40},
  "chassis":    {"weight_reduction": 0.90, "mech_grip": 0.70, "tire_management": 0.50, "wheelbase": "long"},
  "aero":       {"aero_efficiency": 0.85, "philosophy": "floor", "dirty_air_resistance": 0.30, "drs_effect": 0.60}
}
```

## 5. 트랙·날씨 모델

트랙의 원본 데이터는 센터라인 스플라인 하나다. 랩타임 모델이 쓰는 세그먼트도, 3D 렌더러가 그리는 노면도 같은 스플라인에서 파생되므로 계산과 화면이 항상 일치한다.

**원본 데이터**

- `tracks/<name>.csv`: 센터라인 점열 `(x, y, z)` + 좌우 폭. 출처는 공개 데이터셋(TUMFTM racetrack-database 등, 라이선스 확인 필요) 또는 직접 제작.
- `tracks/<name>.yaml`: 랩 수, 피트 손실 시간, 피트 입구·출구 거리, DRS 구간, 세이프티카 기본 확률, 노면 마모도, 범프, 기온 분포, 연중 강우 확률.
- 피트레인은 별도 스플라인. 계산에는 손실 시간만 쓰고, 렌더러가 경로로 쓴다.

**세그먼트 파생 (전처리 1회, 캐시)**

1. 센터라인을 호길이 기준으로 재샘플링하고 (5 m 간격) 곡률 계산.
2. 곡률 < 임계값 구간은 직선, 그 외는 코너. 연속된 코너 샘플은 하나로 합치고 반경 = 1 / 평균 곡률.
3. 결과: `[Straight(length), Corner(radius, length), ...]`. 세그먼트마다 시작 거리 `s0`를 보관해서 로그의 거리 샘플과 매핑한다.

코너 분류는 리플레이와 프로파일용이다: 반경 < 50 m 저속, 50–150 m 중속, > 150 m 고속.

**트랙 프로파일 (에이전트 공개용)**

| 필드 | 의미 |
| --- | --- |
| length\_km, laps | 길이, 레이스 랩 수 |
| straight\_ratio | 전체 길이 중 직선 비율 |
| corners\_low / mid / high | 속도별 코너 수 |
| overtake\_difficulty | 0–1, 추월 확률 식의 입력 |
| abrasiveness | 0–1, 마모율 승수 |
| bumpiness | 0–1, floor·low ride height 페널티 입력 |
| temp\_mean, temp\_sd | 기온 분포 (°C) |
| sc\_rate | 랩당 세이프티카 발생 확률 |
| pit\_loss\_s | 피트스톱 총 손실 시간 |
| rain\_base\_prob | 강우 기본 확률 |

프로파일은 엔진이 쓰는 세그먼트에서 계산해서 내보낸다. 에이전트가 세그먼트 원본을 보지 못하게 하는 건 의도적이다. 풍동이 그 간극을 메우는 툴이다.

**날씨**

- 예보 (전략 제출 전 공개): 10랩 윈도우별 강우 확률 + 기온. 예: `[{laps: [1,10], rain_p: 0.1}, {laps: [11,20], rain_p: 0.4}, ...]`.
- 실현 (레이스 시드의 weather 스트림): 윈도우별로 강우 시작·종료 랩을 추출. 예보와 실현은 일치하지 않을 수 있고, 그게 전략 규칙이 존재하는 이유다.
- 노면 상태: `dry → damp → wet` 전이. 강우 시작 후 2랩에 damp, 5랩에 wet. 강우 종료 후 역순. 노면 상태는 전략 규칙의 트리거로 쓰인다. (구현: 젖음 카운터 — 비 오는 랩 +1, 마른 랩 −1.)
- 트랙의 `rain_base_prob`는 "레이스에 비가 올 확률"이다. 윈도우 W개면 윈도우당 평균 1 − (1 − p)^(1/W)에 로그정규 노이즈(이웃 윈도우끼리 상관)를 곱해 예보를 만든다 (M3).
- 기온은 레이스 시작 시 1회 추출, 레이스 중 고정. `cooling` 상호작용의 입력.

## 6. 랩타임·타이어·연료 모델

랩타임은 세그먼트 단위로 계산한다. 풀 물리 시뮬은 함정이고, 코너 한계 속도와 직선 가속만 맞으면 설계 트레이드오프가 랩타임 차이로 나타나기에 충분하다.

**기본 랩타임 `base_lap(perf, track, surface)`**

깨끗한 공기, 새 타이어, 연료 0 기준. 세그먼트를 순서대로 돌면서 진입 속도를 넘긴다.

- 코너 한계 속도: μ\_eff·g·r = v², μ\_eff = mech\_grip + downforce\_coeff·v² / (mass·g). v가 양변에 있으므로 닫힙해로 풀거나 2–3회 반복. 진입 속도가 한계보다 높으면 직선 끝에서 제동 (제동 감속도 상수).
- 직선: dv/dt = (P/v − ½ρ·Cd·A·v²) / mass. Δs = 5 m로 수치 적분. 최고속은 P = ½ρ·Cd·A·v³의 해. DRS 구간에서 Cd에 `(1 − drs_gain)`.
- 코너 출구 트랙션: 저속 코너 출구 가속에 `mech_grip` 계수를 곱한다. 저속 서킷에서 섀시가 중요해지는 경로.
- 노면: damp는 μ ×0.8, wet은 ×0.65. 잘못된 컴파운드는 여기에 추가 페널티.

**레이스 랩타임**

```
lap = base_lap
    + tire_offset(compound) + deg(compound, life)
    + 0.03 * fuel_mass_kg
    + pace_delta(mode)
    + dirty_air(gap_ahead, dirty_air_loss)
    + warmup(tire_age, warmup_penalty_s)
    + N(0, σ_noise)        # 기본 0.12 s
```

**타이어**

| 컴파운드 | 오프셋 (s/lap) | 마모율/랩 (life) | 클리프 (life) | 워밍업 랩 |
| --- | --- | --- | --- | --- |
| soft | −0.8 | 0.045 | 0.25 | 0 |
| medium | 0.0 | 0.030 | 0.20 | 1 |
| hard | +0.5 | 0.020 | 0.15 | 2 |
| inter | dry +4.0 / damp 0.0 / wet +1.5 | 0.035 (dry에서 ×3) | 0.20 | 0 |
| wet | dry +8.0 / damp +2.0 / wet 0.0 | 0.030 (dry에서 ×4) | 0.20 | 0 |

- `life`는 1.0에서 시작해 랩마다 `마모율 × abrasiveness × deg_multiplier × pace_wear × (1 + 0.1·dirty_air)`만큼 줄어든다. `deg_multiplier`는 `tire_management`에서 파생 (1.0 → 0.6).
- `deg()`: life가 클리프 위에서는 선형 (최대 +1.0 s), 클리프 아래에서는 +1.5 s에서 가파르게 증가. life 0 = 강제 피트 (7절 폴백).
- 다운포스가 높으면 슬라이딩이 줄어 마열 소폭 감소: `× (1 − 0.1·wing_level/10)`. 셋업과 전략을 연결하는 고리.

**연료**

- 시작 연료 = `laps × fuel_per_lap_kg(thermal_efficiency, pace)` + 여유 2 kg. 팀이 정하지 않고 엔진이 계산한다 (연료 미달은 게임 요소로 넣지 않는다).
- 랩당 소모는 페이스 모드에 따라 변함. 0.03 s/kg/lap은 F1 통상값.

**페이스 모드**

| 모드 | 랩타임 | 마모 | 연료 | 고장률 |
| --- | --- | --- | --- | --- |
| push | −0.3 s | ×1.3 | ×1.1 | ×1.5 |
| normal | 0 | ×1.0 | ×1.0 | ×1.0 |
| conserve | +0.3 s | ×0.75 | ×0.9 | ×0.8 |

여기 숫자는 전부 `regulations/2026.yaml`에 두고 코드에 박지 않는다. 밸런스 하네스가 바꾸는 대상이다.

## 7. 예선과 레이스 엔진

예선과 레이스는 `GPPlan`과 시드만 받아 끝까지 돌아간다. 레이스 루프는 랩 단위이고, 랩 안에서의 처리 순서는 고정이다.

**예선**

- `quali_lap = base_lap(soft) + warmup_penalty_s + N(0, 0.15)`. 한 번만 계산한다. Q1–Q3 세션은 나중 확장.
- 예선 후 엔진이 각 팀의 `GPPlan.variants`를 위에서부터 평가해 그리드 조건에 처음 맞는 `RacePlan`을 고정한다. 맞는 게 없으면 마지막 변형(default)을 쓴다.

**스타트**

그리드 순서에 작은 노이즈를 더해 1랩 진입 순서를 정한다 (`N(0, 0.8)` 포지션 값으로 정렬). 스타트 모델은 일부러 단순하게 둔다.

**랩 루프 (랩마다, 이 순서로)**

1. **날씨 전이**: weather 스트림에서 이번 랩 강우 시작/종료 확인, 노면 상태 갱신.
2. **세이프티카 실현**: `p = sc_rate` (고장 차량이 있으면 ×3). 발동 시 3–5랩 지속.
3. **전략 규칙 평가** (8절): 차량별로 현재 상태를 보고 이번 랩 끝에 할 행동(피트/페이스)을 결정. 엔진 폴백도 여기서.
4. **랩타임 계산**: 6절 식. 세이프티카 중이면 `×1.4`, 앞차와 갭 1.0 s로 압축.
5. **추월 해결**: 순위순으로 인접 쌍을 보며 뒷차가 이번 랩 앞차보다 빠르고 갭 < 1.0 s면 추월 시도. 세이프티카 중 추월 금지.
6. **고장 실현**: `p = failure_rate_per_lap × heat × pace`. 발생 시 리타이어.
7. **피트스톱 적용**: 3번에서 피트 결정된 차량에 `pit_loss_s` 가산 (세이프티카 중 ×0.5), 컴파운드 교체, life = 1.0, tire\_age = 0.
8. **누적 시간으로 순위 재계산, 로그 기록.**

**추월 모델**

```
p_pass = sigmoid( a * delta_pace_s          # 뒷차가 빠른 만큼
                + b * drs_gain               # DRS 구간 효과
                + c * ers_boost(ers_mode)    # ERS 추월 보너스
                + d * dirty_air_resistance   # 뒷차의 더티에어 내성
                - e * overtake_difficulty    # 트랙 특성
                - f * defender_ers_boost )   # 앞차 방어
```

실패하면 뒷차는 앞차 바로 뒤에 물리고 (`gap = 0.6 s`), 그 랩 더티에어 페널티와 마모 ×1.1을 받는다. "빠른데 못 지나가는" 상황이 타이어를 겉아먹게 만들어야 언더컷 규칙이 의미를 가진다.

**엔진 폴백 (팀 규칙과 무관하게 항상 최우선)**

| 상황 | 엔진 행동 | 비용 |
| --- | --- | --- |
| tire life ≤ 0 | 강제 피트, 다음 계획 컴파운드 (없으면 hard) | 그 랩 +10 s |
| wet 노면에서 드라이 타이어 3랩 지속 | 강제 inter 교체 | 피트 손실만 |
| dry 노면에서 wet 타이어 3랩 지속 | 강제 다음 계획 드라이 컴파운드 | 피트 손실만 |
| 남은 랩 ≤ 5인데 2종 컴파운드 미충족 | 강제 피트 | 피트 손실 (벌점 회피) |

폴백은 벌점이 아니라 "느린 기본 행동"이다. 팀이 규칙으로 더 잘 대응하면 이득, 안 하면 폴백이 막아준다. 레이스가 망가지지 않게 하되 규칙을 잘 짜는 팀이 보상받는 구조다.

**피니시**

체커 → 2종 컴파운드 규정 검사 → 벌점 가산 → 최종 순위 → 포인트. 리타이어는 완주 랩 수 기준으로 뒤에 배치.

**구현 메모 (M3)**

- 이벤트(강우 시작, 세이프티카 발동)는 같은 랩의 전략 평가에서 보인다 (1·2번이 3번보다 먼저) → "세이프티카 때 피트"가 그 랩에 된다.
- 세이프티카 중: 선두는 ×1.4, 뒤차는 자기 랩타임만큼만 따라붙고 앞차와 1.0 s보다 가까워지지 않는다 → 몇 랩에 걸쳐 압축된다.
- 차·랩 단위 난수(노이즈, 추월, 고장)는 `stream.spawn("<차 인덱스>/<랩>")`으로 뽑는다 → 한 팀의 선택이 다른 팀의 주사위를 움직이지 않는다 (11절).
- ERS 배터리: 셋업의 모드가 레이스 내내 고정이므로 모드 차이는 랩을 넘는 잔량으로 낸다. harvest는 느리지만 잔량을 채워 추월·방어 보너스에 쓰고, attack은 빠르지만 잔량을 비운다 (모자라면 그만큼만 효과). 계수는 `model/2026.yaml`.
- 원하는 컴파운드 세트가 남아 있지 않으면 비슷한 컴파운드로 바꿔 낀다 (트레이스에 `fitted`).

**제외한 것 (의도적)**

VSC, 레드플래그, 사고 모델(충돌로 인한 리타이어), 팀 오더, 드라이버 실수. 전부 나중에 넣을 수 있지만 처음 밸런스에서는 변수를 줄이는 게 우선이다.

## 8. 사전 전략 DSL (GPPlan / RacePlan)

레이스 중 판단은 전부 이 DSL로 사전에 적혀 있어야 한다. 임의 코드는 허용하지 않고, 고정된 트리거·액션 어휘만 쓴다. 결정성, 공정성, 보안, 그리고 사람 팀이 UI로 같은 걸 만들 수 있어야 하기 때문이다.

**구조**

```yaml
setup:
  wing_level: 6
  ride_height: low
  ers_mode: balanced

variants:                       # 예선 후 위에서부터 첫 매치, 마지막은 무조건
  - when: {grid_lte: 5}
    plan: &defend
      start_compound: medium
      pace: normal
      stints:
        - {compound: medium, planned_pit_lap: 24}
        - {compound: hard}
      rules:
        - when: {event: safety_car, lap_between: [12, 40], tire_age_gte: 8}
          do: {pit: hard}
          once: true
        - when: {rival_behind_pitted: true, lap_gte: 18, tire_life_lte: 0.5}
          do: {pit: hard}             # 언더컷 커버
          once: true
        - when: {event: rain_start}
          do: {pit: inter}
        - when: {surface: dry, tire_compound: inter, laps_on_compound_gte: 2}
          do: {pit: next_planned}
        - when: {laps_remaining_lte: 8, position_lte: 3, gap_behind_gte: 4.0}
          do: {pace: conserve}
  - when: {}
    plan:
      start_compound: soft
      pace: push
      stints:
        - {compound: soft, planned_pit_lap: 14}
        - {compound: hard, planned_pit_lap: 38}
        - {compound: medium}
      rules:
        - when: {event: safety_car}
          do: {pit: next_planned}
          cooldown: 10
```

**트리거 어휘** (한 `when` 안의 조건은 AND, 최대 4개)

| 조건 | 타입 | 의미 |
| --- | --- | --- |
| lap\_gte / lap\_lte / lap\_between | int | 현재 랩 |
| laps\_remaining\_lte | int | 남은 랩 |
| event | enum | `safety_car`, `safety_car_end`, `rain_start`, `rain_stop` (그 랩에 발생) |
| surface | enum | `dry`, `damp`, `wet` (현재 상태) |
| tire\_life\_lte / tire\_age\_gte | float / int | 현재 타이어 |
| tire\_compound, laps\_on\_compound\_gte | enum / int | 현재 컴파운드 |
| position\_lte / position\_gte | int | 현재 순위 |
| gap\_ahead\_lte / gap\_behind\_lte / gap\_behind\_gte | float (s) | 인접 차와의 갭 |
| rival\_ahead\_pitted / rival\_behind\_pitted | bool | 직전 랩에 인접 차가 피트 |
| stint\_index\_eq | int | 현재 스틴트 번호 (0부터) |
| grid\_lte / grid\_gte | int | 변형 선택 전용 |

**액션 어휘** (한 규칙에 하나)

| 액션 | 의미 |
| --- | --- |
| `pit: <compound>` | 이번 랩 끝에 피트, 해당 컴파운드 장착. 현재 스틴트를 끝내고 다음 계획 스틴트를 소비 |
| `pit: next_planned` | 다음 계획 스틴트의 컴파운드로 피트 (없으면 hard) |
| `pace: push / normal / conserve` | 페이스 모드 변경, 다음 규칙이 바꿀 때까지 유지 |
| `extend_stint: <n>` | 현재 스틴트의 planned\_pit\_lap을 n랩 미룸 |
| `none` | 아무것도 안 함 (아래 규칙 차단용) |

**평가 의미론**

1. 매 랩 시작 시점(S/F 라인)에 차량별로 평가. 추월·고장·날씨는 직전 랩 결과를 본다.
2. `rules`를 위에서부터 검사, 첫 매치 하나만 실행 (first-match). 피트를 일으킨 규칙(또는 폴백)이 없으면 `stints`의 `planned_pit_lap`을 따른다 — pace·extend_stint·none 규칙이 매치돼도 계획 피트는 그대로다 (M3: 문구대로면 매 랩 매치되는 pace 규칙이 계획 피트를 지워 버린다).
3. `once: true`는 1회 발동 후 비활성, `cooldown: n`은 발동 후 n랩 동안 비활성. 둘 다 없으면 조건이 참인 동안 매 랩 발동 (pace 규칙에 유용, pit 규칙에는 위험 — 검증에서 경고).
4. 규칙 `pit`이 발동하면 현재 스틴트가 끝나고 `stint_index`가 1 증가. `planned_pit_lap`이 지나간 스틴트는 다음 랩에 즉시 피트.
5. 엔진 폴백(7절)은 팀 규칙보다 먼저 평가된다.

**제한** (검증에서 거부)

- `variants` ≤ 4, `rules` ≤ 12 / 변형, `stints` ≤ 4, 조건 ≤ 4 / 규칙.
- 컴파운드는 배분 내에서만. 알 수 없는 필드는 거부.
- `grid_*`는 `variants.when`에서만, 나머지는 `rules.when`에서만.
- `start_compound`는 첫 스틴트의 컴파운드와 같아야 한다. 계획 피트 랩은 증가하고 레이스 안이어야 하며, 마지막 스틴트에는 없다. `once`와 `cooldown`은 같이 쓸 수 없다. (`validatePlan`은 순환 참조를 피해 strategy.ts에 있다.)

**표현력에 대한 판단**

이 어휘로 표현 못 하는 것: "앞차보다 타이어가 새거든 밀어라" 같은 라이벌 상태 참조, "세이프티카가 3랩 안에 끝나면" 같은 미래 예측, 산술식. 부족하면 어휘를 늘리되, 어휘 변경은 규정 변경과 같은 급으로 취급한다 (시즌 단위). 어휘를 작게 유지해야 LLM이 규칙을 안정적으로 쓰고, 사람 팀 UI도 드롭다운 몇 개로 끝난다.

**전략 트레이스**

어느 랩에 어느 규칙이 발동했는지, 폴백이 개입했는지를 전부 로그에 남긴다 (10절). "왜 졌나"를 복기할 수 있게 하는 게 이 게임의 절반이다.

## 9. 에이전트 프로토콜과 정보 패킷

에이전트는 세 개의 메서드를 가진 프로토콜이다. 엔진과 오케스트레이터는 이 인터페이스만 보고, 뒤에 LLM이 있는지 사람이 있는지 모른다.

```ts
export interface TeamAgent {
  readonly kind: string;             // heuristic, replay, coding:<label> — SeasonLog에 남는다
  readonly model?: string;           // SeasonLog teams[].model
  // resubmission이 있으면 재제출 호출 (검증 오류 목록, 같은 패킷·같은 툴 예산)
  designCar(packet: PreseasonPacket, tools: DesignTools, resubmission?: Resubmission): Promise<CarSpec>;
  planGp(packet: GPPacket, tools: PlanTools, resubmission?: Resubmission): Promise<GPPlan>;
  takeReport?(): CallReport | undefined;  // 직전 호출의 원문 응답(·토큰) → AgentIOLog
}

export interface Resubmission { readonly errors: readonly string[] }

export interface DesignTools {
  windTunnel(spec: CarSpec, setup: Setup, trackId: string): WindTunnelResult;  // 예산 초과 시 throw
  readonly remaining: number;
}

export interface PlanTools {
  strategySim(plan: GPPlan, nSamples?: number): StrategySimResult;
  readonly remaining: number;
}
```

구현체: `CodingAgent` (LLM 팀, 아래), `HeuristicAgent` (밸런스·기준선), `ReplayAgent` (로그에서 제출물 재생. 원래 에이전트의 kind·model을 넘기면 SeasonLog까지 원본과 같다), `HumanAgent` (나중에, UI에서 값을 받아오는 어댑터). 사람 팀은 응답 제한 시간만 길게 잡으면 된다.

**LLM 팀 = 코딩 에이전트 (M5 결정)**

LLM 팀은 provider API를 직접 부르지 않고, 각 모델의 코딩 에이전트(Cursor, Antigravity, OpenCode, Claude Code, Codex CLI 등)로 참가한다. 에이전트 루프·툴 사용·컨텍스트 관리는 각 제품의 것이고, 공통 측은 워크스페이스 프로토콜만 고정한다 (`apps/runner/src/coding/`).

- 팀 워크스페이스 하나를 시즌 내내 쓴다 (기본: OS 임시 디렉터리 아래, 레포 밖). 러너가 쓰는 것: `BRIEF.md`(게임 설명 — 공개 문서의 정성적 내용, 모든 팀 동일), 호출마다 `TASK.md`와 `packet.json`, `schemas/`(zod에서 내보낸 JSON Schema), 툴 명령 `./f1sim`. 팀이 남긴 메모·스크립트는 다음 호출에도 남는다.
- 툴은 `./f1sim status | wind-tunnel | strategy-sim | submit`. 명령은 요청을 `.f1sim/inbox/`에 파일로 쓰고 러너가 `.f1sim/outbox/`에 답한다 (네트워크가 막힌 샌드박스에서도 동작). 엔진 코드는 워크스페이스에 없고, 횟수는 러너 메모리의 DesignTools/PlanTools가 센다.
- `submit`은 받는 즉시 같은 검증 함수로 확인해 결과(오류 목록)를 돌려준다. 첫 제출이 걸리면 같은 세션을 살려 둔 채 재제출을 받는다. 에이전트가 제출 없이 끝나거나 시간을 넘기면 오류 목록과 함께 새로 띄운다 (재제출 1회). `status`는 남은 횟수와 이 호출의 남은 초를 알려 준다. 받아들여지면 툴이 닫히고, 에이전트는 메모를 정리할 시간(60초)을 받은 뒤 종료된다 — 다음 호출이 열리기 전에는 반드시 끝낸다 (새 호출의 예산을 못 쓰게).
- 팀마다 헤드리스(러너가 명령을 띄움, `{prompt}` 치환) 또는 수동(러너가 워크스페이스를 알려 주고 제출을 기다림). 팀 구성은 팀 파일 (`apps/runner/teams.example.yaml`).
- 격리는 지시(“이 디렉터리 안에서만”)와 각 도구의 샌드박스 설정에 기댄다. 다른 팀 워크스페이스나 레포(엔진 모델 계수)를 읽지 못하게 강제하려면 컨테이너 격리가 필요하다 — 나중 단계.

**정보 패킷 (모든 팀 동일)**

| 패킷 | 내용 |
| --- | --- |
| `PreseasonPacket` | 규정 전문, 트랙 프로파일 24개, 지난 시즌 공개 로그 (있으면), 풍동 잔여 20 |
| `UpgradePacket` | 현재 스펙, 남은 크레딧, 현재 순위, 지나간 GP 공개 로그, 남은 캘린더, 풍동 잔여 5 |
| `GPPacket` | 트랙 프로파일, 날씨 예보, 타이어 배분, 자기 차의 이 트랙 풍동 요약 (셋업 3개 기본값 기준), 현재 순위, 지난 GP 공개 로그, 전략 시뮬 잔여 5 |

공개 로그는 실제 F1처럼 결과·랩타임·피트 타이밍은 전부 공개하고, 스펙과 규칙 원문은 비공개다. 라이벌의 전략 성향을 로그에서 추론하는 게 하나의 판단 요소가 된다. (구현: `publicRaceLog` — 셋업·전략 트레이스·변형 선택을 뺀다. 패킷의 "규정 전문"은 공개 규정 파일뿐이고 엔진 모델 계수는 없다. 풍동 요약은 윙 2·5·8 세 셋업.)

**툴**

- `wind_tunnel`: 후보 스펙 + 셋업을 특정 트랙에서 돌린 기본 랩타임. 결과는 총 랩타임 + 세그먼트 유형별 손익 (직선 / 저속 / 중속 / 고속 코너) + 마모율 추정, 노이즈 N(0, 0.1 s). 효율 곡선 위의 한 점만 보여주므로 설계자가 직접 탐색해야 한다.
- `strategy_sim`: 자기 `GPPlan`을 n회 시드로 돌린 결과 분포 (평균 순위, 순위 분포, 평균 레이스 타임, 폴백 발동 횟수). 라이벌은 지난 GP 스펙 추정치 + 기본 전략으로 가정. 실제 레이스와 다른 시드를 쓴다.

전략 시뮬을 주는 건 트레이드오프가 있다. 주면 규칙의 버그(예: 매 랩 피트하는 규칙)를 팀이 스스로 잡을 수 있고 판단이 합리적이 된다. 안 주면 분산이 커지고 운이 커진다. 5회로 제한해서 "검증은 되지만 최적화는 안 되는" 수준으로 둔다.

**검증 파이프라인** (제출물마다)

1. 스키마: zod 스키마(strict), 알 수 없는 필드 거부.
2. 규정: 비용 합계, 범위, 아키텍처 불변(업그레이드 시), 컴파운드 배분.
3. 의미: 규칙 수 제한, `grid_*` 위치, 위험 패턴 경고 (once/cooldown 없는 pit 규칙).
4. 실패 시 오류 목록과 함께 1회 재제출 기회 → 다시 실패하면 폴백 + 벌점 (3절).

오류 메시지는 사람이 읽어도 말이 되게 쓴다. LLM 재제출과 사람 팀 UI의 검증 메시지가 같은 문자열이다.

**LLM 팀에 대한 제약 (공통 측에서 강제)**

- 동일 패킷 직렬화 (JSON), 동일 출력 스키마, 동일 BRIEF.md. 헤드리스 명령의 짧은 지시도 모든 팀이 같다.
- 툴 호출 횟수는 공통 측이 세고 초과 시 오류 반환. 에이전트가 세지 않는다.
- 모든 입출력과 툴 호출을 `AgentIOLog`에 기록 (10절). 나중에 "이 모델은 풍동을 어떻게 썼나"를 보는 재만도 여기서 나온다.

## 10. 로그·리플레이 포맷

로그는 세 종류다: 레이스 로그(3D 리플레이와 분석용), 에이전트 I/O 로그(감사용), 시즌 로그(집계용). 전부 JSON이고 스키마는 코드와 같은 패키지에서 버전 관리한다.

**RaceLog**

```json
{
  "schema": "racelog/1",
  "meta": {"season": 2026, "gp": 7, "track": "silverstone", "seed": 918273,
           "weather_realized": {"temp_c": 24, "rain": [[31, 44]]}, "sample_interval_m": 10},
  "cars": [{"team": "fable", "spec_hash": "a91f", "setup": {...}, "variant_selected": 0, "grid": 3}],
  "laps": [
    {"lap": 1, "order": ["opus", "fable", ...], "surface": "dry", "sc": false,
     "cars": {"fable": {"t": 92.41, "cum": 92.41, "pos": 2, "compound": "medium", "life": 0.97, "fuel": 108.2, "pace": "normal"}}}
  ],
  "samples": {"fable": [[0.0, 0, 0.0], [0.42, 10, 24.1], ...]},
  "events": [
    {"t": 1352.7, "lap": 15, "s": 410, "type": "overtake", "car": "fable", "on": "sonnet"},
    {"t": 1890.0, "lap": 21, "s": 0, "type": "safety_car", "duration_laps": 4},
    {"t": 1992.3, "lap": 22, "s": 5100, "type": "pit", "car": "fable", "to": "hard", "loss_s": 11.2}
  ],
  "strategy_trace": [
    {"lap": 22, "car": "fable", "rule_idx": 0, "action": {"pit": "hard"}, "source": "rule"},
    {"lap": 48, "car": "gemini", "action": {"pit": "hard"}, "source": "fallback:tire_life"}
  ],
  "result": [{"team": "opus", "pos": 1, "time": 5412.3, "penalties": []}, ...]
}
```

- `samples`: 차량별 `[t, s, v]` (초, 트랙 거리 m, 속도 m/s). 간격은 `sample_interval_m`. 20대 × 60랩 × 580개 ≈ 70만 샘플, JSON으로 약 15 MB. 분석용은 `laps`만 있으면 되므로 `samples`는 별도 파일(`<race>.samples.json.gz`)로 분리.
- `s`는 랩 내 거리가 아니라 레이스 누적 거리. 렌더러는 `s mod track_length`로 스플라인 위치를 구한다. 피트레인 구간은 `events`의 pit 시각으로 판별.
- `strategy_trace.source`: `rule` / `planned` / `fallback:<reason>`. "왜 이 팀이 여기서 피트했나"의 답.
- M3 구현의 추가 필드: 랩별 차 상태에 `ers`(배터리 잔량), `cars`에 `quali_lap`, `result`에 `laps`·`status`·`points`, 이벤트 `overtake_failed`·`retirement`. 거리 샘플(`samples`)은 렌더러(M7)에서 붙이며 그 전까지 `sample_interval_m: null`.

**AgentIOLog** (팀별, 호출마다 한 줄, JSONL)

```json
{"call": "plan_gp", "team": "fable", "gp": 7, "packet_hash": "c3e1",
 "tool_calls": [{"tool": "strategy_sim", "args_hash": "9a..", "result_summary": {"mean_pos": 4.2}}],
 "raw_response": "...", "validation": {"ok": false, "errors": ["rules[3]: unknown field 'gap_to_leader'"]},
 "resubmission": {"raw_response": "...", "validation": {"ok": true}},
 "final": {...}, "latency_s": 41.2, "tokens": {"in": 8120, "out": 910}}
```

코딩 에이전트 팀: `raw_response`는 제출한 파일 원문, `tokens`는 없다 (도구가 알려 주지 않는다). 에이전트 프로세스 출력은 워크스페이스 `.f1sim/logs/`에 남는다.

이 로그가 있어야 `ReplayAgent`가 시즌을 LLM 호출 없이 재생할 수 있고, 모델 간 판단 스타일 비교(풍동을 몇 번 썼나, 재제출이 얼마나 있었나)가 가능하다.

**SeasonLog**

시즌 시드, 규정 버전, 팀 목록(에이전트 종류·모델 ID), GP별 결과 포인터, 업그레이드 이력, 최종 순위. 작다.

**디렉터리**

```
runs/<season_id>/
  season.json
  regulations.yaml          # 그 시즌에 쓴 규정 스냅샷
  gp07_silverstone/
    race.json
    race.samples.json.gz
    quali.json
  agents/<team>.jsonl
```

## 11. 결정성·시드·검증

같은 시즌 시드와 같은 제출물이면 바이트 단위로 같은 로그가 나와야 한다. LLM의 비결정성은 에이전트 레이어에 가두고, 제출물을 로그로 고정해서 그 이후는 완전히 재현 가능하게 만든다.

**시드 계층**

```
season_seed
  └─ race_seed[gp]        = hash(season_seed, gp_index)
       ├─ stream.weather   = Generator(hash(race_seed, "weather"))
       ├─ stream.safety_car
       ├─ stream.failures
       ├─ stream.overtaking
       ├─ stream.laptime_noise
       ├─ stream.qualifying
       └─ stream.start
```

- 서브스트림을 분리하는 이유: 한 팀이 피트를 한 번 더 한다고 다른 팀의 고장 여부가 바뀌면 안 된다. 차량별 난수는 `stream.X.spawn(car_index)`로 다시 분리.
- 난수 소비 순서가 고정되도록 랩 루프 안의 순회 순서는 항상 차량 인덱스 순.
- 풍동과 전략 시뮬은 별도 시드(`hash(race_seed, "tool", team, call_idx)`)를 써서 실제 레이스를 미리 볼 수 없게 한다.

**재현 경로**

`ReplayAgent`가 `agents/<team>.jsonl`의 `final` 제출물을 그대로 내면 시즌 전체가 LLM 없이 재생된다. 골든 로그와 비교하는 게 회귀 테스트다.

골든 로그 (M4): `apps/runner/golden/<season>-s<seed>/`에 휴리스틱 10팀 시즌 하나를 고정한다. `agents/<team>.jsonl`(제출물. `latency_s`는 실행마다 달라 0으로 적는다)과 `manifest.json`(만든 Node 버전, 입력 지문 = 규정·캘린더 트랙의 해시, `season.json`과 각 `race.json`의 sha256). 테스트는 제출물을 `ReplayAgent`로 재생해 해시를 대조한다. `ReplayAgent`에 원래 에이전트 이름을 넘기면 `season.json`(teams[].agent)까지 원본과 같다. 규정·모델·트랙·엔진을 바꾸면 해시가 어긋나는 게 정상이고, 의도한 변경이면 `pnpm -F @f1sim/runner golden --update`로 다시 만든다.

**부동소수**

Node와 브라우저 모두 IEEE754 double이라 같은 엔진 코드면 일치가 기대되지만, \`Math.exp\`·\`Math.pow\` 같은 초월함수는 엔진(V8/JSC)별로 마지막 비트가 다를 수 있다. 공식 보장은 "같은 Node 버전"까지만. 브라우저와 Node 간 일치가 필요해지면(사람 팀의 전략 시뮬 결과를 서버와 대조할 때) 랩타임을 밀리초 정수로 반올림해 누적하는 걸 고려한다.

**검증 계층**

| 계층 | 무엇을 | 어디서 |
| --- | --- | --- |
| 스키마 | 필드·타입·범위 | zod, 제출 즉시 |
| 규정 | 비용, 불변 항목, 배분 | `regulations.validate()` |
| 의미 | 규칙 수, 위험 패턴 | `strategy.lint()` |
| 엔진 불변식 | 순위 합 = n, 누적 시간 단조, life ∈ \[0,1\], 피트 수 = 스틴트 수 − 1 | 랩 루프 끝 assert (테스트 모드) |
| 회귀 | 골든 로그 일치 | CI |

**테스트 전략**

- 랩타임 모델: 단조성 테스트 (출력↑ → 직선 시간↓, 윙↑ → 코너↓ 직선↑, 무게↑ → 랩타임↑).
- 전략 DSL: 규칙 평가기 단위 테스트 (first-match, once, cooldown, 폴백 우선).
- 레이스: 속성 테스트 (fast-check) — 임의 스펙·플랜·시드에서 불변식 유지.
- 시즌: 골든 로그 1개.

## 12. 밸런스 테스트 하네스

LLM을 붙이기 전에 설계 공간과 전략 공간에 지배 해가 없는지를 수치로 확인한다. 여기서 못 잡으면 뒤에서는 못 잡는다.

**설계 공간 탐색**

- 랜덤 스펙 2,000개 (예산을 다 쓰는 배분을 균등하게 샘플링) × 24 트랙 × 트랙별 최적 셋업(윙 × 지상고 × ERS 모드) × 시드 1개. 순수 랩타임 비교만 하므로 레이스 없이 빠르다. 랩타임에 효과가 없는 레이스 전용 파라미터(reliability, tire_management, dirty_air_resistance)는 모든 스펙에서 균등 배분값으로 고정한다 — 랜덤으로 두면 그쪽에 예산을 덜 쓴 스펙이 배분과 무관하게 이긴다. (M2 결정. `--all-random`, `--sampling budget-volume`으로 원래 방식도 돌릴 수 있다.)
- 지표 1 — 트랙별 최속 스펙의 집중도: 어떤 스펙 하나가 최속인 트랙 비율 최대값 < 35%. 넘으면 트랙 다양성이나 비용 곡선을 조정.
- 지표 2 — 파라미터 기여도: 시즌 총 랩타임을 스펙 파라미터로 회귀. 한 파라미터가 분산의 50% 이상을 설명하면 가중치나 효과 계수 조정.
- 지표 3 — 아키텍처 균형: floor/wing, short/long 각각이 최속인 트랙 수가 24 중 6 이상.

**전략 공간 탐색**

- 고정 스펙 10개 (위 탐색에서 골른 다양한 스펙) × 랜덤 플랜 500개 × 시드 50개, 레이스 전체 실행.
  구현 메모 (M4): 고정 스펙은 레이스 전용 파라미터를 고정한 설계 탐색(400개)의 시즌 시간 상위 25% 안에서 아키텍처 4칸(floor/wing × short/long)마다 최속 1개, 나머지는 이미 고른 것과 가장 먼 스펙. 랜덤 플랜은 검증과 린트를 모두 통과하는 것만 (스틴트 1–4, 규칙 0–4, pit 규칙은 once 또는 cooldown), 셋업은 스펙별 최적. 플랜 500개는 트랙 4개(fast-oval, mixed, tight-street, highland)에 나눈다. 랜덤 플랜 차 1대 + 나머지 9대는 각 스펙의 휴리스틱 플랜이고, 모든 플랜이 같은 시드 묶음을 쓴다 (공통 난수). 지표 5는 아래 결정대로 휴리스틱 플랜으로 잰다. 리포트에는 세이프티카·비·리타이어 유무별 분해와 랜덤 플랜 값(전체, 상위 10%)을 참고로 같이 싣는다. `pnpm -F @f1sim/harness strategy`.
- 지표 4 — 전략 분산: 상위 10% 플랜과 하위 10% 플랜의 평균 결과 차이 ≥ 피트 손실 1회분. 이보다 작으면 전략이 의미 없다는 뜻.
- 지표 5 — 운 비중: 같은 스펙·같은 플랜에서 시드별 순위 표준편차. 1.5 순위 이하 목표. 너무 크면 노이즈·세이프티카 확률을 줄인다.
  (M4 결정) 여기서 플랜은 휴리스틱 플랜이다: 10대 전원이 각 스펙의 휴리스틱 플랜으로, (스펙 × 트랙) 칸마다 시드 50개의 순위 σ를 내고 칸 평균을 본다. 랜덤 플랜으로 재면 세이프티카에 반응하지 않는 플랜이 섞여 운이 아니라 플랜 품질까지 재게 된다 (M4 측정: 랜덤 플랜 1.64, 휴리스틱 1.21).
- 지표 6 — 폴백 빈도: 랜덤 플랜에서도 폴백이 레이스당 평균 1회 미만. 많으면 DSL 어휘나 폴백 임계값 재검토.

**휴리스틱 에이전트**

- 설계: 캘린더의 트랙 프로파일 가중 평균으로 "평균 트랙"을 만들고, 풍동 20회를 좌표 하강으로 쓴다.
- 플랜: 마모도에 따라 1스톱 (medium→hard) 또는 2스톱 (soft→medium→hard), 세이프티카 규칙 1개, 비 규칙 2개.
- 역할: LLM 팀의 기준선. LLM이 휴리스틱을 꾸준히 못 이기면 풍동·전략 시뮬 횟수나 정보 패킷을 재검토.

**처음 밸런스 체크리스트**

- [x] 24 트랙 프로파일이 직선 비율·코너 분포·마모도·기온에서 고루 퍼져 있다
- [x] 지표 1–3 통과
- [x] 지표 4–6 통과
- [x] 휴리스틱 10팀 시즌에서 챔피언 포인트가 2위의 1.5배 미만
- [x] 골든 로그 고정

하네스는 `harness/` 패키지의 CLI로 두고, 규정 파일을 바꿀 때마다 돌린다. 결과는 `harness/reports/<date>.md`로 남긴다.

## 13. 코드 구조와 구현 순서

TypeScript 모노레포로 간다. `packages/core`는 DOM도 Node API도 모르는 순수 엔진이고, Node(시즌 실행·하네스)와 브라우저(사람 팀 전략 시뮬·리플레이)가 같은 코드를 import한다. 웹이 게임 자체이므로 엔진이 브라우저에서 돌아야 한다는 게 언어 선택의 이유다.

```
f1sim/
  packages/
    core/                    # 순수 엔진. 의존: zod, yaml(규정·트랙 메타 파싱). window·fs·process·Math.random 금지 (eslint로 강제)
      src/
        regulations.ts       #   Regulations 스키마, cost(), validateSpec(), validatePlan()
        car.ts               #   CarSpec, Setup, derive() -> DerivedPerf
        track.ts             #   Track(스플라인) -> segments, profile, pit lane
        weather.ts           #   Forecast, realize(), surface transitions
        tires.ts             #   compounds, degradation(), wear()
        laptime.ts           #   baseLap(), raceLap()
        strategy.ts          #   GPPlan, RacePlan, Rule 스키마; selectVariant(), evaluateRules()
        qualifying.ts
        race.ts              #   runRace(): lap loop, overtaking, events, fallbacks
        season.ts            #   calendar, points, standings
        rng.ts               #   seed hierarchy, stream spawn (xoshiro128**)
        log.ts               #   RaceLog, AgentIOLog, SeasonLog 스키마
        index.ts
      test/                  #   vitest + fast-check
    agents/
      src/
        base.ts              #   TeamAgent, packets, DesignTools / PlanTools
        tools.ts             #   windTunnel(), strategySim() + 예산 강제
        heuristic.ts  replay.ts
        conformance/         #   어떤 어댑터든 통과해야 하는 테스트
    harness/                 # 밸런스 탐색 (Node worker_threads), 리포트
  apps/
    runner/                  # 시즌 실행 CLI
      src/coding/            #   CodingAgent: 팀 워크스페이스, ./f1sim 요청 처리, 헤드리스/수동 (9절)
      assets/f1sim-tool.mjs  #   워크스페이스에 복사되는 ./f1sim (파일 IPC만, 엔진 코드 없음)
      teams.example.yaml     #   팀 파일: 코딩 에이전트 팀 + 휴리스틱 팀
      golden/<season>-s<seed>/  # 골든 로그 (11절): 제출물 + 출력 해시. 회귀 테스트가 재생해 대조
    web/                     # Vite + Three.js: 리플레이, 리더보드, 사람 팀 UI (나중에)
  data/
    regulations/2026.yaml    # 공개 규정 (패킷에 들어감)
    model/2026.yaml          # 엔진 모델 계수 (비공개)
    calendar/2026.yaml
    tracks/*.csv  tracks/*.yaml
  docs/DESIGN.md             # 이 문서
  runs/                      # 시즌 출력 (gitignore)
```

의존 방향은 한 쪽이다: `harness`, `apps/*`, `agents` → `core`. `core`는 위를 모른다. `agents/tools`는 `core`를 호출하지만 `core`는 툴의 존재를 모른다.

**기술 선택**

| 항목 | 선택 | 이유 |
| --- | --- | --- |
| 언어 | TypeScript 5 (strict), Node 24 | Node·브라우저 단일 코드, LLM SDK 전부 1급 |
| 패키지 | pnpm workspaces | 모노레포 |
| 스키마 | zod | 런타임 검증 + JSON Schema 내보내기(LLM 구조화 출력) + TS 타입 단일 소스 |
| 설정 | YAML | 규정·트랙 메타를 사람이 읽고 고침 |
| PRNG | xoshiro128\*\* 직접 구현 | Math.random은 시드 불가. 스트림 분리 필요 |
| 테스트 | vitest + fast-check | 속성 테스트로 엔진 불변식 |
| 린트 | eslint, core에 `no-restricted-globals` (window, document, process, fs, Date, Math.random) | 순수성 강제 |
| LLM | 각 모델의 코딩 에이전트 (Cursor, Antigravity, OpenCode, Claude Code …) | 에이전트 루프는 제품 몫, 공통 측은 워크스페이스 프로토콜만 (M5 결정) |
| 렌더러 | Three.js, Vite | M7 |

Python은 분석 노트북에서 로그 JSON을 읽는 용도로만. 엔진에는 들어가지 않는다.

**구현 순서**

| 단계 | 범위 | 완료 기준 |
| --- | --- | --- |
| M1 코어 모델 | rng, regulations, car, track, tires, laptime + `agents/tools.windTunnel` | 16절 테스트 기준 전부 통과 |
| M2 설계 밸런스 | harness 설계 탐색, heuristic 설계 | 24 트랙 프로파일, 12절 지표 1–3 통과 |
| M3 레이스 엔진 | weather, strategy, qualifying, race, log + `agents/base`, heuristic 플랜, replay, conformance | 휴리스틱 10팀 레이스 1개, CLI 텍스트 리플레이, 전략 트레이스 출력 |
| M4 전략 밸런스 | harness 전략 탐색, season | 지표 4–6 통과, 휴리스틱 시즌 1개, 골든 로그 |
| M5 LLM 1개 | `apps/runner/src/coding` (코딩 에이전트 워크스페이스), 팀 파일 | 코딩 에이전트 1팀 + 휴리스틱 9팀 시즌, AgentIOLog, Replay 재현 일치 |
| M6 멀티 모델 | 팀 파일에 코딩 에이전트 여러 개 (Cursor, Antigravity, OpenCode …) | 설계대로 팀 구성 시즌 1개 |
| M7 웹 리플레이 | `apps/web` Three.js | race.json + samples로 3D 리플레이 |
| M8 사람 팀 | HumanAgent + UI, 브라우저 내 strategySim | 사람 1팀이 시즌 참가 |

M1–M4는 LLM이 전혀 없어도 돌아간다. 여기까지가 전체의 절반 이상이고, 여기서 밸런스를 못 잡으면 M5 이후는 의미가 없다.

## 14. 열린 결정 사항

아래는 이 문서가 임시값으로 두고 지나간 것들이다. M1 시작 전에 정해야 하는 건 처음 두 개뿐이고, 나머지는 해당 마일스톤에서 정하면 된다.

| 결정 | 임시값 | 선택지와 트레이드오프 | 언제 |
| --- | --- | --- | --- |
| 팀당 차량 수 | 1대 | 2대면 팀 전략(두 차 다른 전략으로 헤지)이 생기지만 제출물·로그·밸런스 복잡도 2배. 1대로 시작하고 스키마만 2대 확장 가능하게 | M1 전 |
| 비용 곡선 지수 p | 2 | 2는 온건, 3 이상은 "고르게" 쪽으로 강하게 밀림. 하네스가 결정 | M2 |
| 트랙 데이터 출처 | 공개 데이터셋 | 라이선스 확인 필요. 불가하면 가상 서킷 24개를 프로파일 조합으로 생성 (밸런스에는 오히려 유리) | M1 전 |
| 예선 형식 | 1랩 | Q1–Q3는 타이어 소모 전략을 더하지만 사전 플랜 어휘가 늘어남 | M3 |
| 전략 시뮬 횟수 | 5 | 0이면 운 비중↑, 무제한이면 수렴. 휴리스틱 vs LLM 결과 보고 조정 | M5 |
| 업그레이드 윈도우 | 2회 | 많을수록 초기 설계의 무게↓, 호출↑ | M4 |
| 샘플 간격 | 10 m | 렌더러 부드러움 vs 로그 크기. 세그먼트 경계만 남기고 렌더러가 보간하는 옵션도 있음 | M7 |
| DSL 어휘 확장 | 현재 목록 | 라이벌 상태 참조(`rival_ahead_tire_age_gte`) 추가 여부. 지금은 넣지 않고 휴리스틱 시즌에서 필요성 확인 | M4 |
| 스타트 모델 | 노이즈만 | 컴파운드별 스타트 보너스(soft 유리) 추가 시 스타트 컴파운드 선택이 더 의미 있어짐 | M3 |
| 고장의 형태 | 즉시 리타이어 | "출력 저하 후 완주" 같은 부분 고장은 더 현실적이지만 변수 추가 | M3 |

**이 문서가 의도적으로 다루지 않은 것**

- LLM 프롬프트 설계와 모델별 튜닝 — 공통 측은 패킷과 스키마만 고정한다.
- 3D 렌더러 구조 — 로그 포맷(10절)이 계약이고 그 뒤는 별도 문서.
- 사람 팀 UI — `HumanAgent`가 `GPPlan`을 만들어 내기만 하면 되고, DSL 어휘가 작은 게 UI를 위한 설계이기도 하다.

## 15. Claude Code 핸드오프

공통 환경(core, agents 기반, harness, runner)은 Claude Code 하나가 만든다. 이 문서가 계약이고, CLAUDE.md가 규율이고, 마일스톤 하나가 세션 한두 개다. 다른 provider 어댑터(M6)는 그 provider의 코딩 툴(Codex, Gemini CLI)에 맡겨도 되지만, 그건 공통 환경과 conformance 테스트가 있은 뒤의 일이다.

**레포 준비 순서**

1. 빈 레포 `f1sim` 생성, `git init`.
2. 이 문서를 Markdown으로 내보내 `docs/DESIGN.md`로 커밋. 설계가 바뀌면 이 파일도 같이 바뀜다.
3. 아래 CLAUDE.md 초안을 루트에 커밋. Codex를 나중에 붙일 거면 같은 내용을 `AGENTS.md`로도.
4. Claude Code를 레포 루트에서 실행하고 17절의 첫 명령을 그대로.

**세션 단위**

한 세션에 마일스톤 하나를 통째로 시키지 않는다. M1은 두 세션(스캐폴딩 + rng/regulations/car → track/tires/laptime/windTunnel)으로 주고, 각 세션 끝에 `pnpm test`와 `pnpm lint`가 녹색인 걸 확인한 뒤 다음으로 넘어간다. 세션이 길어지면 컴텍스트가 흐려져서 문서와 어긋나기 시작한다.

**세션 끝마다 리뷰할 것**

- `packages/core`에 I/O·`Date`·`Math.random`이 없는가 (lint가 막지만 눈으로도).
- 숫자가 코드에 박혀 있지 않고 `2026.yaml`에 있는가.
- 테스트가 "함수가 호출된다"가 아니라 "물리적으로 맞는 방향이다"를 검사하는가 (16절 단조성 테스트).
- zod 스키마가 문서 3·4·8절과 필드 단위로 일치하는가. 문서에 없는 필드가 생겼으면 이유를 물어보고 문서를 고치거나 코드를 고친다.
- Claude Code가 "문서와 달라진 점"으로 보고한 항목을 문서에 반영.

**CLAUDE.md 초안**

```markdown
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
- 마일스톤 단위 (DESIGN.md 13절). 현재: M1.
- 모듈마다 테스트를 함께. pnpm test와 pnpm lint가 통과하기 전에는 완료 아님.
- 모르는 값은 추측하지 말고 yaml에 기본값 + `// TODO(balance)` 주석. 하네스가 조정한다.
- 작업 끝에 3–5줄로: 무엇을 만들었나, 문서와 달라진 점, 다음 세션 제안.

## 명령
pnpm install · pnpm test · pnpm lint · pnpm -F @f1sim/core build

## 하지 말 것
- core에 I/O, 로깅, console.
- 테스트를 통과시키려고 테스트를 약화.
- 문서에 없는 규정·파라미터·DSL 어휘 추가. 제안은 환영, 구현은 승인 후.
- 현재 마일스톤 밖의 모듈 만들기.
```

## 16. M1 작업 명세

M1은 "스펙과 셋업을 넣으면 트랙별 기본 랩타임이 나오고, 그 위에 풍동 툴이 얹힌다"까지다. 레이스도 전략도 없다. 여기서 랩타임 모델의 방향성이 맞으면 M2 밸런스를 바로 돌릴 수 있다.

**범위**

- 모노레포 스캐폴딩: pnpm workspaces, TS strict, vitest, eslint. `packages/core`, `packages/agents`, `packages/harness`, `apps/runner`는 빈 패키지라도 구조는 전부.
- `packages/core`: `rng.ts`, `regulations.ts`, `car.ts`, `track.ts`, `tires.ts`, `laptime.ts`, `index.ts`.
- `packages/agents/src/tools.ts`의 `windTunnel()`만 (strategySim은 M3).
- `data/regulations/2026.yaml`: 3·4·6절의 숫자 전부.
- `data/tracks/`: 가상 서킷 3개 — `fast-oval`(직선 비율 0.7, 고속 코너 위주), `tight-street`(저속 코너 위주, 범피, 중도 마모), `mixed`(중간). 실제 서킷 데이터는 라이선스 확인 후 M2에서.

**공개 API** (시그니처는 방향을 고정하는 것이고, 타입 세부는 구현하면서 정한다)

```ts
// rng.ts — xoshiro128**
export function makeRng(seed: number): Rng;
export interface Rng {
  next(): number;                       // [0, 1)
  normal(mu: number, sd: number): number;
  spawn(key: string): Rng;              // 독립 스트림. hash(부모의 생성 시점 상태, key) — 부모의 소비량과 무관, 부모 불변
}

// regulations.ts
export const RegulationsSchema: z.ZodType<Regulations>;
export function parseRegulations(rulesYaml: string, modelYaml: string): Regulations;  // 공개 규정 + 엔진 모델
export function publicRules(regs: Regulations): Rules;                                // 패킷용 (엔진 모델 키 제외)
export function cost(spec: CarSpec, regs: Regulations): number;
export function validateSpec(spec: unknown, regs: Regulations): Result<CarSpec, ValidationIssue[]>;
export function validateSetup(setup: unknown): Result<Setup, ValidationIssue[]>;

// car.ts
export const CarSpecSchema, SetupSchema;
export function derive(spec: CarSpec, setup: Setup, track: Track, regs: Regulations,
                       airTempC = track.temp_mean): DerivedPerf;   // 레이스는 실현 기온을 넘긴다 (5절)

// track.ts
export function parseTrackMeta(yamlText: string): TrackMeta;
export function parseTrack(centerlineCsv: string, meta: TrackMeta, regs: Regulations): Track;  // 스플라인 → segments
export function profile(track: Track): TrackProfile;                                          // 5절 표의 필드

// tires.ts
export function degradation(compound: Compound, life: number, regs: Regulations): number;  // s/lap
export function wearPerLap(compound: Compound, perf: DerivedPerf, track: Track,
                           pace: PaceMode, dirtyAir: boolean, surface: Surface, regs: Regulations): number;
//   surface: inter·wet의 dry 노면 마모 승수 때문에 필요

// laptime.ts
export function baseLap(perf: DerivedPerf, track: Track, surface: Surface, regs: Regulations): LapBreakdown;
//   LapBreakdown = { total: number; straight: number; lowSpeed: number; midSpeed: number; highSpeed: number; topSpeedKph: number }
//   straight = 풀 스로틀 시간. low/mid/high = 그 등급 코너에 걸린 시간 (진입 제동 + 그립 한계 + 트랙션 한계 탈출)
export function raceLap(base: LapBreakdown, state: LapState, regs: Regulations): number;  // 6절 식. 노이즈는 호출자가 rng로

// agents/tools.ts
export function makeDesignTools(regs, tracks, budget: number, rng: Rng): DesignTools;
//   windTunnel(spec, setup, trackId) → { lap: LapBreakdown; wearEstimate: number; noiseSd: 0.1 }, remaining--; 0이면 throw
//   잘못된 입력(스키마·코스트 캡·모르는 트랙)도 throw하되 횟수·난수는 쓰지 않는다
```

`Result`는 `{ ok: true, value } | { ok: false, issues }`. `ValidationIssue`는 `{ path, message }`이고 message는 사람이 읽는 문장 (LLM 재제출과 사람 팀 UI가 같은 문자열을 본다).

**테스트 기준** (전부 통과해야 M1 완료)

| 모듈 | 검사 |
| --- | --- |
| rng | 같은 시드 → 같은 수열. `spawn("a")`와 `spawn("b")`가 다르고 부모와 독립. `normal()` 10만 개 평균·표준편차 ±2% |
| regulations | 예산 초과·범위 이탈·미지 필드 거부, issue 경로가 필드를 가리킴. `cost`가 각 파라미터에 대해 볼록 (0.5→1.0 증가분 > 0→0.5 증가분) |
| car.derive | `weight_reduction` 1.0 → 최소 무게, 0.0 → +30 kg. `cooling` 부족 × 기온 35°C → `heat_derate` > 0, 20°C → 0 |
| track | 가상 서킷 3개 파싱, 세그먼트 길이 합 = 트랙 길이 ±1 m, 프로파일 필드 범위 유효, `fast-oval.straight_ratio > mixed.straight_ratio > tight-street.straight_ratio` |
| tires | `degradation`이 life 감소에 단조 증가, 클리프 아래에서 기울기 급증. soft 마모 > medium > hard |
| laptime 단조성 | `thermal_efficiency`↑ → `straight`↓. `wing_level`↑ → 코너 합↓, `straight`↑. mass↑ → `total`↑. `mech_grip`↑ → `lowSpeed`↓ (`highSpeed` 변화 < `lowSpeed` 변화) |
| laptime 트랙 차별 | 고정 스펙에서 `wing_level` 0–10 중 최적값이 `fast-oval` < `mixed` < `tight-street`. `philosophy=floor`는 `tight-street`(범피)에서 `ride_height=low` 페널티 |
| raceLap | `tire_life`↓ → 랩타임↑, fuel↓ → 랩타임↓, `pace=push` < `normal` < `conserve` |
| windTunnel | 예산 n회 후 throw. 같은 rng 시드에서 같은 노이즈. 결과의 `lap.total`이 `baseLap` ± 0.5 s 안 |
| 순수성 | eslint `no-restricted-globals`가 core에서 `Date`, `Math.random`, `process`, `fetch` 사용 시 실패 (일부러 하나 넣어 확인 후 제거) |

**M1 범위 밖** (요청받아도 만들지 않는다)

레이스 루프, 전략 DSL, 날씨 실현, 예선, 로그 포맷, LLM 어댑터, 하네스, 웹. 이 중 하나가 "어차피 필요해서" 생기면 범위가 샐 것이다.

## 17. Claude Code에 줄 명령 (복붙용)

레포 루트에 `docs/DESIGN.md`와 `CLAUDE.md`가 있는 상태에서 시작한다. 명령은 "무엇을"보다 "어디까지"를 분명히 하는 데 초점이 있다. 문서가 "무엇을"을 담당한다.

**세션 1 — 스캐폴딩 + rng / regulations / car**

```
docs/DESIGN.md와 CLAUDE.md를 먼저 끝까지 읽어. 질문이 있으면 코드 쓰기 전에 물어봐.

이번 세션은 M1의 전반이야 (DESIGN.md 16절). 범위:
1. pnpm workspaces 모노레포 스캐폴딩. DESIGN.md 13절 구조 그대로 — packages/core, packages/agents,
   packages/harness, apps/runner 전부 만들고 빈 패키지는 index.ts만. TS strict, vitest, eslint.
   core에는 no-restricted-globals로 window/document/process/fetch/console/Date/Math.random 금지.
2. data/regulations/2026.yaml — DESIGN.md 3·4·6절의 숫자 전부. 문서에 없는 값이 필요하면
   합리적인 기본값 + TODO(balance) 주석.
3. packages/core/src/rng.ts — xoshiro128**, spawn(key), normal(). 16절 시그니처.
4. packages/core/src/regulations.ts, car.ts — zod 스키마(strict), parseRegulations, cost, validateSpec,
   derive. 오류 메시지는 사람이 읽는 문장으로.
5. 16절 테스트 기준 중 rng, regulations, car.derive, 순수성 항목.

track, tires, laptime, windTunnel은 다음 세션이야. 이번에 만들지 마.

끝나면 pnpm test와 pnpm lint 결과, 문서와 달라진 점, 정하지 못해서 기본값으로 둔 것 목록을 짧게 써줘.
```

**세션 2 — track / tires / laptime / windTunnel**

```
세션 1 결과와 docs/DESIGN.md 5·6·16절을 다시 읽어.

이번 세션은 M1의 후반:
1. data/tracks/ 가상 서킷 3개 (fast-oval, tight-street, mixed) — 센터라인 CSV + meta YAML.
   센터라인은 닫힌 곡선이면 되고 예쁘지 않아도 돼. 16절 트랙 테스트가 요구하는 특성 차이만 내.
2. track.ts — 스플라인 재샘플링(5 m) → 곡률 → 세그먼트, profile().
3. tires.ts, laptime.ts — 6절 식 그대로. baseLap은 세그먼트 유형별 breakdown을 내고,
   raceLap은 노이즈를 직접 만들지 않고 호출자가 넘긴 값을 더해.
4. packages/agents/src/tools.ts — makeDesignTools / windTunnel만. 예산 소진 시 throw.
5. 16절 테스트 기준 나머지 전부. 특히 "laptime 트랙 차별" — wing 최적값이 서킷 순서대로 달라야 해.
   안 달라지면 테스트를 느쐨하지 말고 모델의 어느 계수 때문인지 보고해.

끝나면 세 서킷에서 기본 스펙의 baseLap breakdown을 표로 보여주고, M2(하네스 설계 탐색)를 위해
무엇이 더 필요할지 제안해줘.
```

**세션이 어긋날 때**

- 문서에 없는 걸 만들었으면: "그건 범위 밖이야. 되돌리고 왜 필요했는지 말해줘."
- 테스트를 약화했으면: "테스트 원래대로 돌려놓고 모델을 고쳐. 모델이 맞고 테스트가 틀리면 이유를 먼저 설명해."
- 숫자를 코드에 박았으면: "yaml로 옮겨. core에 매직 넘버 금지."
- 문서가 틀렸다고 하면: 들어보고 맞으면 문서부터 고치고 코드를 따라가게.
