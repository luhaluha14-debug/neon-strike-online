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
시작 화면에서 **맵 · 프레임 제한 · 화질**을 고릅니다. 선택은 브라우저에 저장되며,
맵을 바꿔도 페이지를 새로 열지 않으므로 **모든 맵이 같은 링크**를 씁니다.
(예전 `?map=` 링크도 한 번 적용된 뒤 주소에서 지워집니다.)

**프레임 제한**: 기본값 "최대"는 모니터 주사율 그대로(144/165/240Hz 모니터면 그만큼) 그립니다.
브라우저는 화면을 주사율보다 자주 갱신하지 않으므로 그 이상은 의미가 없고, 주사율 밖에서
억지로 돌리면 오히려 화면 갱신이 굶어 끊깁니다(측정으로 확인). 주사율 이상이 꼭 필요하면 브라우저를
`--disable-frame-rate-limit` 로 실행해야 합니다. 프레임이 주사율보다 낮다면 **화질 "낮음"**을 고르세요.

| 키 | 동작 |
| --- | --- |
| W A S D | 이동 |
| 마우스 | 시점 회전 |
| Space | 점프 |
| 좌클릭 | 사격 / 베기 |
| R | 재장전 |
| 1 / 2 / 3 | 무기 선택 (AR-01 / SR-01 / KARAMBIT) |
| 마우스 휠 · Q | 다음 무기 · 이전 무기 |
| F | 무기 살펴보기 |
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
├─ public/maps/seoul.glb        MAP 02 · 서울 (기본 맵, 청계천 버전)
├─ public/maps/Untitled.glb     MAP 01 · 창고 지구
└─ src/
   ├─ main.ts                   진입점, 화질 자동 선택
   ├─ maps.ts                   ★ 맵 목록: 파일 경로, 노드 분류 규칙, 안개/시야 거리
   ├─ config.ts                 이동/카메라/화질 수치
   ├─ core/Game.ts              렌더러, 조명, 고정 틱 게임 루프(120Hz) + 보간, 맵 교체
   ├─ core/FrameLoop.ts         rAF 기반 프레임 루프 + 프레임 제한
   ├─ core/Settings.ts          맵·프레임 제한·화질 저장 (localStorage)
   ├─ world/MapLoader.ts        GLB 로드, 노드 분류, 머티리얼별 정적 배칭, 스폰 포인트 추출
   ├─ world/CollisionWorld.ts   맵 삼각형 BVH, 캡슐 충돌 해소, 레이캐스트
   ├─ player/PlayerController.ts 캡슐 캐릭터 이동 (가속/마찰, 점프, 경사로, 앉기, 지면 스냅)
   ├─ weapons/weapons.ts        ★ 무기 데이터 (피해·연사·탄창·재장전·반동·탄퍼짐·1인칭 위치) + 기본 로드아웃
   ├─ weapons/WeaponDefinition.ts 무기 데이터 타입
   ├─ weapons/Weapon.ts         탄약·연사·재장전 상태 (렌더링 없음, 서버에서도 재사용 가능)
   ├─ weapons/RecoilController.ts 반동 누적/회복
   ├─ weapons/WeaponSystem.ts   로드아웃·무기 교체·살펴보기 + 명령(WeaponCommand) → 무기 → 히트스캔 → 반동 → 이벤트
   ├─ weapons/view/             1인칭 무기 표현 (WeaponView 인터페이스, 임시 절차적 소총, 별도 렌더 패스)
   │  ├─ FirstPersonArms.ts     장갑 낀 손 + 소매. 무기의 앵커와 손잡이 프로필(HandGrip)만 보고 손 모양을 만듦
   │  ├─ HandGrip.ts            손잡이 크기·검지 위치(방아쇠/고리)·손목 높이·팔꿈치 위치
   │  ├─ ModelKit.ts            절차적 모델 도구 (상자·원통·측면 프로필 압출·캔버스 텍스처)
   │  ├─ ProceduralRifleView.ts AR-01 임시 모델
   │  ├─ SniperRifleView.ts     SR-01 (AWP 스타일 볼트액션 저격총) 임시 모델 + 볼트 애니메이션
   │  └─ KarambitView.ts        카람빗 임시 모델 (청록/파랑 그라데이션 칼날)
   ├─ debug/viewModelChecks.ts  (개발용) 장갑-무기 겹침·카메라 근접 측정: 콘솔에서 vmCheck()
   ├─ combat/Damage.ts          Damageable 인터페이스 (나중에 적/봇이 구현)
   ├─ combat/HitscanSystem.ts   화면 중앙 레이캐스트: 맵 먼저 → 더 가까운 대상만 피격, 거리별 피해 감소
   ├─ fx/ImpactEffects.ts       탄흔 + 먼지 (인스턴싱, 드로우콜 2개)
   ├─ input/InputState.ts       장치 독립 입력 상태 (모바일 터치 입력을 나중에 추가하기 위한 추상화)
   ├─ input/KeyboardMouseInput.ts PC 키보드 + Pointer Lock 마우스
   └─ ui/Hud.ts, hud.css        조준점, 체력 HUD, 시작/일시정지 화면, 성능 정보
