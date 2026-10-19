/* 订单页逻辑：从网址取订单号 -> 加载 JSON（分片按需）-> 渲染 + 搜索/筛选 */
(function () {
  "use strict";

  var PAGE = 40;          // 每次渲染追加多少条
var ROLE_SHOW = 12;      // 岗位方向默认显示几个，其余折叠
  var oid = "";
  var all = [];           // 已加载进内存的岗位
  var chunks = 1;         // 服务端总共切了几片
  var nextPart = 2;       // 下一片编号
  var loadingPart = false;
  var autoStop = false; // 自动续拉失败后熔断，防止 refresh 反复触发
  var filtered = [];
  var shown = 0;
  var metaOrder = "";     // 用于 updateMeta()
  var metaTotal = 0;

  /* ---------- 已投递记录（本地 localStorage + 云端 KV，双向合并） ---------- */
  var done = {};                                   // jobId -> 1
  var cloudOn = false;                             // 云端是否可用
  function doneKey() { return "xz_toudi:" + oid; }

  function loadDone() {
    try { done = JSON.parse(localStorage.getItem(doneKey()) || "{}") || {}; }
    catch (e) { done = {}; }
  }
  function saveDone() {
    try { localStorage.setItem(doneKey(), JSON.stringify(done)); }
    catch (e) { /* 无痕模式或容量满：静默降级，不影响浏览 */ }
  }
  function doneCount() {
    var n = 0, k;
    for (k in done) { if (done[k]) n++; }
    return n;
  }

  /* 云端：拉取并与本地取并集（本地优先，union 后写回本地） */
  function syncFromCloud() {
    if (!oid) return Promise.resolve();
    return fetch("/api/toudi?o=" + encodeURIComponent(oid), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ok) return;                   // KV 没绑定/未开通：静默忽略
        cloudOn = true;
        var remote = d.done || {}, k, changed = false;
        for (k in remote) {
          if (remote[k] && !done[k]) { done[k] = 1; changed = true; }
        }
        if (changed) { saveDone(); updateMeta(); render(); }
      })
      .catch(function () { /* 网络不通就用本地记录，不打扰客户 */ });
  }

  /* 云端：单条投递状态变更后同步一份完整记录上去 */
  function pushToCloud() {
    if (!oid || !cloudOn) return;
    fetch("/api/toudi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ o: oid, snapshot: done })
    }).catch(function () { /* 失败也不打扰，下次打开会再拉一次 */ });
  }

  // 订单号既可能是 /2026001（域名根），也可能是 /仓库名/2026001（Gitee 子路径）。
