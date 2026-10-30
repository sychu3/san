# 安全設計（Security by Design）

本文件說明本專案的安全目標、威脅模型、已落實的控制、部署方式與剩餘風險。

## 1. 範圍與定位

本專案是**單機、純前端**的粉絲遊戲：

- 沒有後端、沒有帳號、沒有多人連線。
- 所有遊戲狀態都在使用者瀏覽器內。
- AI 與人類在同一頁面執行。
- 不使用 cookie、localStorage、IndexedDB、分析服務或廣告。

因此安全重點不是「防止駭客入侵伺服器」，而是：

1. 防止 XSS、供應鏈與部署設定造成的瀏覽器風險。
2. 保護單機對局中的隱藏資訊（手牌、身份），避免 UI 或 AI 意外取得。
3. 防止非法／過期操作破壞遊戲狀態或造成死循環。
4. 讓部署者能容易加上正確的安全標頭。

### 非目標

- 防止使用者自行開啟 DevTools 修改本機遊戲狀態。單機遊戲無法定義「作弊」。
- 防止本機使用者讀取瀏覽器記憶體中的完整 `GameState`。
- 線上多人對戰的防作弊、伺服器權威判定、帳號安全。
- 以遊戲隨機數作為密碼學用途或賭博用途。

## 2. 資產與威脅模型

| 資產 | 風險 | 控制 |
|---|---|---|
| 玩家隱藏身份 | 其他玩家或 AI 從畫面／API 取得 | `viewFor()` 遮蔽；AI 只取得自己的 `PlayerView` |
| 玩家手牌 | UI 顯示或 AI 讀取未公開手牌 | 非本人 `hand` 為 `null`，只公開張數 |
| 遊戲完整性 | 偽造選項、卡片 id、目標 id、過期回應 | request id 綁定；引擎驗證所有輸入 |
| 瀏覽器使用者 | XSS、惡意第三方腳本、點擊劫持 | CSP、React escaping、無 CDN、`frame-ancestors 'none'` |
| 供應鏈 | 惡意或漏洞依賴 | 精確版本、lockfile、npm audit、極少依賴 |
| 可用性 | 死循環、無界日誌、牌堆耗盡 | 回合上限、單階段請求上限、無懈連鎖上限、模擬請求上限、日誌上限、平局處理 |
| 部署 | 缺少安全標頭 | `public/_headers`、`vercel.json`、CSP meta |

## 3. 已落實的控制

### 3.1 輸出與 XSS

- 全部 UI 由 React 建立；React 預設對文字做 escaping。
- 原始碼**不使用** `dangerouslySetInnerHTML`、`innerHTML`、`eval`、`new Function`。
- 不接受使用者輸入的 HTML、URL、Markdown 或檔案。
- 卡牌與武將資料都是靜態 TypeScript 物件，不是遠端 JSON。
- 生產環境注入 CSP meta：
  - `default-src 'self'`
  - `script-src 'self'`（禁止 inline script 與外部 script）
  - `style-src 'self'`（禁止 inline style）
  - `connect-src 'none'`（前端不做任何網路請求）
  - `img-src 'self' data:`
  - `object-src 'none'`、`base-uri 'self'`、`form-action 'none'`、`frame-src 'none'`、`worker-src 'none'`
- 部署標頭另外加上 `frame-ancestors 'none'`、`X-Frame-Options: DENY`、`nosniff`、`no-referrer`、`Permissions-Policy`、COOP/CORP。
- 不使用外部字型、CDN、追蹤像素或第三方 SDK。

相關檔案：

- `vite.config.ts`：production build 注入 CSP。
- `public/_headers`：Netlify／Cloudflare Pages 用的完整標頭。
- `vercel.json`：Vercel 用的標頭設定。

### 3.2 隱藏資訊

`viewFor(state, viewerId, godMode)` 是唯一提供給 UI 的視角：

