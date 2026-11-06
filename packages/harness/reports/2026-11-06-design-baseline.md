# 설계 공간 탐색 — 2026-11-06

규정 2026 · 캘린더 24전 · 스펙 2000개 (budget-surface, seed 2026) · 스펙×트랙마다 최적 셋업(윙 0–10 × 지상고 × ERS 모드), 건조 baseLap.

## 지표 (DESIGN.md 12절)

| 지표 | 값 | 기준 | 결과 |
| --- | --- | --- | --- |
| 1. 최속 스펙 집중도 | 스펙 #1736이 15/24 트랙 (62.5%) | < 35.0% | **실패** |
| 2. 파라미터 기여도 | 최대 mech_grip 61.4% (R² 1.000) | < 50.0% | **실패** |
| 3. 아키텍처 균형 | floor 17 / wing 7, short 23 / long 1 | 각 ≥ 6 | **실패** |

## 지표 2: 시즌 랩타임 분산 분해

Pratt 분해 (표준화 회귀계수 × 상관계수, 합 = R²). β < 0이면 값이 클수록 빠르다.

| 변수 | 설명 분산 | 단변량 R² | β |
| --- | --- | --- | --- |
| mech_grip | 61.4% | 0.559 | -0.821 |
| philosophy=floor | 27.7% | 0.273 | -0.530 |
| wheelbase=long | 10.1% | 0.099 | 0.320 |
| cooling | 1.5% | 0.045 | 0.073 |
| reliability | 0.7% | 0.045 | 0.035 |
| thermal_efficiency | 0.4% | 0.001 | -0.172 |
| drs_effect | -0.0% | 0.005 | -0.006 |
| tire_management | -0.1% | 0.010 | -0.012 |
| dirty_air_resistance | -0.1% | 0.016 | -0.010 |
| ers_capacity | -0.3% | 0.001 | -0.090 |
| aero_efficiency | -0.5% | 0.005 | -0.075 |
| weight_reduction | -0.6% | 0.003 | -0.117 |

## 트랙별 최속 스펙

