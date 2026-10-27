/*
 * dm-player.js —— 玩家页逻辑：创建 / 切换 / 改名 / 删除 + 战绩统计
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 *
 * 页面数据流：
 *   localStorage(dm.players / dm.activePlayerId / dm.saves.<id>)
 *     -> DM.CORE 读取、迁移、校验
 *     -> 本文件 renderNotice / renderActive / renderList 生成 HTML
 *     -> 事件委托统一处理 switch / rename / remove
 *
 * 安全原则：
 *   - 所有玩家昵称、备注、时间等动态文本都经过 esc()；
 *   - data-id 只放 UUID，不放昵称；
 *   - 删除/覆盖等破坏性操作必须经过 UI.confirm 二次确认。
 */
(function(){
'use strict';

var CORE = window.DM && DM.CORE;
var UI = window.DM && DM.UI;
if (!CORE || !UI){ return; }

var $notice = document.getElementById('dm-notice');
var $active = document.getElementById('dm-active');
var $list = document.getElementById('dm-list');
var $nameForm = document.getElementById('dm-new-form');
var $nameInput = document.getElementById('dm-new-name');
var $nameError = document.getElementById('dm-new-error');
var $nameSubmit = document.getElementById('dm-new-submit');

/*
 * HTML 转义。
 * 由于列表使用字符串模板 + innerHTML 渲染，必须先转义用户可控文本，
 * 防止昵称中包含 <script> 或引号破坏属性结构。
 */
function esc(text){
	return String(text == null ? '' : text).replace(/[&<>"']/g, function(c){
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}
/* 头像首字符：空昵称回退为“玩”，兼容旧数据。 */
function firstChar(name){
	return String(name || '玩').charAt(0);
}
/*
 * 统计某位玩家“可读取”的存档数量。
 * 损坏档虽然展示，但不计入有效存档数，避免统计虚高。
 */
function saveCount(pid){
	try{
		return CORE.saves(pid).filter(function(s){ return !s._corrupt; }).length;
	}catch(e){
		return 0;
	}
}

/*
 * 校验玩家昵称。
 * @param {string} raw 输入框原始值
 * @return {{ok:boolean, value?:string, error?:string}} 统一结果对象
 *
 * 说明：normalizeName 负责去控制字符、去首尾空白、截断到 12 字符；
 * 这里额外做“非空 + 重名”检查，让 UI 在调用 CORE.createPlayer 前就能给出明确提示。
 */
function validatePlayerName(raw){
	var value = CORE.normalizeName(raw);
	if (!value){
		return { ok: false, error: '昵称不能为空' };
	}
	var exists = CORE.players().some(function(p){ return p.name === value; });
	if (exists){
		return { ok: false, error: '昵称「' + value + '」已存在' };
	}
	return { ok: true, value: value };
}

/* ---------- 提示条 ---------- */

function renderNotice(){
	var html = '';
	// 存储不可用是最高优先级提示：后续所有按钮都会因无法落库而失败。
	if (!CORE.available){
		html = '<div class="dm-notice dm-notice-error">当前浏览器存储不可用（可能处于隐身模式或已禁用），无法保存玩家与存档数据。</div>';
	}else{
		var players = CORE.players();
		// 无玩家时提供两条路径：直接创建，或开局自动生成游客。
		if (!players.length){
			html = '<div class="dm-notice">还没有玩家。你可以先<a href="./index.html">开始游戏</a>（将自动创建游客玩家），或直接在下方创建。</div>';
		}
	}
	$notice.innerHTML = html;
}

/* ---------- 当前玩家卡片 ---------- */

function renderActive(){
	var p = CORE.active();
	if (!p){
		$active.innerHTML = '<div class="dm-empty">尚未选择玩家。开始游戏或从下方列表切换。</div>';
		return;
	}
	var st = p.stats || {};
	// 卡片中的动态字段全部 esc；数字字段来自核心层已收敛，不会再包含 HTML。
	var html =
		'<div class="dm-card highlight">' +
			'<div class="dm-player-row">' +
				'<div class="dm-avatar' + (p.name.indexOf('游客') === 0 ? ' guest' : '') + '">' + esc(firstChar(p.name)) + '</div>' +
				'<div class="dm-player-info">' +
					'<div class="dm-player-name">' + esc(p.name) + ' <span class="dm-badge dm-badge-active">当前</span></div>' +
					'<div class="dm-player-meta">创建于 ' + esc(CORE.fmtTime(p.createdAt)) + ' · 最近游玩 ' + esc(CORE.fmtTime(p.lastActiveAt)) + '</div>' +
					'<div class="dm-player-stats">' +
						'<div class="dm-stat">最高分<b>' + (st.bestScore || 0) + '</b></div>' +
						'<div class="dm-stat">游戏局数<b>' + (st.gamesStarted || 0) + '</b></div>' +
						'<div class="dm-stat">存档<b>' + saveCount(p.id) + '</b></div>' +
						'<div class="dm-stat">通关' + (st.cleared ? '<span class="dm-badge dm-badge-clear">已通关</span>' : '<b style="color:#9aa3ac;font-size:14px;">未通关</b>') + '</div>' +
					'</div>' +
				'</div>' +
				'<div class="dm-btn-row">' +
					'<button type="button" class="dm-btn dm-btn-ghost dm-btn-small" data-act="rename" data-id="' + esc(p.id) + '">改名</button>' +
					'<a class="dm-btn dm-btn-small" href="./save.html">管理存档</a>' +
					'<a class="dm-btn dm-btn-small" href="./load.html">读取存档</a>' +
				'</div>' +
			'</div>' +
		'</div>';
	$active.innerHTML = html;
}

/* ---------- 玩家列表 ---------- */

function renderList(){
	var players = CORE.players();
	var aid = CORE.activeId();
	if (!players.length){
		$list.innerHTML = '<div class="dm-empty">列表为空</div>';
		return;
	}
	// players 是 CORE.players() 返回的新数组，直接排序不会影响存储中的顺序。
	players.sort(function(a, b){ return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); });
	// 使用 map + join 批量生成卡片，避免逐条 appendChild 造成多次重排。
	var rows = players.map(function(p){
		var st = p.stats || {};
		var isActive = p.id === aid;
		return (
			'<div class="dm-card">' +
				'<div class="dm-player-row">' +
					'<div class="dm-avatar' + (p.name.indexOf('游客') === 0 ? ' guest' : '') + '">' + esc(firstChar(p.name)) + '</div>' +
					'<div class="dm-player-info">' +
						'<div class="dm-player-name">' + esc(p.name) + (st.cleared ? ' <span class="dm-badge dm-badge-clear">已通关</span>' : '') + '</div>' +
						'<div class="dm-player-meta">最高分 ' + (st.bestScore || 0) + ' · 存档 ' + saveCount(p.id) + ' 份 · 最近游玩 ' + esc(CORE.fmtTime(p.lastActiveAt)) + '</div>' +
					'</div>' +
					'<div class="dm-btn-row">' +
						(isActive ? '' : '<button type="button" class="dm-btn dm-btn-small" data-act="switch" data-id="' + esc(p.id) + '">切换</button>') +
						'<button type="button" class="dm-btn dm-btn-ghost dm-btn-small" data-act="rename" data-id="' + esc(p.id) + '">改名</button>' +
						'<button type="button" class="dm-btn dm-btn-danger dm-btn-small" data-act="remove" data-id="' + esc(p.id) + '">删除</button>' +
					'</div>' +
				'</div>' +
			'</div>'
		);
	});
	$list.innerHTML = rows.join('');
}

function render(){
	renderNotice();
	renderActive();
	renderList();
}

/* ---------- 行内改名 ---------- */

var renamingId = null;
/*
 * 行内改名。
 * 做法：找到按钮所在的 .dm-card，在其 .dm-player-info 末尾插入输入框，
 * 不重绘整个列表，因此当前滚动位置和焦点不会丢失。
 */
function startRename(id){
	stopRename();
	var p = CORE.player(id);
	if (!p){ return; }
	renamingId = id;
	// 卡片本身没有 data-id，直接通过“改名按钮 -> 最近卡片”定位，
	// 这样同一套逻辑同时适用于顶部当前玩家卡片和下方玩家列表。
	var btn = $list.querySelector('[data-act="rename"][data-id="' + id + '"]') ||
			   $active.querySelector('[data-act="rename"][data-id="' + id + '"]');
	if (!btn){ return; }
	var card = btn.closest('.dm-card');
	var info = card.querySelector('.dm-player-info');
	var old = document.createElement('div');
	old.innerHTML =
		'<div class="dm-form-row">' +
			'<input class="dm-input dm-rename-input" maxlength="12" value="' + esc(p.name) + '"/>' +
			'<button type="button" class="dm-btn dm-btn-small dm-rename-ok">确定</button>' +
			'<button type="button" class="dm-btn dm-btn-ghost dm-btn-small dm-rename-cancel">取消</button>' +
		'</div>' +
		'<p class="dm-form-error dm-rename-error"></p>';
	info.appendChild(old);
	var input = old.querySelector('.dm-rename-input');
	input.focus();
	input.select();
	old.querySelector('.dm-rename-cancel').addEventListener('click', stopRename);
	old.querySelector('.dm-rename-ok').addEventListener('click', function(){
		var name = input.value;
		var result = CORE.renamePlayer(id, name);
		var errEl = old.querySelector('.dm-rename-error');
		if (result.error){
			errEl.textContent = result.error;
			return;
		}
		stopRename();
		UI.toast('已重命名为「' + result.player.name + '」', 'success');
		render();
	});
	input.addEventListener('keydown', function(e){
		// Enter 提交、Esc 取消，更符合常见表格内编辑习惯。
		if (e.keyCode === 13){ old.querySelector('.dm-rename-ok').click(); }
		if (e.keyCode === 27){ stopRename(); }
	});
}
/* 清理所有行内编辑节点；重复调用安全（无节点时什么也不做）。 */
function stopRename(){
	renamingId = null;
	var remain = document.querySelectorAll('.dm-rename-input');
	Array.prototype.forEach.call(remain, function(el){
		var wrap = el.closest('.dm-form-row');
		if (wrap && wrap.parentNode){ wrap.parentNode.removeChild(wrap); }
	});
	var errs = document.querySelectorAll('.dm-rename-error');
	Array.prototype.forEach.call(errs, function(el){
		if (el.parentNode){ el.parentNode.removeChild(el); }
	});
}

/* ---------- 事件委托 ---------- */

/*
 * 玩家列表使用事件委托：
 * 列表会频繁重绘，若给每个按钮单独绑定监听器，重绘后需要重新绑定且容易泄漏。
 * 这里只在 document 上监听一次，通过 data-act 区分动作。
 */
document.addEventListener('click', function(e){
	var btn = e.target.closest ? e.target.closest('[data-act]') : null;
	if (!btn || !btn.getAttribute('data-act')){ return; }
	var act = btn.getAttribute('data-act');
	var id = btn.getAttribute('data-id');
	if (act === 'rename'){
		startRename(id);
	}else if (act === 'switch'){
		CORE.setActive(id);
		var p = CORE.player(id);
		UI.toast('已切换至「' + (p ? p.name : '') + '」', 'success');
		render();
	}else if (act === 'remove'){
		var player = CORE.player(id);
		if (!player){ return; }
		var count = saveCount(id);
		// 先展示影响范围（玩家名 + 存档数量），用户确认后再真正删除。
		UI.confirm({
			title: '删除玩家「' + player.name + '」？',
			text: '将同时删除该玩家的全部存档（' + count + ' 份），删除后不可恢复。',
			okText: '确认删除',
			danger: true
		}).then(function(yes){
			if (!yes){ return; }
			var result = CORE.removePlayer(id);
			if (result.error){
				UI.toast(result.error, 'error');
			}else{
				UI.toast('已删除玩家「' + player.name + '」', 'success');
			}
			render();
		});
	}
});

$nameForm.addEventListener('submit', function(e){
	// 表单提交是本次交互的唯一入口：点击按钮、按 Enter 都由浏览器统一触发 submit。
	e.preventDefault();
	var checked = validatePlayerName($nameInput.value);
	if (!checked.ok){
		$nameError.textContent = checked.error;
		$nameInput.focus();
		return;
	}
	var result = CORE.createPlayer(checked.value);
	if (result.error){
		$nameError.textContent = result.error;
		$nameInput.focus();
		return;
	}
	$nameError.textContent = '';
	$nameInput.value = '';
	CORE.setActive(result.player.id);
	// 创建后自动切换为当前玩家，符合“创建即使用”的习惯。
	UI.toast('已创建玩家「' + result.player.name + '」', 'success');
	render();
});

/* ---------- 多标签页 / 本页变更同步 ---------- */

// 订阅核心层事件：本页操作与其他标签页的 storage 事件都会触发重新渲染。
CORE.on('players:changed', render);
CORE.on('active:changed', render);
CORE.on('saves:changed', render);

render();
})();
