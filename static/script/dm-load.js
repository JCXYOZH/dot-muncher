/*
 * dm-load.js —— 读档页逻辑：继续当前进度 / 选择存档恢复进游戏 / 转存存档 / 导入存档
 * 依赖：dm-core.js（DM.CORE / DM.UI）
 * 恢复机制：sessionStorage 投放 pendingLoad（自包含负载）→ 跳转游戏页
 *
 * 为什么用 sessionStorage 而不是 URL 参数？
 *   - 存档包含豆子矩阵和幽灵状态，体积约 1.5KB，放 URL 不现实；
 *   - sessionStorage 只在当前标签页有效，读完即删，避免游戏页刷新时重复恢复；
 *   - 负载自带 playerId，游戏页可以校验归属。
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
	var $toolbar = document.getElementById('dm-toolbar');

	/* 所有动态文本（昵称、存档名、备注）拼入 innerHTML 前必须转义。 */
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

	/*
	 * 渲染“继续当前进度”卡片。
	 * 只显示当前玩家自己的检查点；没有检查点则整块不渲染。
	 */
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
		// 损坏档不展示关卡/分数，避免把不可信数据当成真实战绩。
		var meta = save._corrupt
			? '数据校验未通过，已隔离防止加载异常'
			: '第 ' + save.level + ' 关<span class="sep">|</span>得分 ' + save.score +
			'<span class="sep">|</span>生命 ' + save.lives + '<span class="sep">|</span>' + esc(CORE.fmtTime(save.updatedAt || save.createdAt));
		var remarkLine = (!save._corrupt && save.remark)
			? '<div class="dm-save-remark" title="' + esc(save.remark) + '">' + esc(save.remark) + '</div>'
			: '';
		var actions = '<div class="dm-btn-row">';
		if (!save._corrupt){
			// 损坏档只保留“删除”按钮：可清理，但不允许读取/转存。
			actions += '<button type="button" class="dm-btn dm-btn-small" data-act="load" data-id="' + esc(save.id) + '">读取并开始</button>';
			actions += '<button type="button" class="dm-btn dm-btn-ghost dm-btn-small" data-act="copy" data-id="' + esc(save.id) + '">转存</button>';
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
			$playerTag.textContent = '';
			// 未选择玩家时给出明确引导，避免页面只剩一个孤立占位符。
			$list.innerHTML = '<div class="dm-empty">选择玩家后显示存档列表</div>';
			$toolbar.style.display = 'none';
			return;
		}
		$toolbar.style.display = '';
		var st = p.stats || {};
		// 玩家名转义后再拼接固定 HTML 徽章。
		$playerTag.innerHTML = esc(p.name) + (st.cleared ? ' <span class="dm-badge dm-badge-clear">已通关</span>' : '');
		var saves = CORE.saves(p.id);
		var manualSaves = saves.filter(function(s){ return s.slotType !== 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		var autoSaves = saves.filter(function(s){ return s.slotType === 'auto'; })
			.sort(function(a, b){ return (b.updatedAt || 0) - (a.updatedAt || 0); });
		if (!manualSaves.length && !autoSaves.length){
			$list.innerHTML = '<div class="dm-empty">还没有任何存档。<a href="./index.html">去玩一局</a>，通关或离页时会自动存档，或者导入已有存档。</div>';
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

	/* ---------- 导入存档（单份 / 多份，来自存档页导出的 .json） ---------- */

	/*
	 * 批量导入文件。
	 * FileReader 是异步 API，这里用 pending 计数等待全部文件结束，
	 * 再一次性汇总提示，避免连续弹多个 toast。
	 */
	function importFiles(files){
		var p = CORE.active();
		if (!p){
			UI.toast('尚未选择玩家，无法导入', 'error');
			return;
		}
		var agg = { imported: 0, skipped: 0, renamed: 0, bad: 0, invalid: [] };
		var pending = files.length;
		files.forEach(function(file){
			var reader = new FileReader();
			var settled = false;
			function finish(){
				if (settled){ return; }
				settled = true;
				pending -= 1;
				if (pending === 0){
					var msg = '成功导入 ' + agg.imported + ' 份存档';
					if (agg.renamed){ msg += '，' + agg.renamed + ' 份重名已自动改名'; }
					if (agg.skipped){
						msg += '，跳过 ' + agg.skipped + ' 份（无效/自动档/超限）';
						// 最多列出前 3 份明细，既能让用户定位问题，又避免 toast 过长。
						var detail = agg.invalid.slice(0, 3).map(function(item){
							return item.name + '：' + item.reason;
						}).join('；');
						if (detail){ msg += '：' + detail + (agg.invalid.length > 3 ? ' 等' : ''); }
					}
					if (agg.bad){ msg += '，' + agg.bad + ' 个文件无效'; }
					UI.toast(msg, agg.imported ? 'success' : 'error');
					render();
				}
			}
			reader.onload = function(){
				// importData 内部会处理 magic/version/校验和/重名/上限，页面只负责聚合统计。
				var report = CORE.importData(reader.result, p.id);
				if (report.error){
					agg.bad += 1;
				}else{
					agg.imported += report.imported;
					agg.skipped += report.skipped;
					agg.renamed += report.renamed;
					if (report.invalid && report.invalid.length){
						agg.invalid = agg.invalid.concat(report.invalid);
					}
				}
				finish();
			};
			reader.onerror = function(){
				agg.bad += 1;
				finish();
			};
			reader.readAsText(file, 'utf-8');
		});
	}

	document.getElementById('dm-import-btn').addEventListener('click', function(){
		// 触发隐藏的 file input；选择后立即清空 value，允许重复选同一个文件。
		document.getElementById('dm-import-file').click();
	});
	document.getElementById('dm-import-file').addEventListener('change', function(){
		var file = this.files && this.files[0];
		this.value = '';
		if (!file){ return; }
		importFiles([file]);
	});

	document.getElementById('dm-import-multi-btn').addEventListener('click', function(){
		document.getElementById('dm-import-multi-file').click();
	});
	document.getElementById('dm-import-multi-file').addEventListener('change', function(){
		var files = Array.prototype.slice.call(this.files || []);
		this.value = '';
		if (!files.length){ return; }
		importFiles(files);
	});

	/* ---------- 事件 ---------- */

	/*
	 * 读档页事件委托。
	 * 统一处理 continue / load / copy / remove，四个动作都依赖当前玩家与存档 ID。
	 */
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
			// 将检查点包装成与存档同构的负载；游戏页的 dmApplySave 不关心来源。
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
			// 投放后跳转游戏页；takePending 会在游戏初始化后消费并删除。
			CORE.setPending({ playerId: p.id, save: save });
			window.location.href = './index.html';
		}else if (act === 'copy'){
			// 转存自动档时会变成手动档，避免被 3 槽滚动淘汰。
			var dup = CORE.duplicateSave(p.id, id);
			if (dup.error){
				UI.toast(dup.error, 'error');
			}else{
				UI.toast('已转存为「' + dup.save.name + '」', 'success');
			}
			render();
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
		}
	});

	/* ---------- 多标签页 / 本页变更同步 ---------- */

	// 任一端修改玩家/存档/检查点，三个列表都会自动刷新。
	CORE.on('players:changed', render);
	CORE.on('active:changed', render);
	CORE.on('saves:changed', render);
	CORE.on('checkpoint:changed', render);

	render();
})();
