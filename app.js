// Refuse to run inside a frame on another site (clickjacking protection).
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error("framed"); }
(function () {
  "use strict";
  // The publishable key is meant to be public: every table and the photo bucket are protected by row-level rules.
  var SUPABASE_URL = "https://kvdhdxcbxvmjnaezbtwx.supabase.co";
  var SUPABASE_KEY = "sb_publishable_7s4w3CA_cjgQsPkvkPAN6w_cFbs45Hs";
  var BUCKET = "repair-photos";
  var PHOTO_LINK_SECONDS = 365 * 24 * 60 * 60;   // how long a photo link opened from the app keeps working: one year
  var STATUS = { open: "פתוח", progress: "בטיפול", done: "תוקן", not_ours: "לא באחריותנו" };
  var ROLES = { admin: "מנהל", staff: "איש צוות", disabled: "חסום" };

  var $ = function (id) { return document.getElementById(id); };
  function h(tag, props) {
    var el = document.createElement(tag), i, k;
    if (props) for (k in props) {
      if (k === "text") el.textContent = props[k];
      else if (k === "class") el.className = props[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), props[k]);
      else el.setAttribute(k, props[k]);
    }
    for (i = 2; i < arguments.length; i++) if (arguments[i]) el.appendChild(arguments[i]);
    return el;
  }
  function fmtDate(iso) { return iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : ""; }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function msg(id, text) { var e = $(id); e.textContent = text || ""; e.hidden = !text; }
  function show(screen) { ["scrLoading", "scrAuth", "scrBlocked", "scrMain"].forEach(function (s) { $(s).hidden = s !== screen; }); }

  if (!window.supabase) { $("scrLoading").textContent = "לא ניתן לטעון את המערכת. בדקו את החיבור לאינטרנט ורעננו את הדף."; return; }
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  var me = null;                 // profile row of the signed-in user
  var rows = [], statusFilter = "all", editing = null, urls = {}, channel = null, setupMode = false;

  // ---------- server function ----------
  var FN_ERR = {
    weak_password: "הסיסמה קצרה מדי. צריך 8 תווים לפחות.", bad_email: "כתובת האימייל לא תקינה.",
    already_set_up: "המערכת כבר הוגדרה. היכנסו עם המשתמש הקיים.", not_admin: "רק מנהל יכול לבצע את הפעולה.",
    not_signed_in: "פג תוקף הכניסה. היכנסו שוב.", cannot_change_self: "אי אפשר לשנות את ההרשאה של עצמך.",
    already_signed: "הקריאה כבר חתומה בחתימה כללית.", not_found: "הקריאה לא נמצאה. שמרו אותה ונסו שוב."
  };
  function fn(body, name) {
    return sb.auth.getSession().then(function (r) {
      var s = r.data.session;
      return fetch(SUPABASE_URL + "/functions/v1/" + (name || "admin-users"), {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: "Bearer " + (s ? s.access_token : SUPABASE_KEY) },
        body: JSON.stringify(body)
      });
    }).then(function (res) {
      return res.json().catch(function () { return { error: "server_error" }; }).then(function (j) {
        if (!res.ok) {
          var e = j.error || "server_error";
          throw new Error(FN_ERR[e] || (/already.*registered|already exists/i.test(e) ? "כבר קיים משתמש עם האימייל הזה." : "הפעולה נכשלה. נסו שוב."));
        }
        return j;
      });
    });
  }

  // ---------- sign in / first-time setup ----------
  function showAuth(setup) {
    setupMode = setup;
    $("authTitle").textContent = setup ? "הגדרה ראשונית" : "מחלקת בדק";
    $("authSub").textContent = setup ? "יוצרים את חשבון המנהל הראשון. אחר כך תוכלו להוסיף את שאר הצוות מתוך המערכת." : "כניסה לצוות החברה.";
    $("authNameWrap").hidden = !setup;
    $("a_pass").setAttribute("autocomplete", setup ? "new-password" : "current-password");
    $("authBtn").textContent = setup ? "יצירת חשבון מנהל" : "כניסה";
    msg("authErr", ""); show("scrAuth");
  }
  $("authForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = $("a_email").value.trim(), pass = $("a_pass").value;
    if (!email || !pass) return msg("authErr", "צריך למלא אימייל וסיסמה.");
    if (setupMode && pass.length < 8) return msg("authErr", "הסיסמה קצרה מדי. צריך 8 תווים לפחות.");
    $("authBtn").disabled = true; msg("authErr", "");
    var p = setupMode ? fn({ action: "setup", email: email, password: pass, full_name: $("a_name").value.trim() }) : Promise.resolve();
    p.then(function () { return sb.auth.signInWithPassword({ email: email, password: pass }); })
      .then(function (r) {
        if (r.error) throw new Error("האימייל או הסיסמה שגויים.");
        $("a_pass").value = "";
        return enter("login");
      })
      .catch(function (e) { msg("authErr", e.message || "הכניסה נכשלה."); })
      .then(function () { $("authBtn").disabled = false; });
  });
  function signOut() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    me = null; rows = []; urls = {};
    sb.auth.signOut().then(boot, boot);
  }
  $("outBtn").addEventListener("click", signOut);
  $("blockedOut").addEventListener("click", signOut);

  function boot() {
    show("scrLoading");
    sb.auth.getSession().then(function (r) {
      if (r.data.session) return enter("visit");
      return fn({ action: "status" }).then(function (s) { showAuth(!!s.needsSetup); }, function () { showAuth(false); });
    });
  }
  function enter(kind) {
    return sb.auth.getUser().then(function (r) {
      if (r.error || !r.data.user) return showAuth(false);
      return sb.from("profiles").select("*").eq("user_id", r.data.user.id).maybeSingle().then(function (p) {
        if (!p.data || p.data.role === "disabled") { me = null; return show("scrBlocked"); }
        me = p.data;
        $("whoami").textContent = "מחוברים בתור " + (me.full_name || me.email) + " · " + ROLES[me.role];
        $("usersBtn").hidden = me.role !== "admin";
        $("logBtn").hidden = !(me.is_owner && me.role === "admin");
        // Record this entry. The server fills in who, when and the IP address; only the owner can read the log.
        sb.from("login_log").insert({ kind: kind === "login" ? "login" : "visit", device: navigator.userAgent }).then(function () {}, function () {});
        show("scrMain");
        $("list").textContent = ""; $("list").appendChild(h("div", { class: "empty" }, h("strong", { text: "טוען קריאות…" })));
        subscribe();
        return load();
      });
    });
  }

  // ---------- data ----------
  function load() {
    var all = [], size = 1000;
    function page(from) {
      return sb.from("repairs").select("*").order("opened_on", { ascending: false }).order("created_at", { ascending: false }).range(from, from + size - 1)
        .then(function (r) {
          if (r.error) throw r.error;
          all = all.concat(r.data);
          return r.data.length === size ? page(from + size) : all;
        });
    }
    return page(0).then(function (data) { rows = data; render(); }, function () {
      $("list").textContent = "";
      $("list").appendChild(h("div", { class: "empty" }, h("strong", { text: "לא ניתן לטעון את הקריאות" }), document.createTextNode("בדקו את החיבור ורעננו את הדף.")));
    });
  }
  var reloadTimer = null;
  function subscribe() {
    if (channel) return;
    channel = sb.channel("repairs-live").on("postgres_changes", { event: "*", schema: "public", table: "repairs" }, function () {
      clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 400);
    }).subscribe();
  }

  // ---------- list and filters ----------
  function uniq(list) { var seen = {}, out = []; list.forEach(function (v) { v = (v || "").trim(); if (v && !seen[v]) { seen[v] = 1; out.push(v); } }); return out.sort(function (a, b) { return a.localeCompare(b, "he"); }); }
  function fillSelect(sel, values, allLabel) {
    var cur = sel.value; sel.textContent = "";
    sel.appendChild(h("option", { value: "", text: allLabel }));
    values.forEach(function (v) { sel.appendChild(h("option", { value: v, text: v })); });
    sel.value = values.indexOf(cur) !== -1 ? cur : "";
  }
  function fillDatalist(dl, values) { dl.textContent = ""; values.forEach(function (v) { dl.appendChild(h("option", { value: v })); }); }
  function refreshFilters() {
    var projects = uniq(rows.map(function (r) { return r.project; }));
    fillSelect($("fProject"), projects, "כל הפרויקטים");
    var proj = $("fProject").value;
    var buyers = uniq(rows.filter(function (r) { return !proj || r.project.trim() === proj; }).map(function (r) { return r.buyer; }));
    fillSelect($("fBuyer"), buyers, "כל הרוכשים");
    fillDatalist($("dlProjects"), projects);
    fillDatalist($("dlBuyers"), uniq(rows.map(function (r) { return r.buyer; })));
  }
  function baseMatch(r) {   // everything except the status chip, so the chip counts reflect the other filters
    var proj = $("fProject").value, buyer = $("fBuyer").value, q = $("q").value.trim().toLowerCase();
    if (proj && r.project.trim() !== proj) return false;
    if (buyer && r.buyer.trim() !== buyer) return false;
    if (q && [r.project, r.apartment, r.buyer, r.issue, r.fix_desc, r.fixer, r.notes].concat(itemsOf(r).map(function (it) { return [it.title, it.fix_desc, it.fixer].join(" "); })).join(" ").toLowerCase().indexOf(q) === -1) return false;
    return true;
  }
  function visible() { return rows.filter(function (r) { return baseMatch(r) && (statusFilter === "all" || r.status === statusFilter); }); }
  function render() {
    refreshFilters();
    var base = rows.filter(baseMatch), c = { all: base.length, open: 0, progress: 0, done: 0, not_ours: 0 };
    base.forEach(function (r) { if (c[r.status] !== undefined) c[r.status]++; });
    var box = $("counts"); box.textContent = "";
    [["all", "הכול"], ["open", STATUS.open], ["progress", STATUS.progress], ["done", STATUS.done], ["not_ours", STATUS.not_ours]].forEach(function (p) {
      box.appendChild(h("button", { class: "count", type: "button", "aria-pressed": String(statusFilter === p[0]), onclick: function () { statusFilter = p[0]; render(); } },
        h("span", { text: p[1] }), h("b", { text: String(c[p[0]]) })));
    });
    var shown = visible(), list = $("list"); list.textContent = "";
    $("shown").textContent = rows.length ? "מוצגות " + shown.length + " מתוך " + rows.length + " קריאות" : "";
    if (!rows.length) return list.appendChild(h("div", { class: "empty" }, h("strong", { text: "עדיין אין קריאות ביומן" }), document.createTextNode("לחצו על \"קריאה חדשה\" כדי לפתוח את הקריאה הראשונה.")));
    if (!shown.length) return list.appendChild(h("div", { class: "empty" }, h("strong", { text: "אין קריאות שמתאימות לסינון" }), document.createTextNode("שנו את הסינון או לחצו על \"ניקוי סינון\".")));
    shown.forEach(function (r) {
      var n = r.photos_before.length + r.photos_after.length + itemsOf(r).reduce(function (a, it) { return a + (it.photos_before || []).length + (it.photos_after || []).length; }, 0), meta = [];
      var its = itemsOf(r), nSigned = its.filter(function (it) { return it.signature_path; }).length;
      if (its.length) meta.push(its.length + " תיקונים" + (nSigned ? " (" + nSigned + " חתומים)" : ""));
      if (r.fix_date) meta.push("תוקן ב-" + fmtDate(r.fix_date));
      if (r.signature_path) meta.push(r.signed_remote ? "חתימה כללית (מרחוק)" : "חתימה כללית");
      else if (r.approved) meta.push("הרוכש אישר");
      if (n) meta.push(n + " תמונות");
      var where = h("span", { class: "where", text: r.apartment });
      if (r.project || r.buyer) where.appendChild(h("small", { text: [r.project, r.buyer].filter(Boolean).join(" · ") }));
      list.appendChild(h("button", { class: "row", type: "button", onclick: function () { openForm(r); } },
        h("span", { class: "date", text: fmtDate(r.opened_on) }), where, h("span", { class: "issue", text: r.issue }),
        h("span", { class: "meta", text: meta.join(" · ") }),
        h("span", { class: "pill " + (STATUS[r.status] ? r.status : "open"), text: STATUS[r.status] || STATUS.open })));
    });
  }
  $("q").addEventListener("input", render);
  $("fProject").addEventListener("change", function () { $("fBuyer").value = ""; render(); });
  $("fBuyer").addEventListener("change", render);
  $("clearBtn").addEventListener("click", function () { $("q").value = ""; $("fProject").value = ""; $("fBuyer").value = ""; statusFilter = "all"; render(); });

  // ---------- photos ----------
  function signed(paths) {
    var need = paths.filter(function (p) { return !urls[p]; });
    if (!need.length) return Promise.resolve();
    return sb.storage.from(BUCKET).createSignedUrls(need, PHOTO_LINK_SECONDS).then(function (r) {
      (r.data || []).forEach(function (x) { if (x.signedUrl && x.path) urls[x.path] = x.signedUrl; });
    });
  }
  function renderPhotos(kind) {
    var box = $(kind === "before" ? "photosBefore" : "photosAfter"), list = editing[kind];
    return signed(list).then(function () {
      box.textContent = "";
      box.appendChild(h("div", { class: "title", text: kind === "before" ? "תמונות כלליות לקריאה: לפני" : "תמונות כלליות לקריאה: אחרי" }));
      var thumbs = h("div", { class: "thumbs" });
      list.forEach(function (path) {
        var t = h("div", { class: "thumb" });
        if (urls[path]) t.appendChild(h("a", { href: urls[path], target: "_blank", rel: "noopener" }, h("img", { src: urls[path], alt: "תמונה", loading: "lazy" })));
        t.appendChild(h("button", { type: "button", "aria-label": "הסרת התמונה מהקריאה", text: "×",
          onclick: function () { editing[kind] = editing[kind].filter(function (x) { return x !== path; }); renderPhotos(kind); } }));
        thumbs.appendChild(t);
      });
      var input = h("input", { type: "file", accept: "image/*", multiple: "", id: "file_" + kind });
      input.addEventListener("change", function () { addPhotos(kind, input); });
      thumbs.appendChild(h("label", { class: "addphoto" }, input, h("span", { text: "הוספת תמונה" })));
      box.appendChild(thumbs);
    });
  }
  function shrink(file) {   // phone photos are large; a 1600px JPEG keeps the free storage going far longer
    if (!window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bmp) {
      var s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement("canvas");
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (res) { c.toBlob(function (b) { res(b || file); }, "image/jpeg", 0.85); });
    }).catch(function () { return file; });
  }
  function addPhotos(kind, input) {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    msg("err", ""); $("saveBtn").disabled = true; $("saveBtn").textContent = "מעלה תמונות…";
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () { return shrink(f); }).then(function (blob) {
        var type = /^image\/(png|jpeg|gif|webp)$/.test(blob.type) ? blob.type : "image/jpeg";
        var path = editing.id + "/" + kind + "-" + crypto.randomUUID() + "." + (type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1]);
        return sb.storage.from(BUCKET).upload(path, blob, { contentType: type }).then(function (r) {
          if (r.error) throw r.error;
          editing[kind].push(path);
        });
      });
    });
    chain.catch(function () { msg("err", "העלאת התמונה נכשלה. אפשר להעלות JPG, PNG, GIF או WEBP עד 10MB."); })
      .then(function () { return renderPhotos(kind); })
      .then(function () { $("saveBtn").disabled = false; $("saveBtn").textContent = "שמירה"; });
  }

  // ---------- customer signature ----------
  function makePad(canvas) {   // ink is always dark on white, whatever the page theme, so the saved image reads the same everywhere
    var ctx = canvas.getContext("2d"), dirty = false, drawing = false;
    function reset() {
      var dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 560, hh = canvas.clientHeight || 150;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hh);
      ctx.strokeStyle = "#111"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      dirty = false;
    }
    function pos(e) { var r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
      var p = pos(e); drawing = true; dirty = true;
      ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.1, p[1] + 0.1); ctx.stroke();
    });
    canvas.addEventListener("pointermove", function (e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (n) { canvas.addEventListener(n, function () { drawing = false; }); });
    return { reset: reset, isDirty: function () { return dirty; }, blob: function () { return new Promise(function (res) { canvas.toBlob(res, "image/png"); }); } };
  }
  var mainPad = makePad($("sigPad"));
  $("sigClear").addEventListener("click", mainPad.reset);
  $("sigRemove").addEventListener("click", function () { editing.signature = null; renderSig(); });
  function renderSig() {
    var has = !!editing.signature;
    $("sigDone").hidden = !has; $("sigNew").hidden = has;
    if (!has) { $("f_signedName").value = ""; mainPad.reset(); renderRemote(); return; }
    var d = editing.signedAt ? new Date(editing.signedAt) : null;
    $("sigInfo").textContent = "נחתם על ידי " + (editing.signedName || "לא צוין") +
      (d ? " בתאריך " + d.toLocaleDateString("he-IL") + " בשעה " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "") +
      (editing.record && editing.record.signed_remote && editing.signature === editing.record.signature_path ? " · נחתם מרחוק דרך קישור אישי" : "");
    $("sigRemove").hidden = me.role !== "admin";
    $("sigImg").removeAttribute("src");
    var path = editing.signature;
    signed([path]).then(function () { if (editing && editing.signature === path && urls[path]) $("sigImg").src = urls[path]; });
  }

  // ---------- remote approval: a personal link the customer opens and signs on their own phone ----------
  // Only a hash of the link's secret is stored, so the link itself can be shown once, right after it is created.
  var APPROVE_URL = new URL("approve.html", location.href.split("#")[0].split("?")[0]).href;
  function remoteState(text, link) {
    $("remoteInfo").textContent = text;
    $("remoteLinkRow").hidden = !link;
    if (link) {
      $("remoteLink").value = link;
      $("remoteWa").href = "https://wa.me/?text=" + encodeURIComponent("שלום, מצורף קישור אישי לאישור התיקונים שבוצעו בדירה. מחלקת בדק סיטי פרוייקטים:\n" + link);
    }
  }
  function renderRemote() {
    var id = editing.id;
    $("remoteBox").hidden = false; $("remoteRevoke").hidden = true; $("remoteCreate").disabled = editing.isNew;
    $("remoteCreate").textContent = "יצירת קישור לאישור מרחוק";
    if (editing.isNew) return remoteState("אפשר לשלוח ללקוח קישור לאישור וחתימה מהטלפון שלו. קודם שומרים את הקריאה, ואז פותחים אותה שוב ויוצרים קישור.", "");
    remoteState("אפשר לשלוח ללקוח קישור אישי. הוא יראה רק את הקריאה הזאת, כפי שנשמרה, ויחתום מהטלפון שלו ליד כל תיקון וגם חתימה כללית. שמרו שינויים לפני יצירת הקישור.", "");
    if (me.user_id === "demo") return;
    sb.from("approval_links").select("created_at, created_by_name, expires_at").eq("repair_id", id).is("used_at", null).is("revoked_at", null)
      .gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(1).then(function (r) {
        if (!editing || editing.id !== id || r.error || !r.data || !r.data.length || !$("remoteLinkRow").hidden) return;
        var l = r.data[0];
        remoteState("קישור פעיל נוצר ב-" + fmtDT(l.created_at) + (l.created_by_name ? " על ידי " + l.created_by_name : "") + ", בתוקף עד " + fmtDate(l.expires_at.slice(0, 10)) +
          ". הלקוח עדיין לא חתם. הקישור עצמו לא נשמר במערכת: כדי לשלוח שוב, צרו קישור חדש (הקודם יבוטל).", "");
        $("remoteCreate").textContent = "יצירת קישור חדש"; $("remoteRevoke").hidden = false;
      });
  }
  $("remoteCreate").addEventListener("click", function () {
    if (!editing || editing.isNew) return;
    var id = editing.id, btn = $("remoteCreate");
    msg("err", ""); btn.disabled = true;
    var p = me.user_id === "demo" ? Promise.resolve({ token: "DEMO-ONLY-0000000000000000000000000000000000", expires_at: new Date(Date.now() + 14 * 864e5).toISOString() })
      : fn({ action: "create", repair_id: id }, "remote-approval");
    p.then(function (res) {
      if (!editing || editing.id !== id) return;
      remoteState("הקישור מוכן ובתוקף עד " + fmtDate(res.expires_at.slice(0, 10)) + ". שלחו אותו ללקוח עכשיו: מטעמי אבטחה הוא לא יוצג שוב אחרי סגירת החלון. יצירת קישור חדש מבטלת את הקודם.", APPROVE_URL + "#" + res.token);
      btn.textContent = "יצירת קישור חדש"; $("remoteRevoke").hidden = false;
    }, function (e) { msg("err", e.message); }).then(function () { btn.disabled = false; });
  });
  $("remoteRevoke").addEventListener("click", function () {
    if (!editing || editing.isNew) return;
    var id = editing.id; msg("err", "");
    (me.user_id === "demo" ? Promise.resolve() : fn({ action: "revoke", repair_id: id }, "remote-approval")).then(function () {
      if (!editing || editing.id !== id) return;
      $("remoteRevoke").hidden = true; $("remoteCreate").textContent = "יצירת קישור לאישור מרחוק";
      remoteState("הקישור בוטל. הלקוח כבר לא יכול לחתום דרכו.", "");
    }, function (e) { msg("err", e.message); });
  });
  $("remoteCopy").addEventListener("click", function () {
    var inp = $("remoteLink"), btn = $("remoteCopy");
    function ok() { btn.textContent = "הועתק"; setTimeout(function () { btn.textContent = "העתקת הקישור"; }, 1800); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(inp.value).then(ok, function () { inp.select(); });
    else { inp.select(); try { document.execCommand("copy"); ok(); } catch (x) {} }
  });

  // ---------- photo strip for one repair ----------
  function photoStrip(list, label, locked, prefix) {
    var box = h("div", { class: "photos" });
    function draw() {
      return signed(list).then(function () {
        box.textContent = "";
        box.appendChild(h("div", { class: "title", text: label }));
        var thumbs = h("div", { class: "thumbs" });
        list.forEach(function (path) {
          var t = h("div", { class: "thumb" });
          if (urls[path]) t.appendChild(h("a", { href: urls[path], target: "_blank", rel: "noopener" }, h("img", { src: urls[path], alt: "תמונה", loading: "lazy" })));
          if (!locked) t.appendChild(h("button", { type: "button", "aria-label": "הסרת התמונה מהתיקון", text: "×",
            onclick: function () { var k = list.indexOf(path); if (k !== -1) list.splice(k, 1); draw(); } }));
          thumbs.appendChild(t);
        });
        if (!locked) {
          var input = h("input", { type: "file", accept: "image/*", multiple: "", "aria-label": label });
          input.addEventListener("change", function () { uploadInto(list, input, prefix, draw); });
          thumbs.appendChild(h("label", { class: "addphoto" }, input, h("span", { text: "הוספת תמונה" })));
        } else if (!list.length) thumbs.appendChild(h("span", { class: "stamp", text: "אין תמונות" }));
        box.appendChild(thumbs);
      });
    }
    draw();
    return box;
  }
  function uploadInto(list, input, prefix, redraw) {
    var files = Array.prototype.slice.call(input.files || []);
    if (!files.length) return;
    msg("err", ""); $("saveBtn").disabled = true; $("saveBtn").textContent = "מעלה תמונות…";
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () { return shrink(f); }).then(function (blob) {
        var type = /^image\/(png|jpeg|gif|webp)$/.test(blob.type) ? blob.type : "image/jpeg";
        var path = editing.id + "/" + prefix + "-" + crypto.randomUUID() + "." + (type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1]);
        return sb.storage.from(BUCKET).upload(path, blob, { contentType: type }).then(function (r) { if (r.error) throw r.error; list.push(path); });
      });
    });
    chain.catch(function () { msg("err", "העלאת התמונה נכשלה. אפשר להעלות JPG, PNG, GIF או WEBP עד 10MB."); })
      .then(redraw)
      .then(function () { $("saveBtn").disabled = false; $("saveBtn").textContent = "שמירה"; });
  }

  // ---------- repairs inside a call (each with its own customer signature) ----------
  function itemsOf(r) { return r && Array.isArray(r.items) ? r.items : []; }
  function sigText(name, at, remote) { return "נחתם על ידי " + (name || "לא צוין") + (at ? " בתאריך " + fmtDT(at) : "") + (remote ? " · נחתם מרחוק דרך קישור אישי" : ""); }
  function renumberItems() { editing.itemUi.forEach(function (ui, i) { ui.num.textContent = "תיקון " + (i + 1); }); $("itemsEmpty").hidden = editing.itemUi.length > 0; }
  function addItemCard(it) {
    var isSigned = !!it.signature_path, locked = isSigned && me.role !== "admin";   // a signed repair is frozen for everyone but an admin
    var ui = { item: it, pad: null, name: null, num: h("strong") };
    it.photos_before = Array.isArray(it.photos_before) ? it.photos_before : [];
    it.photos_after = Array.isArray(it.photos_after) ? it.photos_after : [];
    var tag = "repair-" + String(it.id).slice(0, 8);
    ui.title = h("input", { type: "text", autocomplete: "off" }); ui.title.value = it.title || "";
    ui.desc = h("textarea"); ui.desc.value = it.fix_desc || "";
    ui.date = h("input", { type: "date" }); ui.date.value = it.fix_date || "";
    ui.fixer = h("input", { type: "text", autocomplete: "off" }); ui.fixer.value = it.fixer || "";
    [ui.title, ui.desc, ui.date, ui.fixer].forEach(function (el) { el.disabled = locked; });
    var head = h("div", { class: "ihead" }, ui.num, isSigned ? h("span", { class: "pill done", text: "נחתם" }) : null);
    if (!locked) head.appendChild(h("button", { class: "btn small danger", type: "button", text: "הסרת התיקון", onclick: function () {
      editing.itemUi = editing.itemUi.filter(function (x) { return x !== ui; }); ui.node.remove(); renumberItems();
    } }));
    var sigBox = h("div", { class: "sig" }, h("div", { class: "title", text: "חתימת הלקוח על תיקון זה" }));
    function drawSigArea() {
      while (sigBox.childNodes.length > 1) sigBox.removeChild(sigBox.lastChild);
      ui.pad = null; ui.name = null;
      if (it.signature_path) {
        var img = h("img", { class: "isigimg", alt: "חתימת הלקוח" }), path = it.signature_path;
        sigBox.appendChild(img); sigBox.appendChild(h("div", { class: "stamp", text: sigText(it.signed_name, it.signed_at, it.signed_remote) }));
        if (me.role === "admin") sigBox.appendChild(h("button", { class: "btn small danger", type: "button", text: "הסרת החתימה", onclick: function () {
          it.signature_path = null; it.signed_name = ""; it.signed_at = null; it.signed_remote = false; drawSigArea();
        } }));
        signed([path]).then(function () { if (urls[path]) img.src = urls[path]; });
      } else {
        ui.name = h("input", { type: "text", autocomplete: "off", placeholder: "שם החותם (אם ריק, יירשם שם הרוכש)", "aria-label": "שם החותם" });
        var cv = h("canvas", { class: "sigpad small", "aria-label": "משטח חתימה לתיקון" }), clear = h("button", { class: "btn small", type: "button", text: "ניקוי החתימה" });
        sigBox.appendChild(ui.name); sigBox.appendChild(cv); sigBox.appendChild(clear);
        ui.pad = makePad(cv); clear.addEventListener("click", ui.pad.reset);
        if (cv.isConnected) ui.pad.reset();
      }
    }
    ui.node = h("div", { class: "item" }, head,
      h("div", { class: "grid" },
        h("label", { class: "f full", text: "הליקוי" }, ui.title),
        h("label", { class: "f full", text: "מה תוקן" }, ui.desc),
        h("label", { class: "f", text: "תאריך התיקון" }, ui.date),
        h("label", { class: "f", text: "מי תיקן" }, ui.fixer)),
      photoStrip(it.photos_before, "תמונות לפני התיקון", locked, tag + "-before"),
      photoStrip(it.photos_after, "תמונות אחרי התיקון", locked, tag + "-after"),
      sigBox);
    $("itemsBox").appendChild(ui.node);
    editing.itemUi.push(ui);
    drawSigArea();
    renumberItems();
    return ui;
  }
  function renderItems() {   // called once the dialog is visible, so each signature pad can measure itself
    var box = $("itemsBox"); box.textContent = ""; editing.itemUi = [];
    box.appendChild(h("div", { class: "stamp", id: "itemsEmpty", text: "עדיין לא נוספו תיקונים לקריאה. לחצו על \"הוספת תיקון\"." }));
    editing.items.forEach(addItemCard);
    renumberItems();
  }
  function blankItem() { return { id: crypto.randomUUID(), title: "", fix_desc: "", fix_date: null, fixer: "", photos_before: [], photos_after: [], signature_path: null, signed_name: "", signed_at: null }; }
  $("addItemBtn").addEventListener("click", function () { var ui = addItemCard(blankItem()); ui.title.focus(); });

  // ---------- change history: who changed what, and when ----------
  var FIELDS = { opened_on: "תאריך פתיחה", status: "סטטוס", project: "פרויקט", apartment: "בניין ודירה", buyer: "רוכש", issue: "תיאור הקריאה",
    fix_date: "תאריך תיקון אחרון", fix_desc: "מה תוקן", fixer: "מי תיקן", approved: "אישור רוכש", notes: "הערות", photos_before: "תמונות לפני", photos_after: "תמונות אחרי",
    signature_path: "חתימה כללית", signed_name: "שם החותם (חתימה כללית)", not_ours_reason: "נימוק (לא באחריותנו)", signed_remote: "חתימה כללית מרחוק" };
  function fval(k, v) {
    if (k === "signature_path") return v ? "נחתם" : "אין חתימה";
    if (k === "opened_on" || k === "fix_date") return fmtDate(v) || "ריק";
    if (k === "status") return STATUS[v] || String(v || "ריק");
    if (k === "approved" || k === "signed_remote") return v ? "כן" : "לא";
    if (k.indexOf("photos_") === 0) return (Array.isArray(v) ? v.length : 0) + " תמונות";
    v = v == null ? "" : String(v);
    return v ? (v.length > 80 ? v.slice(0, 80) + "…" : v) : "ריק";
  }
  var IFIELDS = { title: "הליקוי", fix_desc: "מה תוקן", fix_date: "תאריך תיקון", fixer: "מי תיקן" };
  function itemsDiff(a, b) {
    a = Array.isArray(a) ? a : []; b = Array.isArray(b) ? b : [];
    var lines = [];
    b.forEach(function (it, i) {
      var old = a.filter(function (x) { return x.id === it.id; })[0], label = "תיקון " + (i + 1);
      if (!old) {
        lines.push(label + " נוסף: " + fval("title", it.title || it.fix_desc));
        if (it.signature_path) lines.push(label + " – חתימת לקוח: נחתם" + (it.signed_name ? " (" + it.signed_name + ")" : ""));
        return;
      }
      Object.keys(IFIELDS).forEach(function (k) {
        if ((old[k] || "") !== (it[k] || "")) lines.push(label + " – " + IFIELDS[k] + ": " + fval(k, old[k]) + " ← " + fval(k, it[k]));
      });
      ["photos_before", "photos_after"].forEach(function (k) {
        if (JSON.stringify(old[k] || []) !== JSON.stringify(it[k] || [])) lines.push(label + " – " + FIELDS[k] + ": " + fval(k, old[k]) + " ← " + fval(k, it[k]));
      });
      if ((old.signature_path || "") !== (it.signature_path || ""))
        lines.push(label + " – חתימת לקוח: " + fval("signature_path", old.signature_path) + " ← " + fval("signature_path", it.signature_path) + (it.signature_path && it.signed_name ? " (" + it.signed_name + ")" : ""));
    });
    a.forEach(function (old) { if (!b.some(function (x) { return x.id === old.id; })) lines.push("תיקון הוסר: " + fval("title", old.title || old.fix_desc)); });
    return lines;
  }
  function loadHistory(id) {
    var box = $("histList"); box.textContent = ""; $("hist").hidden = true; $("hist").open = false;
    sb.from("repairs_history").select("id, action, changed_at, changed_by_name, row_data").eq("repair_id", id).order("id", { ascending: true }).then(function (r) {
      if (r.error || !r.data || !r.data.length || !editing || editing.id !== id) return;
      var items = historyItems(r.data);
      items.reverse().forEach(function (it) {
        var ul = h("ul");
        it.lines.forEach(function (l) { ul.appendChild(h("li", { text: l })); });
        box.appendChild(h("div", { class: "ev" }, h("div", { class: "hd", text: it.hd }), ul));
      });
      $("histSum").textContent = "היסטוריית שינויים (" + items.length + ")";
      $("hist").hidden = false;
    });
  }

  // ---------- PDF report for one call ----------
  // The report is laid out as ordinary HTML (so the browser sets the Hebrew), each block is
  // rendered to an image, and the images are stacked onto A4 pages without splitting a block.
  function fmtDT(iso) { if (!iso) return ""; var d = new Date(iso); return d.toLocaleDateString("he-IL") + " " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }); }
  function historyItems(data) {
    var prev = null, items = [];
    (data || []).forEach(function (e) {
      var cur = e.row_data || {}, lines = [];
      if (e.action === "INSERT") lines.push("הקריאה נפתחה");
      else if (e.action === "DELETE") lines.push("הקריאה נמחקה");
      else if (prev) {
        Object.keys(FIELDS).forEach(function (k) {
          if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) lines.push(FIELDS[k] + ": " + fval(k, prev[k]) + " ← " + fval(k, cur[k]));
        });
        lines = lines.concat(itemsDiff(prev.items, cur.items));
      }
      if (!lines.length) lines.push("נשמרה ללא שינוי בשדות");
      items.push({ hd: fmtDT(e.changed_at) + " · " + (e.changed_by_name || "לא ידוע"), lines: lines });
      prev = cur;
    });
    return items;
  }
  function buildReport(r, hist, imgUrls, link) {
    var root = h("div", { class: "report", dir: "rtl", lang: "he" }), pending = null;
    function block() {
      var b = h("div", { class: "rblock" });
      if (pending) { b.appendChild(h("h3", { class: "rsec", text: pending })); pending = null; }
      for (var i = 0; i < arguments.length; i++) if (arguments[i]) b.appendChild(arguments[i]);
      root.appendChild(b);
    }
    function kv(label, value) { return h("div", { class: "rkv" }, h("span", { class: "rk", text: label }), h("span", { class: "rv", text: value || "—" })); }
    function text(label, value) { block(label ? h("div", { class: "rk", text: label }) : null, h("p", { class: "rtext", text: value || "—" })); }
    function photos(title, paths) {
      if (!paths.length) return;
      pending = title + " (" + paths.length + ")";
      for (var i = 0; i < paths.length; i += 2) {
        var row = h("div", { class: "rphotos" });
        paths.slice(i, i + 2).forEach(function (p) {
          row.appendChild(imgUrls[p] ? h("img", { src: imgUrls[p], alt: "" }) : h("div", { class: "rmissing", text: "התמונה לא זמינה" }));
        });
        block(row);
      }
    }
    var st = STATUS[r.status] ? r.status : "open";
    block(h("div", { class: "rhead" },
      h("img", { src: "logo.png?v=13", alt: "" }),
      h("div", { class: "rtitle" }, h("div", { class: "rname", text: "מחלקת בדק סיטי פרוייקטים" }), h("div", { class: "rdoc", text: "דוח קריאת שירות" }),
        h("div", { class: "rmeta", text: "הופק בתאריך " + fmtDT(new Date().toISOString()) + (me ? " על ידי " + (me.full_name || me.email) : "") })),
      h("span", { class: "pill " + st, text: STATUS[st] })));
    block(h("div", { class: "rgrid" },
      kv("פרויקט", r.project), kv("בניין ודירה", r.apartment), kv("שם הרוכש", r.buyer), kv("סטטוס", STATUS[st]),
      kv("תאריך פתיחת הקריאה", fmtDate(r.opened_on)), kv("נרשמה במערכת", fmtDT(r.created_at) + (r.created_by_name ? " · " + r.created_by_name : ""))));
    pending = "תיאור הקריאה"; text("", r.issue);
    photos("תמונות כלליות לקריאה: לפני", r.photos_before || []);
    if (r.status === "not_ours") { pending = "נימוק: הליקוי לא באחריות החברה"; text("", r.not_ours_reason || "לא נרשם נימוק."); }
    var its = itemsOf(r);
    if (its.length) {
      pending = "תיקונים (" + its.length + ")";
      its.forEach(function (it, i) {
        var sigEl = it.signature_path
          ? h("div", { class: "risig" },
              imgUrls[it.signature_path] ? h("img", { class: "rsig", src: imgUrls[it.signature_path], alt: "" }) : h("div", { class: "rmissing", text: "תמונת החתימה לא זמינה" }),
              h("div", { class: "rk", text: "חתימת הלקוח על תיקון זה: " + sigText(it.signed_name, it.signed_at, it.signed_remote) }))
          : h("div", { class: "rk", text: "הלקוח לא חתם על תיקון זה." });
        block(h("div", { class: "ritem" },
          h("div", { class: "rititle", text: "תיקון " + (i + 1) + (it.title ? ": " + it.title : "") }),
          h("div", { class: "rgrid" }, kv("תאריך התיקון", fmtDate(it.fix_date)), kv("מי תיקן", it.fixer)),
          h("div", { class: "rk", text: "מה תוקן" }), h("p", { class: "rtext", text: it.fix_desc || "—" }),
          sigEl));
        photos("תיקון " + (i + 1) + ": תמונות לפני", it.photos_before || []);
        photos("תיקון " + (i + 1) + ": תמונות אחרי", it.photos_after || []);
      });
    } else { pending = "תיקונים"; text("", "לא נרשמו תיקונים בקריאה זו."); }
    photos("תמונות כלליות לקריאה: אחרי", r.photos_after || []);
    if (r.notes) { pending = "הערות"; text("", r.notes); }
    pending = "חתימה כללית של הלקוח על כל התיקונים";
    if (r.signature_path) block(
      imgUrls[r.signature_path] ? h("img", { class: "rsig", src: imgUrls[r.signature_path], alt: "" }) : h("div", { class: "rmissing", text: "תמונת החתימה לא זמינה" }),
      h("p", { class: "rtext", text: "נחתם על ידי " + (r.signed_name || "לא צוין") + " בתאריך " + fmtDT(r.signed_at) + ". מועד החתימה נרשם על ידי השרת." +
        (r.signed_remote ? " החתימה ניתנה מרחוק, דרך קישור אישי" + (link ? " שנוצר על ידי " + (link.created_by_name || "הצוות") + " בתאריך " + fmtDT(link.created_at) +
          (link.ip ? ". כתובת ה-IP של החותם: " + link.ip : "") : "") + "." : "") }));
    else text("", r.approved ? "הרוכש אישר את התיקונים (סומן על ידי הצוות, ללא חתימה כללית)." : "אין חתימה כללית.");
    if (hist.length) {
      pending = "היסטוריית שינויים";
      hist.forEach(function (it) {
        var ul = h("ul"); it.lines.forEach(function (l) { ul.appendChild(h("li", { text: l })); });
        block(h("div", { class: "rev" }, h("div", { class: "rhd", text: it.hd }), ul));
      });
    }
    return root;
  }
  function reportToPdf(root) {
    document.body.appendChild(root);
    var imgs = Array.prototype.slice.call(root.querySelectorAll("img"));
    return Promise.all(imgs.map(function (i) { return i.decode ? i.decode().catch(function () {}) : null; }))
      .then(function () { return document.fonts && document.fonts.ready; })
      .then(function () {
        // Group consecutive blocks (about four screens each) so the report is rendered a few times, not once per block,
        // then cut each rendered group back into its blocks so a page break never lands inside one.
        var blocks = Array.prototype.slice.call(root.querySelectorAll(".rblock")), groups = [], g = null, gh = 0;
        blocks.forEach(function (b) {
          var bh = b.offsetHeight;
          if (!g || gh + bh > 3200) { g = h("div", { class: "rgroup" }); root.insertBefore(g, b); groups.push(g); gh = 0; }
          g.appendChild(b); gh += bh;
        });
        var pieces = [], chain = Promise.resolve();
        groups.forEach(function (grp) {
          chain = chain.then(function () { return window.html2canvas(grp, { scale: 2, backgroundColor: "#ffffff", logging: false }); }).then(function (cv) {
            var box = grp.getBoundingClientRect(), k = cv.height / box.height;
            Array.prototype.forEach.call(grp.children, function (b) {
              var rc = b.getBoundingClientRect(), y0 = Math.round((rc.top - box.top) * k), hp = Math.min(Math.round(rc.height * k), cv.height - y0);
              if (hp <= 0) return;
              var t = document.createElement("canvas"); t.width = cv.width; t.height = hp;
              t.getContext("2d").drawImage(cv, 0, y0, cv.width, hp, 0, 0, cv.width, hp);
              pieces.push(t);
            });
          });
        });
        return chain.then(function () { return pieces; });
      }).then(function (canvases) {
        var doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" }), PW = doc.internal.pageSize.getWidth(), PH = doc.internal.pageSize.getHeight();
        var M = 30, W = PW - 2 * M, top = M, bottom = PH - 44, y = top, maxH = bottom - top;
        function put(cv) { var hh = cv.height * W / cv.width; if (y + hh > bottom + 0.5) { doc.addPage(); y = top; } doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", M, y, W, hh); y += hh; }
        canvases.forEach(function (cv) {
          if (!cv.width || !cv.height) return;
          if (cv.height * W / cv.width <= maxH) return put(cv);
          var slice = Math.floor(maxH * cv.width / W), off = 0;       // a block taller than a page is cut into page-high pieces
          while (off < cv.height) {
            var hp = Math.min(slice, cv.height - off), t = document.createElement("canvas");
            t.width = cv.width; t.height = hp; t.getContext("2d").drawImage(cv, 0, off, cv.width, hp, 0, 0, cv.width, hp);
            put(t); off += hp;
          }
        });
        var n = doc.getNumberOfPages();
        for (var p = 1; p <= n; p++) { doc.setPage(p); doc.setFontSize(9); doc.setTextColor(120); doc.text(p + " / " + n, PW / 2, PH - 22, { align: "center" }); }
        return doc;
      }).then(function (doc) { root.remove(); return doc; }, function (e) { root.remove(); throw e; });
  }
  window.bedekReport = { build: buildReport, toPdf: reportToPdf };   // pure layout helpers, exposed for testing; they read no data
  $("pdfBtn").addEventListener("click", function () {
    var r = editing && editing.record, btn = $("pdfBtn");
    if (!r) return;
    if (!window.html2canvas || !window.jspdf) return msg("err", "רכיב ה-PDF לא נטען. רעננו את הדף ונסו שוב.");
    btn.disabled = true; btn.textContent = "מכין PDF…"; msg("err", "");
    var paths = (r.photos_before || []).concat(r.photos_after || []).concat(r.signature_path ? [r.signature_path] : [])
      .concat(itemsOf(r).reduce(function (a, it) { return a.concat(it.photos_before || [], it.photos_after || [], it.signature_path ? [it.signature_path] : []); }, [])), map = {}, made = [];
    Promise.all(paths.map(function (p) {
      return sb.storage.from(BUCKET).download(p).then(function (res) { if (!res.error && res.data) { map[p] = URL.createObjectURL(res.data); made.push(map[p]); } });
    })).then(function () {
      return sb.from("repairs_history").select("id, action, changed_at, changed_by_name, row_data").eq("repair_id", r.id).order("id", { ascending: true });
    }).then(function (hr) {
      var hist = historyItems(hr.data);
      if (!r.signed_remote) return reportToPdf(buildReport(r, hist, map));
      return sb.from("approval_links").select("created_at, created_by_name, used_at, ip").eq("repair_id", r.id).not("used_at", "is", null).order("used_at", { ascending: false }).limit(1)
        .then(function (lr) { return reportToPdf(buildReport(r, hist, map, lr.data && lr.data[0])); });
    })
      .then(function (doc) { doc.save("bedek-" + (r.apartment || "").replace(/[^0-9A-Za-z\u0590-\u05FF]+/g, "-").slice(0, 40) + "-" + r.opened_on + ".pdf"); })
      .catch(function () { msg("err", "הפקת ה-PDF נכשלה. נסו שוב."); })
      .then(function () { made.forEach(function (u) { URL.revokeObjectURL(u); }); btn.disabled = false; btn.textContent = "ייצוא PDF"; });
  });

  // ---------- call form ----------
  function openForm(r) {
    editing = { id: r ? r.id : crypto.randomUUID(), isNew: !r, before: r ? r.photos_before.slice() : [], after: r ? r.photos_after.slice() : [],
      record: r || null, itemUi: [],
      items: itemsOf(r).length ? JSON.parse(JSON.stringify(r.items)) : [blankItem()],
      signature: r ? r.signature_path : null, signedName: r ? r.signed_name : "", signedAt: r ? r.signed_at : null };
    $("dlgTitle").textContent = r ? "עריכת קריאה" : "קריאה חדשה";
    $("f_date").value = r ? r.opened_on : today();
    $("f_status").value = r && STATUS[r.status] ? r.status : "open";
    $("f_project").value = r ? r.project : $("fProject").value;
    $("f_apartment").value = r ? r.apartment : "";
    $("f_buyer").value = r ? r.buyer : $("fBuyer").value;
    $("f_issue").value = r ? r.issue : "";
    $("f_notes").value = r ? r.notes : "";
    $("f_reason").value = r ? (r.not_ours_reason || "") : "";
    $("reasonWrap").hidden = $("f_status").value !== "not_ours";
    $("f_approved").checked = !!(r && r.approved);
    $("delBtn").hidden = !(r && me.role === "admin");
    $("pdfBtn").hidden = !r;
    $("delBtn").textContent = "מחיקת הקריאה"; $("delBtn").dataset.armed = "";
    msg("err", "");
    var stamp = "";
    if (r) {
      var d = new Date(r.updated_at);
      stamp = "נפתחה על ידי " + (r.created_by_name || "לא ידוע") + " · עודכנה לאחרונה " + d.toLocaleDateString("he-IL") + " " +
        d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) + (r.updated_by_name ? " על ידי " + r.updated_by_name : "");
    }
    $("stamp").textContent = stamp;
    if (r) loadHistory(r.id); else { $("hist").hidden = true; $("histList").textContent = ""; }
    renderPhotos("before"); renderPhotos("after");
    $("dlg").showModal();
    renderSig();   // after the dialog is visible, so the signature pads can measure themselves
    renderItems();
  }
  $("newBtn").addEventListener("click", function () { openForm(null); });
  $("f_status").addEventListener("change", function () { $("reasonWrap").hidden = $("f_status").value !== "not_ours"; });
  $("cancelBtn").addEventListener("click", function () { $("dlg").close(); });

  $("frm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!editing) return;
    var b = {
      opened_on: $("f_date").value, status: $("f_status").value, project: $("f_project").value.trim(), apartment: $("f_apartment").value.trim(),
      buyer: $("f_buyer").value.trim(), issue: $("f_issue").value.trim(), notes: $("f_notes").value.trim(),
      not_ours_reason: $("f_status").value === "not_ours" ? $("f_reason").value.trim() : "", approved: $("f_approved").checked,
      photos_before: editing.before.slice(), photos_after: editing.after.slice()
    };
    if (!b.opened_on) return msg("err", "חסר תאריך פתיחת הקריאה.");
    if (!b.apartment) return msg("err", "חסר בניין ודירה.");
    if (!b.issue) return msg("err", "חסר תיאור הקריאה.");

    // Collect the repairs. A card left completely empty is ignored.
    var items = [], sigJobs = [], i, ui, it, o, wantsSig, nm;
    for (i = 0; i < editing.itemUi.length; i++) {
      ui = editing.itemUi[i]; it = ui.item;
      o = { id: it.id, title: ui.title.value.trim(), fix_desc: ui.desc.value.trim(), fix_date: ui.date.value || null, fixer: ui.fixer.value.trim(),
            signature_path: it.signature_path || null, signed_name: it.signed_name || "",
            photos_before: it.photos_before.slice(), photos_after: it.photos_after.slice() };
      wantsSig = !it.signature_path && ui.pad && ui.pad.isDirty();
      if (!o.title && !o.fix_desc && !o.fix_date && !o.fixer && !wantsSig && !o.signature_path && !o.photos_before.length && !o.photos_after.length) continue;
      if (!o.title && !o.fix_desc) return msg("err", "בתיקון " + (i + 1) + " חסר תיאור: מה הליקוי או מה תוקן.");
      if (o.fix_date && o.fix_date < b.opened_on) return msg("err", "בתיקון " + (i + 1) + " תאריך התיקון מוקדם מתאריך פתיחת הקריאה.");
      if (wantsSig) {
        nm = ui.name.value.trim() || b.buyer;
        if (!nm) return msg("err", "בתיקון " + (i + 1) + " יש חתימה אבל חסר שם החותם.");
        sigJobs.push({ o: o, pad: ui.pad, name: nm });
      }
      items.push(o);
    }
    if (b.status === "done" && !items.some(function (x) { return x.fix_date && x.fix_desc; }))
      return msg("err", "כדי לסמן \"תוקן\" צריך לפחות תיקון אחד עם תאריך תיקון ופירוט של מה תוקן.");
    var newSig = !editing.signature && mainPad.isDirty(), signer = $("f_signedName").value.trim() || b.buyer;
    if (newSig && !signer) return msg("err", "יש חתימה כללית אבל חסר שם החותם.");

    $("saveBtn").disabled = true; msg("err", "");
    b.items = items;
    b.signature_path = editing.signature || null;
    function uploadSig(pad, name) {
      return pad.blob().then(function (blob) {
        var path = editing.id + "/" + name + "-" + crypto.randomUUID() + ".png";
        return sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/png" }).then(function (r) { if (r.error) throw r.error; return path; });
      });
    }
    var pre = Promise.resolve();
    sigJobs.forEach(function (job) {
      pre = pre.then(function () { return uploadSig(job.pad, "repair-signature"); }).then(function (path) { job.o.signature_path = path; job.o.signed_name = job.name; });
    });
    if (newSig) pre = pre.then(function () { return uploadSig(mainPad, "signature"); }).then(function (path) { b.signature_path = path; b.signed_name = signer; b.approved = true; });
    pre.then(function () {
      if (editing.isNew) { b.id = editing.id; return sb.from("repairs").insert(b); }
      return sb.from("repairs").update(b).eq("id", editing.id);
    }).then(function (r) {
      if (r.error) throw r.error;
      $("dlg").close(); load();
    }).catch(function (e) {
      msg("err", e && e.code === "42501" ? "אין לך הרשאה לבצע את השינוי הזה. תיקון חתום יכול לשנות רק מנהל." : "השמירה נכשלה. בדקו את החיבור ונסו שוב.");
    }).then(function () { $("saveBtn").disabled = false; });
  });
  $("delBtn").addEventListener("click", function () {
    var b = $("delBtn");
    if (!editing || editing.isNew) return;
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "ללחוץ שוב למחיקה סופית"; return; }
    b.disabled = true;
    sb.from("repairs").delete().eq("id", editing.id).then(function (r) {
      b.disabled = false;
      if (r.error) return msg("err", "המחיקה נכשלה. נסו שוב.");
      $("dlg").close(); load();
    });
  });

  // ---------- export ----------
  $("exportBtn").addEventListener("click", function () {
    if (!window.XLSX) return;
    var data = visible().map(function (r) {
      return {
        "תאריך פתיחה": fmtDate(r.opened_on), "סטטוס": STATUS[r.status] || "", "פרויקט": r.project, "בניין ודירה": r.apartment, "רוכש": r.buyer,
        "תיאור הקריאה": r.issue, "תאריך תיקון אחרון": fmtDate(r.fix_date),
        "תיקונים": itemsOf(r).map(function (it, i) {
          return (i + 1) + ". " + [it.title, it.fix_desc, fmtDate(it.fix_date), it.fixer, it.signature_path ? "נחתם" + (it.signed_remote ? " מרחוק" : "") + ": " + (it.signed_name || "") + " " + fmtDT(it.signed_at) : "לא נחתם",
            ((it.photos_before || []).length + (it.photos_after || []).length) ? "תמונות: " + ((it.photos_before || []).length + (it.photos_after || []).length) : ""].filter(Boolean).join(" | ");
        }).join("\n"), "מספר תיקונים": itemsOf(r).length,
        "נימוק (לא באחריותנו)": r.not_ours_reason || "", "הרוכש אישר": r.approved ? "כן" : "לא", "חתימה כללית: שם החותם": r.signed_name || "",
        "חתימה כללית: מועד": r.signed_at ? new Date(r.signed_at).toLocaleString("he-IL") : "",
        "חתימה כללית: אופן": r.signature_path ? (r.signed_remote ? "מרחוק, דרך קישור" : "במקום") : "", "הערות": r.notes, "תמונות לפני": r.photos_before.length, "תמונות אחרי": r.photos_after.length,
        "נפתחה על ידי": r.created_by_name, "עודכנה על ידי": r.updated_by_name, "עודכנה בתאריך": new Date(r.updated_at).toLocaleString("he-IL")
      };
    });
    if (!data.length) return;
    var ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [12, 9, 16, 18, 18, 40, 12, 70, 8, 30, 10, 16, 18, 16, 30, 10, 10, 16, 16, 18].map(function (w) { return { wch: w }; });
    var wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, ws, "קריאות");
    XLSX.writeFile(wb, "bedek-" + today() + ".xlsx");
  });

  // ---------- users (admin) ----------
  function loadUsers() {
    return sb.from("profiles").select("*").order("created_at").then(function (r) {
      var box = $("usersList"); box.textContent = "";
      (r.data || []).forEach(function (u) {
        var who = h("div", { class: "who", text: u.full_name || u.email }); who.appendChild(h("small", { text: u.email }));
        var sel = h("select", { "aria-label": "הרשאה" });
        Object.keys(ROLES).forEach(function (k) { sel.appendChild(h("option", { value: k, text: ROLES[k] })); });
        sel.value = u.role; sel.disabled = u.user_id === me.user_id;
        sel.addEventListener("change", function () {
          msg("usersErr", ""); msg("usersOk", "");
          fn({ action: "set_role", user_id: u.user_id, role: sel.value }).then(function () { msg("usersOk", "ההרשאה עודכנה."); }, function (e) { msg("usersErr", e.message); sel.value = u.role; });
        });
        var row = h("div", { class: "urow" }, who, sel);
        var rst = h("button", { class: "btn small rst", type: "button", text: "איפוס סיסמה" });
        rst.addEventListener("click", function () {
          if (row.querySelector(".pw")) return;
          var inp = h("input", { type: "text", placeholder: "סיסמה חדשה (8 תווים לפחות)", autocomplete: "off", "aria-label": "סיסמה חדשה" });
          var ok = h("button", { class: "btn small", type: "button", text: "שמירה" });
          ok.addEventListener("click", function () {
            msg("usersErr", ""); msg("usersOk", "");
            fn({ action: "set_password", user_id: u.user_id, password: inp.value }).then(function () { msg("usersOk", "הסיסמה של " + (u.full_name || u.email) + " הוחלפה."); pw.remove(); }, function (e) { msg("usersErr", e.message); });
          });
          var pw = h("div", { class: "pw" }, inp, ok); row.appendChild(pw); inp.focus();
        });
        row.appendChild(rst); box.appendChild(row);
      });
    });
  }
  $("usersBtn").addEventListener("click", function () { msg("usersErr", ""); msg("usersOk", ""); loadUsers(); $("usersDlg").showModal(); });
  $("usersClose").addEventListener("click", function () { $("usersDlg").close(); });
  $("newUserForm").addEventListener("submit", function (ev) {
    ev.preventDefault(); msg("usersErr", ""); msg("usersOk", "");
    var email = $("u_email").value.trim(), pass = $("u_pass").value;
    if (!email) return msg("usersErr", "חסר אימייל.");
    if (pass.length < 8) return msg("usersErr", "הסיסמה קצרה מדי. צריך 8 תווים לפחות.");
    $("u_add").disabled = true;
    fn({ action: "create", email: email, password: pass, full_name: $("u_name").value.trim(), role: $("u_role").value }).then(function () {
      msg("usersOk", "המשתמש נוסף. מסרו לו את האימייל והסיסמה הראשונית.");
      $("u_name").value = ""; $("u_email").value = ""; $("u_pass").value = "";
      return loadUsers();
    }, function (e) { msg("usersErr", e.message); }).then(function () { $("u_add").disabled = false; });
  });

  // ---------- login history (owner only) ----------
  var logRows = [];
  function deviceName(ua) {
    var os = /Android/.test(ua) ? "אנדרואיד" : /iPhone|iPad/.test(ua) ? "אייפון / אייפד" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "לא מזוהה";
    var br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
    return os + (br ? " · " + br : "");
  }
  function renderLog() {
    var box = $("logList"), who = $("logUser").value; box.textContent = "";
    var shown = logRows.filter(function (e) { return !who || e.user_name === who; });
    if (!shown.length) return box.appendChild(h("div", { class: "empty" }, h("strong", { text: "אין כניסות להצגה" })));
    box.appendChild(h("div", { class: "lrow lhead" }, h("span", { text: "מועד" }), h("span", { text: "משתמש" }), h("span", { text: "סוג" }), h("span", { text: "מכשיר" }), h("span", { text: "כתובת IP" })));
    shown.forEach(function (e) {
      box.appendChild(h("div", { class: "lrow" }, h("span", { class: "num", text: fmtDT(e.at) }), h("span", { text: e.user_name || "לא ידוע" }),
        h("span", { text: e.kind === "login" ? "כניסה עם סיסמה" : "פתיחת האתר" }), h("span", { text: deviceName(e.device || "") }), h("span", { class: "num", dir: "ltr", text: e.ip || "" })));
    });
  }
  $("logBtn").addEventListener("click", function () {
    $("logList").textContent = ""; $("logList").appendChild(h("div", { class: "empty" }, h("strong", { text: "טוען…" })));
    $("logDlg").showModal();
    sb.from("login_log").select("at, user_name, kind, device, ip").order("at", { ascending: false }).limit(500).then(function (r) {
      if (r.error) { $("logList").textContent = ""; return $("logList").appendChild(h("div", { class: "empty" }, h("strong", { text: "לא ניתן לטעון את ההיסטוריה" }))); }
      logRows = r.data || [];
      fillSelect($("logUser"), uniq(logRows.map(function (e) { return e.user_name; })), "כל המשתמשים");
      renderLog();
    });
  });
  $("logUser").addEventListener("change", renderLog);
  $("logClose").addEventListener("click", function () { $("logDlg").close(); });

  // ---------- own password ----------
  $("pwBtn").addEventListener("click", function () { $("p_new").value = ""; msg("pwErr", ""); msg("pwOk", ""); $("pwDlg").showModal(); });
  $("pwClose").addEventListener("click", function () { $("pwDlg").close(); });
  $("pwForm").addEventListener("submit", function (ev) {
    ev.preventDefault(); msg("pwErr", ""); msg("pwOk", "");
    var p = $("p_new").value;
    if (p.length < 8) return msg("pwErr", "הסיסמה קצרה מדי. צריך 8 תווים לפחות.");
    $("p_save").disabled = true;
    sb.auth.updateUser({ password: p }).then(function (r) {
      $("p_save").disabled = false;
      if (r.error) return msg("pwErr", "החלפת הסיסמה נכשלה. נסו סיסמה אחרת.");
      $("p_new").value = ""; msg("pwOk", "הסיסמה הוחלפה.");
    });
  });

  // Local preview only: on localhost, ?demo shows the screens with sample data and no server access, so the layout can be checked without an account.
  if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") && location.search.indexOf("demo") !== -1) {
    me = { user_id: "demo", email: "demo@example.com", full_name: "תצוגה מקדימה", role: location.search.indexOf("demo=staff") !== -1 ? "staff" : "admin", is_owner: false };
    var demoNow = new Date().toISOString();
    rows = [{ id: "00000000-0000-0000-0000-00000000d001", opened_on: "2026-11-10", status: "progress", project: "פרויקט לדוגמה", apartment: "בניין 2, דירה 14", buyer: "ישראל ישראלי",
      issue: "כמה ליקויים שדווחו אחרי הכניסה לדירה", fix_date: "2026-11-14", fix_desc: "", fixer: "", approved: false, notes: "", not_ours_reason: "",
      photos_before: [], photos_after: [], signature_path: null, signed_name: "", signed_at: null,
      items: [
        { id: "00000000-0000-0000-0000-00000000d101", title: "נזילה מתחת לכיור במטבח", fix_desc: "הוחלף סיפון ואטם", fix_date: "2026-11-14", fixer: "אינסטלטור", signature_path: "demo/sig.png", signed_name: "ישראל ישראלי", signed_at: demoNow },
        { id: "00000000-0000-0000-0000-00000000d102", title: "סדק בטיח בחדר השינה", fix_desc: "", fix_date: null, fixer: "", signature_path: null, signed_name: "", signed_at: null }],
      created_at: demoNow, created_by_name: "תצוגה מקדימה", updated_at: demoNow, updated_by_name: "תצוגה מקדימה" }];
    $("whoami").textContent = "תצוגה מקדימה מקומית, ללא חיבור לנתונים";
    $("usersBtn").hidden = me.role !== "admin";
    show("scrMain"); render();
    return;
  }
  boot();
})();
