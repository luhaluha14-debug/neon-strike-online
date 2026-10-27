# GRID 계정 서버 · PostgreSQL 영구 저장

기준점: `a02e996` (main, PR #21 병합 후). 작업 전 기준선: 테스트 206/206 통과, `tsc --noEmit`·프로덕션 빌드 통과.

## 0. 상태 요약 — 무엇이 실제 DB로 동작하고 무엇이 아직 없는가

| 기능 | 상태 |
| --- | --- |
| 가입·로그인·로그아웃·세션 만료·정지 계정·로그인 제한 | **구현 · 실제 PostgreSQL 테스트** |
| 잔액·원장·인벤토리·장착·일일 미션·미션 보상 수령 | **구현 · 실제 PostgreSQL 테스트** |
| 구매 (서버 가격·서버 잔액·한 트랜잭션·멱등 키·동시성·롤백) | **구현 · 실제 PostgreSQL 테스트** |
| 게임 클라이언트 연동 (계정 줄·로그인 창·서버/오프라인 전환·새로고침·다른 브라우저) | **구현 · 브라우저 e2e(실제 서버+DB)** |
| 경기 보상 · 미션 진행 (`settleVerifiedMatch`) | 서버 내부 함수만 구현·테스트. **이를 호출할 신뢰 가능한 경기 검증(권위 게임 서버)은 없음** → 온라인 계정은 경기로 크레딧·미션 진행을 얻지 않음 |
| 클라이언트 경기 결과 보고 (`POST /api/match-results`) | 항상 403 `unverified` (지급 없음) |
| 플레이어 간 거래 | **미구현** (`src/economy/server/TradeService.ts`는 메모리 모델 그대로, DB·API 없음) |
| 오프라인 기록 → 계정 이전 | **하지 않음** (검증 불가). 로그인 시 알림만 |
| 배포 | 루트 `render.yaml`: DB `grid-accounts`(basic-256mb) + 웹 서비스 `tactical-fps-online`(starter). 정적 사이트 `tactical-fps`는 오프라인 전용으로 유지 |

## 1. 조사 결과 (기존 코드)

| 대상 | 기존 상태 | 이번 작업에서 |
| --- | --- | --- |
| `src/economy/*` (카탈로그 32종 = 기본 외형 8 + 판매 24, 규칙, 서비스) | 순수 TS, 브라우저·Node 공용 | **재사용**: 서버가 같은 카탈로그·가격(`ShopService.check`)·장착 규칙(`LoadoutService.equip`)·보상(`matchReward`)·미션 증가량(`missionIncrement`, 이번에 `MissionService.record`에서 분리)을 그대로 씀 |
| `EconomyAuthority` + `LocalAccountRepository` | localStorage에 계정 JSON 한 덩어리 | **오프라인 기록**으로 유지 (변경 없음) |
| `server/AccountApi.ts`, `RemoteEconomyBackend.ts` | 토큰 기반 참조 처리기(메모리) + 클라이언트 | 변경 없음(기존 테스트 유지). 실제 서버는 `server/`, 클라이언트는 `AccountClient.ts` |
| `server/TradeService.ts` | 메모리 모델 | 변경 없음 |
| `ui/GridStore.ts` | `EconomyBackend`만 사용 | 미션 날짜 표기(서버/기기), 페이지 열 때 서버 오류 무시, `suspended` 오류 문구만 추가 |
| `skins/*`, 무기·HUD·모드·입력 | — | 수정하지 않음 |
| 배포 | Render 정적 사이트 `tactical-fps` | 그대로. 서버 구성은 별도 파일로 준비 |

참고: README의 "스킨 34종(기본 8 + 판매 26)"은 이전 작업의 문서 오기였음(실제 코드·테스트는 32종 = 8 + 24). 카탈로그는 바꾸지 않고 문서를 바로잡음.

## 2. 아키텍처

```
브라우저 (Vite 빌드 클라이언트)
  └─ 같은 출처의 /api/*  ──  GRID 계정 서버 (Node 22, dist-server/main.js ← server/main.ts)
                                ├─ 정적 파일: dist/ (게임 클라이언트)
                                ├─ 인증: scrypt 비밀번호 해시, HttpOnly 세션 쿠키(DB에는 SHA-256)
                                ├─ 경제: 계정 행 잠금 + SQL 트랜잭션 (구매·장착·미션 수령)
                                └─ PostgreSQL (pg Pool)
```

| 파일 | 역할 |
| --- | --- |
| `server/config.ts` | 환경 변수 읽기·검증, 미션 날짜(`GRID_MISSION_TZ`) |
| `server/db.ts` | 풀, `withTx`, 시작 시 재시도, 오류 설명(URL·값 제거) |
| `server/migrations.ts` | 스키마 마이그레이션(코드에 포함, 번호순, 트랜잭션 + advisory lock) |
| `server/passwords.ts` | scrypt 해시·검증, 세션 토큰·해시 |
| `server/auth.ts` | 가입·로그인·로그아웃·세션 조회·로그인/가입 제한·감사 로그·정리 |
| `server/economyDb.ts` | 계정 조회, 구매·장착·미션 수령(멱등), `settleVerifiedMatch` |
| `server/http.ts` | 라우팅, JSON 본문(16 KB), 쿠키, CSRF, 정적 파일, 로그 |
| `server/main.ts` | 시작(연결 재시도 → 마이그레이션 → listen), SIGTERM 종료 |
| `src/economy/AccountProtocol.ts` | 클라이언트·서버 공통 규칙(아이디·비밀번호 규칙, 오류 코드, 문구). 비밀 없음 |
| `src/economy/AccountClient.ts` | 서버 감지, 로그인 API, `ServerEconomyBackend`, `SwitchableEconomyBackend` |
| `src/economy/AccountSession.ts` | 모드(확인 중 / 오프라인 / 로그아웃 / 로그인) 전환, 오프라인 기록 알림 |
| `src/ui/AccountPanel.ts` | GRID 페이지 상단 계정 줄 + 로그인·가입 창 |

- **같은 출처**: 서버가 게임도 제공하므로 세션은 1st-party `HttpOnly; SameSite=Lax` 쿠키, CORS 없음.
- **빌드 분리**: 클라이언트 `npm run build` → `dist/`. 서버 `npm run build:server` → `dist-server/main.js` (`pg`만 외부). 클라이언트는 `server/`를 import하지 않음 — 빌드 결과에서 `DATABASE_URL`, `scrypt`, `password_hash`, `grid_session` 문자열이 없음을 확인.
- **개발**: `GRID_API_PROXY=http://127.0.0.1:8080 npm run dev`면 Vite가 `/api`를 로컬 서버로 넘김. 없으면 `/api` 없음 → 오프라인.

### 설정 (서버 환경 변수만)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `DATABASE_URL` | (필수) | PostgreSQL 연결 문자열. 외부 연결이면 `?sslmode=require` |
| `PORT` / `HOST` | 8080 / 0.0.0.0 | |
| `NODE_ENV` | — | `production`이면 아래 두 값의 기본이 true |
| `GRID_COOKIE_SECURE` | 운영 true | 쿠키 `Secure` |
| `GRID_TRUST_PROXY` | 운영 true | 클라이언트 IP = `X-Forwarded-For`의 **마지막** 값(프록시가 붙인 값) |
| `GRID_STATIC_DIR` | `dist` | 빈 문자열이면 API만 |
| `GRID_SESSION_TTL_HOURS` | 168 | 1–2160 |
| `GRID_MISSION_TZ` | `Asia/Seoul` | 미션 날짜 기준 |
| `GRID_DB_POOL_MAX` | 10 | |

## 3. DB 스키마 (`server/migrations.ts`, 버전 1 `init`)

| 테이블 | 핵심 열 · 제약 |
| --- | --- |
| `schema_migrations` | `version` PK |
| `accounts` | `account_id uuid` PK, `username_lower` UNIQUE (+ `CHECK username_lower = lower(username)`), `password_hash`(scrypt), `status ∈ {active, suspended}`, `credits bigint CHECK (credits >= 0)`, `revision` |
| `profiles` | `account_id` PK/FK, `display_name` |
| `sessions` | `token_hash bytea` PK (`length = 32`, SHA-256; 원문 토큰 저장 안 함), `account_id` FK, `expires_at`, `revoked_at` |
| `inventory_items` | `item_id uuid` PK, UNIQUE(`account_id`, `skin_id`), UNIQUE(`account_id`, `item_id`) |
| `loadout` | PK(`account_id`, `slot`), FK(`account_id`, `item_id`) → `inventory_items` — **다른 계정의 아이템은 장착 자체가 DB에서 불가** |
| `credit_ledger` | `tx_id uuid` PK, `seq`, `amount`, `balance_after CHECK (>= 0)`, `kind`, `ref`, `scope`(미션 날짜), `request_key`; 부분 UNIQUE(`account_id`, `kind`, `ref`, `scope`) WHERE kind ∈ {match_reward, mission_reward, grant} |
| `idempotency_keys` | PK(`account_id`, `key`), `key` 8–100자, `endpoint`, `request_hash`, `status_code`, `response jsonb` |
| `missions` | PK(`account_id`, `day`, `mission_id`), `progress CHECK (>= 0)`, `CHECK (NOT claimed OR completed)` |
| `mission_events` | PK(`account_id`, `day`, `event_id`) — 같은 경기는 미션에 1회 |
| `match_rewards` | PK(`account_id`, `match_id`), `credits CHECK (>= 0)` — 같은 경기 1회 |
| `audit_log` | 가입·로그인(성공/실패/제한/정지)·로그아웃·구매(거부 포함)·장착·미션 수령·경기 정산. 비밀번호·토큰 없음 |
| `login_attempts` | 사용자명·IP·성공 여부·시각 |

모든 쿼리는 `$n` 매개변수. SQL 문자열에 값을 이어 붙이는 곳 없음(테스트 헬퍼의 `CREATE DATABASE` 이름은 테스트 코드가 만든 난수).

## 4. API (모두 `/api`, JSON, 본문 최대 16 KB)

| 요청 | 설명 |
| --- | --- |
| `GET /api/health` | `{service:'grid-account', db:'up'}` 200 / `db:'down'` 503 |
| `POST /api/auth/signup` `{username, password}` | 계정 + 시작 크레딧 500(원장 `grant`) + 세션 쿠키 → 201. 중복 409, 규칙 위반 400, IP당 시간당 10회 초과 429 |
| `POST /api/auth/login` `{username, password}` | 세션 쿠키 → 200. 틀림 401 `invalid_credentials`(존재 여부 비공개), 제한 429, 정지 403 |
| `POST /api/auth/logout` | 세션 폐기, 쿠키 삭제 |
| `GET /api/auth/me` | `{ok:true, account}` 또는 로그아웃 상태면 `{ok:true, account:null}` (브라우저 콘솔에 실패 요청이 남지 않도록 200) |
| `GET /api/account` | `AccountState` 형태(잔액·아이템·장착·오늘 미션·최근 원장 50건). 세션 없음 401, 정지 403 |
| `POST /api/purchase` `{skinId}` + `Idempotency-Key` | |
| `POST /api/equip` `{category, target, itemId|null}` + `Idempotency-Key` | |
| `POST /api/missions/:id/claim` + `Idempotency-Key` | |
| `POST /api/match-results` | **항상 403 `unverified`** |

- 계정은 세션 쿠키에서만 정해짐. 본문·쿼리의 `accountId`, `price`, `credits`는 무시(테스트로 확인).
- 변경 요청은 `X-GRID-CSRF: 1` 필수, `Origin`이 있으면 `Host`와 같아야 함 → 아니면 403.
- 오류 코드는 기존 `EconomyError`(+ `suspended`) / `AuthError`. DB 오류는 503 `storage_error`(롤백되어 아무것도 바뀌지 않음).

## 5. 인증 · 보안

- 비밀번호: `scrypt` N=2^15, r=8, p=1, 솔트 16 B, 키 64 B → `scrypt$N$r$p$salt$key`; `timingSafeEqual`; NFKC 정규화. 길이 10–128.
- 존재하지 않는 아이디도 더미 해시로 같은 계산을 해 시간 차로 아이디를 알 수 없게 함.
- 세션: 32 B 난수(base64url) → 쿠키, DB엔 SHA-256만. 만료(기본 7일)·로그아웃 폐기·정지 계정은 모든 요청 거부.
- 로그인 제한: 같은 아이디 15분 내 실패 5회 또는 같은 IP 30회 → 429(맞는 비밀번호여도). 동시에 몰린 시도는 몇 회 더 통과할 수 있음(카운트 후 기록 방식, 알려진 한계).
- 가입 제한: IP당 시간당 10회.
- 로그: `METHOD /path STATUS ms`와 오류 코드·메시지만. 본문·쿠키·토큰·비밀번호·쿼리 값·DB URL 없음(테스트로 확인, `describeDbError`가 URL 제거).
- 응답 헤더: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, API `no-store`.
- 클라이언트 번들: 서버 코드·비밀 없음. 비밀번호는 입력 후 전송 즉시 입력란을 비움.

## 6. 경제 · 보상 규칙 (서버)

- **요청 순서**: 변경 요청은 트랜잭션 시작 직후 `SELECT … FROM accounts … FOR UPDATE`로 계정 행을 먼저 잠근 뒤 멱등 키를 넣는다. (키를 먼저 넣으면 그 외래 키 검사가 같은 행에 공유 잠금을 잡아 동시 요청끼리 교착 상태가 생김 — 테스트에서 실제로 발견해 고침.)
- **멱등**: `(account_id, key)` 첫 요청만 실행하고 응답을 같은 트랜잭션에 저장. 같은 키 재전송 → 저장된 결과(현재 계정 상태와 함께), 같은 키로 다른 요청 → 409 `conflict`. 거부 결과도 재생됨. 트랜잭션이 실패하면 키도 롤백되어 재시도가 정상 실행됨.
- **구매**: 공유 `ShopService.check`(존재·판매·보유·잔액) → 잔액 차감 + 원장 + 아이템을 한 트랜잭션. 음수 잔액은 서비스 검사 + DB `CHECK` 이중 방어.
- **장착**: 공유 `LoadoutService.equip`(보유·카테고리·대상) + DB 복합 외래 키.
- **미션 수령**: 오늘(서버 날짜) 완료·미수령일 때만, 원장 부분 UNIQUE로 같은 날 같은 미션 2회 불가.
- **경기 보상**: `settleVerifiedMatch`(HTTP 미노출)만 지급. 같은 `match_id` 1회, 훈련장·포기·중도 이탈·1분 미만은 0 CR(`matchReward`), 미션 진행은 기존과 같이 완료된 팀전·데스매치만(1분 미만도 미션은 진행 — 오프라인과 동일).
- **온라인 계정 결과**: 현재 경기 검증 서버가 없으므로 결과 화면에 "GRID 크레딧: 서버가 확인하지 않은 경기 결과는 반영되지 않습니다."가 표시되고 서버 잔액은 그대로.

## 7. 데이터 이전 (오프라인 → 계정)

- 오프라인 기록(localStorage `grid.account.v1`)은 **검증할 수 없으므로 서버 계정으로 옮기지 않는다**(크레딧·아이템·장착 모두). 가입 직후 서버 계정은 500 CR, 아이템 0.
- 로그인/가입 시 오프라인 기록이 새 기록과 다르면(아이템 있음 또는 잔액 ≠ 500) "오프라인 기록은 옮겨지지 않습니다 (크레딧 N CR, 스킨 M개)" 창을 띄우고 [확인]을 받는다. 확인은 계정별로 `grid.offline-notice.v1`에 기록.
- 오프라인 기록은 지우지 않는다. 로그아웃·세션 만료·서버 장애 때 다시 표시(라벨 "오프라인 기록").
- 자동 동기화 경로 없음. `planSync`의 "스스로 덮어쓰지 않음" 정책 유지(테스트).

## 8. 운영 · 실패 복구

- **시작**: `npm ci --include=dev && npm run build && npm run build:server` → `npm start`. 시작 시 DB 연결 재시도(0.5→1→2→4 s, 5회), 실패하면 종료 코드 1(로그에 URL·비밀번호 없음, 확인함).
- **마이그레이션**: 시작 시 자동. `pg_advisory_lock`으로 여러 인스턴스가 동시에 시작해도 한 번만 적용(테스트). 적용된 마이그레이션은 수정 금지, 새 버전 추가.
- **실행 중 DB 오류**: 요청은 503 `storage_error`, 트랜잭션 롤백. `/api/health` 503 → Render 헬스 체크가 감지. 클라이언트는 새로 접속하면 "계정 서버에 연결할 수 없음 · 오프라인 기록" + [다시 연결]; 이미 로그인한 화면에서는 요청이 `network`/`storage_error`로 거부되고 아무것도 바뀌지 않음.
- **종료**: SIGTERM/SIGINT → 새 연결 거부, 진행 중 요청 완료 후 풀 종료, 10초 후 강제 종료.
- **정리**: 1시간마다 만료 30일 지난 세션, 1일 지난 로그인 시도, 7일 지난 멱등 키 삭제.
- **백업**: `pg_dump -Fc -f grid.dump "$DATABASE_URL"`. **복원**: 빈 DB에 `pg_restore --no-owner -d "$TARGET_URL" grid.dump` 후 서버 시작(마이그레이션은 "up to date"). 테스트에서 실제로 덤프→다른 DB 복원→같은 계정·로그인 확인. Render 유료 DB는 자동 백업·PITR 제공, 무료 DB는 30일 후 삭제·백업 없음 → 실제 계정에는 유료 플랜 필요.
- **Render**: 루트 `render.yaml`의 DB `grid-accounts`(유료 basic-256mb, 내부 연결만) + 웹 서비스 `tactical-fps-online`(`healthCheckPath: /api/health`, `DATABASE_URL` fromDatabase). `NODE_ENV=production`이 빌드에도 적용되므로 `npm ci --include=dev`.
- 현재 정적 사이트에는 `/api`가 없어 `/api/health`가 404 → 클라이언트는 오프라인 모드(정상 동작, 브라우저 콘솔에 404 한 줄).

## 9. 테스트

| 파일 | 내용 | 필요 |
| --- | --- | --- |
| `tests/grid-account-server.test.mjs` (23) | 마이그레이션(동시 시작), 카탈로그, 가입·저장 형식, 검증·중복, 로그인·로그아웃, 로그인/가입 제한, 만료·정지, CSRF, 계정 격리, 구매·거부, 멱등(동시 5회), 동시 구매, 롤백(트리거로 DB 실패 주입), DB 제약, 장착, 클라이언트 경기 결과 거부, 검증 경기 정산·미션·동시 수령, 재시작·다른 브라우저 영속성, DB 장애, 로그, 백업·복원, 정적 파일·HTTP 오류 | PostgreSQL |
| `tests/grid-account-e2e.test.mjs` (6) | 실제 게임 페이지: 가입·이전 안 됨 알림, 서버 구매·장착, 새로고침, 두 번째 브라우저 로그인, 경기 보상 미지급, DB 장애 → 오프라인 → 다시 연결, 로그아웃 | PostgreSQL + Chromium |
| `tests/grid-account-client.test.mjs` (7) | 서버 감지, 재시도 키, 세션 만료, 모드 전환·알림, 동기화 정책, 공통 규칙 | — |

PostgreSQL: `GRID_TEST_DATABASE_URL`(CREATEDB 권한)이 있으면 그 서버에 파일마다 새 DB를 만들고, 없으면 로컬 `initdb`/`pg_ctl`로 임시 클러스터를 띄웠다가 지운다(`tests/pg.mjs`). 둘 다 없으면 해당 테스트는 **건너뜀으로 보고**(통과로 세지 않음).

## 10. 남은 일 · 위험

- 신뢰 가능한 경기 결과 검증(권위 게임 서버) — 없으면 온라인 계정은 경기로 크레딧을 얻지 못함.
- 거래의 DB·API 구현 (`TradeService`를 SQL 트랜잭션으로).
- 비밀번호 재설정·이메일 확인·계정 삭제·관리자 정지 도구(지금은 DB에서 `status` 직접 변경).
- 로그인 제한의 동시 시도 경합, 분산 공격(IP 다수)에 대한 추가 방어(캡차 등).
- 세션 목록·다른 기기 로그아웃 UI 없음.
- Render 배포 후 HTTPS 쿠키 동작은 배포 결과로 확인해야 함(이 작업 환경에서 onrender.com 접속 불가).