```

## 무기

| 슬롯 | 무기 | 특징 |
| --- | --- | --- |
| 1 | **AR-01** 돌격소총 | 600 RPM 자동, 30 / 90발, 재장전 2.2초, 몸통 32 · 머리 ×4 |
| 2 | **SR-01** 볼트액션 저격총 (AWP 스타일) | 한 발씩(볼트 1.46초), 5 / 30발, 재장전 3.6초, 몸통 115 · 머리 ×4, 이동 중 탄퍼짐 큼, 꺼내기 1.0초 |
| 3 | **KARAMBIT** 카람빗 | 탄약 없음, 0.5초마다 베기, 사거리 1.9 m, 40 피해 |

- 이름과 모델은 모두 오리지널 임시 디자인입니다 (실제 총기·게임 이름을 쓰지 않음).
- 모든 수치는 `src/weapons/weapons.ts` 한 곳에 있습니다. 새 무기는 같은 형식의 항목을 추가하고 `DEFAULT_LOADOUT` 에 넣으면 됩니다.
- 무기를 바꿔도 각 무기의 탄약은 유지되고, 재장전 중에 바꾸면 재장전이 취소됩니다(탄약 손실 없음).
- 발사는 고정 틱(120Hz)에서 계산되어 프레임레이트와 무관하게 연사 속도가 정확합니다. 매 발마다 별도 레이캐스트를 합니다.
- 제자리에서는 첫 발이 조준점 정중앙에 맞고, 이동/점프 중에는 탄퍼짐이 커집니다 (`spread`).
- 반동: 발사할수록 위로 누적(최대 6°), 좌우는 약간 흔들리다 길게 쏘면 한쪽으로 흐름. 사격을 멈추면 원래 조준점으로 복귀하며, 플레이어가 마우스를 내려 보정한 만큼은 되돌리지 않습니다.
- **손**: 검은 전술 장갑 + 어두운 소매의 절차적 팔이 무기의 `gripAnchor`(오른손)와 `supportAnchor`(왼손)에 붙습니다.
  손잡이 크기에 맞춰 손가락 위치가 바뀌고, 검지는 방아쇠 위(총) 또는 고리 안(카람빗)에 들어갑니다. 한 손 무기는 왼팔을 숨깁니다.
- **적 추가 시**: `Damageable` 을 구현해 `game.hitscan.register(target)` 하면 벽 판정·거리 감소·부위 배율이 자동 적용됩니다.
- 개발 서버 콘솔에서 `game.debugShots = true` 로 매 발의 명중 결과를 로그로 볼 수 있습니다.

## 무기 구조

```
플레이어 입력 ─┐
               ├─▶ WeaponCommand { fire, reload, equipSlot, equipLast, inspect }
AI 봇 (예정) ──┘                 │
                                 ▼
                         WeaponSystem (로드아웃, 교체, 살펴보기)
                                 ▼
                         Weapon (탄약·연사·재장전·꺼내기 상태, 렌더링 없음)
                                 ▼  이벤트(onShot, onEquip …)
          Game ──▶ ViewModelLayer ──▶ WeaponView (AR-01 / SR-01 / KARAMBIT / GLB)
                         │                 └─ 앵커: Grip_R, Grip_L, Muzzle, Magazine, Bolt
                         └──▶ FirstPersonArms (앵커 + HandGripProfile 로 손 모양 생성)
