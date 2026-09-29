# Tactical FPS (프로토타입)

웹 브라우저에서 실행되는 5v5 라운드 기반 폭탄 해체 전술 FPS의 기반 프로젝트입니다.
현재 단계는 **"Blender로 만든 맵 안을 1인칭으로 정상적으로 돌아다닐 수 있는 FPS 기반"** 입니다.
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
화질은 자동으로 고르며 `?quality=low|medium|high` 로 강제할 수 있습니다.

| 키 | 동작 |
| --- | --- |
| W A S D | 이동 |
| 마우스 | 시점 회전 |
| Space | 점프 |
| Shift | 걷기 (느리게) |
| C / 왼쪽 Ctrl | 앉기 (머리 위 공간이 있어야 일어섬) |
| R | 스폰 위치로 복귀 |
| F3 | 성능 정보 + 게임 구역(스폰/설치 구역) 표시 |
| Esc | 일시정지 |

> 브라우저는 Ctrl+W 같은 단축키를 막을 수 없으므로 앉기는 C 키를 권장합니다.

## 구조

```
tactical-fps/
├─ index.html
├─ public/maps/Untitled.glb     Blender에서 만든 맵 (원본 그대로)
└─ src/
   ├─ main.ts                   진입점, 화질 자동 선택
   ├─ config.ts                 맵 경로·노드 분류 규칙, 이동/카메라/화질 수치
   ├─ core/Game.ts              렌더러, 조명, 고정 틱 게임 루프(120Hz) + 보간
   ├─ world/MapLoader.ts        GLB 로드, 노드 분류, 머티리얼별 정적 배칭, 스폰 포인트 추출
   ├─ world/CollisionWorld.ts   맵 삼각형 BVH, 캡슐 충돌 해소, 레이캐스트
   ├─ player/PlayerController.ts 캡슐 캐릭터 이동 (가속/마찰, 점프, 경사로, 앉기, 지면 스냅)
   ├─ input/InputState.ts       장치 독립 입력 상태 (모바일 터치 입력을 나중에 추가하기 위한 추상화)
   ├─ input/KeyboardMouseInput.ts PC 키보드 + Pointer Lock 마우스
   └─ ui/Hud.ts, hud.css        조준점, 체력 HUD, 시작/일시정지 화면, 성능 정보
```

## 맵 규칙 (Blender 노드 이름)

맵은 노드 이름 접두어로 분류됩니다. 규칙은 `src/config.ts` 의 `MAP_CONFIG` 에 있습니다.

- `ATK_SpawnPoint_*`, `DEF_SpawnPoint_*` (Empty): 공격/수비 스폰 위치. 현재는 공격 스폰 가운데에서 시작합니다.
- `Tpl_*`, `Cube`: 원점에 놓인 템플릿/기본 큐브 → 숨김, 충돌 없음.
- `Zone_*`: 스폰·폭탄 설치 구역 표시 → 기본 숨김(F3로 표시), 충돌 없음.
- `Ground_Pebble_*`, `Ground_Dirt_*`, `Deco_Cables_*`, `Sign_Letter_*` 등: 보이지만 충돌 없음 (작은 돌기에 걸리지 않도록).
- 나머지 메시(`Floor_`, `Wall_`, `Bldg_`, `Cover_`, `Ramp_`, `Platform_`, `Prop_` …): 렌더링 + 충돌.

맵 파일을 교체할 때는 `public/maps/` 에 넣고 `MAP_CONFIG.url` 만 바꾸면 됩니다.

## 성능 설계

- 586개 메시를 머티리얼별로 병합해 **약 90 드로우콜**로 렌더링
- 정적 맵이므로 그림자 맵은 로드 시 **한 번만** 렌더링
- 충돌은 약 10만 삼각형을 하나의 BVH(three-mesh-bvh)로 처리
- 저사양(`low`): 픽셀 비율 1, 그림자·안티앨리어싱 끔
- HUD는 값이 바뀔 때만 DOM을 갱신
