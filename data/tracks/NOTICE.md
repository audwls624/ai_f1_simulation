# 트랙 데이터 출처

## 실제 서킷

| 파일 | 서킷 | 출처 |
| --- | --- | --- |
| `spa.csv` | Circuit de Spa-Francorchamps (벨기에) | TUMFTM racetrack-database `tracks/Spa.csv` |

- 원본: https://github.com/TUMFTM/racetrack-database (Chair of Automotive Technology, Technical University of Munich).
  라이선스 LGPL-3.0 — 전문은 `LICENSE-TUMFTM-LGPL-3.0.txt` (LGPL-3.0은 GPL-3.0에 추가 허가를 더한 것이다: https://www.gnu.org/licenses/gpl-3.0.txt).
- 센터라인의 원래 GPS 점: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). TUMFTM이 평활화하고 위성 사진에서 폭을 뽑았다.
- 이 저장소에서 바꾼 것: 열 순서를 `x_m, y_m, z_m, w_left_m, w_right_m`으로 (원본은 `x, y, w_right, w_left`), z = 0 (원본에 고도 없음). 점은 원본 그대로.
- 레이스 성격 값(`<id>.yaml`의 랩 수 외 항목)은 이 프로젝트가 정한 출발값이다.

## 가상 서킷

나머지 트랙(`fast-oval`, `mixed`, `tight-street`, 그리고 하네스가 생성한 21개)은 이 프로젝트에서 만든 것이다 (`pnpm -F @f1sim/harness gen-tracks`).
