/*
 * dm-core.js —— 存档系统核心（Dot-Muncher Save System Core）
 *
 * 职责：
 *   1. 存储适配层（StorageAdapter）：所有读写经由统一接口，
 *      当前为 LocalStorageAdapter；未来联机时可替换为远端实现
 *      （如 REST / WebSocket 适配器），游戏与页面逻辑零改动。
 *   2. 玩家管理：昵称 + 内部 UUID（未来可"认领"为联机账号）。
 *   3. 存档管理：手动档（玩家命名）与自动档（滚动 3 份）隔离，
 *      校验和防损坏，schemaVersion 版本迁移。
 *   4. 导出 / 导入（.json 自包含负载，可跨浏览器迁移）。
 *   5. 检查点（checkpoint）与待读档（pendingLoad）桥接。
 *   6. 事件总线：页面间与多标签页（storage 事件）同步。
 *
 * 依赖：无，但需在 game/index 脚本与其他 dm-*.js 之前加载。
 * 命名空间：window.DM
 */
(function(){
        'use strict';

        var DM = window.DM = window.DM || {};

        /* ============================== 常量 ============================== */

        var SCHEMA_VERSION = 1;                 // 存档数据结构版本（未来加字段时递增并注册迁移函数）
        var EXPORT_MAGIC = 'DOT-MUNCHER-SAVE';
        var MANUAL_MAX = 20;                    // 每玩家手动存档上限
        var AUTO_SLOTS = 3;                             // 自动存档滚动槽位数
        var NAME_MAX = 12;                              // 昵称/存档名最大长度
        var REMARK_MAX = 60;                            // 存档备注最大长度（选填）
        var LEVEL_MAX = 12;                             // 关卡总数
        // 当前 12 关共用同一套地图几何：豆子矩阵 31 行 x 28 列，
        // 每格 20px，地图左上角位于画布 (60,10)。若未来关卡尺寸变化，
        // 必须同步更新这些常量，否则旧快照会被判定为无效。
        var SNAPSHOT_ROWS = 31;
        var SNAPSHOT_COLS = 28;
        var SNAPSHOT_CELL = 20;
        var SNAPSHOT_MAP_X = 60;
        var SNAPSHOT_MAP_Y = 10;

        var K = {
                PLAYERS: 'dm.players',
                ACTIVE: 'dm.activePlayerId',
                SAVES: 'dm.saves.',                     // + 玩家ID
                CHECKPOINT: 'dm.checkpoint',
                PENDING: 'dm.pendingLoad'       // sessionStorage
        };

        /* ============================ 存储适配层 ============================ */
        /*
         * 统一接口：get(key) / set(key,value) / remove(key)
         * 远端适配器实现同一接口后即可整体替换（联机预留）。
         * 注：localStorage 不可用时优雅降级，不抛异常。
         */
        /*
         * 创建本地存储适配器。
         * 返回值同时暴露 available 标记与 get / set / remove 三个方法；
         * 页面只依赖这三个方法，因此未来替换为远程存储时不需要改业务代码。
         */
        function createAdapter(){
                var ok = true;
                try{
                        // 先做一次“写入-删除”探测：隐私模式、配额为 0 或被策略禁用时 setItem 会抛异常。
                        var probe = '__dm_probe__' + Date.now();
                        window.localStorage.setItem(probe, '1');
                        window.localStorage.removeItem(probe);
                }catch(e){
                        // 探测失败只记录状态，不向上抛异常，保证游戏本身仍可运行。
                        ok = false;
                }
                return {
                        available: ok,
                        get: function(key){
                                // 不可用时返回 null，让上层走“无数据”分支。
                                if (!ok) return null;
                                try{
                                        var raw = window.localStorage.getItem(key);
                                        // localStorage 只能存字符串，这里统一做 JSON 反序列化。
                                        return raw == null ? null : JSON.parse(raw);
                                }catch(e){
                                        // JSON 损坏或读取被拒绝时按无数据处理，避免页面白屏。
                                        return null;
                                }
                        },
                        set: function(key, value){
                                if (!ok) return false;
                                try{
                                        // 返回布尔值而不是抛错，调用方可以据此展示“存储写入失败”。
                                        window.localStorage.setItem(key, JSON.stringify(value));
                                        return true;
                                }catch(e){
                                        return false;   // 配额满或被禁写
                                }
                        },
                        remove: function(key){
                                if (!ok) return false;
                                try{
                                        window.localStorage.removeItem(key);
                                        return true;
                                }catch(e){
                                        return false;
                                }
                        }
                };
        }
        var store = createAdapter();

        /* ============================== 事件总线 ============================== */

        // 订阅表：eventName -> [callback, callback, ...]
        var _subs = {};
        /*
         * 订阅事件。
         * @param {string} event 事件名，例如 players:changed
         * @param {Function} fn 回调
         * @return {Function} 取消订阅函数，便于页面卸载时清理
         */
        function on(event, fn){
                (_subs[event] = _subs[event] || []).push(fn);
                return function(){ off(event, fn); };
        }
        /*
         * 取消订阅。
         * 使用 filter 生成新数组，避免在 emit 遍历过程中直接修改原数组。
         */
        function off(event, fn){
                if (!_subs[event]) return;
                _subs[event] = _subs[event].filter(function(f){ return f !== fn; });
        }
        /*
         * 触发事件。
         * 使用 slice() 复制订阅者列表：某个回调在内部取消订阅时，不会影响本轮遍历。
         * 单个订阅者抛错会被吞掉，防止一个页面的异常阻断其他页面同步。
         */
        function emit(event, data){
                (_subs[event] || []).slice().forEach(function(fn){
                        try{ fn(data); }catch(e){ /* 订阅方异常不影响其他订阅者 */ }
                });
        }
// 多标签页同步：storage 事件仅在"其它"标签页触发
        window.addEventListener('storage', function(e){
                if (!e || !e.key) return;
                if (e.key === K.PLAYERS){ emit('players:changed'); }
                else if (e.key === K.ACTIVE){ emit('active:changed'); }
                else if (e.key.indexOf(K.SAVES) === 0){ emit('saves:changed'); }
                else if (e.key === K.CHECKPOINT){ emit('checkpoint:changed'); }
        });

        /* ============================== 工具函数 ============================== */

        /*
         * 生成“时间戳 + 随机数”的本地唯一 ID。
         * 这里不依赖 crypto.randomUUID，兼容旧浏览器；碰撞概率对本地玩家/存档足够低。
         */
        function uuid(){
                return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        }
        /* 统一的当前时间戳入口，便于测试时替换或未来接入服务器时间。 */
        function now(){
                return Date.now();
        }
// 轻量校验和（djb2）：用于检测损坏/手改，非安全加密
        /*
         * 计算存档校验和。
         * - 排除 sum 自身，避免“校验和包含校验和”的循环依赖。
         * - 排除 createdAt / updatedAt，让“只刷新时间”的自动存档无需重算内容摘要。
         * - djb2 只用于发现意外损坏，不用于防篡改（前端代码本身对用户可见）。
         */
        function checksum(obj){
                var s;
                try{
                        s = JSON.stringify(obj, function(key, value){
                                return (key === 'sum' || key === 'createdAt' || key === 'updatedAt') ? undefined : value;
                        });
                }catch(e){
                        return 'ERR';
                }
                var h = 5381;       // djb2 初始值
                for (var i = 0; i < s.length; i++){
                        // 每次左移 5 位再加自身，等价于 h * 33，最后转成 32 位整数。
                        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
                }
                // >>> 0 转无符号数，再转 36 进制缩短字符串长度。
                return (h >>> 0).toString(36);
        }
        /*
         * 深拷贝普通 JSON 数据。
         * 用于隔离 localStorage 读出的对象与页面状态，防止 UI 修改影响缓存。
         */
        function deepCopy(obj){
                try{
                        return JSON.parse(JSON.stringify(obj));
                }catch(e){
                        return null;
                }
        }
        /*
         * 时间戳格式化：交给浏览器本地化，自动适配系统语言与时区。
         * 空值或非法时间返回 '-'，避免界面出现 Invalid Date。
         */
        function fmtTime(ts){
                if (!ts) return '-';
                try{
                        return new Date(ts).toLocaleString();
                }catch(e){
                        return '-';
                }
        }
// 名称规范化：去首尾空白、去控制字符、限长
        /*
         * 规范化昵称/存档名。
         * 步骤：任意类型转字符串 -> 去掉控制字符 -> trim -> 截断到 12 个字符。
         * 截断放在 trim 之后，保证用户粘贴超长文本时保留前 12 个可见字符。
         */
        function normalizeName(name){
                return String(name == null ? '' : name)
                    .replace(/[\x00-\x1f\x7f]/g, '')
                    .trim()
                    .slice(0, NAME_MAX);
        }

// 备注规范化：去控制字符、限长（选填字段，空值不落库）
        /*
         * 规范化备注：控制字符替换为空格，保留换行以外的可读文本，最后截断到 60 字符。
         */
        function normalizeRemark(remark){
                return String(remark == null ? '' : remark)
                    .replace(/[\x00-\x1f\x7f]/g, ' ')
                    .trim()
                    .slice(0, REMARK_MAX);
        }

        /* ============================== 版本迁移 ============================== */
        /*
         * 迁移注册表：MIGRATIONS[fromVersion] = function(record){...; record.schemaVersion = to; return record; }
         * 读取旧档时自动逐级迁移并写回。当前 v1，暂无迁移项。
         */
        var MIGRATIONS = {};

        function migrateRecord(rec){
                var guard = 0;
                while (rec && typeof rec.schemaVersion === 'number' && rec.schemaVersion < SCHEMA_VERSION && guard++ < 10){
                        var step = MIGRATIONS[rec.schemaVersion];
                        if (!step){ break; }
                        try{
                                rec = step(rec) || rec;
                        }catch(e){
                                break;
                        }
                }
                if (rec && typeof rec.schemaVersion !== 'number'){
                        rec.schemaVersion = 1;  // 无版本号的远古数据视为 v1
                }
                return rec;
        }

        /* ============================== 玩家管理 ============================== */

        /*
         * 读取玩家列表。
         * 兼容三种历史/异常格式：
         *   1. 直接存数组（早期版本）；
         *   2. { list: [...] } 包装（迁移过渡）；
         *   3. 其他格式一律视为空列表。
         */
        function readPlayers(){
                var data = store.get(K.PLAYERS);
                if (Array.isArray(data)){
                        return data;
                }
                if (data && Array.isArray(data.list)){
                        return data.list;
                }
                return [];
        }
        /*
         * 写入玩家列表并广播变更。
         * 注意：这里不直接返回数组本身，避免调用方绕过 store 适配层。
         */
        function writePlayers(list){
                var ok = store.set(K.PLAYERS, list);
                if (ok){ emit('players:changed'); }
                return ok;
        }

        /*
         * 对外读取玩家列表（返回新数组，调用方 sort 不会影响缓存）。
         * 同时补齐 stats 字段，兼容没有统计信息的旧数据。
         */
        function listPlayers(){
                return readPlayers().map(function(p){
                        p.stats = p.stats || {};
                        return p;
                });
        }
        /* 按内部 UUID 查玩家；界面显示昵称，逻辑层始终使用 UUID。 */
        function getPlayer(id){
                return listPlayers().filter(function(p){ return p.id === id; })[0] || null;
        }
        /*
         * 读取当前活动玩家 ID。
         * 键值以 JSON 字符串形式存储（"uuid"），这里兼容损坏数据并回退为 null。
         */
        function activeId(){
                var id = null;
                try{
                        var raw = window.localStorage.getItem(K.ACTIVE);
                        id = raw ? String(JSON.parse(raw)) : null;
                }catch(e){
                        id = null;
                }
                return id;
        }
        /* 当前玩家对象：ID 存在但玩家已被删除时返回 null。 */
        function active(){
                var id = activeId();
                return id ? getPlayer(id) : null;
        }
        /*
         * 切换当前玩家。
         * 只有玩家真实存在才写入，成功后同步更新 lastActiveAt 与两个事件。
         */
        function setActive(id){
                if (!getPlayer(id)){ return false; }
                var ok = store.set(K.ACTIVE, id);
                if (ok){
                        // 更新最近活跃时间
                        var list = readPlayers();
                        for (var i = 0; i < list.length; i++){
                                if (list[i].id === id){ list[i].lastActiveAt = now(); }
                        }
                        store.set(K.PLAYERS, list);
                        emit('active:changed');
                        emit('players:changed');
                }
                return ok;
        }
        /*
         * 创建玩家。
         * @param {string} name 原始昵称
         * @return {{player:Object}|{error:string}}
         * 校验顺序：规范化 -> 非空 -> 重名 -> 生成 UUID -> 写入 -> 广播。
         */
        function createPlayer(name){
                var nm = normalizeName(name);
                if (!nm){
                        return { error: '昵称不能为空' };
                }
                var list = readPlayers();
                if (list.some(function(p){ return p.name === nm; })){
                        return { error: '昵称「'+nm+'」已存在' };
                }
                var player = {
                        id: uuid(),
                        name: nm,
                        createdAt: now(),
                        lastActiveAt: now(),
                        stats: { gamesStarted: 0, bestScore: 0, cleared: false }
                };
                list.push(player);
                if (!writePlayers(list)){ return { error: '存储写入失败' }; }
                emit('players:changed');
                return { player: player };
        }
        /*
         * 重命名玩家。
         * 重名检查排除自己，允许“只改大小写/空格后恢复原名”。
         */
        function renamePlayer(id, name){
                var nm = normalizeName(name);
                if (!nm){ return { error: '昵称不能为空' }; }
                var list = readPlayers();
                var dup = list.some(function(p){ return p.name === nm && p.id !== id; });
                if (dup){ return { error: '昵称「'+nm+'」已被占用' }; }
                var target = null;
                for (var i = 0; i < list.length; i++){
                        if (list[i].id === id){
                                list[i].name = nm;
                                list[i].lastActiveAt = now();
                                target = list[i];
                        }
                }
                if (!target){ return { error: '玩家不存在' }; }
                if (!writePlayers(list)){ return { error: '存储写入失败' }; }
                return { player: target };
        }
        /*
         * 删除玩家及其全部存档、检查点。
         * 若删除的是当前玩家，自动切换到最近活跃的其他玩家；没有其他玩家则清空活动 ID。
         * 返回 saveCount 供确认弹层展示“将删除多少份存档”。
         */
        function removePlayer(id){
                var list = readPlayers();
                var target = list.filter(function(p){ return p.id === id; })[0];
                if (!target){ return { error: '玩家不存在' }; }
                var saveCount = listSaves(id).length;
                list = list.filter(function(p){ return p.id !== id; });
                store.remove(K.SAVES + id);                     // 连带删除其全部存档
                // 若检查点属于该玩家，一并清理
                var cp = getCheckpoint();
                if (cp && cp.playerId === id){ store.remove(K.CHECKPOINT); emit('checkpoint:changed'); }
                var ok = writePlayers(list);
                if (ok && activeId() === id){
                        // 活动玩家被删除：切换到最近活跃的其余玩家，否则置空
                        var next = list.slice().sort(function(a, b){
                                return (b.lastActiveAt || 0) - (a.lastActiveAt || 0);
                        })[0];
                        if (next){
                                store.set(K.ACTIVE, next.id);
                        }else{
                                store.remove(K.ACTIVE);
                        }
                        emit('active:changed');
                }
                return { removed: target, saveCount: saveCount };
        }
// 无活动玩家时自动创建游客（游戏中兜底，绝不丢进度）
        /*
         * 游客兜底。
         * 重名策略：游客、游客2、游客3……（从 2 开始编号，避免出现“游客1”）。
         */
        function ensureGuest(){
                var existing = active();
                if (existing){ return existing; }
                var list = readPlayers();
                var base = '游客';
                var name = base;
                var n = 1;
                while (list.some(function(p){ return p.name === name; })){
                        n += 1;
                        name = base + n;
                }
                var result = createPlayer(name);
                if (result.player){
                        setActive(result.player.id);
                        return result.player;
                }
                return null;
        }
// 战绩上报（开局/终局）
        /*
         * 记录一局开始：局数 +1，刷新最近活跃时间。
         * 即使写入失败也不阻断游戏，统计属于附加信息。
         */
        function reportGameStart(pid){
                var list = readPlayers();
                for (var i = 0; i < list.length; i++){
                        if (list[i].id === pid){
                                list[i].stats = list[i].stats || {};
                                list[i].stats.gamesStarted = (list[i].stats.gamesStarted || 0) + 1;
                                list[i].lastActiveAt = now();
                        }
                }
                writePlayers(list);
        }
        /*
         * 记录一局结束。
         * result.score 为最终得分（含剩余生命奖励），result.win 表示是否通关。
         * 得分取整并防止负数；bestScore 只增不减，cleared 一旦为 true 不会被失败覆盖。
         */
        function reportGameEnd(pid, result){
                var list = readPlayers();
                var score = Math.max(0, Math.floor(result && result.score || 0));
                for (var i = 0; i < list.length; i++){
                        if (list[i].id === pid){
                                list[i].stats = list[i].stats || {};
                                list[i].stats.bestScore = Math.max(list[i].stats.bestScore || 0, score);
                                if (result && result.win){ list[i].stats.cleared = true; }
                                list[i].lastActiveAt = now();
                        }
                }
                writePlayers(list);
        }

        /* ============================== 存档管理 ============================== */

        /*
         * 读取某位玩家的存档容器。
         * 容器结构：{ __v, saves: [...] }；若历史数据是裸数组则现场包装，避免旧档失效。
         */
        function readSaveContainer(pid){
                var data = store.get(K.SAVES + pid);
                if (Array.isArray(data)){ data = { __v: 1, saves: data }; }     // 兼容直存数组
                if (!data || !Array.isArray(data.saves)){ return { __v: SCHEMA_VERSION, saves: [] }; }
                return data;
        }
        /* 写入存档容器：成功才广播 saves:changed，失败由调用方给出反馈。 */
        function writeSaveContainer(pid, container){
                var ok = store.set(K.SAVES + pid, container);
                if (ok){ emit('saves:changed'); }
                return ok;
        }

// 读取列表：迁移 + 校验（坏档不剔除，标记 _corrupt 供 UI 隔离）
        /*
         * 读取存档列表。
         * 关键设计：坏档不删除，而是标记 _corrupt。原因：
         *   - 用户仍能看到并手动删除；
         *   - 不会因为一条坏数据导致整个列表消失；
         *   - 读档页可以明确显示“已损坏，不可读取”。
         */
        function listSaves(pid){
                var container = readSaveContainer(pid);
                return container.saves.map(function(raw){
                        var rec = migrateRecord(deepCopy(raw) || raw);
                        // 缺少必要字段：标记损坏，但仍返回占位对象给 UI。
                        if (!rec || !rec.id || typeof rec.level !== 'number'){
                                rec = rec || { id: 'broken' };
                                rec._corrupt = true;
                                return rec;
                        }
                        var expect = rec.sum;       // 先保存原始校验和
                        // 除校验和外还要做语义校验：矩阵尺寸、坐标边界、枚举值。
                        // 这样本地被手工改过但重新算过 sum 的记录也会被隔离。
                        var dataError = recordDataError(rec);
                        delete rec._corrupt;
                        // 缺少 sum 与 sum 不一致同样视为损坏：与导入规则保持一致，
                        // 也保证“全部导出”按钮显示的数量与实际导出数组长度一致。
                        if (expect == null || checksum(rec) !== expect || dataError){
                                rec._corrupt = true;
                        }
                        rec.slotType = rec.slotType === 'auto' ? 'auto' : 'manual';
                        return rec;
                });
        }
        /* 按存档 ID 查找单份存档；找不到返回 null。 */
        function getSaves(pid, sid){
                return listSaves(pid).filter(function(s){ return s.id === sid; })[0] || null;
        }

// 构造存档记录（含校验和与版本）
        /*
         * 构造标准存档记录。
         * 所有外部输入（关卡、分数、生命）都在这里做边界收敛：
         *   level -> 1..12，score -> >=0 的整数，lives -> 1..5；
         * 这样即使导入文件字段异常，也不会把非法值写进游戏状态。
         */
        function buildRecord(data){
                var rec = {
                        id: data.id || uuid(),
                        name: normalizeName(data.name) || ('第' + data.level + '关'),
                        slotType: data.slotType === 'auto' ? 'auto' : 'manual',
                        level: Math.min(Math.max(1, Math.floor(data.level || 1)), LEVEL_MAX),
                        score: Math.max(0, Math.floor(data.score || 0)),
                        lives: Math.min(Math.max(1, Math.floor(data.lives || 5)), 5),
                        isCheated: !!data.isCheated,
                        schemaVersion: SCHEMA_VERSION
                };
                if (data.snapshot){
                        rec.snapshot = data.snapshot;
                }
                var remark = normalizeRemark(data.remark);
                if (remark){ rec.remark = remark; }     // 备注选填：空则不落字段
                if (data.createdAt){ rec.createdAt = data.createdAt; }
                if (data.updatedAt){ rec.updatedAt = data.updatedAt; }
                rec.sum = checksum(rec);
                return rec;
        }

// 新增手动存档（校验上限）
        /*
         * 新增手动存档。
         * 自动存档有独立滚动槽位，不占用 20 份手动档配额。
         */
        function addSave(pid, data){
                var container = readSaveContainer(pid);
                var manualCount = container.saves.filter(function(s){ return s.slotType !== 'auto'; }).length;
                if (data.slotType !== 'auto' && manualCount >= MANUAL_MAX){
                        return { error: '手动存档已达上限（'+MANUAL_MAX+'份），请先清理' };
                }
                var rec = buildRecord(data);
                rec.createdAt = now();
                rec.updatedAt = now();
                container.saves.push(rec);
                if (!writeSaveContainer(pid, container)){ return { error: '存储写入失败' }; }
                return { save: rec };
        }

// 更新（覆盖）既有存档：保留 id 与创建时间
        /*
         * 覆盖存档。
         * 必须保留原 id、createdAt，并重新计算 sum（因为内容与 updatedAt 已变化）。
         */
        function updateSave(pid, sid, data){
                var container = readSaveContainer(pid);
                var idx = -1;
                for (var i = 0; i < container.saves.length; i++){
                        if (container.saves[i].id === sid){ idx = i; break; }
                }
                if (idx < 0){ return { error: '存档不存在' }; }
                var old = container.saves[idx];
                var rec = buildRecord(data);
                rec.id = sid;
                rec.createdAt = old.createdAt || now();
                rec.updatedAt = now();
                rec.sum = checksum(rec);        // id 与时间戳定稿后必须重算校验和
                container.saves[idx] = rec;
                if (!writeSaveContainer(pid, container)){ return { error: '存储写入失败' }; }
                return { save: rec };
        }

// 删除存档
        /*
         * 删除单份存档；写入失败时返回错误，不向 UI 谎报成功。
         */
        function removeSave(pid, sid){
                var container = readSaveContainer(pid);
                var before = container.saves.length;
                container.saves = container.saves.filter(function(s){ return s.id !== sid; });
                if (container.saves.length === before){ return { error: '存档不存在' }; }
                if (!writeSaveContainer(pid, container)){ return { error: '存储写入失败' }; }
                return { removed: true };
        }

// 转存存档：生成同内容的新手动档（新 id，命名「原名 · 副本」，重名自动编号）。
// 自动档被转存后转为手动档——不受 3 槽滚动淘汰，实现“转存珍藏”。
        /*
         * 转存逻辑：
         *   1. 深拷贝并迁移源记录，避免修改原档；
         *   2. 校验源档校验和，损坏档拒绝转存；
         *   3. 检查手动档上限；
         *   4. 生成不重复的「原名 · 副本N」；
         *   5. 以全新 ID/时间戳写入手动档。
         */
        function duplicateSave(pid, sid){
                var container = readSaveContainer(pid);
                var raw = null;
                for (var i = 0; i < container.saves.length; i++){
                        if (container.saves[i].id === sid){ raw = container.saves[i]; break; }
                }
                if (!raw){ return { error: '存档不存在' }; }
                var src = migrateRecord(deepCopy(raw) || raw);
                if (!src || src.sum == null || checksum(src) !== src.sum){
                        return { error: '存档已损坏，无法转存' };
                }
                var manualCount = container.saves.filter(function(s){ return s.slotType !== 'auto'; }).length;
                if (manualCount >= MANUAL_MAX){
                        return { error: '手动存档已达上限（'+MANUAL_MAX+'份），请先清理' };
                }
                // 副本命名：去掉历史副本后缀防止叠加；截短原名以容纳「 · 副本」（5 字符）
                var names = container.saves.map(function(s){ return s.name; });
                var base = normalizeName(src.name) || '未命名';
                base = base.replace(/\s*·\s*副本\d*$/, '');
                if (base.length > NAME_MAX - 5){ base = base.slice(0, NAME_MAX - 5); }
                var name = base + ' · 副本';
                var n = 1;
                while (names.indexOf(name) >= 0){
                        n += 1;
                        name = base + ' · 副本' + n;
                }
                var rec = buildRecord({
                        name: name,
                        slotType: 'manual',
                        level: src.level,
                        score: src.score,
                        lives: src.lives,
                        isCheated: !!src.isCheated,
                        remark: src.remark || '',
                        snapshot: src.snapshot || null
                });
                rec.createdAt = now();
                rec.updatedAt = now();
                rec.sum = checksum(rec);
                container.saves.push(rec);
                if (!writeSaveContainer(pid, container)){ return { error: '存储写入失败' }; }
                return { save: rec };
        }

// 自动存档：滚动保留最近 AUTO_SLOTS 份；内容相同则仅刷新时间（防槽位抖动）
        /*
         * 自动存档。
         * 去重条件：关卡、分数、生命、作弊标记、完整快照都相同。
         * 防止只比较“是否有快照”，否则会导致同一分数但走到不同位置时丢快照；
         * 这里比较完整快照，确保“离开页面”保存的确实是当前位置。
         */
        function autosave(pid, data){
                var container = readSaveContainer(pid);
                var rec = buildRecord(data);
                rec.slotType = 'auto';
                rec.createdAt = now();
                rec.updatedAt = now();
                rec.sum = checksum(rec);

                var autos = container.saves.filter(function(s){ return s.slotType === 'auto'; });
                var newest = autos[0];
                // 快照一般只有约 1.5KB，直接序列化比较足够快，且无需额外哈希函数。
                var sameSnapshot = JSON.stringify(newest && newest.snapshot || null) === JSON.stringify(rec.snapshot || null);
                if (newest && !newest._corrupt &&
                    newest.level === rec.level && newest.score === rec.score && newest.lives === rec.lives &&
                    !!newest.isCheated === !!rec.isCheated && sameSnapshot){
                        newest.updatedAt = now();
                        newest.sum = checksum(newest);
                        return writeSaveContainer(pid, container);
                }
                container.saves = [rec].concat(container.saves);        // 自动档置顶
                // 裁剪自动档至槽位上限（丢最旧的）
                // filter 保持原顺序：先遇到的是最新自动档，seen > AUTO_SLOTS 的旧档被丢弃。
                var seen = 0;
                container.saves = container.saves.filter(function(s){
                        if (s.slotType === 'auto'){ seen += 1; return seen <= AUTO_SLOTS; }
                        return true;
                });
                return writeSaveContainer(pid, container);
        }

        /* ============================== 检查点 / 待读档 ============================== */

        /* 读取游戏页写入的实时检查点；没有进行中的对局时为 null。 */
        function getCheckpoint(){
                return store.get(K.CHECKPOINT);
        }
        /*
         * 写入实时检查点。
         * 这里只接受白名单字段，避免页面把临时对象/函数写进 localStorage；
         * updatedAt 由核心层统一生成，防止调用方传入旧时间。
         */
        function setCheckpoint(data){
                var payload = {
                        playerId: data.playerId,
                        level: data.level,
                        score: data.score,
                        lives: data.lives,
                        isCheated: !!data.isCheated,
                        snapshot: data.snapshot || null,
                        updatedAt: now()
                };
                var ok = store.set(K.CHECKPOINT, payload);
                if (ok){ emit('checkpoint:changed'); }
                return ok;
        }
// 待读档桥（sessionStorage：读档页 → 游戏页 同标签页交接）
        /*
         * 投放“待读档”负载。
         * 使用 sessionStorage 而不是 localStorage：只在当前标签页交接一次，
         * 读完立即删除，避免刷新游戏页时反复自动读档。
         */
        function setPending(payload){
                try{
                        window.sessionStorage.setItem(K.PENDING, JSON.stringify(payload));
                        return true;
                }catch(e){
                        return false;
                }
        }
        /*
         * 取出并删除待读档负载。
         * JSON 损坏时返回 null，让游戏页停留在正常启动页而不是崩溃。
         */
        function takePending(){
                try{
                        var raw = window.sessionStorage.getItem(K.PENDING);
                        if (!raw){ return null; }
                        window.sessionStorage.removeItem(K.PENDING);
                        return JSON.parse(raw);
                }catch(e){
                        return null;
                }
        }

        /* ============================== 导出 / 导入 ============================== */

        /*
         * 导出某位玩家的全部有效存档。
         * 导出文件自带 magic/version/player 元信息，便于跨设备识别与未来迁移。
         */
        function exportData(pid){
                var player = getPlayer(pid);
                // 导出前再次做完整校验，确保任何无效记录都不会离开本机。
                var saves = listSaves(pid).filter(function(s){
                        return !s._corrupt && !recordDataError(s) && checksum(s) === s.sum;
                });
                return {
                        magic: EXPORT_MAGIC,
                        version: SCHEMA_VERSION,
                        exportedAt: now(),
                        player: player ? { id: player.id, name: player.name } : null,
                        saves: saves
                };
        }

// 快照语义校验：结构正确 + 与当前关卡几何一致，避免“sum 合法但数据不可恢复”。
        /*
         * 快照完整校验。
         * 只判断“是不是数组/数字”还不够：导入文件来自用户磁盘，下面是
         * dmApplySave 真正需要的可恢复条件。
         *
         * 校验规则：
         *   - beans 必须严格为 31 x 28，单元格只能是 0/1/2；
         *   - player / ghosts 的像素坐标必须落在当前地图范围内；
         *   - 朝向、幽灵状态必须是 0..3 / 0..4 的整数；
         *   - 幽灵目标点 vector 使用地图格坐标，必须在矩阵范围内；
         *   - ghosts 允许 0..4 只；缺失的幽灵由 dmApplySave 保留初始位置。
         *
         * @param {Object|null} snapshot
         * @param {number} level 1..12，决定校验使用的关卡上下文
         * @return {boolean} true 表示可安全交给 dmApplySave 恢复
         */
        function isValidSnapshot(snapshot, level){
                if (!snapshot) return true;
                if (!(typeof level === 'number' && isFinite(level) && level % 1 === 0 &&
                      level >= 1 && level <= LEVEL_MAX)){ return false; }
                if (typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;

                function isIntegerInRange(value, min, max){
                        return typeof value === 'number' && isFinite(value) &&
                               value % 1 === 0 && value >= min && value <= max;
                }
                function isPosition(point){
                        var maxX = SNAPSHOT_MAP_X + SNAPSHOT_COLS * SNAPSHOT_CELL;
                        var maxY = SNAPSHOT_MAP_Y + SNAPSHOT_ROWS * SNAPSHOT_CELL;
                        return !!point &&
                               typeof point.x === 'number' && isFinite(point.x) &&
                               typeof point.y === 'number' && isFinite(point.y) &&
                               point.x >= SNAPSHOT_MAP_X && point.x < maxX &&
                               point.y >= SNAPSHOT_MAP_Y && point.y < maxY;
                }

                var beans = snapshot.beans;
                if (!Array.isArray(beans) || beans.length !== SNAPSHOT_ROWS) return false;
                for (var y = 0; y < beans.length; y++){
                        var row = beans[y];
                        if (!Array.isArray(row) || row.length !== SNAPSHOT_COLS) return false;
                        for (var x = 0; x < row.length; x++){
                                var cell = row[x];
                                if (cell !== 0 && cell !== 1 && cell !== 2){ return false; }
                        }
                }

                var player = snapshot.player;
                if (!isPosition(player) || !isIntegerInRange(player.orientation, 0, 3)){ return false; }

                var ghosts = snapshot.ghosts;
                if (!Array.isArray(ghosts) || ghosts.length > 4) return false;
                for (var i = 0; i < ghosts.length; i++){
                        var ghost = ghosts[i];
                        if (!ghost || !isPosition(ghost)){ return false; }
                        if (!isIntegerInRange(ghost.orientation, 0, 3)){ return false; }
                        if (!isIntegerInRange(ghost.status, 0, 4)){ return false; }
                        if (typeof ghost.timeout !== 'number' || !isFinite(ghost.timeout) || ghost.timeout < 0){ return false; }
                        if (ghost.vector != null){
                                if (typeof ghost.vector !== 'object' || Array.isArray(ghost.vector)){ return false; }
                                if (!isIntegerInRange(ghost.vector.x, 0, SNAPSHOT_COLS - 1) ||
                                    !isIntegerInRange(ghost.vector.y, 0, SNAPSHOT_ROWS - 1)){ return false; }
                        }
                }
                return true;
        }

        /*
         * 单份存档的业务字段校验。
         * 返回 null 表示通过，否则返回可直接展示给用户的原因。
         * 读取列表、导出全部、导入三个入口共用此函数，避免规则漂移。
         */
        function recordDataError(rec){
                if (!rec || typeof rec !== 'object' || Array.isArray(rec)){ return '存档记录格式无效'; }
                if (!(typeof rec.level === 'number' && isFinite(rec.level) && rec.level % 1 === 0 &&
                      rec.level >= 1 && rec.level <= LEVEL_MAX)){ return '关卡数据无效'; }
                if (!(typeof rec.score === 'number' && isFinite(rec.score) && rec.score % 1 === 0 &&
                      rec.score >= 0)){ return '分数数据无效'; }
                if (!(typeof rec.lives === 'number' && isFinite(rec.lives) && rec.lives % 1 === 0 &&
                      rec.lives >= 1 && rec.lives <= 5)){ return '生命数据无效'; }
                if (rec.slotType != null && rec.slotType !== 'manual' && rec.slotType !== 'auto'){
                        return '存档类型无效';
                }
                if (!isValidSnapshot(rec.snapshot, rec.level)){ return '快照结构或坐标无效'; }
                return null;
        }

// 导入到指定玩家：逐份校验、重命名冲突、执行上限
        /*
         * 导入存档。
         * @param {string|Object} json 文件文本或已解析对象
         * @param {string} pid 目标玩家 ID
         * @return {Object} 统计报告 { imported, skipped, renamed } 或 { error }
         *
         * 安全策略：
         *   - 校验 magic/version；
         *   - 自动档跳过（自动档属于本机滚动数据，不应跨设备覆盖）；
         *   - 重名自动追加「· 导入」，并继续编号；
         *   - 每份都重新校验 sum 与快照结构；
         *   - 达到手动档上限后剩余文件计入 skipped，不中断整批导入。
         */
        function importData(json, pid){
                var report = { imported: 0, skipped: 0, renamed: 0, invalid: [] };
                // 记录每份被跳过存档的名称与原因，页面可以展示具体是哪一份无效。
                function skip(rec, reason){
                        report.skipped += 1;
                        report.invalid.push({
                                name: normalizeName(rec && rec.name) || '未命名',
                                reason: reason
                        });
                }
                var data;
                if (typeof json === 'string'){
                        try{ data = JSON.parse(json); }catch(e){ return { error: '文件不是有效的 JSON' }; }
                }else{
                        data = json;
                }
                // magic 是文件类型守卫，防止用户误选普通 JSON。
                if (!data || data.magic !== EXPORT_MAGIC){
                        return { error: '不是有效的存档导出文件' };
                }
                // 版本高于当前代码说明站点未升级，拒绝导入以免丢字段。
                if (typeof data.version !== 'number' || data.version > SCHEMA_VERSION){
                        return { error: '存档文件版本过新（v'+data.version+'），请升级站点' };
                }
                if (!Array.isArray(data.saves)){
                        return { error: '存档文件内容缺失' };
                }
                if (!getPlayer(pid)){
                        return { error: '目标玩家不存在' };
                }
                // 一次性读出容器，循环内只改内存数组，最后统一写回，减少 localStorage 抖动。
                var container = readSaveContainer(pid);
                var manualCount = container.saves.filter(function(s){ return s.slotType !== 'auto'; }).length;
                var existingNames = container.saves.map(function(s){ return s.name; });

                data.saves.forEach(function(raw){
                        // 逐份深拷贝 + 迁移，保证循环中的修改不会污染原始导出数据。
                        var rec = migrateRecord(deepCopy(raw) || raw);
                        var dataError = recordDataError(rec);
                        // 校验和用于发现“内容与摘要不一致”；它不能替代上面的语义校验。
                        if (rec && typeof rec === 'object' &&
                            (rec.sum == null || checksum(rec) !== rec.sum)){
                                dataError = '校验和不匹配或缺失';
                        }
                        if (dataError){ skip(rec, dataError); return; }
                        if (rec.slotType === 'auto'){
                                // 自动档不导入（属于本机滚动数据）
                                skip(rec, '自动档不导入');
                                return;
                        }
                        if (manualCount >= MANUAL_MAX){
                                skip(rec, '超出手动档上限');
                                return;
                        }
                        var name = normalizeName(rec.name) || '导入存档';
                        // 重名时追加「· 导入」；若仍然重复则继续加数字。
                        if (existingNames.indexOf(name) >= 0){
                                var base = name + ' · 导入';
                                var final = base;
                                var n = 1;
                                while (existingNames.indexOf(final) >= 0){
                                        n += 1;
                                        final = base + n;
                                }
                                name = final;
                                report.renamed += 1;
                        }
                        // 导入后生成全新 id/createdAt/updatedAt，避免与源设备存档冲突。
                        var fresh = buildRecord({
                                name: name,
                                slotType: 'manual',
                                level: rec.level,
                                score: rec.score,
                                lives: rec.lives,
                                isCheated: !!rec.isCheated,
                                remark: rec.remark || '',
                                snapshot: rec.snapshot || null
                        });
                        fresh.createdAt = now();
                        fresh.updatedAt = now();
                        fresh.sum = checksum(fresh);
                        container.saves.push(fresh);
                        existingNames.push(name);
                        manualCount += 1;
                        report.imported += 1;
                });
                if (!writeSaveContainer(pid, container) && report.imported){
                        return { error: '存储写入失败' };
                }
                return report;
        }

        /* ============================== UI 组件（toast / 确认弹层） ============================== */

        /*
         * 无框架的轻量 UI 组件。
         * 所有节点都用 createElement + textContent 构建，避免把用户昵称/备注拼进
         * innerHTML 造成 XSS；只有结构固定的弹层外壳使用 innerHTML。
         */
        var UI = (function(){
                /* 惰性创建 toast 容器：页面第一次弹提示时才插入 DOM。 */
                function ensureContainer(){
                        var el = document.getElementById('dm-toast-box');
                        if (!el){
                                el = document.createElement('div');
                                el.id = 'dm-toast-box';
                                // toast 属于非打断式反馈：读屏软件在空闲时播报，不抢焦点。
                                el.setAttribute('role', 'status');
                                el.setAttribute('aria-live', 'polite');
                                document.body.appendChild(el);
                        }
                        return el;
                }
                /*
                 * 顶部轻提示。
                 * 同时最多保留 3 条，超出时移除最旧一条；2.4 秒后淡出。
                 */
                function toast(msg, type){
                        try{
                                var box = ensureContainer();
                                var item = document.createElement('div');
                                item.className = 'dm-toast' + (type ? ' dm-toast-' + type : '');
                                item.textContent = msg;
                                box.appendChild(item);
                                while (box.children.length > 3){
                                        box.removeChild(box.firstChild);
                                }
                                setTimeout(function(){
                                        item.classList.add('dm-toast-out');
                                        setTimeout(function(){
                                                if (item.parentNode){ item.parentNode.removeChild(item); }
                                        }, 300);
                                }, 2400);
                        }catch(e){ /* 静默 */ }
                }
                /*
                 * 自定义确认弹层。
                 * 返回 Promise<boolean>，调用方可以 await / then；
                 * 支持 Esc 取消、点击遮罩取消、默认聚焦确认按钮。
                 * 极端情况下（DOM 构建失败）回退到原生 confirm，保证删除/覆盖流程不中断。
                 */
                function confirmModal(opts){
                        opts = opts || {};
                        return new Promise(function(resolve){
                                try{
                                        var overlay = document.createElement('div');
                                        overlay.className = 'dm-modal-overlay';
                                        var dialog = document.createElement('div');
                                        dialog.className = 'dm-modal' + (opts.danger ? ' dm-modal-danger' : '');
                                        dialog.innerHTML =
                                            '<div class="dm-modal-title"></div>' +
                                            '<div class="dm-modal-text"></div>' +
                                            '<div class="dm-modal-btns">' +
                                            '<button type="button" class="dm-btn dm-btn-ghost dm-modal-cancel"></button>' +
                                            '<button type="button" class="dm-btn dm-modal-ok"></button>' +
                                            '</div>';
                                        dialog.querySelector('.dm-modal-title').textContent = opts.title || '确认操作';
                                        dialog.querySelector('.dm-modal-text').textContent = opts.text || '';
                                        var okBtn = dialog.querySelector('.dm-modal-ok');
                                        var cancelBtn = dialog.querySelector('.dm-modal-cancel');
                                        okBtn.textContent = opts.okText || '确定';
                                        cancelBtn.textContent = opts.cancelText || '取消';
                                        if (opts.danger){ okBtn.classList.add('dm-btn-danger'); }
                                        else { okBtn.classList.add('dm-btn-primary'); }
                                        overlay.appendChild(dialog);
                                        document.body.appendChild(overlay);
                                        function close(result){
                                                // 先移除节点和全局键盘监听，再 resolve，避免重复关闭。
                                                if (overlay.parentNode){ overlay.parentNode.removeChild(overlay); }
                                                document.removeEventListener('keydown', onKey, true);
                                                resolve(result);
                                        }
                                        function onKey(e){
                                                if (e.keyCode === 27){ close(false); }  // Esc
                                        }
                                        okBtn.addEventListener('click', function(){ close(true); });
                                        cancelBtn.addEventListener('click', function(){ close(false); });
                                        overlay.addEventListener('click', function(e){
                                                if (e.target === overlay){ close(false); }
                                        });
                                        document.addEventListener('keydown', onKey, true);
                                        setTimeout(function(){ okBtn.focus(); }, 50);
                                }catch(e){
                                        resolve(window.confirm(opts.title || ''));      // 兜底原生确认框
                                }
                        });
                }
                return { toast: toast, confirm: confirmModal };
        })();

        /* ============================== 对外暴露 ============================== */

        DM.CORE = {
                available: store.available,
                // 常量
                SCHEMA_VERSION: SCHEMA_VERSION,
                MANUAL_MAX: MANUAL_MAX,
                AUTO_SLOTS: AUTO_SLOTS,
                LEVEL_MAX: LEVEL_MAX,
                // 事件
                on: on,
                off: off,
                emit: emit,
                // 玩家
                players: listPlayers,
                player: getPlayer,
                active: active,
                activeId: activeId,
                setActive: setActive,
                createPlayer: createPlayer,
                renamePlayer: renamePlayer,
                removePlayer: removePlayer,
                ensureGuest: ensureGuest,
                reportGameStart: reportGameStart,
                reportGameEnd: reportGameEnd,
                // 存档
                saves: listSaves,
                save: getSaves,
                addSave: addSave,
                updateSave: updateSave,
                removeSave: removeSave,
                duplicateSave: duplicateSave,
                autosave: autosave,
                // 检查点 / 桥接
                checkpoint: getCheckpoint,
                setCheckpoint: setCheckpoint,
                setPending: setPending,
                takePending: takePending,
                // 导出导入
                exportData: exportData,
                importData: importData,
                // 工具
                uuid: uuid,
                fmtTime: fmtTime,
                normalizeName: normalizeName,
                normalizeRemark: normalizeRemark
        };
        DM.UI = UI;

})();
