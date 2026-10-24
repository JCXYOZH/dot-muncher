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
	let url = location['hostname']+location['pathname'];
	document.write(`
		<div class="mod-projects">
			<div class="hd">
				<a href="./project.html" target="_blank">😉 更多开源项目</a>
			</div>
			<div class="bd">
				<ul>
					`+(function(){
						return list.map(function(item){
							return `<li><a href="${item['url']}" target="_blank">${item['name']}</a></li>`;
						}).join('');
					})()+`
				</ul>
			</div>
		</div>
		<style type="text/css">
			.mod-projects{max-width:1000px;margin:0 auto 20px;padding: 30px 0;text-align:center;font-size:15px;}
			.mod-projects a{text-decoration:none;color:#6e7781;}
			.mod-projects .hd{line-height:40px;font-size:20px;font-weight:bold;color:#3f4349;}
			.mod-projects .hd a{color:#3f4349;}
			.mod-projects ul{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;list-style: none;margin:0;padding:0 2px;}
			.mod-projects li a{display:block;line-height:40px;background: rgba(0,0,0,0.03);border-radius:5px;color:#6e7781;}
			.mod-projects li a:hover{background: #eef2f9}
			.mod-spread{max-width:960px;margin:0 auto 20px;padding: 30px 0;text-align:center;}
			.mod-spread .bd img{max-width:100%;height: auto;}
			@media screen and (max-width: 800px){
				.mod-projects ul{grid-template-columns:repeat(2,1fr);}
			}
		</style>
	`);
})();
