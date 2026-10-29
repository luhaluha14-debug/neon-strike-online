# 저장소 안내

| 폴더 | 내용 |
|---|---|
| [`sigilfall/`](sigilfall/README.md) | **SIGILFALL** — 고속 주술 액션 FPS (PC / 모바일, 온라인 지원). `npm start` 로 실행되는 현재 게임입니다. |
| [`dropzone/`](dropzone/README.md) | NEON STRIKE: DROPZONE — 3D 배틀로얄. `npm run dropzone` |
| [`tactical-fps/`](tactical-fps/README.md) | GRID — 5v5 라운드 기반 전술 FPS. 폴더 안에서 `npm run dev` |
| [`neon_strike_online/`](neon_strike_online/README.md) | NEON STRIKE — 먼저 만들었던 온라인 FPS. `npm run start:legacy` |

```bash
npm install
npm start            # SIGILFALL   http://localhost:8080
npm run start:legacy # NEON STRIKE http://localhost:8080
npm run dropzone     # DROPZONE
npm test
```

## 인터넷에 올리기

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/luhaluha14-debug/neon-strike-online)

위 버튼을 누르면 Render 가 루트의 `render.yaml` 을 읽어 서비스 목록을 보여 줍니다.
필요한 것만 켜고 **Apply** 하면 됩니다 (주술 액션 FPS는 `sigilfall`).
직접 하려면 **New → Blueprint** 에서 이 저장소를 고르면 같은 화면이 나옵니다.

| 서비스 | 내용 |
|---|---|
| `sigilfall` | SIGILFALL 게임 + 방 서버 |
| `dropzone` | DROPZONE 온라인 서버 |
| `tactical-fps` | GRID 정적 사이트(싱글 플레이) |
| `tactical-fps-mp` | GRID 게임 + 멀티 릴레이(`/mp`) |

자세한 설명과 무료 플랜 주의사항은
[`sigilfall/README.md`](sigilfall/README.md#12-render-에-올리기) 에 있습니다.
