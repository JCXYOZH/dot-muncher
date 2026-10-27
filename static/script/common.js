/*
 * common.js —— 全站通用交互
 *
 * 只在所有页面共用的能力放在这里：
 *   1. 顶部固定导航随滚动逐渐加深背景；
 *   2. 右下角“回到顶部”平滑滚动；
 *   3. .J_link 卡片整块可点击（内部链接仍保持原生行为）。
 *
 * 依赖：无，但是必须放在页面 DOM 之后加载。
 */
const $scrollContainer = document.documentElement;

// 头部滚动
(function(){
    const $header = document.querySelector('.mod-head');
    // 页面没有头部时直接退出，避免在异常模板上抛 null.style。
    if (!$header){ return; }
    window.addEventListener('scroll',function(){
        let scrollTop = $scrollContainer.scrollTop;
        // 600px 内线性增加不透明度，之后保持 0.8。
        let ratio = Math.min(scrollTop/600,1);
        $header.style.background = 'rgba(255,255,255,'+(ratio*0.8)+')';
        $header.style.boxShadow = '1px 2px 8px rgba(0,0,0,'+(ratio*0.06)+')';
    });
})();

// 底部滚动
(function(){
    const $gotop = document.querySelector('.mod-fixedbar .gotop');
    if (!$gotop){ return; }
    $gotop.addEventListener('click',function(){
        // 支持 smooth 的浏览器平滑滚动；旧浏览器回退为瞬间回顶。
        if (typeof $scrollContainer.scrollTo === 'function'){
            $scrollContainer.scrollTo({
                left:0,
                top:0,
                behavior:'smooth'
            });
        }else{
            $scrollContainer.scrollTop = 0;
        }
    });
})();

// 块链接（注：向上遍历需判空——点击目标处于刚被移除的弹层等游离节点时，parentNode 链会取到 null）
(function(){
    document.addEventListener('click',function(e) {
        let $tag = e.target;
        // 向上寻找可点击的 A / .J_link，最多到 BODY；parentNode 可能为 null（游离节点）。
        while ($tag && $tag.tagName!='A' && $tag.tagName!='BODY' && !($tag.classList && $tag.classList.contains('J_link'))) {
            $tag = $tag.parentNode;
        }
        // 真正点在 A 上时交给浏览器默认行为，避免重复打开。
        if($tag && $tag.tagName!='A' && $tag.classList && $tag.classList.contains('J_link')){
            let url = $tag.getAttribute('data-url');
            let target = $tag.getAttribute('data-target');
            if(url){
                if (target === '_blank') {
                    window.open(url, '_blank', 'noopener');
                } else {
                    location.href = url;
                }
            }else{
                let $link = $tag.querySelector('a');
                if ($link){
                    target = $link.getAttribute('target');
                    url = $link.getAttribute('href')||'/';
                    if (target == '_blank') {
                        // noopener 防止新页面通过 window.opener 反向控制当前页。
                        window.open(url, '_blank', 'noopener');
                    } else {
                        location.href = url;
                    }
                }
            }
        }
    });
})();
