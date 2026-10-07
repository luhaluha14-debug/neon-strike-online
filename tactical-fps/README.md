# Tactical FPS (프로토타입)

웹 브라우저에서 실행되는 5v5 라운드 기반 폭탄 해체 전술 FPS의 기반 프로젝트입니다.
현재 단계: Blender 맵 안에서 1인칭 이동 + 기본 소총 **AR-01** (자동 사격, 탄약/재장전, 히트스캔, 반동).
모든 콘텐츠(맵, UI 등)는 오리지널입니다.

## 실행

```bash
cd tactical-fps
npm install
npm run dev        # http://localhost:5173
npm run build      # 타입 검사 + 프로덕션 빌드 (dist/)
npm run preview    # 빌드 결과 확인
```

화면의 **클릭하여 시작** 버튼을 누르면 마우스가 잠기고 바로 플레이할 수 있습니다.
시작 화면에서 **맵**을 고를 수 있습니다 (`?map=seoul` / `?map=warehouse` 로도 지정).
화질은 자동으로 고르며 `?quality=low|medium|high` 로 강제할 수 있습니다.

| 키 | 동작 |
| --- | --- |
| W A S D | 이동 |
| 마우스 | 시점 회전 |
| Space | 점프 |
| 좌클릭 | 사격 (자동) |
| R | 재장전 |
| Shift | 걷기 (느리게) |
| C / 왼쪽 Ctrl | 앉기 (머리 위 공간이 있어야 일어섬) |
| F4 | 스폰 위치로 복귀 |
| F3 | 성능 정보 + 게임 구역(스폰/설치 구역) 표시 |
| Esc | 일시정지 |

> 브라우저는 Ctrl+W 같은 단축키를 막을 수 없으므로 앉기는 C 키를 권장합니다.

## 구조

```
tactical-fps/
├─ index.html
├─ public/maps/seoul.glb        MAP 02 · 서울 (기본 맵)
├─ public/maps/Untitled.glb     MAP 01 · 창고 지구
└─ src/
   ├─ main.ts                   진입점, 화질 자동 선택
   ├─ maps.ts                   ★ 맵 목록: 파일 경로, 노드 분류 규칙, 안개/시야 거리
   ├─ config.ts                 이동/카메라/화질 수치
   ├─ core/Game.ts              렌더러, 조명, 고정 틱 게임 루프(120Hz) + 보간
   ├─ world/MapLoader.ts        GLB 로드, 노드 분류, 머티리얼별 정적 배칭, 스폰 포인트 추출
   ├─ world/CollisionWorld.ts   맵 삼각형 BVH, 캡슐 충돌 해소, 레이캐스트
   ├─ player/PlayerController.ts 캡슐 캐릭터 이동 (가속/마찰, 점프, 경사로, 앉기, 지면 스냅)
   ├─ weapons/weapons.ts        ★ 무기 데이터 (피해·연사·탄창·재장전·반동·탄퍼짐) — 밸런스는 여기서만 수정
   ├─ weapons/WeaponDefinition.ts 무기 데이터 타입
   ├─ weapons/Weapon.ts         탄약·연사·재장전 상태 (렌더링 없음, 서버에서도 재사용 가능)
   ├─ weapons/RecoilController.ts 반동 누적/회복
   ├─ weapons/WeaponSystem.ts   입력 → 무기 → 한 발씩 히트스캔 → 반동 → 이벤트
   ├─ weapons/view/             1인칭 무기 표현 (WeaponView 인터페이스, 임시 절차적 소총, 별도 렌더 패스)
   ├─ combat/Damage.ts          Damageable 인터페이스 (나중에 적/봇이 구현)
   ├─ combat/HitscanSystem.ts   화면 중앙 레이캐스트: 맵 먼저 → 더 가까운 대상만 피격, 거리별 피해 감소
   ├─ fx/ImpactEffects.ts       탄흔 + 먼지 (인스턴싱, 드로우콜 2개)
   ├─ input/InputState.ts       장치 독립 입력 상태 (모바일 터치 입력을 나중에 추가하기 위한 추상화)
   ├─ input/KeyboardMouseInput.ts PC 키보드 + Pointer Lock 마우스
   └─ ui/Hud.ts, hud.css        조준점, 체력 HUD, 시작/일시정지 화면, 성능 정보
```

## 무기

