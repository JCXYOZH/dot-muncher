# dot-muncher 吃豆游戏

- 项目地址：https://github.com/JCXYOZH/dot-muncher
- 在线演示：http://setup.cc.cd



## 一、功能说明

### 玩家
- 昵称 + 内部 UUID 双重标识：界面只显示昵称，同名玩家互不冲突；未来联机时 UUID 可"认领"为账号。
- 创建 / 切换 / 改名 / 删除均有操作；删除玩家会连带清理其全部存档与检查点（有二次确认）。
- **游客兜底**：无玩家时开始游戏，自动创建"游客"（重名自动编号），进度绝不丢失，之后可在玩家页改名转正。

### 存档（手动）
- 游戏进行中会实时把**关卡中途快照**（豆子残余矩阵、玩家像素坐标与朝向、4 只幽灵的位置/朝向/状态/虚弱倒计时）写入检查点（localStorage `dm.checkpoint`）。
- 存档页的表单读取该检查点存为手动档：**可精确恢复到吃到一半的瞬间**，不降级为"关卡起点"。
- 同名存档会弹确认层询问是否覆盖；每玩家上限 20 份手动档，达上限会引导清理。
- 支持导出 / 导入 `.json` 文件（单份或全部），跨浏览器 / 跨设备迁移存档；导入逐份校验，重名自动加"· 导入"后缀，坏数据跳过并计数提示。

### 存档（自动）
- **通关必存**：每过一关自动写入"下一关起点"型自动档（游戏画面右上角轻量 HUD 角标提示，不打断游玩）。
- **离页兜底**：切页 / 切标签页 / 关闭页面时，把进行中的快照升格为自动档。
- **失败续档**：生命耗尽 GAME OVER 时，自动存"本关开头"（得分回退到本关开始值防止刷分，生命回满 5），下一局可从该关重来。
- 自动档独立滚动槽位，最多保留最近 3 份，**永不覆盖玩家命名的手动档**；内容相同时仅刷新时间，避免槽位抖动。

### 读档
- "继续当前进度"卡片：接上次离开（含崩溃恢复）的精确状态。
- 任意手动 / 自动档均可"读取并开始"：恢复后进入**暂停态**（画面显示 PAUSE），按空格正式开始，防止恢复瞬间被幽灵偷袭。
- 已通关玩家在读档页显示"已通关"徽章（战绩来自玩家数据，非存档）。

### 数据安全
- 每份存档带 djb2 校验和：手改 / 损坏的存档会被标记"已损坏"并以灰色隔离展示，**可删除但不可读取**，不影响其他存档。
- 存档结构带 `schemaVersion` 版本号 + 迁移注册表：未来加字段不炸旧档。
- 多标签页通过 `storage` 事件总线实时同步，玩家 / 存档列表跨页签自动刷新。
- localStorage 不可用（隐身模式 / 被禁）时优雅降级：页面显示提示条，游戏本身照常可玩。

---

## 二、数据结构（localStorage 键）

```
dm.players          = [{ id(UUID), name, createdAt, lastActiveAt,
                         stats: { gamesStarted, bestScore, cleared } }]
dm.activePlayerId   = "<UUID>"
dm.saves.<玩家UUID>  = {
    __v: 1,
    saves: [{
        id, name, slotType: 'manual'|'auto',
        level, score, lives,
        remark,               // 备注（选填，最长60字，空则不落字段，无此键亦兼容）
        snapshot: { beans, player:{x,y,orientation}, ghosts:[{...}] } | null,
        isCheated,            // 仅数据，任何界面均不展示
        schemaVersion: 1, sum: "<校验和>",
        createdAt, updatedAt
    }]
}
dm.checkpoint       = { playerId, level, score, lives, isCheated, snapshot, updatedAt }
sessionStorage dm.pendingLoad = { playerId, save }   // 读档页 → 游戏页 同标签页交接
```

单份存档约 1.5KB；20 手动档 + 3 自动档 / 玩家，远低于 localStorage 约 5MB 配额。

---

## 三、内部调度键

游戏进行中按 **Ctrl + Shift + L** 直接跳至下一关（供调试使用，第 12 关接着按下进入通关结算）。

- 界面、控制台、任何提示中均**不出现**该键的任何痕迹；代码中键值以 `(188-112)` 形式计算，注释中性化。
- 使用过调度键的本局，其产生的所有存档（含自动档）会带 `isCheated: true` 数据标记，同样**任何界面不展示**，提供作为后续数据清洗或者未来联机校验。

---

## 四、部署（Nginx）

纯静态方案，localStorage 按**域名**隔离。

后续实现双人实时联机时，Nginx 再追加 WebSocket 反代，参考：

```nginx
location /ws/ {
    proxy_pass http://127.0.0.1:8800;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 300s;
}
```

---

## 五、联机预留架构

- **存储适配层**：所有读写都经过 `dm-core.js` 中的统一 `store` 接口（get / set / remove）。未来联机时实现同接口的远端适配器（REST 或 WebSocket）并替换即可，游戏逻辑、三个页面**零改动**。
- **自包含负载**：检查点与待读档都是完整数据包，未来可直接作为服务端中继的状态同步载体（主机权威模式）。
- **快照可扩展**：`snapshot.player` 为单玩家结构，未来双人游玩时升级为 `snapshot.players[]`，通过 `schemaVersion` 迁移函数平滑升级旧档。
- **玩家 UUID 认领**：本地玩家未来注册账号时可把 UUID 映射为账号 ID，老存档无缝跟随。

