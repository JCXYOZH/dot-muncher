'use strict';

/*
 * 小型游戏引擎
 *
 * 设计目标：
 *   - 不依赖第三方库，使用 Canvas 2D + requestAnimationFrame 驱动；
 *   - 用 Stage（布景）组织启动页 / 12 个关卡 / 结算页；
 *   - 用 Map（地图）描述墙、豆子、坐标转换与 BFS 寻路；
 *   - 用 Item（活动对象）描述玩家、幽灵和纯绘制型文本/图标。
 *
 * 一个 Stage 内可以有多张 Map（墙、豆子）和多个 Item（玩家、幽灵、HUD 文本）。
 * 引擎只负责“何时 update / 何时 draw”，具体规则全部由 index.js 注入。
 */

// requestAnimationFrame polyfill：兼容旧浏览器与 iOS 6 的异常实现。
if (!Date.now)
Date.now = function() { return new Date().getTime(); };
(function() {
    'use strict';
    var vendors = ['webkit', 'moz'];
    for (var i = 0; i < vendors.length && !window.requestAnimationFrame; ++i) {
        var vp = vendors[i];
        window.requestAnimationFrame = window[vp+'RequestAnimationFrame'];
        window.cancelAnimationFrame = (window[vp+'CancelAnimationFrame'] || window[vp+'CancelRequestAnimationFrame']);
    }
    if (/iP(ad|hone|od).*OS 6/.test(window.navigator.userAgent) // iOS6 is buggy
    || !window.requestAnimationFrame || !window.cancelAnimationFrame) {
        var lastTime = 0;
        window.requestAnimationFrame = function(callback) {
            var now = Date.now();
            var nextTime = Math.max(lastTime + 16, now);
            return setTimeout(function() { callback(lastTime = nextTime); },
            nextTime - now);
        };
        window.cancelAnimationFrame = clearTimeout;
    }
}());

/*
 * 游戏主类。
 * @param {string} id canvas 元素 ID
 * @param {Object} params 可覆盖 width / height
 *
 * 内部状态：
 *   _stages  所有布景
 *   _events  事件注册表，key 形如 s<stageIndex>i<itemId>
 *   _index   当前布景索引
 *   _hander  requestAnimationFrame 返回句柄
 */
