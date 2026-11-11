// 印刷用ページの「目次」を見出し (h1・h2) から組む。
// mkdocs.yml の toc.integrate で右側の目次が無く、print-site の目次が空になるため。
(function () {
  var nav = document.querySelector("#print-page-toc nav");
  if (!nav) return;
  var ul = document.createElement("ul");
  ul.className = "pdf-toc";
  document.querySelectorAll("section.print-page[id] h1[id], section.print-page[id] h2[id]").forEach(function (h) {
    var li = document.createElement("li");
    li.className = "pdf-toc-" + h.tagName.toLowerCase();
    var a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent.replace("¶", "").trim();
    li.appendChild(a);
    ul.appendChild(li);
  });
  nav.appendChild(ul);
  var css = document.createElement("style");
  css.textContent =
    ".pdf-toc{list-style:none;padding:0;margin:0}" +
    ".pdf-toc li{margin:0;line-height:1.7}" +
    ".pdf-toc-h1{font-weight:700;margin-top:.6em!important}" +
    ".pdf-toc-h2{padding-left:1.5em}" +
    ".pdf-toc a{color:inherit;text-decoration:none}";
  document.head.appendChild(css);
})();
