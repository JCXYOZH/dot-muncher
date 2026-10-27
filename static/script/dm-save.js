/*
 * dm-save.js —— 存档页逻辑：表单存档 / 覆盖 / 删除 / 导出
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 * 数据源：游戏页实时写入的检查点（localStorage dm.checkpoint）
 *
 * 页面职责：
 *   1. 展示“当前进度”并把手动档保存动作接到检查点；
 *   2. 分别渲染手动档 / 自动档，自动档不提供覆盖按钮；
 *   3. 提供单档导出、全部导出；
 *   4. 删除、覆盖等危险操作统一走确认弹层。
 *
 * 数据流：
 *   dm.checkpoint --(myCheckpoint)--> 表单 --(DM.CORE.addSave)--> dm.saves.<pid>
 *   dm.saves.<pid> --(listSaves)--> saveRow() -> innerHTML
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
	var $exportBtn = document.getElementById('dm-export');

	/* 此处再次强调：这里渲染的 name/remark 都来自用户输入或导入文件，必须转义。 */
	function esc(text){
		return String(text == null ? '' : text).replace(/[&<>"']/g, function(c){
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	/*
	 * 取当前玩家自己的检查点。
	 * 场景：A 玩家玩到一半，切到 B 玩家；此时存档页不应把 A 的进度显示给 B。
	 */
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

	/*
	 * 渲染“当前进度”卡片。
	 * 没有检查点时只显示空状态，不显示不可用的保存表单，减少无效点击。
	 */
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
		// 名称留空时使用此建议值；placeholder 让用户知道默认会存成什么。
		var suggested = '第' + cp.level + '关 · ' + cp.score + '分';
		$progress.innerHTML =
			'<div class="dm-card highlight">' +
			'<div class="dm-progress">' +
			'<div class="dm-progress-info">' +
			'<div class="dm-player-name">当前进度 <span class="dm-badge dm-badge-manual">' + esc(p.name) + '</span></div>' +
			'<div class="dm-save-meta">第 ' + cp.level + ' 关<span class="sep">|</span>得分 ' + cp.score +
			'<span class="sep">|</span>生命 ' + cp.lives + '<span class="sep">|</span>更新于 ' + esc(CORE.fmtTime(cp.updatedAt)) + '</div>' +
			'</div>' +
			'<form class="dm-progress-form" id="dm-save-form" novalidate>' +
			'<label class="dm-visually-hidden" for="dm-save-name">存档名称</label>' +
			'<input id="dm-save-name" class="dm-input" maxlength="12" autocomplete="off" placeholder="' + esc(suggested) + '"/>' +
			'<label class="dm-visually-hidden" for="dm-save-remark">存档备注</label>' +
			'<input id="dm-save-remark" class="dm-input dm-input-remark" maxlength="60" autocomplete="off" placeholder="备注（选填）"/>' +
			'<button type="submit" class="dm-btn" id="dm-save-submit">保存进度</button>' +
			'</form>' +
			'</div>' +
			'<p class="dm-form-error" id="dm-save-error"></p>' +
			'<p class="dm-form-hint">将以关卡中途的精确状态存档（豆子残余、位置、幽灵状态一并保留）。重名存档将询问是否覆盖。</p>' +
			'</div>';
		var input = document.getElementById('dm-save-name');
		var remark = document.getElementById('dm-save-remark');
		var form = document.getElementById('dm-save-form');
		// submit 同时覆盖鼠标点击与键盘 Enter，避免两个入口各写一套逻辑造成状态不一致。
		form.addEventListener('submit', function(e){
			e.preventDefault();
			doSave(input.value, remark.value);
		});
	}

	/*
	 * 保存当前检查点为手动档。
	 * @param {string} rawName 输入框中的名称（可为空，空则使用建议名）
	 * @param {string} rawRemark 备注（选填）
	 *
	 * 流程：取检查点 -> 规范化名称 -> 查重 -> 有重名则确认覆盖 -> 新增/更新。
	 */
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
		// 只对“有效的手动档”做同名判断；损坏档和自动档不参与覆盖逻辑。
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

	/*
	 * 生成单张存档卡片。
	 * @param {Object} save 核心层返回的存档记录
	 * @param {boolean} isAuto 是否自动档
	 * @return {string} HTML 字符串
	 */
	function saveRow(save, isAuto){
		var badges = '';
		if (save._corrupt){
			badges = '<span class="dm-badge dm-badge-corrupt">已损坏</span>';
		}else{
			badges = isAuto ? '<span class="dm-badge dm-badge-auto">自动</span>' : '<span class="dm-badge dm-badge-manual">手动</span>';
			if (save.snapshot){ badges += ' <span class="dm-badge">中途快照</span>'; }
			else { badges += ' <span class="dm-badge">关卡起点</span>'; }
		}
		// 损坏档只显示原因，不显示关卡/得分等可能不可信的数据。
		var meta = save._corrupt
			? '数据校验未通过，已隔离防止加载异常'
			: '第 ' + save.level + ' 关<span class="sep">|</span>得分 ' + save.score +
			'<span class="sep">|</span>生命 ' + save.lives + '<span class="sep">|</span>' + esc(CORE.fmtTime(save.updatedAt || save.createdAt));
		var remarkLine = (!save._corrupt && save.remark)
			? '<div class="dm-save-remark" title="' + esc(save.remark) + '">' + esc(save.remark) + '</div>'
			: '';
		var actions = '<div class="dm-btn-row">';
		// 自动档由系统滚动管理，不提供“覆盖”按钮；手动档可以覆盖。
		if (!save._corrupt && !isAuto){
			actions += '<button type="button" class="dm-btn dm-btn-small" data-act="overwrite" data-id="' + esc(save.id) + '">覆盖</button>';
		}
		// 损坏档只允许删除；把无法恢复的数据导出到其他设备没有意义。
		if (!save._corrupt){
			actions += '<button type="button" class="dm-btn dm-btn-ghost dm-btn-small" data-act="export-one" data-id="' + esc(save.id) + '">导出</button>';
		}
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
			// 未选择玩家时不展示无意义的占位符，直接说明下一步动作。
			$manual.innerHTML = '<div class="dm-empty">选择玩家后显示手动存档</div>';
			$auto.innerHTML = '<div class="dm-empty">选择玩家后显示自动存档</div>';
			$manualCount.textContent = '';
			$toolbar.style.display = 'none';
			$exportBtn.textContent = '导出全部存档';
			$exportBtn.disabled = true;
			return;
		}
		$toolbar.style.display = '';
		var saves = CORE.saves(p.id);
		// filter + sort：手动与自动分离，各自按更新时间倒序；
		// 手动档上限只统计 slotType !== 'auto' 的记录。
		var manualSaves = saves.filter(function(s){ return s.slotType !== 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		var autoSaves = saves.filter(function(s){ return s.slotType === 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		$manualCount.textContent = manualSaves.length + ' / ' + CORE.MANUAL_MAX;
		// 工具栏按钮只统计有效档，和 exportData 的过滤规则保持一致。
		var exportableCount = saves.filter(function(s){ return !s._corrupt; }).length;
		$exportBtn.textContent = '导出全部存档（' + exportableCount + ' 份）';
		$exportBtn.disabled = exportableCount === 0;
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
			// Blob + ObjectURL 让纯前端也能导出文件，不依赖后端接口。
			var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
			var url = URL.createObjectURL(blob);
			var a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			setTimeout(function(){
				// 下载触发后立即 revoke 可能导致部分浏览器失败，延迟 100ms 更稳。
				document.body.removeChild(a);
				URL.revokeObjectURL(url);
			}, 100);
		}catch(e){
			UI.toast('导出失败：浏览器不支持文件下载', 'error');
		}
	}
	/* 文件名安全化：去掉 Windows/macOS 非法字符，并限制长度。 */
	function safeFilename(name){
		return String(name || '玩家').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
	}

	/* ---------- 事件 ---------- */

	/*
	 * 存档卡片事件委托。
	 * 每张卡片的按钮只带 data-act / data-id，统一在这里查存档并处理，
	 * 避免每次 render 后给新节点重复绑定 click。
	 */
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
			// 覆盖使用的是“此刻的检查点”，不是当前存档内容。
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
			if (save._corrupt){
				UI.toast('该存档已损坏，无法导出', 'error');
				return;
			}
			// 单档导出仍使用统一 magic/version 结构，读档页可直接导入。
			download('dot-muncher_' + safeFilename(save.name) + '.json', {
				magic: 'DOT-MUNCHER-SAVE',
				version: CORE.SCHEMA_VERSION,
				exportedAt: Date.now(),
				player: { id: p.id, name: p.name },
				saves: [save]
			});
			UI.toast('已导出单份存档「' + (save.name || '') + '」', 'success');
		}
	});

	$exportBtn.addEventListener('click', function(){
		var p = CORE.active();
		if (!p){ return; }
		var payload = CORE.exportData(p.id);
		if (!payload.saves.length){
			UI.toast('暂无可导出的有效存档', 'error');
			return;
		}
		download('dot-muncher_' + safeFilename(p.name) + '_存档.json', payload);
		UI.toast('已导出全部有效存档（' + payload.saves.length + ' 份）', 'success');
	});

	/* ---------- 多标签页 / 本页变更同步 ---------- */

	// 存储事件由 dm-core 转成业务事件；本页只需要重新渲染。
	CORE.on('players:changed', render);
	CORE.on('active:changed', render);
	CORE.on('saves:changed', render);
	CORE.on('checkpoint:changed', render);

	render();
})();