```

- 무기는 입력 장치를 모릅니다. `WeaponSystem.step(command, dt)` 에 같은 구조체만 넣으면 플레이어든 봇이든 똑같이 동작합니다.
- 근접 무기는 "탄창 0 + 사거리 1.9 m" 인 무기라서 사격·히트스캔·피해 코드를 그대로 씁니다.
- **1인칭 위치 조정**: `weapons.ts` 의 `view.pose` (position / rotation / scale). 코드 수정 없이 숫자만 바꾸면 됩니다.
  개발 서버에서는 콘솔에서 `game.viewModel.restPosition.set(x, y, z)` 로 바로 확인하고, `vmCheck()` 로 장갑 겹침과 카메라 근접을 측정할 수 있습니다.
- 애니메이션 자리: 꺼내기(아래에서 올라옴), 재장전, 반동, 볼트 당기기(SR-01), 베기(카람빗), 살펴보기(F)는 간단한 임시 동작입니다.
  모델은 `animate(state)` 로 자기 부품(볼트 등)만 움직이고, 공통 동작은 `ViewModelLayer` 가 처리합니다.

### Blender 모델로 교체하기

1. 모델 좌표(게임 기준): 총구/칼날 방향 **-Z**, 위 **+Y**, 오른쪽 **+X**, 단위 m. 원점은 대략 손잡이 근처.
   Blender(Z-up)에서는 총구를 **+Y**, 위를 **+Z** 로 만들면 glTF 내보내기가 게임 기준으로 바꿔 줍니다.
2. 빈 오브젝트(Empty) 이름:
   - `Grip_R` — 오른손 위치. 로컬 +Y 가 손잡이 축(위), +Z 가 사수 쪽.
   - `Grip_L` — 왼손 위치 (총열 덮개 아래). 한 손 무기는 생략 → 왼팔 숨김.
   - `Muzzle` (총구 화염), `Magazine` (재장전 때 빠지는 부품), `Bolt` (볼트액션) — 있으면 사용.
3. 장갑 맞추기 (Custom Properties, glTF 내보내기에서 "Custom Properties" 체크):
   - `Grip_R` 에 `grip_width`, `grip_depth` (m), `grip_index` ("trigger" / "ring"), `wrist_lift` (m)
   - 무기 오브젝트에 `right_elbow`, `left_elbow` ([x, y, z]) — 팔이 모델을 관통할 때만
4. `public/weapons/` 에 GLB를 넣고 `weapons.ts` 의 `view` 를
   `{ kind: 'gltf', url: '/weapons/sr01.glb', fallback: 'sr01', pose: { … } }` 로 바꿉니다. 끝입니다.
   로딩 중에는 `fallback` 임시 모델이 보이고, 다 받으면 자동으로 바뀝니다 (`GltfWeaponView`).
   무기 로직(`Weapon`, `WeaponSystem`), 팔(`FirstPersonArms`), 공통 모션(`ViewModelLayer`)은 수정하지 않습니다.
5. 개발 서버 콘솔에서 `vmCheck()` 로 장갑이 모델에 묻히는지(mm)와 카메라에 너무 가까운지 확인하고 `pose` 를 조정합니다.

검증: 현재 SR-01 임시 모델을 브라우저에서 GLB로 내보낸 뒤 이 경로로 다시 불러와, 손 위치·손잡이 프로필·팔꿈치·볼트 동작·겹침 수치가
절차적 모델과 동일함을 확인했습니다.

## 맵 규칙 (Blender 노드 이름)

맵은 노드 이름 접두어로 분류되며, 규칙은 맵마다 `src/maps.ts` 에 있습니다.

| 분류 | 서울 | 창고 지구 | 동작 |
| --- | --- | --- | --- |
| 스폰 (Empty) | `ATK_SpawnPoint_*`, `DEF_SpawnPoint_*` | 같음 | 공격 스폰 가운데에서 시작 |
| 숨김 | `TPL_*`, `CG_TPL*`, `Cube*` | `Tpl_*`, `Cube` | 원점에 놓인 템플릿 → 표시·충돌 없음 |
| 플레이어 차단벽 | `Boundary_*` | – | 보이지 않음, 이동만 막고 **총알은 통과** |
| 충돌 없음 | 원경(`Backdrop_`, `Skyline_`, `Mountain_`, `Far_` …), 청계천 갈대·버드나무, 바닥 도색 | 자갈·케이블·간판 등 | 보이지만 통과 |
| 구역 표시 | `Zone_*` | `Zone_*` | 기본 숨김, F3로 표시 |
| 나머지 | | | 렌더링 + 충돌 + 총알 차단 |

**새 맵 추가**: GLB를 `public/maps/` 에 넣고 `src/maps.ts` 의 `MAPS` 에 항목 하나를 추가하면 시작 화면 선택 목록에 나타납니다.
Blender 파일에 장면이 여러 개면 **활성 장면**(내보낼 때 선택된 장면)이 로드됩니다.

## 성능 설계

- 메시를 머티리얼별로 병합: 서울 1308개 → 168 드로우콜, 창고 지구 586개 → 88 드로우콜
  (공간 단위로 더 쪼개는 방식도 측정했지만 삼각형은 20%만 줄고 드로우콜이 2~3배가 되어 채택하지 않음)
- 정적 맵이므로 그림자 맵은 로드 시 **한 번만** 렌더링 (플레이 구역에만 맞춰 해상도 확보)
- 충돌은 BVH(three-mesh-bvh)로 처리 (서울 약 29만, 창고 지구 약 10만 삼각형). 원경·갈대·버드나무는 충돌에서 제외
- 1인칭 무기·손은 작은 환경 반사맵(시작 시 1회 생성)으로 재질감 표현
- 저사양(`low`): 픽셀 비율 1, 그림자·안티앨리어싱 끔
- HUD는 값이 바뀔 때만 DOM을 갱신

## 배포 (Render 정적 사이트, 무료)

저장소 루트의 `render.yaml` 에 `tactical-fps` 정적 사이트가 정의되어 있습니다
(`npm ci && npm run build` → `dist/` 공개).

1. [Render](https://render.com)에서 **New → Blueprint** 를 누르고 이 저장소를 고릅니다.
   이미 Blueprint를 연결해 두었다면 기본 브랜치에 병합되는 순간 자동으로 추가됩니다.
2. 배포가 끝나면 `https://tactical-fps-xxxx.onrender.com` 주소로 접속합니다.

정적 사이트라 서버처럼 잠들지 않고, 바로 열립니다.
