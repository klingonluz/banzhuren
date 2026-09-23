// 通用小工具：零依赖、纯函数式、不碰任何业务状态
// 🔴 这几个函数原先在 data.js / export.js / record.js / class.js 里各写了一份（P2-4），
//    口径容易悄悄漂移（补零位数、下载的 charset、dataURL 失败处理），统一到这里。
export const pad = n => String(n).padStart(2, '0');

// 触发一次文件下载（Blob → <a download> 点击 → 回收 blob URL）
export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = u; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}

// Blob → dataURL（导出备份时把图片内联进 JSON）
// ⚠️ app/recover.html 里有一份同名实现：那个页面刻意零依赖（应用坏了也要能单独双击打开），
//    不能 import 本模块 —— 两处是刻意分开的，不是漏合并。
export function blobToDataURL(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}