| GP | 트랙 | 길이 | 직선 비율 | 코너 L/M/H | 범프 | 최속 스펙 | 랩 | 셋업 (윙/지상고/ERS) | 중앙값 랩 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | lakeside | 6.22 | 0.67 | 4/7/6 | 0.15 | #1736 floor/short | 85.161 | 6/low/attack | 86.526 |
| 2 | desert-sweep | 5.47 | 0.71 | 2/4/9 | 0.20 | #1122 floor/long | 67.892 | 6/low/attack | 68.854 |
| 3 | oasis | 4.31 | 0.73 | 3/5/6 | 0.10 | #9 floor/short | 60.695 | 8/low/attack | 61.591 |
| 4 | pinewood | 5.87 | 0.61 | 5/10/5 | 0.35 | #1736 floor/short | 86.686 | 10/low/attack | 88.115 |
| 5 | harbour-street | 3.06 | 0.55 | 12/5/3 | 0.75 | #1226 wing/short | 71.932 | 10/high/attack | 73.080 |
| 6 | canyon | 5.38 | 0.59 | 6/8/5 | 0.50 | #1736 floor/short | 90.350 | 10/low/attack | 91.057 |
| 7 | mixed | 3.55 | 0.66 | 2/5/2 | 0.30 | #1736 floor/short | 53.474 | 9/low/attack | 54.373 |
| 8 | tight-street | 2.19 | 0.58 | 10/2/1 | 0.80 | #1226 wing/short | 55.262 | 10/high/attack | 55.987 |
| 9 | vineyard | 5.86 | 0.62 | 3/9/6 | 0.25 | #1736 floor/short | 85.681 | 10/low/attack | 87.088 |
| 10 | coastal | 5.32 | 0.65 | 4/6/7 | 0.20 | #1736 floor/short | 79.892 | 6/low/attack | 81.035 |
| 11 | forest-ring | 6.00 | 0.56 | 3/10/8 | 0.35 | #1736 floor/short | 85.447 | 7/low/attack | 86.863 |
| 12 | airfield | 3.21 | 0.73 | 3/5/3 | 0.40 | #1736 floor/short | 48.186 | 6/low/attack | 48.970 |
| 13 | hillside | 4.57 | 0.53 | 6/12/3 | 0.55 | #1226 wing/short | 84.595 | 10/low/attack | 85.042 |
| 14 | plateau | 5.95 | 0.68 | 5/4/9 | 0.20 | #1736 floor/short | 82.284 | 5/low/attack | 83.698 |
| 15 | fast-oval | 4.35 | 0.71 | 2/1/5 | 0.15 | #1736 floor/short | 50.340 | 3/low/attack | 51.132 |
| 16 | quarry | 3.05 | 0.53 | 8/10/2 | 0.60 | #1226 wing/short | 69.187 | 10/mid/attack | 69.788 |
| 17 | marina | 3.79 | 0.57 | 10/6/2 | 0.60 | #1226 wing/short | 78.671 | 10/mid/attack | 79.361 |
| 18 | riverside-night | 6.49 | 0.64 | 5/8/5 | 0.40 | #1736 floor/short | 99.764 | 10/low/attack | 101.531 |
| 19 | sunset-boulevard | 3.45 | 0.67 | 9/4/3 | 0.70 | #1957 wing/short | 67.787 | 10/mid/attack | 68.755 |
| 20 | old-town | 3.59 | 0.54 | 11/8/1 | 0.85 | #1226 wing/short | 78.300 | 10/high/attack | 79.600 |
| 21 | stadium-loop | 3.73 | 0.72 | 3/6/3 | 0.30 | #1736 floor/short | 59.548 | 10/low/attack | 60.654 |
| 22 | river-park | 5.99 | 0.63 | 8/6/3 | 0.45 | #1736 floor/short | 97.982 | 8/low/attack | 99.493 |
| 23 | highland | 6.31 | 0.57 | 5/8/6 | 0.30 | #1736 floor/short | 95.726 | 10/low/attack | 97.420 |
| 24 | glacier | 5.12 | 0.59 | 6/6/5 | 0.10 | #1736 floor/short | 82.615 | 10/low/attack | 84.219 |

## 트랙 최속 스펙 목록

- #9 (1트랙): floor/short · 100.0 cr · thermal efficiency 1.00, reliability 1.00, ers capacity 1.00, cooling 0.40, weight reduction 1.00, mech grip 1.00, tire management 1.00, aero efficiency 1.00, dirty air resistance 1.00, drs effect 0.87
- #1122 (1트랙): floor/long · 100.0 cr · thermal efficiency 1.00, reliability 1.00, ers capacity 0.97, cooling 0.29, weight reduction 1.00, mech grip 1.00, tire management 1.00, aero efficiency 1.00, dirty air resistance 1.00, drs effect 1.00
- #1226 (6트랙): wing/short · 100.0 cr · thermal efficiency 1.00, reliability 1.00, ers capacity 1.00, cooling 0.01, weight reduction 1.00, mech grip 1.00, tire management 1.00, aero efficiency 1.00, dirty air resistance 1.00, drs effect 1.00
- #1736 (15트랙): floor/short · 100.0 cr · thermal efficiency 1.00, reliability 1.00, ers capacity 1.00, cooling 0.00, weight reduction 1.00, mech grip 1.00, tire management 1.00, aero efficiency 1.00, dirty air resistance 1.00, drs effect 1.00
- #1957 (1트랙): wing/short · 100.0 cr · thermal efficiency 1.00, reliability 1.00, ers capacity 1.00, cooling 0.07, weight reduction 1.00, mech grip 1.00, tire management 1.00, aero efficiency 1.00, dirty air resistance 1.00, drs effect 1.00

## 최적 셋업 분포 (스펙×트랙 전체)

- ERS 모드: harvest 0.0%, balanced 0.0%, attack 100.0%
- 지상고: low 79.2%, mid 8.3%, high 12.5%

