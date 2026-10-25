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
 * 注意：localStorage 不可用时优雅降级，不抛异常。
 */
function createAdapter(){
        var ok = true;
        try{
                var probe = '__dm_probe__' + Date.now();
                window.localStorage.setItem(probe, '1');
                window.localStorage.removeItem(probe);
        }catch(e){
                ok = false;
        }
        return {
                available: ok,
                get: function(key){
                        if (!ok) return null;
                        try{
                                var raw = window.localStorage.getItem(key);
                                return raw == null ? null : JSON.parse(raw);
                        }catch(e){
                                return null;
                        }
                },
                set: function(key, value){
                        if (!ok) return false;
                        try{
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

var _subs = {};
function on(event, fn){
        (_subs[event] = _subs[event] || []).push(fn);
        return function(){ off(event, fn); };
}
function off(event, fn){
        if (!_subs[event]) return;
        _subs[event] = _subs[event].filter(function(f){ return f !== fn; });
}
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

function uuid(){
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function now(){
        return Date.now();
}
// 轻量校验和（djb2）：用于检测损坏/手改，非安全加密
function checksum(obj){
        var s;
        try{
                s = JSON.stringify(obj, function(key, value){
                        return (key === 'sum' || key === 'createdAt' || key === 'updatedAt') ? undefined : value;
                });
        }catch(e){
                return 'ERR';
        }
        var h = 5381;
        for (var i = 0; i < s.length; i++){
                h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        }
        return (h >>> 0).toString(36);
}
function deepCopy(obj){
        try{
                return JSON.parse(JSON.stringify(obj));
        }catch(e){
                return null;
        }
}
function fmtTime(ts){
        if (!ts) return '-';
        try{
                return new Date(ts).toLocaleString();
        }catch(e){
                return '-';
        }
}
// 名称规范化：去首尾空白、去控制字符、限长
function normalizeName(name){
        return String(name == null ? '' : name)
                .replace(/[\x00-\x1f\x7f]/g, '')
                .trim()
                .slice(0, NAME_MAX);
}

// 备注规范化：去控制字符、限长（选填字段，空值不落库）
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

function readPlayers(){
        var data = store.get(K.PLAYERS);
        if (!data || !Array.isArray(data.saves) && !Array.isArray(data.list)){ /* 兼容直存数组 */ }
        if (Array.isArray(data)){
                return data;                                            // 早期直存数组格式
        }
        if (data && Array.isArray(data.list)){
                return data.list;
        }
        return [];
}
function writePlayers(list){
        var ok = store.set(K.PLAYERS, list);
        if (ok){ emit('players:changed'); }
        return ok;
}

function listPlayers(){
        return readPlayers().map(function(p){
                p.stats = p.stats || {};
                return p;
        });
}
function getPlayer(id){
        return listPlayers().filter(function(p){ return p.id === id; })[0] || null;
}
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
function active(){
        var id = activeId();
        return id ? getPlayer(id) : null;
}
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

function readSaveContainer(pid){
        var data = store.get(K.SAVES + pid);
        if (Array.isArray(data)){ data = { __v: 1, saves: data }; }     // 兼容直存数组
        if (!data || !Array.isArray(data.saves)){ return { __v: SCHEMA_VERSION, saves: [] }; }
        return data;
}
function writeSaveContainer(pid, container){
        var ok = store.set(K.SAVES + pid, container);
        if (ok){ emit('saves:changed'); }
        return ok;
}

// 读取列表：迁移 + 校验（坏档不剔除，标记 _corrupt 供 UI 隔离）
function listSaves(pid){
        var container = readSaveContainer(pid);
        return container.saves.map(function(raw){
                var rec = migrateRecord(deepCopy(raw) || raw);
                if (!rec || !rec.id || typeof rec.level !== 'number'){
                        rec = rec || { id: 'broken' };
                        rec._corrupt = true;
                        return rec;
                }
                var expect = rec.sum;
                delete rec._corrupt;
                if (expect != null && checksum(rec) !== expect){
                        rec._corrupt = true;
                }
                rec.slotType = rec.slotType === 'auto' ? 'auto' : 'manual';
                return rec;
        });
}
function getSaves(pid, sid){
        return listSaves(pid).filter(function(s){ return s.id === sid; })[0] || null;
}

// 构造存档记录（含校验和与版本）
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
function removeSave(pid, sid){
        var container = readSaveContainer(pid);
        var before = container.saves.length;
        container.saves = container.saves.filter(function(s){ return s.id !== sid; });
        if (container.saves.length === before){ return { error: '存档不存在' }; }
        writeSaveContainer(pid, container);
        return { removed: true };
}

// 自动存档：滚动保留最近 AUTO_SLOTS 份；内容相同则仅刷新时间（防槽位抖动）
function autosave(pid, data){
        var container = readSaveContainer(pid);
        var rec = buildRecord(data);
        rec.slotType = 'auto';
        rec.createdAt = now();
        rec.updatedAt = now();
        rec.sum = checksum(rec);

        var autos = container.saves.filter(function(s){ return s.slotType === 'auto'; });
        var newest = autos[0];
        if (newest && !newest._corrupt &&
                newest.level === rec.level && newest.score === rec.score &&
                !newest.snapshot === !rec.snapshot && newest.lives === rec.lives){
                newest.updatedAt = now();
                newest.sum = checksum(newest);
                return writeSaveContainer(pid, container);
        }
        container.saves = [rec].concat(container.saves);        // 自动档置顶
        // 裁剪自动档至槽位上限（丢最旧的）
        var seen = 0;
        container.saves = container.saves.filter(function(s){
                if (s.slotType === 'auto'){ seen += 1; return seen <= AUTO_SLOTS; }
                return true;
        });
        return writeSaveContainer(pid, container);
}

/* ============================== 检查点 / 待读档 ============================== */

function getCheckpoint(){
        return store.get(K.CHECKPOINT);
}
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
function setPending(payload){
        try{
                window.sessionStorage.setItem(K.PENDING, JSON.stringify(payload));
                return true;
        }catch(e){
                return false;
        }
}
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

function exportData(pid){
        var player = getPlayer(pid);
        var saves = listSaves(pid).filter(function(s){ return !s._corrupt; });
        return {
                magic: EXPORT_MAGIC,
                version: SCHEMA_VERSION,
                exportedAt: now(),
                player: player ? { id: player.id, name: player.name } : null,
                saves: saves
        };
}

// 导入到指定玩家：逐份校验、重命名冲突、执行上限
function importData(json, pid){
        var report = { imported: 0, skipped: 0, renamed: 0 };
        var data;
        if (typeof json === 'string'){
                try{ data = JSON.parse(json); }catch(e){ return { error: '文件不是有效的 JSON' }; }
        }else{
                data = json;
        }
        if (!data || data.magic !== EXPORT_MAGIC){
                return { error: '不是有效的存档导出文件' };
        }
        if (typeof data.version !== 'number' || data.version > SCHEMA_VERSION){
                return { error: '存档文件版本过新（v'+data.version+'），请升级站点' };
        }
        if (!Array.isArray(data.saves)){
                return { error: '存档文件内容缺失' };
        }
        if (!getPlayer(pid)){
                return { error: '目标玩家不存在' };
        }
        var container = readSaveContainer(pid);
        var manualCount = container.saves.filter(function(s){ return s.slotType !== 'auto'; }).length;
        var existingNames = container.saves.map(function(s){ return s.name; });

        data.saves.forEach(function(raw){
                var rec = migrateRecord(deepCopy(raw) || raw);
                if (!rec || typeof rec.level !== 'number' || rec.sum == null || checksum(rec) !== rec.sum){
                        report.skipped += 1;    // 校验失败
                        return;
                }
                if (rec.slotType === 'auto'){
                        // 自动档不导入（属于本机滚动数据）
                        report.skipped += 1;
                        return;
                }
                if (manualCount >= MANUAL_MAX){
                        report.skipped += 1;
                        return;
                }
                var name = normalizeName(rec.name) || '导入存档';
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
        writeSaveContainer(pid, container);
        return report;
}

/* ============================== UI 组件（toast / 确认弹层） ============================== */

var UI = (function(){
        function ensureContainer(){
                var el = document.getElementById('dm-toast-box');
                if (!el){
                        el = document.createElement('div');
                        el.id = 'dm-toast-box';
                        document.body.appendChild(el);
                }
                return el;
        }
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