// Gitee Pages 会把仓库名变成一级路径，所以这里取**最后一段**。
var ORDER_RE = /^\/(?:[A-Za-z0-9\-_%]+\/)*([A-Za-z0-9\-_%]{2,64})\/?$/;

  function pickOrderId() {
    var q = new URLSearchParams(location.search);
    var v = q.get("o") || q.get("order") || q.get("id");
    if (v) return v.trim();
    var m = ORDER_RE.exec(location.pathname);
    if (m && m[1] !== "order.html" && m[1] !== "index.html") return decodeURIComponent(m[1]);
    return "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fail(msg) {
    document.getElementById("title").textContent = "没找到这份岗位表";
    document.getElementById("meta").textContent = "";
    document.getElementById("list").innerHTML =
      '<div class="empty">' + esc(msg) +
      "<br><br>请确认链接是否完整，或直接联系客服重新获取。</div>";
  }

  /* ---------- 0 命中 / 资料不全 ---------- */
  function blankState(missing) {
    var n = missing.length;
    document.getElementById("list").innerHTML =
      '<div class="empty zero">' +
      '<div class="zt">你的资料还不完整</div>' +
      '<p class="zbig">缺少：' + esc(missing.join("、")) + "</p>" +
      '<p class="ztip">这 ' + n + " 项是匹配岗位的必填项，补齐后我们才能帮你筛选。" +
      "请把订单号发给客服补上，补好后这个页面会自动更新。</p></div>";
  }

  function zeroState() {
    document.getElementById("list").innerHTML =
      '<div class="empty zero">' +
      '<div class="zt">当前没有合适岗位</div>' +
      '<p class="zbig">请每天关注！</p>' +
      '<p class="ztip">岗位池每天更新，链接不变。有了符合你条件的新岗位，' +
      "这个页面会自动出现。</p></div>";
  }

  /* ---------- 渲染单条 ---------- */
  function tagClass(k) {
    return k === "字面" ? "tag k1" : (k === "类别" ? "tag k2" : "tag k3");
  }
  function tagText(k) {
    return k === "字面" ? "专业对口" : (k === "类别" ? "专业相关" : "专业待核实");
  }

  function card(j) {
    var raw = j["截止时间"] || "";
    var hot = /尽快|招满|长期|随时|持续/.test(raw);
    var dl = raw ? (hot ? "招满即止，尽快投递" : "截止 " + raw) : "";
    var link = j["投递链接"] || j["公告链接"] || "";

    var rows = [];
    if (j["工作地点"]) {
      // 岗位写「全国多地」时求职者会疑惑「我只要 XX 市，怎么推外地」——显式标出来
      var nat = /全国/.test(j["工作地点"]) ? '<em class="nat">全国可投</em>' : "";
      rows.push("<span><i>地点</i> " + esc(j["工作地点"]) + nat + "</span>");
    }
    if (j["届次"]) rows.push("<span><i>届次</i> " + esc(j["届次"]) + "</span>");
    if (j["学历要求"]) rows.push("<span><i>学历</i> " + esc(j["学历要求"]) + "</span>");
    if (j["企业性质"]) rows.push("<span><i>性质</i> " + esc(j["企业性质"]) + "</span>");

    // 笔试：源表 34% 明确标「有笔试」，学生最关心投完要不要笔试
    var pen = j["需笔试"]
      ? '<span class="pen">需笔试</span>'
      : '<span class="pen unk">笔试未说明</span>';

    // 岗位方向：源表这一列常是「战略研究类,投资研究类,资产管理类,……」几十个方向挤在一起，
    // 直接铺出来客户看不懂。build.py 已拆成「方向」数组，这里渲染成标签，
    // 超过 ROLE_SHOW 个折叠成「展开全部 N 个」。
    var roleHtml = "";
    var dirs = j["方向"];
    if (dirs && dirs.length) {
      var shown = dirs.slice(0, ROLE_SHOW);
      roleHtml = '<div class="roles">' + shown.map(function (d) {
        return '<button class="rt" type="button" data-kw="' + esc(d) + '">' + esc(d) + "</button>";
      }).join("");
      if (dirs.length > ROLE_SHOW) {
        var moreTxt = "展开全部 " + dirs.length + " 个方向";
        roleHtml += '<button class="rt more" type="button" data-act="roles" data-total="' +
          esc(moreTxt) + '">' + esc(moreTxt) + "</button>";
        roleHtml += '<div class="roles-rest" hidden>' +
          dirs.slice(ROLE_SHOW).map(function (d) {
            return '<button class="rt" type="button" data-kw="' + esc(d) + '">' + esc(d) + "</button>";
          }).join("") + "</div>";
      }
      roleHtml += "</div>";
    } else if (j["招聘岗位"]) {
      // 拆不出方向（整段文字）的，直接显示原文
      roleHtml = '<div class="role">' + esc(j["招聘岗位"].slice(0, 160)) + "</div>";
    }

    var extra = "";
    var maj = j["专业要求"] || "";
    if (maj && j["对口"] !== "不限") {
      extra = '<div class="rows"><span><i>专业</i> ' + esc(maj.slice(0, 140)) +
        (maj.length > 140 ? "…" : "") + "</span></div>";
    }

    // 已投递标记：靠岗位的稳定 ID 记录，岗位池每天新增也不会错位
    var jid = j["id"] || "";
    var isDone = !!(jid && done[jid]);
    // 岗位更新日期：放在「标记已投递」后面（大人第 2 条）
    var upd = j["更新时间"]
      ? '<span class="upd">更新 ' + esc(j["更新时间"]) + "</span>" : "";

    return '<article class="job' + (isDone ? " done" : "") + '" data-id="' + esc(jid) + '">' +
      '<div class="top"><div class="co">' + esc(j["公司名称"]) +
      (j["公司岗位数"] ? '<em class="multi">共 ' + j["公司岗位数"] + " 个岗位</em>" : "") +
      pen + "</div>" +
      '<span class="' + tagClass(j["对口"]) + '">' + tagText(j["对口"]) + "</span></div>" +
      roleHtml +
      '<div class="rows">' + rows.join("") + "</div>" + extra +
      '<div class="foot">' +
      (dl ? '<span class="deadline' + (hot ? " hot" : "") + '">' + esc(dl) + "</span>" : "") +
      '<button class="mark' + (isDone ? " on" : "") + '" type="button" data-act="mark">' +
      (isDone ? "已投递" : "标记已投递") + "</button>" + upd +
      (link
        ? '<a class="apply" href="' + esc(link) + '" target="_blank" rel="noopener">去投递</a>'
        : '<span class="apply off">暂无链接</span>') +
      "</div></article>";
  }

  function render() {
    var box = document.getElementById("list");
    if (!filtered.length) {
      box.innerHTML = all.length
        ? '<div class="empty">没有符合条件的岗位，换个关键词或清空筛选试试。</div>'
        : '<div class="empty">这份表暂时还没有匹配到岗位。</div>';
      return;
    }
    var end = Math.min(shown, filtered.length);
    box.innerHTML = filtered.slice(0, end).map(card).join("");

    if (end < filtered.length) {
      addMoreBtn("还有 " + (filtered.length - end) + " 条，继续加载", function () {
        shown = end + PAGE;
        render();
      });
    } else if (nextPart <= chunks) {
      addMoreBtn("岗位较多，点击加载更多", loadMore);
    }
  }

  function addMoreBtn(text, fn) {
    var btn = document.createElement("button");
    btn.className = "more";
    btn.type = "button";
    btn.textContent = text;
    btn.onclick = fn;
    document.getElementById("list").appendChild(btn);
  }

  /* ---------- 分片加载 ---------- */
  function loadMore() {
    if (loadingPart || nextPart > chunks) return;
    loadingPart = true;
    var part = nextPart;
    var btn = document.querySelector(".more");
    if (btn) { btn.textContent = "正在加载…"; btn.disabled = true; }

    fetch("data/o/" + encodeURIComponent(oid) + "." + part + ".json", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        all = all.concat(d.jobs || []);
        nextPart++;
        loadingPart = false;
        refresh();
      })
      .catch(function () {
        loadingPart = false;
        // 自动续拉失败：熔断，避免 refresh() 反复触发死循环；退回「按当前已加载内容渲染」
        autoStop = true;
        refresh();
        if (btn) { btn.textContent = "加载失败，点这里重试"; btn.disabled = false; }
      });
  }

  /* ---------- 筛选 ---------- */
  function refresh() {
    var kw = document.getElementById("kw").value.trim().toLowerCase();
    var city = document.getElementById("city").value;
    var fit = document.getElementById("fit").value;   // ""=全部 / 字面 / 类别 / 不限
    var hideDone = document.getElementById("hideDone").classList.contains("on");
    var noPen = document.getElementById("noPen").classList.contains("on");
    var ind = document.getElementById("ind").value;
    var nat = document.getElementById("nat").value;

    // 岗位按「专业对口分层排序」后再切片，首片几乎全是字面岗。
    // 所以选了「专业相关 / 专业待核实」时，已加载的部分可能一条都没有 ——
    // 这时自动续拉一片，不用让客户干点「继续加载」。
    // 每次只拉一片，拉完 refresh() 重入，最多到 chunks 为止（不会死循环）。
    if ((fit || noPen || ind || nat) && !autoStop && !loadingPart
      && nextPart <= chunks && !hasFit()) {
      loadMore();
      return;                       // 等 loadMore 拉完再渲染
    }

    filtered = all.filter(function (j) {
      if (fit && j["对口"] !== fit) return false;
      if (hideDone && j["id"] && done[j["id"]]) return false;
  // 「只看无需笔试」：源表 34% 明确标有笔试，学生最关心这个
      if (noPen && j["需笔试"]) return false;
  // 行业/性质筛选：一个岗位可能属多个行业（如「电子通信、制造业」），任一命中即保留
      if (ind && (j["行业"] || []).indexOf(ind) < 0) return false;
      if (nat && j["性质类"] !== nat) return false;
      if (city && (j["工作地点"] || "").indexOf(city) < 0) return false;
      if (!kw) return true;
      // 方向标签也要能搜到（客户点标签后是按方向过滤的）
      return [j["公司名称"], j["招聘岗位"], j["工作地点"], j["专业要求"],
              (j["方向"] || []).join(" ")]
        .join(" ").toLowerCase().indexOf(kw) >= 0;
    });
    if (shown < PAGE) shown = PAGE;
    render();
  }

  // 当前已加载的岗位里，有没有选中分类的（只看专业维度，不受搜索/城市影响）
  function hasFit() {
    var fit = document.getElementById("fit").value;
    var noPen = document.getElementById("noPen").classList.contains("on");
    var ind = document.getElementById("ind").value;
    var nat = document.getElementById("nat").value;
    if (!fit && !noPen && !ind && !nat) return true;
    for (var i = 0; i < all.length; i++) {
      if (noPen && all[i]["需笔试"]) continue;
      if (ind && (all[i]["行业"] || []).indexOf(ind) < 0) continue;
      if (nat && all[i]["性质类"] !== nat) continue;
      if (fit && all[i]["对口"] !== fit) continue;
      return true;
    }
    return false;
  }

  /* ---------- 点「标记已投递」：切换状态，只动这一张卡片 ---------- */
  function toggleDone(btn) {
    var art = btn.closest ? btn.closest(".job") : null;
    if (!art) return;
    var jid = art.getAttribute("data-id");
    if (!jid) return;
    if (done[jid]) { delete done[jid]; } else { done[jid] = 1; }
    saveDone();
    pushToCloud();
    var on = !!done[jid];
    btn.textContent = on ? "已投递" : "标记已投递";
    btn.className = "mark" + (on ? " on" : "");
    art.className = "job" + (on ? " done" : "");
    updateMeta();
    if (document.getElementById("hideDone").classList.contains("on")) refresh();
  }

  function updateMeta() {
    var base = "订单号 " + (metaOrder || oid) + " · 共 " + (metaTotal || all.length) + " 条岗位";
    var n = doneCount();
    if (n) base += " · 已投递 " + n;
    document.getElementById("meta").textContent = base;
  }

  function buildCities() {
    var set = {};
    all.forEach(function (j) {
      (j["工作地点"] || "").split(/[、,，/／\s]+/).forEach(function (c) {
        c = c.replace(/市$/, "").trim();
        if (c && c.length <= 6 && c !== "全国多地") set[c] = (set[c] || 0) + 1;
      });
    });
    var list = Object.keys(set).sort(function (a, b) { return set[b] - set[a]; }).slice(0, 60);
    var sel = document.getElementById("city");
    sel.innerHTML = '<option value="">全部城市</option>';
    list.forEach(function (c) {
      var o = document.createElement("option");
      o.value = c;
      o.textContent = c + "（" + set[c] + "）";
      sel.appendChild(o);
    });
  }

  // 行业下拉：源表 95 种碎片已在后端归并成大类，这里按当前已加载的数量排序
  function buildIndustries() {
    var set = {};
    all.forEach(function (j) {
      (j["行业"] || []).forEach(function (t) { set[t] = (set[t] || 0) + 1; });
    });
    var list = Object.keys(set).sort(function (a, b) { return set[b] - set[a]; });
    var sel = document.getElementById("ind");
    sel.innerHTML = '<option value="">全部行业</option>';
    list.forEach(function (t) {
      var o = document.createElement("option");
      o.value = t;
      o.textContent = t + "（" + set[t] + "）";
      sel.appendChild(o);
    });
  }

  /* ---------- 启动 ---------- */
  oid = pickOrderId();
  if (!oid) { fail("链接里没有带上订单号。"); return; }
  loadDone();

  fetch("data/o/" + encodeURIComponent(oid) + ".json", { cache: "no-store" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      all = data.jobs || [];
      chunks = data.chunks || 1;
      metaOrder = data.order || oid;
      metaTotal = data.total || all.length;

      document.title = (data.name || "") + " 的校招岗位表";
      document.getElementById("title").textContent =
        (data.name || "同学") + "，这是你的专属岗位表";
      updateMeta();

      // 有效期：大人第 3 条 —— 呈现「更新至 X」；到期后明确写「已停止更新」
      var until = data.update_until || "";
      // 链接失效日期（大人 2026-10-18）：过了这天页面文件会被删除，
      // 提前告诉客户，免得客户某天发现链接打不开却不知道为什么。
      var expire = data.link_expire || "";
      var vh;
      if (data.frozen) {
        vh = '<span class="vtag frozen">已停止更新</span>' +
          '<span class="vtip">本表更新至 ' + esc(until || "—") + "，之后内容不再变化</span>";
      } else if (until) {
        vh = '<span class="vtag">每日更新</span>' +
          '<span class="vtip">更新至 ' + esc(until) + "</span>";
      } else {
        vh = '<span class="vtag">每日更新</span>' +
          '<span class="vtip">链接不变，内容每天刷新</span>';
      }
      if (expire) {
        vh += '<span class="vtip expire">链接失效日期 ' + esc(expire) + "</span>";
      }
      document.getElementById("valid").innerHTML = vh;

      var p = data.profile || {};
      document.getElementById("profile").innerHTML =
        ["学历 " + (p["学历"] || "—"), "专业 " + (p["专业"] || "—"),
         "意向 " + (p["意向城市"] || "—"), p["届次"] || ""]
          .filter(Boolean).map(function (t) {
            return '<span class="chip">' + esc(t) + "</span>";
          }).join("");

      var c = data.counts || {};
      document.getElementById("c1").textContent = c["对口"] || 0;
      document.getElementById("c2").textContent = c["相关"] || 0;
      document.getElementById("c3").textContent = c["不限专业"] || 0;
      document.getElementById("c4").textContent = data.total || all.length;
      document.getElementById("c5").textContent = (c["需笔试"] != null) ? c["需笔试"] : 0;

      // 资料不全（学历/届次/专业 漏填）：优先提示补资料，别让客户以为「没有岗位」
      if (data.incomplete && data.incomplete.length) {
        blankState(data.incomplete);
        document.getElementById("foot").textContent =
          "本页由客服为你生成，资料更新后内容会自动跟着变。";
        return;
      }

      // 0 命中：只留档案 + 提示，不显示空的统计条与筛选栏（否则客户会一直点）
      if (!all.length) {
        zeroState();
        document.getElementById("foot").textContent =
          "本页由客服为你生成，数据每天更新，链接不变。";
        return;
      }

      document.getElementById("stats").hidden = false;
      document.getElementById("toolbar").hidden = false;
      document.getElementById("foot").textContent =
        "本页由客服为你生成，数据每天更新，链接不变。";

      buildCities();
      buildIndustries();
      filtered = all.slice();
      shown = PAGE;
      render();

      // 云端已投递记录：拉到后与本地取并集（换手机/清缓存也不丢）
      syncFromCloud();

      document.getElementById("kw").addEventListener("input", refresh);
      document.getElementById("city").addEventListener("change", refresh);
      document.getElementById("ind").addEventListener("change", function () {
        autoStop = false;
        refresh();
      });
      document.getElementById("nat").addEventListener("change", function () {
        autoStop = false;
        refresh();
      });
      document.getElementById("fit").addEventListener("change", function () {
        autoStop = false;            // 换了分类，重新允许自动续拉
        refresh();
      });
      document.getElementById("hideDone").addEventListener("click", function () {
        this.classList.toggle("on");
        refresh();
      });
      document.getElementById("noPen").addEventListener("click", function () {
        this.classList.toggle("on");
        autoStop = false;
        refresh();
      });
      document.getElementById("list").addEventListener("click", function (e) {
        var t = e.target;
        // 点方向标签 -> 按该方向搜索（客户想快速看"这家公司的算法岗还有哪些"）
        if (t.classList && t.classList.contains("rt") && t.getAttribute("data-kw")) {
          document.getElementById("kw").value = t.getAttribute("data-kw");
          refresh();
          document.getElementById("kw").scrollIntoView({ block: "center" });
          return;
        }
        while (t && t !== this) {
          if (t.getAttribute && t.getAttribute("data-act") === "mark") {
            toggleDone(t);
            return;
          }
          // 点「展开全部 N 个方向」-> 展开/收起这张卡片的折叠区
          if (t.getAttribute && t.getAttribute("data-act") === "roles") {
            var rest = t.parentNode.querySelector(".roles-rest");
            if (rest) {
              var open = !rest.hidden;
              rest.hidden = open;
              t.textContent = open ? t.getAttribute("data-total") : "收起";
            }
            return;
          }
          t = t.parentNode;
        }
      });
    })
    .catch(function () { fail("这份岗位表不存在，或者链接里的订单号有误。"); });
})();