- 自己的手牌：完整顯示。
- 其他存活玩家：`hand = null`，只給 `handCount`。
- 身份：自己、主公、已死亡玩家會顯示；其他存活玩家為 `null`。
- 裝備、判定牌、體力、連鎖狀態：公開資訊。
- `pending` 請求只會給等待中的玩家；上帝視角除外。
- 日誌不洩漏隱藏手牌：例如【順手牽羊】從手牌取得的牌只顯示「一張手牌」，不顯示牌名。
- `viewFor()` 回傳的卡牌、陣列與請求都是副本；UI 修改視角不會回寫引擎狀態。
- AI 在 `GameController` 內以 `viewFor(state, aiId)` 取得視角，不使用完整 `GameState` 做決策。

`GameController` 的 UI 快照只包含人類視角（除非使用者主動開啟除錯用上帝視角）。

### 3.3 輸入與狀態驗證

`GameController.respond(requestId, response)` 會檢查：

1. 目前確實有 `pending`。
2. `requestId` 與目前請求相符。
3. 請求的玩家是人類玩家。
4. 該 request id 尚未被使用。

引擎的 `ask*` 函式再驗證：

- 選項 id 必須存在於本次提供的合法選項。
- 卡片 id 必須在指定角色可選的區域中。
- 選牌數量必須在 `min`／`max` 之間。
- 目標 id 必須在候選名單中。
- 重複 id 會去重。
- 非法輸入會拋出錯誤，驅動器會顯示錯誤訊息，不會把非法狀態寫入遊戲。

### 3.4 可用性與死循環

- 單局最多 500 個角色回合，超過即平局。
- 單一階段最多 4,000 個請求，超過即平局，避免出牌／回應互相觸發造成死循環。
- 無懈可擊連鎖最多 16 張；達到上限後停止詢問。
- 自動模擬每局最多 800,000 個 request，超過即拋錯（測試用）。
- 日誌最多保留 500 行，UI 只取最近 200 行。
- 牌堆與棄牌堆皆空時，抽牌／判定會以平局結束。
- 手牌、裝備、判定區的數量受 160 張牌上限約束，不會無界成長。
- 丈八蛇矛改為「先選目標、再選兩張手牌」，避免手牌多時行動選項平方成長。
- 所有選牌 UI 都有 `min`／`max` 與確認按鈕，避免空轉。
- 技能請求沿用同一套驗證：仁德／制衡的選牌上限為當下手牌數，青囊／離間固定 1 張，護駕／激將只在有合法盟友時才產生請求。
- 【觀星】使用 `chooseFrom` 請求，只允許選取本次翻開的牌堆頂牌；牌 id 會再驗證。
- 技能迴圈都有上限：【洛神】最多重複 10 次，其餘技能不重複請求；單一階段 4,000 個請求與回合上限 500 仍然生效。
- 單回合技能標記（仁德、制衡、離間、青囊）在該角色回合開始時重置，且標記只存在 `PlayerState.marks`，不影響其他玩家。
- 全牌池＋技能的 AI 1,000 局模擬（seed 1–1000）納入 `npm test`；目前全部正常結束，無崩潰、無死循環。

### 3.5 供應鏈

- `package.json` 使用精確版本（沒有 `^` 或 `~`）。
- 提交 `package-lock.json`，部署應使用 `npm ci`。
- `.npmrc` 設定 `save-exact=true` 與 `ignore-scripts=true`，安裝時不執行依賴的安裝腳本。
- 執行期依賴只有 `react`、`react-dom`；沒有 UI 框架、CSS 框架、HTTP client 或分析 SDK。
- 開發依賴只有 Vite、TypeScript、Vitest、React 型別與 plugin。
- `npm audit --audit-level=high` 目前 0 漏洞。
- `npm run build` 不含 source map，減少原始碼暴露。
- 不使用 postinstall 腳本或遠端資源。

### 3.6 部署

#### Netlify／Cloudflare Pages

`public/_headers` 會複製到 `dist/_headers`，提供：

```text
Content-Security-Policy: ...; connect-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
```

#### Vercel