- **AR-01** (오리지널 임시 디자인): 600 RPM 자동, 30발 탄창 / 예비 90발, 재장전 2.2초, 몸통 32 / 머리 ×4.
- 모든 수치는 `src/weapons/weapons.ts` 한 곳에 있습니다. 새 총은 같은 형식의 항목을 하나 추가하면 됩니다.
- 발사는 고정 틱(120Hz)에서 계산되어 프레임레이트와 무관하게 연사 속도가 정확합니다. 매 발마다 별도 레이캐스트를 합니다.
- 제자리에서는 첫 발이 조준점 정중앙에 맞고, 이동/점프 중에는 탄퍼짐이 커집니다 (`spread`).
- 반동: 발사할수록 위로 누적(최대 6°), 좌우는 약간 흔들리다 길게 쏘면 한쪽으로 흐름. 사격을 멈추면 원래 조준점으로 복귀하며, 플레이어가 마우스를 내려 보정한 만큼은 되돌리지 않습니다.
- **Blender 무기 모델로 교체하기**: 총구 방향 -Z, 손잡이 위치를 원점으로 모델을 만들고 `Muzzle`, `Magazine` 이름의 Empty를 두면 됩니다.
  `weapons.ts` 의 `view` 를 `{ kind: 'gltf', url: '/weapons/ar01.glb' }` 로 바꾸고 `WeaponView.ts` 의 GLB 로더 부분만 채우면 흔들림·반동·재장전 모션은 그대로 적용됩니다.
- **적 추가 시**: `Damageable` 을 구현해 `game.hitscan.register(target)` 하면 벽 판정·거리 감소·부위 배율이 자동 적용됩니다.
- 개발 서버 콘솔에서 `game.debugShots = true` 로 매 발의 명중 결과를 로그로 볼 수 있습니다.

## 맵 규칙 (Blender 노드 이름)

맵은 노드 이름 접두어로 분류되며, 규칙은 맵마다 `src/maps.ts` 에 있습니다.

| 분류 | 서울 | 창고 지구 | 동작 |
| --- | --- | --- | --- |
| 스폰 (Empty) | `ATK_SpawnPoint_*`, `DEF_SpawnPoint_*` | 같음 | 공격 스폰 가운데에서 시작 |
| 숨김 | `TPL_*`, `Cube` | `Tpl_*`, `Cube` | 원점에 놓인 템플릿 → 표시·충돌 없음 |
| 플레이어 차단벽 | `Boundary_*` | – | 보이지 않음, 이동만 막고 **총알은 통과** |
| 충돌 없음 | 원경(`Backdrop_`, `Skyline_`, `Mountain_`, `Far_`, `Han_River_` …), 바닥 도색 | 자갈·케이블·간판 등 | 보이지만 통과 |
| 구역 표시 | `Zone_*` | `Zone_*` | 기본 숨김, F3로 표시 |
| 나머지 | | | 렌더링 + 충돌 + 총알 차단 |

**새 맵 추가**: GLB를 `public/maps/` 에 넣고 `src/maps.ts` 의 `MAPS` 에 항목 하나를 추가하면 시작 화면 선택 목록에 나타납니다.
Blender 파일에 장면이 여러 개면 **활성 장면**(내보낼 때 선택된 장면)이 로드됩니다.

## 성능 설계

- 메시를 머티리얼별로 병합: 서울 1160개 → 136 드로우콜, 창고 지구 586개 → 88 드로우콜
- 정적 맵이므로 그림자 맵은 로드 시 **한 번만** 렌더링 (플레이 구역에만 맞춰 해상도 확보)
- 충돌은 BVH(three-mesh-bvh)로 처리 (서울 약 15만, 창고 지구 약 10만 삼각형). 원경은 충돌에서 제외
- 저사양(`low`): 픽셀 비율 1, 그림자·안티앨리어싱 끔
- HUD는 값이 바뀔 때만 DOM을 갱신

## 배포 (Render 정적 사이트, 무료)

저장소 루트의 `render.yaml` 에 `tactical-fps` 정적 사이트가 정의되어 있습니다
(`npm ci && npm run build` → `dist/` 공개).

1. [Render](https://render.com)에서 **New → Blueprint** 를 누르고 이 저장소를 고릅니다.
   이미 Blueprint를 연결해 두었다면 기본 브랜치에 병합되는 순간 자동으로 추가됩니다.
2. 배포가 끝나면 `https://tactical-fps-xxxx.onrender.com` 주소로 접속합니다.

정적 사이트라 서버처럼 잠들지 않고, 바로 열립니다.
