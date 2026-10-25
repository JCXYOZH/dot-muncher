/*
 * dm-save.js —— 存档页逻辑：表单存档 / 覆盖 / 删除 / 导出
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 * 数据源：游戏页实时写入的检查点（localStorage dm.checkpoint）
 */
(function(){
	'use strict';

	var CORE = window.DM && DM.CORE;
	var UI = window.DM && DM.UI;
	if (!CORE || !UI){ return; }

	var $notice = document.getElementById('dm-notice');
	var $progress = document.getElementById('dm-progress');
	var $manual = document.getElementById('dm-manual');
	var $manualCount = document.getElementById('dm-manual-count');
	var $auto = document.getElementById('dm-auto');
	var $toolbar = document.getElementById('dm-toolbar');

	function esc(text){
		return String(text == null ? '' : text).replace(/[&<>"']/g, function(c){
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function myCheckpoint(){
		var cp = CORE.checkpoint();
		var p = CORE.active();
		if (!cp || !p || cp.playerId !== p.id){ return null; }
		return cp;
	}

	/* ---------- 提示条 ---------- */

	function renderNotice(){
		var html = '';
		if (!CORE.available){
			html = '<div class="dm-notice dm-notice-error">当前浏览器存储不可用（可能处于隐身模式或已禁用），无法保存存档。</div>';
		}else if (!CORE.active()){
			html = '<div class="dm-notice">尚未选择玩家。<a href="./player.html">去创建玩家</a>，或<a href="./index.html">开始游戏</a>自动创建游客。</div>';
		}
		$notice.innerHTML = html;
	}

	/* ---------- 当前进度卡片（存档表单） ---------- */

	function renderProgress(){
		var p = CORE.active();
		if (!p){
			$progress.innerHTML = '';
			return;
		}
		var cp = myCheckpoint();
		if (!cp){
			$progress.innerHTML =
				'<div class="dm-card">' +
				'<div class="dm-empty">暂无可保存的游戏进度。<br/>先<a href="./index.html">去玩一局</a>，游戏中会实时记录进度，回到本页即可保存。</div>' +
				'</div>';
			return;
		}
		var suggested = '第' + cp.level + '关 · ' + cp.score + '分';
		$progress.innerHTML =
			'<div class="dm-card highlight">' +
			'<div class="dm-progress">' +
			'<div class="dm-progress-info">' +
			'<div class="dm-player-name">当前进度 <span class="dm-badge dm-badge-manual">' + esc(p.name) + '</span></div>' +
			'<div class="dm-save-meta">第 ' + cp.level + ' 关<span class="sep">|</span>得分 ' + cp.score +
			'<span class="sep">|</span>生命 ' + cp.lives + '<span class="sep">|</span>更新于 ' + esc(CORE.fmtTime(cp.updatedAt)) + '</div>' +
			'</div>' +
			'<div class="dm-progress-form">' +
			'<input id="dm-save-name" class="dm-input" maxlength="12" placeholder="' + esc(suggested) + '"/>' +
			'<input id="dm-save-remark" class="dm-input dm-input-remark" maxlength="60" placeholder="备注（选填）"/>' +
			'<button type="button" class="dm-btn" id="dm-save-submit">保存进度</button>' +
			'</div>' +
			'</div>' +
			'<p class="dm-form-error" id="dm-save-error"></p>' +
			'<p class="dm-form-hint">将以关卡中途的精确状态存档（豆子残余、位置、幽灵状态一并保留）。重名存档将询问是否覆盖。</p>' +
			'</div>';
		var input = document.getElementById('dm-save-name');
		var remark = document.getElementById('dm-save-remark');
		var submit = document.getElementById('dm-save-submit');
		submit.addEventListener('click', function(){ doSave(input.value, remark.value); });
		input.addEventListener('keydown', function(e){
			if (e.keyCode === 13){ submit.click(); }
		});
		remark.addEventListener('keydown', function(e){
			if (e.keyCode === 13){ submit.click(); }
		});
	}

	function doSave(rawName, rawRemark){
		var cp = myCheckpoint();
		if (!cp){
			UI.toast('没有可保存的游戏进度', 'error');
			return;
		}
		var p = CORE.active();
		var name = CORE.normalizeName(rawName);
		if (!name){
			name = '第' + cp.level + '关 · ' + cp.score + '分';
		}
		var $error = document.getElementById('dm-save-error');
		var data = {
			name: name,
			slotType: 'manual',
			level: cp.level,
			score: cp.score,
			lives: cp.lives,
			isCheated: !!cp.isCheated,
			remark: rawRemark || '',
			snapshot: cp.snapshot || null
		};
		var dup = CORE.saves(p.id).filter(function(s){
			return !s._corrupt && s.slotType !== 'auto' && s.name === name;
		})[0];
		if (dup){
			UI.confirm({
				title: '覆盖存档「' + name + '」？',
				text: '已存在同名存档（第 ' + dup.level + ' 关 · ' + dup.score + ' 分），覆盖后旧内容不可恢复。',
				okText: '覆盖保存'
			}).then(function(yes){
				if (!yes){ return; }
				var result = CORE.updateSave(p.id, dup.id, data);
				if (result.error){
					UI.toast(result.error, 'error');
				}else{
					UI.toast('已覆盖存档「' + name + '」', 'success');
					render();
				}
			});
			return;
		}
		var result = CORE.addSave(p.id, data);
		if (result.error){
			if ($error){ $error.textContent = result.error; }
			UI.toast(result.error, 'error');
			return;
		}
		if ($error){ $error.textContent = ''; }
		UI.toast('已保存存档「' + name + '」', 'success');
		render();
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
		if (!save._corrupt && !isAuto){
			actions += '<button type="button" class="dm-btn dm-btn-small" data-act="overwrite" data-id="' + esc(save.id) + '">覆盖</button>';
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
			$manual.innerHTML = '<div class="dm-empty">-</div>';
			$auto.innerHTML = '<div class="dm-empty">-</div>';
			$manualCount.textContent = '';
			$toolbar.style.display = 'none';
			return;
		}
		$toolbar.style.display = '';
		var saves = CORE.saves(p.id);
		var manualSaves = saves.filter(function(s){ return s.slotType !== 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		var autoSaves = saves.filter(function(s){ return s.slotType === 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		$manualCount.textContent = manualSaves.length + ' / ' + CORE.MANUAL_MAX;
		$manual.innerHTML = manualSaves.length
			? manualSaves.map(function(s){ return saveRow(s, false); }).join('')
			: '<div class="dm-empty">暂无手动存档</div>';
		$auto.innerHTML = autoSaves.length
			? autoSaves.map(function(s){ return saveRow(s, true); }).join('')
			: '<div class="dm-empty">暂无自动存档</div>';
	}

	function render(){
		renderNotice();
		renderProgress();
		renderList();
	}

	/* ---------- 导出 / 导入 / 文件下载 ---------- */

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
		var id = btn.getAttribute('data-id');
		var p = CORE.active();
		if (!p){ return; }
		var save = CORE.save(p.id, id);
		if (!save){ return; }

		if (act === 'remove'){
			UI.confirm({
				title: '删除存档「' + (save.name || '') + '」？',
				text: '删除后不可恢复。' + (save.slotType === 'auto' ? '该自动槽位将在下次自动存档时重新使用。' : ''),
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
		}else if (act === 'overwrite'){
			var cp = myCheckpoint();
			if (!cp){
				UI.toast('当前没有进行中的游戏进度，无法覆盖', 'error');
				return;
			}
			UI.confirm({
				title: '覆盖存档「' + (save.name || '') + '」？',
				text: '将用当前进度（第 ' + cp.level + ' 关 · ' + cp.score + ' 分）替换该存档内容。',
				okText: '覆盖'
			}).then(function(yes){
				if (!yes){ return; }
				var result = CORE.updateSave(p.id, id, {
					name: save.name,
					slotType: save.slotType,
					level: cp.level,
					score: cp.score,
					lives: cp.lives,
					isCheated: !!cp.isCheated,
					remark: save.remark || '',
					snapshot: cp.snapshot || null
				});
				if (result.error){
					UI.toast(result.error, 'error');
				}else{
					UI.toast('已覆盖存档「' + save.name + '」', 'success');
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

	document.getElementById('dm-export').addEventListener('click', function(){
		var p = CORE.active();
		if (!p){ return; }
		download('dot-muncher_' + safeFilename(p.name) + '_存档.json', CORE.exportData(p.id));
		UI.toast('已导出全部存档（' + p.name + '）', 'success');
	});

	/* ---------- 多标签页 / 本页变更同步 ---------- */

	CORE.on('players:changed', render);
	CORE.on('active:changed', render);
	CORE.on('saves:changed', render);
	CORE.on('checkpoint:changed', render);

	render();
})();
