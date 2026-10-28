# 저장소 안내

| 폴더 | 내용 |
|---|---|
| [`sigilfall/`](sigilfall/README.md) | **SIGILFALL** — 고속 주술 액션 FPS (PC / 모바일, 온라인 지원). `npm start` 로 실행되는 현재 게임입니다. |
| [`neon_strike_online/`](neon_strike_online/README.md) | NEON STRIKE — 먼저 만들었던 온라인 FPS. `npm run start:legacy` 로 그대로 실행됩니다. |

```bash
npm install
npm start            # SIGILFALL   http://localhost:8080
npm run start:legacy # NEON STRIKE http://localhost:8080
npm test
```

## 인터넷에 올리기

저장소 루트의 `render.yaml` 로 [Render](https://render.com) 에서 **New → Blueprint** 하면
그대로 배포됩니다. 자세한 설명과 무료 플랜 주의사항은
[`sigilfall/README.md`](sigilfall/README.md#12-render-에-올리기) 에 있습니다.
