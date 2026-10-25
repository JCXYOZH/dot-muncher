/*
 * dm-load.js —— 读档页逻辑：继续当前进度 / 选择存档恢复进游戏
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 * 恢复机制：sessionStorage 投放 pendingLoad（自包含负载）→ 跳转游戏页
 */
(function(){
	'use strict';

	var CORE = window.DM && DM.CORE;
	var UI = window.DM && DM.UI;
	if (!CORE || !UI){ return; }

	var $notice = document.getElementById('dm-notice');
	var $session = document.getElementById('dm-session');
	var $list = document.getElementById('dm-list');
	var $playerTag = document.getElementById('dm-player-tag');

	function esc(text){
		return String(text == null ? '' : text).replace(/[&<>"']/g, function(c){
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/* ---------- 提示条 ---------- */

	function renderNotice(){
		var html = '';
		if (!CORE.available){
			html = '<div class="dm-notice dm-notice-error">当前浏览器存储不可用（可能处于隐身模式或已禁用），无法读取存档。</div>';
		}else if (!CORE.active()){
			html = '<div class="dm-notice">尚未选择玩家。<a href="./player.html">去创建玩家</a>，或<a href="./index.html">开始游戏</a>自动创建游客。</div>';
		}
		$notice.innerHTML = html;
	}

	/* ---------- 继续当前进度（检查点卡片） ---------- */

	function renderSession(){
		var p = CORE.active();
		if (!p){
			$session.innerHTML = '';
			return;
		}
		var cp = CORE.checkpoint();
		if (!cp || cp.playerId !== p.id){
			$session.innerHTML = '';
			return;
		}
		$session.innerHTML =
			'<div class="dm-card highlight">' +
			'<div class="dm-save-row">' +
			'<div class="dm-save-info">' +
			'<div class="dm-save-name">继续当前进度 <span class="dm-badge dm-badge-manual">' + esc(p.name) + '</span></div>' +
			'<div class="dm-save-meta">第 ' + cp.level + ' 关<span class="sep">|</span>得分 ' + cp.score +
			'<span class="sep">|</span>生命 ' + cp.lives + '<span class="sep">|</span>记录于 ' + esc(CORE.fmtTime(cp.updatedAt)) + '</div>' +
			'</div>' +
			'<div class="dm-btn-row">' +
			'<button type="button" class="dm-btn" data-act="continue">继续游戏</button>' +
			'</div>' +
			'</div>' +
			'<p class="dm-form-hint">接上次离开时的精确状态（豆子残余、位置一并还原），恢复后进入暂停，按 [空格] 开始。</p>' +
			'</div>';
	}

	/* ---------- 存档列表 ---------- */

	function saveRow(save, isAuto){
		var badges = '';
		if (save._corrupt){
			badges = '<span class="dm-badge dm-badge-corrupt">已损坏</span>';
		}else{
			badges = isAuto ? '<span class="dm-badge dm-badge-auto">自动</span>' : '<span class="dm-badge dm-badge-manual">手动</span>';
			if (save.snapshot){ badges += ' <span class="dm-badge">中途快照</span>'; }
			else { badges += ' <span class="dm-badge">关卡起点</span>'; }
		}
		var meta = save._corrupt
			? '数据校验未通过，已隔离防止加载异常'
			: '第 ' + save.level + ' 关<span class="sep">|</span>得分 ' + save.score +
			'<span class="sep">|</span>生命 ' + save.lives + '<span class="sep">|</span>' + esc(CORE.fmtTime(save.updatedAt || save.createdAt));
		var remarkLine = (!save._corrupt && save.remark)
			? '<div class="dm-save-remark" title="' + esc(save.remark) + '">' + esc(save.remark) + '</div>'
			: '';
		var actions = '<div class="dm-btn-row">';
		if (!save._corrupt){
			actions += '<button type="button" class="dm-btn dm-btn-small" data-act="load" data-id="' + esc(save.id) + '">读取并开始</button>';
		}
		actions += '<button type="button" class="dm-btn dm-btn-ghost dm-btn-small" data-act="export-one" data-id="' + esc(save.id) + '">导出</button>';
		actions += '<button type="button" class="dm-btn dm-btn-danger dm-btn-small" data-act="remove" data-id="' + esc(save.id) + '">删除</button>';
		actions += '</div>';
		return (
			'<div class="dm-card' + (save._corrupt ? ' dm-corrupt' : '') + '">' +
			'<div class="dm-save-row">' +
			'<div class="dm-save-info">' +
			'<div class="dm-save-name">' + esc(save.name || '未命名') + ' ' + badges + '</div>' +
			'<div class="dm-save-meta">' + meta + '</div>' +
			remarkLine +
			'</div>' +
			actions +
			'</div>' +
			'</div>'
		);
	}

	function renderList(){
		var p = CORE.active();
		if (!p){
			$playerTag.textContent = '';
			$list.innerHTML = '<div class="dm-empty">-</div>';
			return;
		}
		var st = p.stats || {};
		$playerTag.innerHTML = esc(p.name) + (st.cleared ? ' <span class="dm-badge dm-badge-clear">已通关</span>' : '');
		var saves = CORE.saves(p.id);
		var manualSaves = saves.filter(function(s){ return s.slotType !== 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		var autoSaves = saves.filter(function(s){ return s.slotType === 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		if (!manualSaves.length && !autoSaves.length){
			$list.innerHTML = '<div class="dm-empty">还没有任何存档。<a href="./index.html">去玩一局</a>，通关或离页时会自动存档。</div>';
			return;
		}
		$list.innerHTML = manualSaves.concat(autoSaves).map(function(s){
			return saveRow(s, s.slotType === 'auto');
		}).join('');
	}

	function render(){
		renderNotice();
		renderSession();
		renderList();
	}

	/* ---------- 导出单份 ---------- */

	function download(filename, data){
		try{
			var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			var url = URL.createObjectURL(blob);
			var a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			setTimeout(function(){
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			}, 100);
		}catch(e){
			UI.toast('导出失败：浏览器不支持文件下载', 'error');
		}
	}
	function safeFilename(name){
		return String(name || '玩家').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
	}

	/* ---------- 事件 ---------- */

	document.addEventListener('click', function(e){
		var btn = e.target.closest ? e.target.closest('[data-act]') : null;
		if (!btn || !btn.getAttribute('data-act')){ return; }
		var act = btn.getAttribute('data-act');
		var p = CORE.active();
		if (!p){ return; }

		if (act === 'continue'){
			var cp = CORE.checkpoint();
			if (!cp || cp.playerId !== p.id){
				UI.toast('当前进度已失效', 'error');
				render();
				return;
			}
			CORE.setPending({
				playerId: p.id,
				save: {
					name: '当前进度',
					slotType: 'manual',
					level: cp.level,
					score: cp.score,
					lives: cp.lives,
					isCheated: !!cp.isCheated,
					snapshot: cp.snapshot || null
				}
			});
			window.location.href = './index.html';
			return;
		}

		var id = btn.getAttribute('data-id');
		var save = CORE.save(p.id, id);
		if (!save){ return; }

		if (act === 'load'){
			if (save._corrupt){
				UI.toast('存档已损坏，无法读取', 'error');
				return;
			}
			CORE.setPending({ playerId: p.id, save: save });
			window.location.href = './index.html';
		}else if (act === 'remove'){
			UI.confirm({
				title: '删除存档「' + (save.name || '') + '」？',
				text: '删除后不可恢复。',
				okText: '确认删除',
				danger: true
			}).then(function(yes){
				if (!yes){ return; }
				var result = CORE.removeSave(p.id, id);
				if (result.error){
					UI.toast(result.error, 'error');
				}else{
					UI.toast('已删除存档「' + (save.name || '') + '」', 'success');
				}
				render();
			});
		}else if (act === 'export-one'){
			download('dot-muncher_' + safeFilename(save.name) + '.json', {
				magic: 'DOT-MUNCHER-SAVE',
				version: CORE.SCHEMA_VERSION,
				exportedAt: Date.now(),
				player: { id: p.id, name: p.name },
				saves: [save]
			});
			UI.toast('已导出「' + (save.name || '') + '」', 'success');
		}
	});

	/* ---------- 多标签页 / 本页变更同步 ---------- */

	CORE.on('players:changed', render);
	CORE.on('active:changed', render);
	CORE.on('saves:changed', render);
	CORE.on('checkpoint:changed', render);

	render();
})();
