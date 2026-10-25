/*
 * dm-player.js —— 玩家页逻辑：创建 / 切换 / 改名 / 删除 + 战绩统计
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 */
(function(){
'use strict';

var CORE = window.DM && DM.CORE;
var UI = window.DM && DM.UI;
if (!CORE || !UI){ return; }

var $notice = document.getElementById('dm-notice');
var $active = document.getElementById('dm-active');
var $list = document.getElementById('dm-list');
var $nameInput = document.getElementById('dm-new-name');
var $nameError = document.getElementById('dm-new-error');
var $nameSubmit = document.getElementById('dm-new-submit');

function esc(text){
	return String(text == null ? '' : text).replace(/[&<>"']/g, function(c){
		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
	});
}
function firstChar(name){
	return String(name || '玩').charAt(0);
}
function saveCount(pid){
	try{
		return CORE.saves(pid).filter(function(s){ return !s._corrupt; }).length;
	}catch(e){
		return 0;
	}
}

/* ---------- 提示条 ---------- */

function renderNotice(){
	var html = '';
	if (!CORE.available){
		html = '<div class="dm-notice dm-notice-error">当前浏览器存储不可用（可能处于隐身模式或已禁用），无法保存玩家与存档数据。</div>';
	}else{
		var players = CORE.players();
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
	players.sort(function(a, b){ return (b.lastActiveAt || 0) - (a.lastActiveAt || 0); });
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
function startRename(id){
	stopRename();
	var p = CORE.player(id);
	if (!p){ return; }
	renamingId = id;
	var nameEl = $list.querySelector('.dm-card[data-id="' + id + '"] .dm-player-name') ||
				 $active.querySelector('.dm-card[data-id="' + id + '"] .dm-player-name');
	// 列表卡片需要 data-id 标记；此处从按钮定位到所在卡片
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
		if (e.keyCode === 13){ old.querySelector('.dm-rename-ok').click(); }
		if (e.keyCode === 27){ stopRename(); }
	});
}
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

$nameSubmit.addEventListener('click', function(){
	var name = $nameInput.value;
	var result = CORE.createPlayer(name);
	if (result.error){
		$nameError.textContent = result.error;
		return;
	}
	$nameError.textContent = '';
	$nameInput.value = '';
	CORE.setActive(result.player.id);
	UI.toast('已创建玩家「' + result.player.name + '」', 'success');
	render();
});
$nameInput.addEventListener('keydown', function(e){
	if (e.keyCode === 13){ $nameSubmit.click(); }
});

/* ---------- 多标签页 / 本页变更同步 ---------- */

CORE.on('players:changed', render);
CORE.on('active:changed', render);
CORE.on('saves:changed', render);

render();
})();
