# beyblade-eslite-monitor

使用 GitHub Actions 定期呼叫誠品 Athena API，監控 BEYBLADE X 商品。

## 目前功能

- 每 5 分鐘執行一次
- 搜尋 `BEYBLADE X`
- 過濾名稱包含 `BX-xx` / `UX-xx` / `CX-xx` 的商品
- 新商品 Telegram 通知
- 無庫存變可購買時 Telegram 補貨通知
- `data/state.json` 保存上一次商品狀態

## GitHub Secrets

Repository → Settings → Secrets and variables → Actions → New repository secret

新增：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## 手動測試

Repository → Actions → Eslite Beyblade Monitor → Run workflow

第一次執行時，因為 `data/state.json` 是空的，目前搜尋到的所有符合商品都會視為 NEW 並發 Telegram 通知。

## API

`https://athena.eslite.com/api/v2/search?q=%22BEYBLADE+X%22&final_price=0,&sort=weight&size=100&start=0`