function Game(id,params){
    var _ = this;
    var settings = {
        width:960,						//画布宽度
        height:640						//画布高度
    };
    Object.assign(_,settings,params);
    var $canvas = document.getElementById(id);
    $canvas.width = _.width;
    $canvas.height = _.height;
    var _context = $canvas.getContext('2d');	//画布上下文环境
    var _stages = [];							//布景对象队列
    var _events = {};							//事件集合
    var _index=0,								//当前布景索引
        _hander;  								//帧动画控制
    /* 活动对象构造器：所有可绘制、可更新的实体都由此创建。 */
    var Item = function(params){
        this._params = params||{};
        this._id = 0;               //标志符
        this._stage = null;         //与所属布景绑定
        this._settings = {
            x:0,					//位置坐标:横坐标
            y:0,					//位置坐标:纵坐标
            width:20,				//宽
            height:20,				//高
            type:0,					//对象类型,0表示普通对象(不与地图绑定),1表示玩家控制对象,2表示程序控制对象
            color:'#F00',			//标识颜色
            status:1,				//对象状态,0表示未激活/结束,1表示正常,2表示暂停,3表示临时,4表示异常
            orientation:0,			//当前定位方向,0表示右,1表示下,2表示左,3表示上
            speed:0,				//移动速度
            //地图相关
            location:null,			//定位地图,Map对象
            coord:null,				//如果对象与地图绑定,需设置地图坐标;若不绑定,则设置位置坐标
            path:[],				//幽灵自动行走的路径
            vector:null,			//目标坐标
            //布局相关
            frames:1,				//速度等级,内部计算器times多少帧变化一次
            times:0,				//刷新画布计数(用于循环动画状态判断)
            timeout:0,				//倒计时(用于过程动画状态判断)
            control:{},				//控制缓存,到达定位点时处理
            update:function(){}, 	//更新参数信息
            draw:function(){}		//绘制
        };
        Object.assign(this,this._settings,this._params);
    };
    /*
     * 给单个 Item 绑定 Canvas 事件。
     * 引擎只在 canvas 上挂一个原生监听器，再根据点击/触摸坐标做矩形命中测试，
     * 这样即使有几十个 Item，也不会产生几十个 DOM 监听器。
     */
    Item.prototype.bind = function(eventType,callback){
        if(!_events[eventType]){
            _events[eventType] = {};
            $canvas.addEventListener(eventType,function(e){
                var position = _.getPosition(e);
                _stages[_index].items.forEach(function(item){
                    if(item.x<=position.x&&position.x<=item.x+item.width&&item.y<=position.y&&position.y<=item.y+item.height){
                        var key = 's'+_index+'i'+item._id;
                        if(_events[eventType][key]){
                            _events[eventType][key](e);
                        }
                    }
                });
                e.preventDefault();
            });
        }
        _events[eventType]['s'+this._stage.index+'i'+this._id] = callback.bind(this);  //绑定作用域
    };
    /* 地图对象构造器：data 为二维数组，0=可走，1=墙，2=幽灵巢穴。 */
    var Map = function(params){
        this._params = params||{};
        this._id = 0;               //标志符
        this._stage = null;         //与所属布景绑定
        this._settings = {
            x:0,					//地图起点坐标
            y:0,
            size:20,				//地图单元的宽度
            data:[],				//地图数据
            x_length:0,				//二维数组x轴长度
            y_length:0,				//二维数组y轴长度
            frames:1,				//速度等级,内部计算器times多少帧变化一次
            times:0,				//刷新画布计数(用于循环动画状态判断)
            cache:false,    		//是否静态（如静态则设置缓存）
            update:function(){},	//更新地图数据
            draw:function(){},		//绘制地图
        };
        Object.assign(this,this._settings,this._params);
    };
    /*
     * 读取地图坐标 (x,y) 的值。
     * 越界统一返回 -1，调用方（寻路/碰撞）无需重复判断边界。
     */
    Map.prototype.get = function(x,y){
        if(this.data[y]&&typeof this.data[y][x]!='undefined'){
            return this.data[y][x];
        }
        return -1;
    };
    /* 写入地图坐标；行不存在时静默忽略，避免越界写入创建稀疏数组。 */
    Map.prototype.set = function(x,y,value){
        if(this.data[y]){
            this.data[y][x] = value;
        }
    };
    /*
     * 地图格坐标 -> 画布像素中心点。
     * 加 size/2 是为了让对象落在格子中心，而不是左上角。
     */
    Map.prototype.coord2position = function(cx,cy){
        return {
            x:this.x+cx*this.size+this.size/2,
            y:this.y+cy*this.size+this.size/2
        };
    };
    /*
     * 画布像素坐标 -> 地图格坐标。
     * offset 表示当前坐标距离格子中心的距离，用于判断“是否已经到达格心”。
     * 隧道区域允许坐标为负，因此使用 Math.abs 处理取模。
     */
    Map.prototype.position2coord = function(x,y){
        var fx = Math.abs(x-this.x)%this.size-this.size/2;
        var fy = Math.abs(y-this.y)%this.size-this.size/2;
        return {
            x:Math.floor((x-this.x)/this.size),
            y:Math.floor((y-this.y)/this.size),
            offset:Math.sqrt(fx*fx+fy*fy)
        };
    };
    /*
     * 寻路算法（广度优先搜索）。
     * @param {Object} params
     *   map   二维地图
     *   start 起点 {x,y}
     *   end   终点 {x,y}
     *   type  'path' 返回完整路径；'next' 只返回终点周围可走的下一步集合
     * @return {Array} 路径坐标数组；不可达时返回 []
     *
     * 实现要点：
     *   - steps 二维数组既记录“是否访问过”，也记录该点由哪个点扩展而来；
     *   - 地图越界（值为 -1）时按隧道处理，坐标取模后打上 change 标记；
     *   - 使用队列式逐层扩展，保证第一次到达终点时路径最短。
     */
    Map.prototype.finder = function(params){
        var defaults = {
            map:null,
            start:{},
            end:{},
            type:'path'
        };
        var options = Object.assign({},defaults,params);
        if(options.map[options.start.y][options.start.x]||options.map[options.end.y][options.end.x]){ //当起点或终点设置在墙上
            return [];
        }
        var finded = false;
        var result = [];
        var y_length  = options.map.length;
        var x_length = options.map[0].length;
        // 步骤映射：0 表示未访问；访问后存放“来源坐标”对象，用于回溯路径。
        var steps = Array(y_length).fill(0).map(()=>Array(x_length).fill(0));
        var _getValue = function(x,y){  //获取地图上的值
            if(options.map[y]&&typeof options.map[y][x]!='undefined'){
                return options.map[y][x];
            }
            return -1;
        };
        /*
         * 判断一个相邻格是否可走，可走则加入 result。
         * 地图外坐标通过取模实现左右/上下互通（经典吃豆隧道）。
         */
        var _next = function(to){
            var value = _getValue(to.x,to.y);
            if(value<1){
                if(value==-1){
                    to.x = (to.x+x_length)%x_length;
                    to.y = (to.y+y_length)%y_length;
                    to.change = 1;
                }
                if(!steps[to.y][to.x]){
                    result.push(to);
                }
            }
        };
        /*
         * 逐层扩展。
         * list 为当前层的所有节点；每轮把下一层放入 new_list，递归直到找到终点或没有新节点。
         */
        var _render = function(list){
            var new_list = [];
            var next = function(from,to){
                var value = _getValue(to.x,to.y);
                if(value<1){	//当前点是否可以走
                    if(value==-1){
                        to.x = (to.x+x_length)%x_length;
                        to.y = (to.y+y_length)%y_length;
                        to.change = 1;
                    }
                    if(to.x==options.end.x&&to.y==options.end.y){
                        steps[to.y][to.x] = from;
                        finded = true;
                    }else if(!steps[to.y][to.x]){
                        steps[to.y][to.x] = from;
                        new_list.push(to);
                    }
                }
            };
            list.forEach(function(current){
				next(current,{y:current.y+1,x:current.x});
                next(current,{y:current.y,x:current.x+1});
                next(current,{y:current.y-1,x:current.x});
                next(current,{y:current.y,x:current.x-1});
            });
            if(!finded&&new_list.length){
                _render(new_list);
            }
        };
        _render([options.start]);
        if(finded){
            var current=options.end;
            if(options.type=='path'){
                while(current.x!=options.start.x||current.y!=options.start.y){
                    result.unshift(current);
                    current=steps[current.y][current.x];
                }
            }else if(options.type=='next'){
                _next({x:current.x+1,y:current.y});
                _next({x:current.x,y:current.y+1});
                _next({x:current.x-1,y:current.y});
                _next({x:current.x,y:current.y-1});
            }
        }
        return result;
    };
    /*
     * 布景对象构造器。
     * 每个布景拥有独立的地图、对象、倒计时与 update 钩子。
     */
    var Stage = function(params){
        this._params = params||{};
        this._settings = {
            index:0,                        //布景索引
            status:0,						//布景状态,0表示未激活/结束,1表示正常,2表示暂停,3表示临时状态
            maps:[],						//地图队列
            audio:[],						//音频资源
            images:[],						//图片资源
            items:[],						//对象队列
            timeout:0,						//倒计时(用于过程动画状态判断)
            update:function(){}				//嗅探,处理布局下不同对象的相对关系
        };
        Object.assign(this,this._settings,this._params);
    };
    /*
     * 添加活动对象，并把它绑定到当前布景。
     *   - 若对象声明了 location/coord，会自动换算初始像素坐标；
     *   - Item ID 等于加入顺序，事件表用它定位回调。
     */
    Stage.prototype.createItem = function(options){
        var item = new Item(options);
        //动态属性
        if(item.location){
            Object.assign(item,item.location.coord2position(item.coord.x,item.coord.y));
        }
        //关系绑定
        item._stage = this;
        item._id = this.items.length;
        this.items.push(item);
        return item;
    };
    /*
     * 重置所有对象到初始参数。
     * 用于“生命 -1 后重开本关”：保留关卡地图与得分，但玩家/幽灵回到初始位置。
     */
    Stage.prototype.resetItems = function(){
        this.status = 1;
        this.items.forEach(function(item,index){
            Object.assign(item,item._settings,item._params);
            if(item.location){
                Object.assign(item,item.location.coord2position(item.coord.x,item.coord.y));
            }
        });
    };
    /* 按 type 筛选对象（1=玩家，2=幽灵），存档快照依赖此只读接口。 */
    Stage.prototype.getItemsByType = function(type){
        return this.items.filter(function(item){
	    return item.type == type;
        });
    };
    /*
     * 添加地图并深拷贝源数据。
     * x_length/y_length 提前算好，绘制循环无需反复访问嵌套数组。
     */
    Stage.prototype.createMap = function(options){
        var map = new Map(options);
        //动态属性
        map.data = JSON.parse(JSON.stringify(map._params.data));
        map.y_length = map.data.length;
        map.x_length = map.data[0].length;
        map.imageData = null;
        //关系绑定
        map._stage = this;
        map._id = this.maps.length;
        this.maps.push(map);
        return map;
    };
    /*
     * 重置地图数据。
     * 必须深拷贝 _params.data，否则吃到豆子后修改的是同一份数组，重开本关无法恢复豆子。
     */
    Stage.prototype.resetMaps = function(){
        this.status = 1;
        this.maps.forEach(function(map){
            Object.assign(map,map._settings,map._params);
            map.data = JSON.parse(JSON.stringify(map._params.data));
            map.y_length = map.data.length;
            map.x_length = map.data[0].length;
            map.imageData = null;
        });
    };
    /* 布景完整重置：恢复自身参数、所有对象位置与所有地图数据。 */
    Stage.prototype.reset = function(){
        Object.assign(this,this._settings,this._params);
        this.resetItems();
        this.resetMaps();
    };
    /*
     * 给布景绑定全局事件（keydown 等）。
     * 只有当前布景的处理器会执行，避免启动页和关卡页同时响应按键。
     */
    Stage.prototype.bind = function(eventType,callback){
        if(!_events[eventType]){
            _events[eventType] = {};
            window.addEventListener(eventType,function(e){
                var key = 's' + _index;
                if(_events[eventType][key]){
                    _events[eventType][key](e);
                }
                e.preventDefault();
            });
        }
        _events[eventType]['s'+this.index] = callback.bind(this);	//绑定事件作用域
    };
    /*
     * 启动主循环。
     * 每帧：清屏 -> 布景 update -> 地图 update/draw -> 对象 update/draw。
     * 使用 16ms 限频，避免 120Hz/144Hz 屏幕上游戏速度翻倍。
     */
    this.start = function() {
        var f = 0;		//帧数计算
        var timestamp = (new Date()).getTime();
        var fn = function(){
            var now = (new Date()).getTime();
            // 距离上一帧不足 16ms 时仅继续排队，不推进游戏逻辑。
            if(now-timestamp<16){
                _hander = requestAnimationFrame(fn);
                return false;
            }
            timestamp = now;
            var stage = _stages[_index];
            _context.clearRect(0,0,_.width,_.height);		//清除画布
            _context.fillStyle = '#000000';
            _context.fillRect(0,0,_.width,_.height);
            f++;
            if(stage.timeout){
                stage.timeout--;
            }
            if(stage.update()!=false){		            //update返回false,则不绘制
                stage.maps.forEach(function(map){
                    if(!(f%map.frames)){
                        map.times = f/map.frames;		//计数器
                    }
                    if(map.cache){
                        // 静态地图（墙）只绘制一次并缓存为 ImageData，后续直接贴图。
                        if(!map.imageData){
                            _context.save();
                            map.draw(_context);
                            map.imageData = _context.getImageData(0,0,_.width,_.height);
                            _context.restore();
                        }else{
                            _context.putImageData(map.imageData,0,0);
                        }
                    }else{
                    	map.update();
                        map.draw(_context);
                    }
                });
                stage.items.forEach(function(item){
                    if(!(f%item.frames)){
                        item.times = f/item.frames;		   //计数器
                    }
                    // 只有布景正常运行且对象未暂停时才更新；暂停时仍然 draw，保留画面。
                    if(stage.status==1&&item.status!=2){
                        if(item.location){
                            item.coord = item.location.position2coord(item.x,item.y);
                        }
                        if(item.timeout){
                            item.timeout--;
                        }
                        item.update();
                    }
                    item.draw(_context);
                });
            }
            _hander = requestAnimationFrame(fn);
        };
        _hander = requestAnimationFrame(fn);
    };
    /* 停止主循环；重复调用安全。 */
    this.stop = function(){
        _hander&&cancelAnimationFrame(_hander);
    };
    /*
     * 把鼠标/触摸事件的视口坐标换算成 canvas 内部分辨率坐标。
     * 注意必须先用 clientX 减去 canvas 左边界，再乘缩放比例，
     * 否则 canvas 被 CSS 缩小后点击热区会整体偏移。
     */
    this.getPosition = function(e){
        var box = $canvas.getBoundingClientRect();
        return {
            // 先减去画布在视口中的偏移，再按缩放比例换算成内部分辨率坐标。
            // 原写法缺少括号，画布缩放后点击热区会偏移；此修改不改变桌面端 1:1 时的结果。
            x:(e.clientX-box.left)*(_.width/box.width),
            y:(e.clientY-box.top)*(_.height/box.height)
        };
    }
    /* 创建布景并自动分配索引。 */
    this.createStage = function(options){
        var stage = new Stage(options);
        stage.index = _stages.length;
        _stages.push(stage);
        return stage;
    };
    /*
     * 切换到指定布景。
     * 先把旧布景 status 置 0（停止更新），再激活并 reset 新布景。
     */
    this.setStage = function(index){
        _stages[_index].status = 0;
        _index = index;
        _stages[_index].status = 1;
        _stages[_index].reset(); //重置
        return _stages[_index];
    };
    /* 进入下一个布景；已经是最后一个时抛错，由调用方决定是否处理。 */
    this.nextStage = function(){
        if(_index<_stages.length-1){
            return this.setStage(++_index);
        }else{
            throw new Error('unfound new stage.');
        }
    };
    /* 只读访问器：存档系统需要按索引拿到指定关卡。 */
    this.getStages = function(){
        return _stages;
    };
    //获取当前布景索引（存档系统集成所需，只读访问器）
    this.getIndex = function(){
        return _index;
    };
    /* 初始化：回到启动页并启动主循环。 */
    this.init = function(){
        _index = 0;
        this.start();
    };
}
