/*
 * projects.js —— 首页底部“更多开源项目”快捷入口
 *
 * 数据驱动：项目清单集中维护在 list 中，渲染时统一生成链接。
 * 这里使用 DOM API 而不是 document.write：
 *   - 不会在脚本异步/延迟执行时覆盖整个文档；
 *   - 链接文字通过 textContent 写入，天然避免 HTML 注入；
 *   - 样式统一放在 index.css，便于缓存与维护。
 */
(function(){
	let list = [{
		'url':'https://github.com/JCXYOZH/teachai-agent-web',
		'name':'AI 教师'
	},{
		'url':'https://github.com/JCXYOZH/image-to-character',
		'name':'图片转字符'
	},{
		'url':'https://github.com/JCXYOZH/wxpay_monitor',
		'name':'微信监控回调'
	},{
		'url':'https://github.com/JCXYOZH/rob-red-envelope',
		'name':'抢红包'
	},{
		'url':'https://github.com/JCXYOZH/identify-front',
		'name':'视觉识别'
	},{
		'url':'https://github.com/JCXYOZH/coursera-front',
		'name':'知新堂'
	},{
		'url':'https://github.com/JCXYOZH/information-walls-front',
		'name':'表白墙'
	},{
		'url':'https://github.com/JCXYOZH/coursera-bloc',
		'name':'温故阁'
	},{
		'url':'https://github.com/JCXYOZH/comfortable-living-front',
		'name':'安舒居'
	},{
		'url':'https://github.com/JCXYOZH/manpower-management-system',
		'name':'人力管理'
	},{
		'url':'https://github.com/JCXYOZH/home',
		'name':'个人主页'
	},{
		'url':'https://github.com/JCXYOZH/data-analysis-collection',
		'name':'分析项目'
	},{
		'url':'https://github.com/JCXYOZH/crawlerCollection',
		'name':'爬虫项目合集'
	},{
		'url':'https://github.com/JCXYOZH/smart-health',
		'name':'鸿蒙智能健康助手'
	},{
		'url':'https://github.com/JCXYOZH/book-information-management-system',
		'name':'图书管理系统'
	},{
		'url':'https://github.com/JCXYOZH/dot-muncher',
		'name':'吃豆游戏'
	}];
	// 构建 DOM：外层容器
	var box = document.createElement('div');
	box.className = 'mod-projects';

	// 标题行
	var head = document.createElement('div');
	head.className = 'hd';
	var more = document.createElement('a');
	more.href = './project.html';
	more.textContent = '😉 更多开源项目';
	head.appendChild(more);
	box.appendChild(head);

	// 链接列表
	var body = document.createElement('div');
	body.className = 'bd';
	var ul = document.createElement('ul');
	// map 生成 <li>，再用 appendChild 逐个插入，避免把项目名拼进 innerHTML。
	list.map(function(item){
		var li = document.createElement('li');
		var a = document.createElement('a');
		a.href = item.url;
		a.target = '_blank';
		a.rel = 'noopener';
		a.textContent = item.name;
		li.appendChild(a);
		return li;
	}).forEach(function(li){ ul.appendChild(li); });
	body.appendChild(ul);
	box.appendChild(body);

	// document.currentScript 指向本 <script>，把卡片插到它后面（内容区末尾）。
	var script = document.currentScript || (function(){
		var all = document.getElementsByTagName('script');
		return all[all.length - 1];
	})();
	if (script && script.parentNode){
		script.parentNode.insertBefore(box, script.nextSibling);
	}
})();