`vercel.json` 提供相同的標頭。

#### 其他靜態主機

請在伺服器層設定與 `public/_headers` 相同的標頭。只依賴 HTML 內的 CSP meta 不夠，因為 meta CSP 不支援 `frame-ancestors`。

#### 開發伺服器

Vite dev server 只綁定 `127.0.0.1`，不應直接暴露到公網。開發環境不注入 production CSP，以免阻擋 HMR。

## 4. 安全測試

`src/tests/security.test.ts` 會檢查：

- 原始碼沒有 `dangerouslySetInnerHTML`、`innerHTML`、`eval`、`new Function`。
- 原始碼沒有外部 `http://`／`https://` 資源。
- `package.json` 的依賴版本是精確版本。
- `public/_headers` 包含 CSP、nosniff、frame options、referrer policy。
- `vite.config.ts` 的 production CSP 包含 `script-src 'self'` 與 `connect-src 'none'`。
- `viewFor` 遮蔽其他玩家的手牌與身份（見 `engine.test.ts`）。

`src/tests/simulation.test.ts` 另外以 seed 1–1000 跑完整 160 張牌堆，確認：

- 每局都能正常結束，不出現「死循環」或「請求過多」平局。
- 平均回合數 < 100。
- M2 新牌（決鬥、群體錦囊、火攻、無懈可擊、鐵索、延時錦囊）確實被 AI 使用。
- 同一 seed 產生完全相同的結果與日誌。

`src/tests/m3.test.ts` 與 `src/tests/m3b.test.ts` 另外以可控手牌測試全部武將技能（含判定替換、觀星、連營、梟姬等時機），`src/tests/ai.test.ts` 驗證 AI 拆牌與無懈可擊的判斷不會反過來幫敵人。

執行：

```bash
npm test
npm run audit
```

## 5. 剩餘風險

| 風險 | 說明 | 處置 |
|---|---|---|
| 本機修改 | 使用者可用 DevTools 修改 `GameState` 或直接呼叫引擎 | 單機遊戲接受此風險；不視為安全邊界 |
| 客戶端 RNG | mulberry32 不是密碼學隨機數 | 只用於遊戲娛樂，不用於安全用途 |
| AI 推測 | AI 可能從公開行動推測身份 | 這是遊戲設計的一部分；AI 不讀隱藏資料 |
| 供應鏈未來漏洞 | 今日 audit 乾淨，未來可能出現新 advisory | 定期 `npm audit`、更新依賴、重新測試 |
| 部署設定錯誤 | 主機未套用 `_headers`／`vercel.json` | 部署後用瀏覽器 DevTools 檢查 response headers |
| 瀏覽器 CSP 相容性 | 舊瀏覽器可能忽略部分指令 | 使用現代瀏覽器；不以 CSP 取代輸入驗證 |
| 文字／字型 | 依賴系統中文字型，不載入遠端字型 | 不影響安全，只影響外觀 |

## 6. 漏洞回報

本專案為非商業粉絲作品。若發現安全問題，請提供：

- 受影響版本或 commit。
- 重現步驟。
- 影響範圍（XSS、資訊洩漏、DoS、供應鏈等）。
- 建議修補方式（若有）。

請勿在公開場所張貼可直接利用的細節，直到維護者確認修補。

## 7. 安全檢查清單（發佈前）

- [ ] `npm ci` 成功。
- [ ] `npm test` 全數通過（含全牌池 1,000 局 AI 模擬）。
- [ ] `npm run build` 成功。
- [ ] `npm audit --audit-level=high` 為 0 漏洞。
- [ ] `dist/index.html` 含 production CSP。
- [ ] `dist/_headers` 存在且內容正確。
- [ ] 部署後檢查 response headers 含 CSP、`X-Frame-Options`、`nosniff`。
- [ ] 瀏覽器 console 沒有 CSP violation。
- [ ] 不使用上帝視角時，其他玩家手牌與身份不可見。
- [ ] 沒有新增外部連線、CDN、字型或分析腳本。
