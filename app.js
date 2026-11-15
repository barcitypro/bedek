// Refuse to run inside a frame on another site (clickjacking protection).
if (window.top !== window.self) { document.documentElement.hidden = true; throw new Error("framed"); }
(function () {
  "use strict";
  // The publishable key is meant to be public: every table and the photo bucket are protected by row-level rules.
  var SUPABASE_URL = "https://kvdhdxcbxvmjnaezbtwx.supabase.co";
  var SUPABASE_KEY = "sb_publishable_7s4w3CA_cjgQsPkvkPAN6w_cFbs45Hs";
  var BUCKET = "repair-photos";
  var PHOTO_LINK_SECONDS = 365 * 24 * 60 * 60;   // how long a photo link opened from the app keeps working: one year
  var STATUS = { open: "פתוח", progress: "בטיפול", done: "תוקן" };
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
    not_signed_in: "פג תוקף הכניסה. היכנסו שוב.", cannot_change_self: "אי אפשר לשנות את ההרשאה של עצמך."
  };
  function fn(body) {
    return sb.auth.getSession().then(function (r) {
      var s = r.data.session;
      return fetch(SUPABASE_URL + "/functions/v1/admin-users", {
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
        return enter();
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
      if (r.data.session) return enter();
      return fn({ action: "status" }).then(function (s) { showAuth(!!s.needsSetup); }, function () { showAuth(false); });
    });
  }
  function enter() {
    return sb.auth.getUser().then(function (r) {
      if (r.error || !r.data.user) return showAuth(false);
      return sb.from("profiles").select("*").eq("user_id", r.data.user.id).maybeSingle().then(function (p) {
        if (!p.data || p.data.role === "disabled") { me = null; return show("scrBlocked"); }
        me = p.data;
        $("whoami").textContent = "מחוברים בתור " + (me.full_name || me.email) + " · " + ROLES[me.role];
        $("usersBtn").hidden = me.role !== "admin";
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
    if (q && [r.project, r.apartment, r.buyer, r.issue, r.fix_desc, r.fixer, r.notes].join(" ").toLowerCase().indexOf(q) === -1) return false;
    return true;
  }
  function visible() { return rows.filter(function (r) { return baseMatch(r) && (statusFilter === "all" || r.status === statusFilter); }); }
  function render() {
    refreshFilters();
    var base = rows.filter(baseMatch), c = { all: base.length, open: 0, progress: 0, done: 0 };
    base.forEach(function (r) { if (c[r.status] !== undefined) c[r.status]++; });
    var box = $("counts"); box.textContent = "";
    [["all", "הכול"], ["open", STATUS.open], ["progress", STATUS.progress], ["done", STATUS.done]].forEach(function (p) {
      box.appendChild(h("button", { class: "count", type: "button", "aria-pressed": String(statusFilter === p[0]), onclick: function () { statusFilter = p[0]; render(); } },
        h("span", { text: p[1] }), h("b", { text: String(c[p[0]]) })));
    });
    var shown = visible(), list = $("list"); list.textContent = "";
    $("shown").textContent = rows.length ? "מוצגות " + shown.length + " מתוך " + rows.length + " קריאות" : "";
    if (!rows.length) return list.appendChild(h("div", { class: "empty" }, h("strong", { text: "עדיין אין קריאות ביומן" }), document.createTextNode("לחצו על \"קריאה חדשה\" כדי לפתוח את הקריאה הראשונה.")));
    if (!shown.length) return list.appendChild(h("div", { class: "empty" }, h("strong", { text: "אין קריאות שמתאימות לסינון" }), document.createTextNode("שנו את הסינון או לחצו על \"ניקוי סינון\".")));
    shown.forEach(function (r) {
      var n = r.photos_before.length + r.photos_after.length, meta = [];
      if (r.fix_date) meta.push("תוקן ב-" + fmtDate(r.fix_date));
      if (r.signature_path) meta.push("נחתם");
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
      box.appendChild(h("div", { class: "title", text: kind === "before" ? "תמונות לפני" : "תמונות אחרי" }));
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
  var pad = $("sigPad"), ctx = pad.getContext("2d"), sigDirty = false, drawing = false;
  function sigReset() {   // ink is always dark on white, whatever the page theme, so the saved image reads the same everywhere
    var dpr = window.devicePixelRatio || 1, w = pad.clientWidth || 560, hh = pad.clientHeight || 160;
    pad.width = Math.round(w * dpr); pad.height = Math.round(hh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hh);
    ctx.strokeStyle = "#111"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    sigDirty = false;
  }
  function sigPos(e) { var r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  pad.addEventListener("pointerdown", function (e) {
    e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch (x) {}
    var p = sigPos(e); drawing = true; sigDirty = true;
    ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0] + 0.1, p[1] + 0.1); ctx.stroke();
  });
  pad.addEventListener("pointermove", function (e) { if (!drawing) return; var p = sigPos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (n) { pad.addEventListener(n, function () { drawing = false; }); });
  $("sigClear").addEventListener("click", sigReset);
  $("sigRemove").addEventListener("click", function () { editing.signature = null; renderSig(); });
  function renderSig() {
    var has = !!editing.signature;
    $("sigDone").hidden = !has; $("sigNew").hidden = has;
    if (!has) { $("f_signedName").value = ""; sigReset(); return; }
    var d = editing.signedAt ? new Date(editing.signedAt) : null;
    $("sigInfo").textContent = "נחתם על ידי " + (editing.signedName || "לא צוין") +
      (d ? " בתאריך " + d.toLocaleDateString("he-IL") + " בשעה " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "");
    $("sigRemove").hidden = me.role !== "admin";
    $("sigImg").removeAttribute("src");
    var path = editing.signature;
    signed([path]).then(function () { if (editing && editing.signature === path && urls[path]) $("sigImg").src = urls[path]; });
  }

  // ---------- change history: who changed what, and when ----------
  var FIELDS = { opened_on: "תאריך פתיחה", status: "סטטוס", project: "פרויקט", apartment: "בניין ודירה", buyer: "רוכש", issue: "תיאור הליקוי",
    fix_date: "תאריך תיקון", fix_desc: "מה תוקן", fixer: "מי תיקן", approved: "אישור רוכש", notes: "הערות", photos_before: "תמונות לפני", photos_after: "תמונות אחרי",
    signature_path: "חתימת לקוח", signed_name: "שם החותם" };
  function fval(k, v) {
    if (k === "signature_path") return v ? "נחתם" : "אין חתימה";
    if (k === "opened_on" || k === "fix_date") return fmtDate(v) || "ריק";
    if (k === "status") return STATUS[v] || String(v || "ריק");
    if (k === "approved") return v ? "כן" : "לא";
    if (k.indexOf("photos_") === 0) return (Array.isArray(v) ? v.length : 0) + " תמונות";
    v = v == null ? "" : String(v);
    return v ? (v.length > 80 ? v.slice(0, 80) + "…" : v) : "ריק";
  }
  function loadHistory(id) {
    var box = $("histList"); box.textContent = ""; $("hist").hidden = true; $("hist").open = false;
    sb.from("repairs_history").select("id, action, changed_at, changed_by_name, row_data").eq("repair_id", id).order("id", { ascending: true }).then(function (r) {
      if (r.error || !r.data || !r.data.length || !editing || editing.id !== id) return;
      var prev = null, items = [];
      r.data.forEach(function (e) {
        var cur = e.row_data || {}, lines = [];
        if (e.action === "INSERT") lines.push("הקריאה נפתחה");
        else if (prev) Object.keys(FIELDS).forEach(function (k) {
          if (JSON.stringify(prev[k]) !== JSON.stringify(cur[k])) lines.push(FIELDS[k] + ": " + fval(k, prev[k]) + " ← " + fval(k, cur[k]));
        });
        if (!lines.length) lines.push("נשמרה ללא שינוי בשדות");
        var d = new Date(e.changed_at);
        items.push({ hd: d.toLocaleDateString("he-IL") + " " + d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) + " · " + (e.changed_by_name || "לא ידוע"), lines: lines });
        prev = cur;
      });
      items.reverse().forEach(function (it) {
        var ul = h("ul");
        it.lines.forEach(function (l) { ul.appendChild(h("li", { text: l })); });
        box.appendChild(h("div", { class: "ev" }, h("div", { class: "hd", text: it.hd }), ul));
      });
      $("histSum").textContent = "היסטוריית שינויים (" + items.length + ")";
      $("hist").hidden = false;
    });
  }

  // ---------- call form ----------
  function openForm(r) {
    editing = { id: r ? r.id : crypto.randomUUID(), isNew: !r, before: r ? r.photos_before.slice() : [], after: r ? r.photos_after.slice() : [],
      signature: r ? r.signature_path : null, signedName: r ? r.signed_name : "", signedAt: r ? r.signed_at : null };
    $("dlgTitle").textContent = r ? "עריכת קריאה" : "קריאה חדשה";
    $("f_date").value = r ? r.opened_on : today();
    $("f_status").value = r && STATUS[r.status] ? r.status : "open";
    $("f_project").value = r ? r.project : $("fProject").value;
    $("f_apartment").value = r ? r.apartment : "";
    $("f_buyer").value = r ? r.buyer : $("fBuyer").value;
    $("f_issue").value = r ? r.issue : "";
    $("f_fixDate").value = r && r.fix_date ? r.fix_date : "";
    $("f_fixer").value = r ? r.fixer : "";
    $("f_fixDesc").value = r ? r.fix_desc : "";
    $("f_notes").value = r ? r.notes : "";
    $("f_approved").checked = !!(r && r.approved);
    $("delBtn").hidden = !(r && me.role === "admin");
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
    renderSig();   // after the dialog is visible, so the signature pad can measure itself
  }
  $("newBtn").addEventListener("click", function () { openForm(null); });
  $("cancelBtn").addEventListener("click", function () { $("dlg").close(); });
  $("f_status").addEventListener("change", function () { if ($("f_status").value === "done" && !$("f_fixDate").value) $("f_fixDate").value = today(); });

  $("frm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!editing) return;
    var b = {
      opened_on: $("f_date").value, status: $("f_status").value, project: $("f_project").value.trim(), apartment: $("f_apartment").value.trim(),
      buyer: $("f_buyer").value.trim(), issue: $("f_issue").value.trim(), fix_date: $("f_fixDate").value || null, fixer: $("f_fixer").value.trim(),
      fix_desc: $("f_fixDesc").value.trim(), notes: $("f_notes").value.trim(), approved: $("f_approved").checked,
      photos_before: editing.before.slice(), photos_after: editing.after.slice()
    };
    if (!b.opened_on) return msg("err", "חסר תאריך פתיחת הקריאה.");
    if (!b.apartment) return msg("err", "חסר בניין ודירה.");
    if (!b.issue) return msg("err", "חסר תיאור הליקוי.");
    if (b.status === "done" && !b.fix_date) return msg("err", "כדי לסמן \"תוקן\" צריך למלא את תאריך התיקון.");
    if (b.status === "done" && !b.fix_desc) return msg("err", "כדי לסמן \"תוקן\" צריך לפרט מה תוקן.");
    if (b.fix_date && b.fix_date < b.opened_on) return msg("err", "תאריך התיקון מוקדם מתאריך פתיחת הקריאה.");
    var newSig = !editing.signature && sigDirty, signer = $("f_signedName").value.trim();
    if (newSig && !signer) return msg("err", "יש חתימה אבל חסר שם החותם.");
    $("saveBtn").disabled = true; msg("err", "");
    b.signature_path = editing.signature || null;
    var pre = Promise.resolve();
    if (newSig) pre = new Promise(function (res) { pad.toBlob(res, "image/png"); }).then(function (blob) {
      var path = editing.id + "/signature-" + crypto.randomUUID() + ".png";
      return sb.storage.from(BUCKET).upload(path, blob, { contentType: "image/png" }).then(function (r) {
        if (r.error) throw r.error;
        b.signature_path = path; b.signed_name = signer; b.approved = true;
      });
    });
    pre.then(function () {
      if (editing.isNew) { b.id = editing.id; return sb.from("repairs").insert(b); }
      return sb.from("repairs").update(b).eq("id", editing.id);
    }).then(function (r) {
      if (r.error) throw r.error;
      $("dlg").close(); load();
    }).catch(function (e) {
      msg("err", e && e.code === "42501" ? "אין לך הרשאה לבצע את השינוי הזה." : "השמירה נכשלה. בדקו את החיבור ונסו שוב.");
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
        "תיאור הליקוי": r.issue, "תאריך תיקון": fmtDate(r.fix_date), "מה תוקן": r.fix_desc, "מי תיקן": r.fixer,
        "הרוכש אישר": r.approved ? "כן" : "לא", "שם החותם": r.signed_name || "",
        "מועד חתימה": r.signed_at ? new Date(r.signed_at).toLocaleString("he-IL") : "", "הערות": r.notes, "תמונות לפני": r.photos_before.length, "תמונות אחרי": r.photos_after.length,
        "נפתחה על ידי": r.created_by_name, "עודכנה על ידי": r.updated_by_name, "עודכנה בתאריך": new Date(r.updated_at).toLocaleString("he-IL")
      };
    });
    if (!data.length) return;
    var ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [12, 9, 16, 18, 18, 40, 12, 40, 16, 10, 16, 18, 30, 10, 10, 16, 16, 18].map(function (w) { return { wch: w }; });
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

  boot();
})();
