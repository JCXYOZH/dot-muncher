(function(){
	let list = [{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
	},{
		'url':'xx',
		'name':'xx'
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
