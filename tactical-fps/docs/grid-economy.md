# GRID 스킨 · 상점 · 보관함 · 크레딧 — 설계와 계약

Git 기준점: `05be091` (main, PR #20 병합 후). 이 문서는 1단계 조사 결과, 파일별 계획,
그리고 온라인 계정·거래로 확장할 때의 API 계약을 함께 담는다.

## 1. 조사 결과 (실제 코드 기준)

| 항목 | 실제 위치 | 분류 |
| --- | --- | --- |
| 패키지 구성 | 루트 `package.json`(dropzone / neon_strike_online: 별개 게임), `tactical-fps/`(Vite 8 + TS 5.9 + three 0.186, 정적 사이트) | 재사용 |
| 게임 상태 · 메인 메뉴 | `core/Game.ts`(모든 연결), `ui/MainMenu.ts`(탭: 플레이·무기·설정·조작, 일시정지 메뉴), `ui/Hud.ts` | 확장 필요 (탭 3개 추가) |
| 무기 카탈로그 · ID | `weapons/weapons.ts`: `ar01 sr01 karambit smg01 sg01 pis01`; 라운드 구매 카탈로그 `weapons/catalog.ts`(AR-01 …, 라운드 자금 $) | 재사용 (스킨 대상 ID로 사용, 라운드 경제와 분리) |
| 1인칭 무기 뷰모델 | `weapons/view/GltfWeaponView.ts`(GLB 장면을 복제, **재질은 캐시된 원본과 공유**), `ViewModelLayer.setView` | 확장 필요 (생성 직후 외형 적용 지점) |
| 월드 무기 모델 | 봇 소총만(`ai/BotModel.ts buildBotRifle`). 플레이어의 3인칭 모델은 없음 | 해당 없음 (플레이어 월드 모델이 존재하지 않음) |
| 장갑 · 소매 | `weapons/view/FirstPersonArms.ts`(장갑·패드·소매·커프 재질, 무기마다 새로 생성) | 확장 필요 (외형 값 주입) |
| 캐릭터 | 플레이어: `player/FirstPersonBody.ts`(하체·재킷 재질) + 1인칭 소매. 봇: `BotModel`/`AgentModel`(팀 색) | 확장 필요 (플레이어 것만; 봇 팀 색은 유지 — 피아 식별) |
| 칼 | `karambit` 무기(GLB `m9_bayonet.glb`, 재질 5개) | 무기 스킨과 같은 경로 |
| 라운드 종료 · 승패 | `game/TeamMatch.ts`(`over`, `winner`, `forfeitedBy`, `history`, `feed`) | 재사용 (읽기만) |
| 데스매치 처치 · 사망 | `game/Match.ts`(`recordKill`, `feed`, `over`) | 재사용 (읽기만) |
| 훈련장 | `combat/TrainingRange.ts`(표적, 리셋) — 경기 개념 없음 | 보상 대상 아님 |
| 라운드 구매 경제 | `game/Economy.ts`(경기 내 $ 자금) | 그대로 보존 (GRID 크레딧과 완전히 별개) |
| 설정 · 저장 | `core/Settings.ts`, `input/Controls.ts`, `game/MatchSettings.ts` — 각자 `localStorage` 직접 | 그대로; 새 경제는 저장소 추상화 경유 |
| 테스트 | `tests/*.test.mjs`(node:test + Playwright + Vite dev 서버), `tests/run.mjs` | 재사용; 순수 로직은 Vite `ssrLoadModule`로 **Node에서** 실행 |
| 배포 | `render.yaml` 정적 사이트(`tactical-fps`) | 서버 없음 |
| 서버 · 백엔드 | GRID용 서버·DB·인증 **없음** (`dropzone/`은 다른 게임의 ws 서버) | 온라인 서버 확인 필요 → 이번 범위는 계약·서버측 로직·테스트까지 |
| GLB 텍스처 · UV | 모든 무기·캐릭터 GLB에 텍스처 없음, UV는 일부 메시만(SMG/캐릭터 0%) | 스킨 외형 = 재질별 단색 마감(색·금속성·거칠기). 패턴 텍스처는 UV가 없어 쓰지 않음 |

## 2. 모듈 구성 (새 파일)

전투 코드와 독립. `src/economy/*`는 three·DOM을 쓰지 않는 순수 TS(서버에서도 그대로 실행 가능).

| 파일 | 역할 |
| --- | --- |
| `economy/types.ts` | 스킨·보유 아이템·장착·거래 기록·미션·계정 상태 타입 |
| `economy/SkinCatalog.ts` | 스킨 상품 데이터 + 검증(고유 ID, 0 이상 정수 가격, 대상 호환) |
| `economy/EconomyRules.ts` | 경기 보상·미션 정의(데이터로 조정) |
| `economy/AccountRepository.ts` | 저장소 인터페이스 + `LocalAccountRepository`(localStorage `grid.account.v1`) + `MemoryAccountRepository` |
| `economy/WalletService.ts` | 잔액·거래 기록(음수 금지, 고유 txId) |
| `economy/InventoryService.ts` | 보유 아이템(아이템 인스턴스 ID, 획득 경로, 거래 가능 여부) |
| `economy/LoadoutService.ts` | 장착(소유·호환 검증, 기본 스킨, 해제) |
| `economy/ShopService.ts` | 상품 조회·구매(가격은 카탈로그에서만) |
| `economy/MissionService.ts` | 일일 미션(날짜 키, 이벤트 ID 중복 방지, 완료/수령 분리) |
| `economy/RewardService.ts` | 경기 결과 → 크레딧(경기 ID 1회, 훈련장·포기·중단 0) |
| `economy/EconomyAuthority.ts` | 위 서비스들을 묶은 **권한 있는 처리기**: 요청 직렬화, 요청 ID 멱등, 저장 성공 시에만 확정(원자성) |
| `economy/EconomyBackend.ts` | 클라이언트가 쓰는 API 계약 + `LocalEconomyBackend`(오프라인: 같은 Authority를 로컬 저장소로 실행) |
| `economy/server/TradeService.ts` | 사용자 간 거래 상태 기계(서버측 모델) + 소유권 원장 |
| `skins/SkinRenderer.ts` | 외형 적용(무기·칼 재질 교체, 장갑·소매·하체 색). 재질은 스킨별 1회 생성 후 캐시 |
| `ui/GridStore.ts` (+ `grid.css`) | 상점 · 보관함 · 미션 화면 |

## 3. 기존 파일 변경 (연결 지점만)

| 파일 | 변경 |
| --- | --- |
| `core/Game.ts` | 경제 백엔드·스킨 렌더러 생성; 무기 뷰 생성 직후 외형 적용; 경기 종료 시 결과 1회 제출(경기 ID) |
| `weapons/view/ViewModelLayer.ts` | 팔 생성 시 외형 콜백 1개 |
| `weapons/view/FirstPersonArms.ts` | `applyLook()` (자기 재질 색만 변경) |
| `player/FirstPersonBody.ts` | `applyLook()` |
| `ui/MainMenu.ts` | 탭 3개(보관함·상점·미션) 추가, 넓은 페이지 레이아웃 |
| `ui/weaponThumbnails.ts` | 선택 인자 `decorate`(스킨 미리보기) |

## 4. 예상 충돌 지점

- **재질 공유**: GLB 복제본은 원본 재질을 공유 → 스킨은 원본 재질을 수정하지 않고 메시의 재질 참조만 캐시된 스킨 재질로 교체(다른 무기·썸네일 오염 방지).
- **이름 충돌**: 라운드 구매의 `$`/`Economy.ts`/`BuyMenu`와 GRID 크레딧은 이름·화면·저장 키를 분리(`grid.*`, "CR").
- **메뉴 폭**: 기존 메뉴는 좌측 좁은 패널 → 상점·보관함 탭에서만 넓은 레이아웃.
- **경기 종료 경로**: 정상 종료(결과 화면), 포기(`forfeitMatch`), 중도 이탈(재시작·모드 변경) — 보상은 정상 종료에서만 1회.
- **봇 팀 색**: 캐릭터 스킨은 플레이어 자신의 외형에만 적용(봇·아군 식별 색 불변).

## 5. 보상 · 미션 정책 (데이터: `EconomyRules.ts`)

- 팀전 정상 종료: 기본 + 승리 보너스 + 처치당 소액(상한). 데스매치 정상 종료: 기본 + 1위 보너스 + 처치당 소액(상한).
- **대결 포기**: 0 (경기 미완료로 간주, 미션 진행 없음). **중도 이탈**(재시작·모드/맵 변경·새로고침): 0.
- **훈련장**: 0, 미션 진행 없음.
- 같은 경기 ID의 결과는 한 번만 지급(결과 화면 재진입·재전송 무시).
- 일일 미션: 로컬 버전은 **브라우저 로컬 날짜**(YYYY-MM-DD)로 초기화. 온라인 버전은 서버가 날짜 키를 정함(`EconomyClock` 교체).

## 6. 온라인 계약 (서버 구현 시)

`EconomyBackend`(클라이언트가 호출하는 유일한 면):

| 요청 | 입력 | 서버가 결정 |
| --- | --- | --- |
| `getAccount()` | — | 계정 스냅샷(잔액·보유·장착·미션·revision) |
| `purchase(skinId, requestId)` | 상품 ID, 멱등 키 | 가격·잔액 검증·차감·지급(원자적), 거래 기록 |
| `equip(category, target, skinId \| null, requestId)` | 슬롯, 스킨 | 소유·호환 검증 |
| `submitMatchResult(result)` | 경기 ID·모드·결과·처치 | 결과 검증 후 보상(온라인: 서버가 본 경기만 인정) |
| `claimMission(missionId, requestId)` | 미션 ID, 멱등 키 | 완료 여부·1회 지급 |

- 모든 응답은 계정 `revision`을 포함. 클라이언트는 응답으로만 상태를 갱신(낙관적 반영 없음).
- 인증: 서버측 세션/토큰(검증된 인증 시스템). 비밀번호는 클라이언트·이 저장소에 저장하지 않음.
- 동기화: 로컬 데이터와 서버 데이터가 다르면 자동 덮어쓰기 없이 `conflict`로 보고하고 사용자가 선택.
- 거래(`economy/server/TradeService.ts`): 서버 전용. 상태 `open → (양측 확정) → completed | cancelled | expired | failed`,
  아이템 잠금·원자적 소유권 이전·멱등 요청·감사 기록·정지 계정 차단. 현금 결제·인출 없음.
