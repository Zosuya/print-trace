# PRINT//TRACE

Bambu Lab 列印進度的 3D 看板：讀 `.gcode.3mf`／`.gcode`，用科技感 HUD 顯示噴頭目前在印哪裡。
目前是**離線模擬版**（自己用時間軸播放），下一步要接印表機的即時資料。

## 執行

純前端、單一檔案，不需要建置。three.js 和熱床模型都放在 repo 裡，不需要網路。

```sh
python3 -m http.server 8765
# 開 http://localhost:8765/ ，把 .gcode.3mf 拖進去
```

網址參數（測試用）：`?file=xxx.gcode.3mf&at=秒數&render=wire|holo|solid|cloud&color=feature|filament&rot=度&zoom=倍數`

## 目前功能

- G-code 解析：G0/G1/G2/G3、相對／絕對座標、M83、FEATURE／LAYER 註解、M204 加速度、M73 進度、換料（T/M620/M621）、溫度（M104/M109/M140/M190）
- 時間估算：梯形加減速＋轉角速度，再用切片軟體的 `M73 P` 進度點校正到總時間
- 準備階段：讀 `M1002 gcode_claim_action`（跟 MQTT `stg_cur` 同一套代碼）做步驟清單與倒數；讀起始程序的 `;===== xxx =====` 段落算出清潔、擠料、調平（`G29 A X Y I J`）等工作區並畫在板子上
- 顯示方式：線框（預設推薦）、全息、實體、點雲；上色：線條類型／模型顏色（多色自動用模型顏色）
- 開場動畫：鏡頭轉入 → 點雲由下往上 → 外牆輪廓擠出的近似外殼由下往上填
- 噴頭跟隨模式（F 鍵）；準備階段自動跟隨（拉遠、有不動範圍）
- 熱床外形：`bed/` 來自 OrcaSlicer（A1/X1/P1 共用 `bbl-3dp-X1.stl`、`bbl-3dp-logo.svg`）
- 光暈 bloom 固定 0.3、線框線寬固定 2px

## 下一步：接 A1 即時資料

- MQTT：`mqtts://<IP>:8883`，帳號 `bblp`、密碼＝LAN access code，訂閱 `device/<序號>/report`
  - 用到的欄位：`layer_num`、`total_layer_num`、`mc_percent`、`mc_remaining_time`、`stg_cur`、`gcode_state`、`spd_lvl`、`spd_mag`、`nozzle_temper`／`bed_temper`、`subtask_name`／`gcode_file`
- FTPS：`ftps://<IP>:990`（implicit TLS，`bblp`／access code）下載正在印的 `.gcode.3mf`
- 新韌體可能要開 LAN 模式／開發者模式第三方才連得上
- 瀏覽器不能直接連 MQTT over TLS／FTPS → 需要一個小的後端（Node 或 Python）轉成 WebSocket/SSE 給前端
- 層內位置用推算：收到換層就對齊該層開始時間，依 G-code 時間往前推，推完停在層尾等下一層；乘 `spd_mag`；用剩餘時間微調
- 時間軸改成只顯示（可拖回看已印部分，旁邊「回到即時」）

## 已知限制

- 自動調平的時間被切片軟體算在「清潔噴嘴」裡，離線時拆不開（接實機改用 `stg_cur`）
- 外殼用外牆中心線擠出，比實際小約半個線寬
- 多色只用人工雙色檔驗證過，還沒用真的 AMS 檔案測

## 第三方

- three.js r170（MIT）：`lib/`
- OrcaSlicer 熱床模型與貼圖（AGPL-3.0）：`bed/`
