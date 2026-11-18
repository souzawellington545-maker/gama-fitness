
(function () {
  "use strict";

  var originalSave = window.salvarTudo;
  var ready = false, timer = null, sending = false, pending = false;
  var cloudVersion = null, syncBlocked = false;
  var keys = ["planos", "alunos", "checkins", "aulas", "pagamentos", "cfg"];

  function localState() {
    return {
      planos: S.planos,
      alunos: S.alunos,
      checkins: S.checkins,
      aulas: S.aulas,
      pagamentos: S.pagamentos,
      cfg: S.cfg
    };
  }

  function validState(x) {
    return x && Array.isArray(x.planos) &&
      Array.isArray(x.alunos) &&
      Array.isArray(x.checkins) &&
      Array.isArray(x.aulas) &&
      Array.isArray(x.pagamentos) &&
      x.cfg && typeof x.cfg === "object";
  }

  function applyState(x) {
    if (!validState(x)) {
      throw new Error("O banco retornou dados inválidos.");
    }

    keys.forEach(function (k) {
      S[k] = x[k];
    });

    originalSave();
  }

  function api(url, options) {
    options = options || {};
    options.credentials = "same-origin";
    options.headers = Object.assign(
      { "Content-Type": "application/json" },
      options.headers || {}
    );

    return fetch("/api?" + url, options).then(function (r) {
      return r.json().catch(function () {
        return {};
      }).then(function (data) {
        if (!r.ok) {
          var error = new Error(data.error || "Erro de comunicação.");
          error.status = r.status;
          throw error;
        }
        return data;
      });
    });
  }

  function showGate(message) {
    var old = document.getElementById("gama-cloud-gate");
    if (old) old.remove();

    var gate = document.createElement("div");
    gate.id = "gama-cloud-gate";

    gate.innerHTML =
      '<div class="gama-gate-card">' +
        '<div class="gama-gate-logo">gama<span>fitness</span></div>' +
        '<h2>Acesso ao sistema</h2>' +
        '<p>Entre com a senha administrativa para acessar os dados da academia.</p>' +
        '<form id="gama-login-form">' +
          '<label for="gama-pass">Senha de acesso</label>' +
          '<input id="gama-pass" type="password" autocomplete="current-password" required>' +
          '<button type="submit">Entrar</button>' +
          '<div id="gama-gate-error" role="alert"></div>' +
        '</form>' +
      '</div>';

    document.body.appendChild(gate);

    document.getElementById("gama-login-form").addEventListener("submit", function (ev) {
      ev.preventDefault();

      var btn = this.querySelector("button");
      var pass = document.getElementById("gama-pass").value;

      btn.disabled = true;
      btn.textContent = "Entrando...";

      api("action=login", {
        method: "POST",
        body: JSON.stringify({ password: pass })
      })
        .then(loadCloud)
        .catch(function (e) {
          document.getElementById("gama-gate-error").textContent = e.message;
        })
        .finally(function () {
          btn.disabled = false;
          btn.textContent = "Entrar";
        });
    });

    if (message) {
      document.getElementById("gama-gate-error").textContent = message;
    }
  }

  function saveCloud() {
    if (!ready || syncBlocked) return;

    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 450);
  }

  function flush() {
    if (!ready || sending || !pending || syncBlocked) return;

    pending = false;
    sending = true;

    api("action=state", {
      method: "PUT",
      body: JSON.stringify({ state: localState(), expectedVersion: cloudVersion })
    })
      .then(function (data) {
        cloudVersion = data.version;
      })
      .catch(function (e) {
        console.error("GAMA sincronização:", e);
        if (e.status === 409) {
          syncBlocked = true;
          pending = false;
          try {
            localStorage.setItem(conflictKey, JSON.stringify({
              format: "gama-fitness-local-conflict",
              savedAt: new Date().toISOString(),
              cloudVersion: cloudVersion,
              state: localState()
            }));
          } catch (backupError) {
            console.error("GAMA backup local de conflito:", backupError);
          }
          if (window.toast) toast("Conflito detectado. Alterações deste aparelho foram guardadas em backup local; não recarregue antes de baixar.");
          return;
        }
        pending = true;
        if (window.toast) toast("Falha ao sincronizar: " + e.message);
      })
      .finally(function () {
        sending = false;
        if (pending) setTimeout(flush, 1200);
      });
  }

  var conflictKey = "gama_conflict_backup";

  function downloadLocalConflict() {
    var raw = localStorage.getItem(conflictKey);
    if (!raw) {
      if (window.toast) toast("Não há backup de conflito neste aparelho.");
      return;
    }

    var blob = new Blob([raw], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "gama-fitness-conflito-local.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function showConflictRecovery() {
    var gate = document.getElementById("gama-cloud-gate");
    if (!gate) return;

    var card = gate.querySelector(".gama-gate-card");
    card.innerHTML =
      '<div class="gama-gate-logo">gama<span>fitness</span></div>' +
      '<h2>Backup local protegido</h2>' +
      '<p>Este aparelho possui alterações que não foram enviadas porque outro aparelho salvou dados mais recentes.</p>' +
      '<p><strong>Baixe o arquivo antes de continuar.</strong> Ele contém os dados locais deste aparelho e ficará guardado mesmo se você atualizar a página.</p>' +
      '<button type="button" id="gama-download-conflict">Baixar alterações locais</button>' +
      '<button type="button" id="gama-continue-cloud" style="background:var(--sf);color:var(--ink);border:1px solid var(--ln)">Continuar mantendo o backup guardado</button>' +
      '<button type="button" id="gama-dismiss-conflict" style="background:transparent;color:var(--mut);border:1px solid var(--ln)">Já baixei: não mostrar novamente</button>';

    document.getElementById("gama-download-conflict").onclick = downloadLocalConflict;
    document.getElementById("gama-continue-cloud").onclick = function () {
      loadCloudData();
    };
    document.getElementById("gama-dismiss-conflict").onclick = function () {
      if (!confirm("Confirma que já baixou e guardou o arquivo de alterações locais? A cópia deste navegador será apagada.")) return;
      localStorage.removeItem(conflictKey);
      loadCloudData();
    };
  }

  function loadCloud() {
    if (localStorage.getItem(conflictKey)) {
      showConflictRecovery();
      return Promise.resolve();
    }
    return loadCloudData();
  }

  function loadCloudData() {
    return api("action=state").then(function (data) {
      if (data.initialized && validState(data.state)) {
        applyState(data.state);
        cloudVersion = data.version;
      } else {
        originalSave();
        return api("action=state", {
          method: "PUT",
          body: JSON.stringify({ state: localState(), expectedVersion: null })
        }).then(function (saved) { cloudVersion = saved.version; });
      }
    }).then(function () {
      ready = true;
      var gate = document.getElementById("gama-cloud-gate");
      if (gate) gate.remove();
      if (typeof go === "function") go();
      addLogout();
      startRefresh();
    });
  }

  // NOVO: baixa o backup protegido pela sessão do administrador.
  function downloadBackup(button) {
    if (!ready || button.disabled) return;

    button.disabled = true;
    button.textContent = "Gerando...";

    fetch("/api?action=backup", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    })
      .then(function (response) {
        if (!response.ok) {
          return response.json().catch(function () {
            return {};
          }).then(function (data) {
            throw new Error(data.error || "Não foi possível gerar o backup.");
          });
        }

        return response.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var link = document.createElement("a");

        link.href = url;
        link.download = "gama-fitness-backup.json";

        document.body.appendChild(link);
        link.click();
        link.remove();

        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 2000);

        if (window.toast) {
          toast("Backup baixado com sucesso!");
        }
      })
      .catch(function (error) {
        console.error("GAMA backup:", error);

        if (window.toast) {
          toast("Erro no backup: " + error.message);
        } else {
          alert("Erro no backup: " + error.message);
        }
      })
      .finally(function () {
        button.disabled = false;
        button.textContent = "Backup";
      });
  }

  function addLogout() {
    var main = document.querySelector("main");

    if (!main) return;

    // Botão de backup
    if (!document.getElementById("gama-backup")) {
      var backup = document.createElement("button");

      backup.id = "gama-backup";
      backup.type = "button";
      backup.textContent = "Backup";

      backup.style.cssText =
        "position:fixed;right:14px;top:12px;z-index:8;" +
        "border:1px solid var(--ac);background:var(--ac);" +
        "color:var(--acx);border-radius:8px;padding:7px 12px;" +
        "font-weight:700;cursor:pointer";

      backup.onclick = function () {
        downloadBackup(backup);
      };

      document.body.appendChild(backup);
    }

    // Botão de sair
    if (!document.getElementById("gama-logout")) {
      var b = document.createElement("button");

      b.id = "gama-logout";
      b.type = "button";
      b.textContent = "Sair";

      b.style.cssText =
        "position:fixed;right:14px;top:54px;z-index:8;" +
        "border:1px solid var(--ln);background:var(--sf);" +
        "color:var(--ink);border-radius:8px;padding:7px 12px;" +
        "font-weight:600;cursor:pointer";

      b.onclick = function () {
        api("action=logout", {
          method: "POST",
          body: "{}"
        }).finally(function () {
          ready = false;

          var backup = document.getElementById("gama-backup");
          if (backup) backup.remove();

          b.remove();
          showGate();
        });
      };

      document.body.appendChild(b);
    }
  }

  function startRefresh() {
    // Atualiza alterações feitas em outro aparelho.
    // Não sobrescreve enquanto há gravação local pendente.
    setInterval(function () {
      if (
        !ready ||
        syncBlocked ||
        pending ||
        sending ||
        document.visibilityState !== "visible"
      ) return;

      api("action=state").then(function (data) {
        // A edição pode começar enquanto a consulta está em trânsito.
        if (pending || sending || syncBlocked) return;
        if (data.initialized && validState(data.state) && data.version !== cloudVersion) {
          applyState(data.state);
          cloudVersion = data.version;

          if (typeof go === "function") go();
        }
      }).catch(function (e) {
        console.warn("GAMA atualização:", e.message);
      });

    }, 15000);
  }

  window.salvarTudo = function () {
    if (typeof originalSave === "function") {
      originalSave();
    }

    saveCloud();
  };

  // Mantém a aplicação escondida até autenticar e carregar o estado central.
  var style = document.createElement("style");

  style.textContent =
    '#gama-cloud-gate{' +
      'position:fixed;inset:0;z-index:99999;' +
      'background:var(--bg);display:grid;place-items:center;' +
      'padding:20px;font-family:Archivo,system-ui,sans-serif;' +
      'color:var(--ink)' +
    '}' +
    '.gama-gate-card{' +
      'width:min(420px,100%);background:var(--sf);' +
      'border:1px solid var(--ln);border-radius:16px;' +
      'padding:28px;box-shadow:0 20px 60px #0005' +
    '}' +
    '.gama-gate-logo{' +
      'font-size:26px;font-weight:800;margin-bottom:22px' +
    '}' +
    '.gama-gate-logo span{color:var(--ac)}' +
    '.gama-gate-card p{color:var(--mut)}' +
    '.gama-gate-card label{' +
      'display:block;margin:16px 0 6px;color:var(--mut)' +
    '}' +
    '.gama-gate-card input{' +
      'width:100%;padding:12px;border-radius:8px;' +
      'border:1px solid var(--ln);background:var(--bg);' +
      'color:var(--ink)' +
    '}' +
    '.gama-gate-card button{' +
      'width:100%;margin-top:14px;padding:12px;border:0;' +
      'border-radius:8px;background:var(--ac);' +
      'color:var(--acx);font-weight:700;cursor:pointer' +
    '}' +
    '.gama-gate-card button:disabled{opacity:.6}' +
    '#gama-gate-error{' +
      'color:var(--er);margin-top:12px;font-size:13px' +
    '}';

  document.head.appendChild(style);

  if (typeof originalSave !== "function") {
    showGate("Não foi possível iniciar a integração. Recarregue a página.");
    return;
  }

  showGate();

  api("action=state").then(loadCloud).catch(function (e) {
    // 401 significa sessão ausente; demais erros indicam configuração ou conexão.
    showGate(e.message);
  });

})();
