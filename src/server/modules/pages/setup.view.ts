export function setupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATM Setup</title>
  <link rel="icon" href="/assets/brand/atm-persona.svg">
  ${styles()}
</head>
<body>
  <main class="shell">
    <header class="product-header">
      <div class="brand-lockup">
        <img class="brand-avatar" src="/assets/brand/atm-persona.svg" alt="">
        <div>
          <p class="eyebrow">ATM · Agent Tasks Manager</p>
          <h1>Connect existing agents to self-hosted tasks.</h1>
          <p class="muted">Install one plugin into Hermes or OpenClaw. Keep Slack ownership with the agent you already run.</p>
        </div>
      </div>
      <a class="link-button" href="/dashboard">Dashboard</a>
    </header>

    <section class="grid setup-grid">
      <form id="admin-form" class="panel">
        <div class="step">Step 1</div>
        <h2>Admin</h2>
        <p class="panel-copy">Create the local administrator. After this, setup is locked.</p>
        <label>Email <input name="email" type="email" autocomplete="email" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <button type="submit">Create Admin</button>
        <p id="admin-result" class="result"></p>
      </form>

      <section class="panel">
        <div class="step">Step 2</div>
        <h2>Storage</h2>
        <p class="panel-copy">Verify writable task, event, audit, and SQLite paths.</p>
        <dl id="storage-list" class="kv"></dl>
        <button id="storage-check" type="button">Check Storage</button>
        <p id="storage-result" class="result"></p>
      </section>

      <form id="agent-form" class="panel wide">
        <div class="step">Steps 3-4</div>
        <h2>Install Agent Plugin</h2>
        <p class="panel-copy">ATM auto-detects local or mounted agent workspaces, installs the plugin, and runs a credential smoke test.</p>
        <div class="agent-choices" role="radiogroup" aria-label="Agent type">
          <label class="agent-choice">
            <input type="radio" name="type" value="hermes" checked>
            <span>Hermes Agent</span>
          </label>
          <label class="agent-choice">
            <input type="radio" name="type" value="openclaw">
            <span>OpenClaw</span>
          </label>
        </div>
        <div id="workspace-status" class="detect-status">Create admin first, then workspace detection will run.</div>
        <label id="workspace-choice" class="hidden">Detected workspace
          <select id="workspace-select"></select>
        </label>
        <label class="check"><input name="runReload" type="checkbox" checked> Run reload command after install</label>
        <input name="regenerateToken" type="hidden" value="on">
        <details class="advanced">
          <summary>Advanced diagnostics</summary>
          <div class="row">
            <label>CLI path <input name="cliPath" placeholder="hermes"></label>
            <label>Config path <input name="configPath" placeholder="/opt/hermes/config.yml"></label>
          </div>
          <label>Manual workspace path <input id="manual-workspace" placeholder="/opt/hermes"></label>
        </details>
        <div class="button-row">
          <button type="submit">Install Plugin</button>
          <button id="uninstall-plugin" type="button">Uninstall Plugin</button>
        </div>
        <div id="agent-result" class="result"></div>
        <section id="agent-next" class="quick-grid hidden">
          <div class="quick-block">
            <div class="command-head"><h3>Environment</h3><button type="button" data-copy="env-block">Copy</button></div>
            <pre id="env-block" class="commands"></pre>
          </div>
          <div class="quick-block">
            <div class="command-head"><h3>Install</h3><button type="button" data-copy="install-commands">Copy</button></div>
            <pre id="install-commands" class="commands"></pre>
          </div>
          <div class="quick-block">
            <div class="command-head"><h3>Smoke Test</h3><button type="button" data-copy="smoke-test">Copy</button></div>
            <pre id="smoke-test" class="commands"></pre>
          </div>
          <div class="quick-block">
            <h3>Checks</h3>
            <ul id="agent-checks" class="checks"></ul>
          </div>
        </section>
      </form>

      <form id="cloudflare-form" class="panel">
        <div class="step">Step 5</div>
        <h2>Cloudflare Tunnel</h2>
        <p class="panel-copy">Optional public dashboard URL. It is only an ingress layer.</p>
        <label>Public URL <input name="publicUrl" placeholder="https://tasks.example.com"></label>
        <button type="submit">Test URL</button>
        <p id="cloudflare-result" class="result"></p>
      </form>

      <form id="permissions-form" class="panel">
        <div class="step">Step 6</div>
        <h2>Slack Permissions</h2>
        <p class="panel-copy">Review the existing agent bot scopes. ATM does not need a second Slack app.</p>
        <ul class="checks permission-list">
          <li>Existing agent bot can read target channels and thread context.</li>
          <li>Existing agent bot can post thread replies.</li>
          <li>Existing agent bot can DM assignees if assignment prompts use DM.</li>
          <li>Existing agent ignores bot-origin messages to prevent loops.</li>
          <li>Existing agent command/mention gating is enabled for manual channels.</li>
        </ul>
        <button type="submit">Mark Reviewed</button>
        <p id="permissions-result" class="result"></p>
      </form>

      <form id="channel-form" class="panel">
        <div class="step">Optional</div>
        <h2>Automation Mode</h2>
        <p class="panel-copy">Keep channels manual by default. Enable suggestions only where the team expects proposals.</p>
        <label>Slack channel ID <input name="channelId" placeholder="C0123456789" required></label>
        <label>Mode
          <select name="mode">
            <option value="manual_only">manual_only - explicit commands only</option>
            <option value="suggest_only">suggest_only - propose with confirmation</option>
          </select>
        </label>
        <button type="submit">Save Automation Mode</button>
        <p id="channel-result" class="result"></p>
      </form>
    </section>
  </main>
  <script>
    const state = { token: localStorage.getItem('tm_admin_token') || '' };
    const $ = (id) => document.getElementById(id);

    async function api(path, options = {}) {
      const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
      if (state.token) headers.authorization = 'Bearer ' + state.token;
      const response = await fetch(path, Object.assign({}, options, { headers }));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    }

    function formData(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    function setResult(id, message, ok = true) {
      const node = $(id);
      node.textContent = message;
      node.className = ok ? 'result ok' : 'result error';
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
    }

    function renderStorage(storage) {
      $('storage-list').innerHTML = [
        ['Data', storage.dataDir],
        ['Tasks', storage.tasksDir],
        ['Events', storage.eventsDir],
        ['SQLite', storage.sqlitePath],
        ['Config', storage.configPath]
      ].map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
    }

    function selectedAgentType() {
      return document.querySelector('input[name="type"]:checked').value;
    }

    async function detectWorkspace() {
      const type = selectedAgentType();
      $('workspace-status').textContent = 'Detecting ' + type + ' workspace...';
      $('workspace-status').className = 'detect-status';
      try {
        const data = await api('/api/setup/agent/workspaces?type=' + encodeURIComponent(type));
        if (!data.selected) {
          $('workspace-choice').classList.add('hidden');
          $('workspace-select').innerHTML = '';
          $('workspace-status').textContent = data.candidates.length
            ? 'Found candidates, but none are writable enough for automatic install. Use Advanced if needed.'
            : 'No workspace detected. Use Advanced only if this agent runs on this same server or mounted volume.';
          $('workspace-status').className = 'detect-status warn';
          return;
        }

        $('workspace-select').innerHTML = data.candidates
          .filter((item) => item.exists)
          .map((item) => '<option value="' + escapeHtml(item.path) + '"' + (item.path === data.selected.path ? ' selected' : '') + '>' + escapeHtml(item.path + ' · ' + item.confidence + ' · ' + item.source) + '</option>')
          .join('');
        $('workspace-choice').classList.remove('hidden');
        $('workspace-status').textContent = 'Detected workspace: ' + data.selected.path;
        $('workspace-status').className = 'detect-status ok';
      } catch (error) {
        $('workspace-choice').classList.add('hidden');
        $('workspace-status').textContent = 'Workspace detection will run after admin login.';
        $('workspace-status').className = 'detect-status warn';
      }
    }

    async function loadStatus() {
      const status = await api('/api/setup/status', { headers: {} }).catch(() => null);
      if (!status) return;
      renderStorage(status.storage);
      if (status.setupLocked) setResult('admin-result', 'Setup locked. Use dashboard login.', true);
    }

    $('admin-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/setup/admin', {
          method: 'POST',
          body: JSON.stringify(formData(event.currentTarget))
        });
        state.token = data.token;
        localStorage.setItem('tm_admin_token', data.token);
        setResult('admin-result', 'Admin created and setup locked.');
        await detectWorkspace();
      } catch (error) {
        setResult('admin-result', error.message, false);
      }
    });

    $('storage-check').addEventListener('click', async () => {
      try {
        const data = await api('/api/setup/storage/check', { method: 'POST', body: '{}' });
        renderStorage(data.storage);
        setResult('storage-result', 'Storage is ready.');
      } catch (error) {
        setResult('storage-result', error.message, false);
      }
    });

    $('agent-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const raw = formData(event.currentTarget);
      const manualWorkspace = $('manual-workspace').value.trim();
      const detectedWorkspace = $('workspace-select').value;
      const body = {
        type: raw.type,
        cliPath: raw.cliPath,
        configPath: raw.configPath,
        workspacePath: manualWorkspace || detectedWorkspace || undefined,
        runReload: Boolean(raw.runReload),
        regenerateToken: Boolean(raw.regenerateToken)
      };
      try {
        const data = await api('/api/setup/agent/install', {
          method: 'POST',
          body: JSON.stringify(body)
        });
        const installed = data.install;
        const details = [
          'Plugin installed for ' + data.agent.name + ' (' + data.agent.id + ').',
          'Plugin: ' + installed.pluginPath,
          'Env: ' + installed.envPath,
          installed.reload.ran
            ? 'Reload: ' + (installed.reload.ok ? 'completed' : 'failed')
            : 'Reload: skipped',
          'Connection test: ' + (data.connectTest.ok ? 'ok' : 'failed')
        ].join('\\n');
        $('agent-result').textContent = details;
        $('agent-result').className = installed.ok && data.connectTest.ok ? 'result ok' : 'result error';
        $('env-block').textContent = data.quickStart.env.join('\\n');
        $('install-commands').textContent = [
          'Installed files:',
          installed.copied.join('\\n'),
          '',
          'Equivalent manual commands:',
          data.quickStart.install.join('\\n')
        ].join('\\n');
        $('smoke-test').textContent = data.quickStart.smokeTest.join('\\n');
        $('agent-checks').innerHTML = data.quickStart.checks
          .concat(installed.diagnostics.map((item) => (item.ok ? 'OK ' : 'MISS ') + item.label + ': ' + item.message))
          .map((item) => '<li>' + escapeHtml(item) + '</li>')
          .join('');
        $('agent-next').classList.remove('hidden');
      } catch (error) {
        setResult('agent-result', error.message, false);
      }
    });

    $('uninstall-plugin').addEventListener('click', async () => {
      if (!confirm('Remove the ATM plugin files and revoke this agent token?')) return;

      const form = $('agent-form');
      const raw = formData(form);
      const manualWorkspace = $('manual-workspace').value.trim();
      const detectedWorkspace = $('workspace-select').value;
      const body = {
        type: raw.type,
        cliPath: raw.cliPath,
        workspacePath: manualWorkspace || detectedWorkspace || undefined,
        runReload: Boolean(raw.runReload)
      };

      try {
        const data = await api('/api/setup/agent/uninstall', {
          method: 'POST',
          body: JSON.stringify(body)
        });
        const removed = data.uninstall.removed.length ? data.uninstall.removed.join('\\n') : 'No plugin files were present.';
        const details = [
          'Plugin removed.',
          'Removed:',
          removed,
          data.uninstall.reload.ran
            ? 'Reload: ' + (data.uninstall.reload.ok ? 'completed' : 'failed')
            : 'Reload: skipped',
          'Token revoked: ' + (data.tokenRevoked ? 'yes' : 'no saved agent token found')
        ].join('\\n');
        $('agent-result').textContent = details;
        $('agent-result').className = data.ok ? 'result ok' : 'result error';
        $('agent-checks').innerHTML = data.uninstall.diagnostics
          .map((item) => '<li>' + escapeHtml((item.ok ? 'OK ' : 'MISS ') + item.label + ': ' + item.message) + '</li>')
          .join('');
        $('agent-next').classList.remove('hidden');
        await detectWorkspace();
      } catch (error) {
        setResult('agent-result', error.message, false);
      }
    });

    document.querySelectorAll('input[name="type"]').forEach((node) => {
      node.addEventListener('change', detectWorkspace);
    });

    $('permissions-form').addEventListener('submit', (event) => {
      event.preventDefault();
      localStorage.setItem('tm_permissions_reviewed', new Date().toISOString());
      setResult('permissions-result', 'Permissions checklist marked reviewed.');
    });

    document.querySelectorAll('[data-copy]').forEach((button) => {
      button.addEventListener('click', async () => {
        const target = $(button.getAttribute('data-copy'));
        await navigator.clipboard.writeText(target.textContent || '');
        button.textContent = 'Copied';
        setTimeout(() => { button.textContent = 'Copy'; }, 1200);
      });
    });

    $('cloudflare-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/setup/cloudflare/test', {
          method: 'POST',
          body: JSON.stringify(formData(event.currentTarget))
        });
        setResult('cloudflare-result', data.skipped ? 'Skipped.' : 'Health status: ' + data.status, data.ok);
      } catch (error) {
        setResult('cloudflare-result', error.message, false);
      }
    });

    $('channel-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/settings/channels', {
          method: 'PATCH',
          body: JSON.stringify(formData(event.currentTarget))
        });
        setResult('channel-result', data.policy.channelId + ' automation mode set to ' + data.policy.mode);
      } catch (error) {
        setResult('channel-result', error.message, false);
      }
    });

    loadStatus().then(detectWorkspace);
  </script>
</body>
</html>`;
}

function styles(): string {
  return `<style>
    :root {
      color-scheme: light;
      --bg: #f7faf9;
      --surface: #ffffff;
      --text: #132033;
      --muted: #667486;
      --line: #d8e1e8;
      --accent: #157a55;
      --accent-ink: #0c2b25;
      --blue: #126bc4;
      --danger: #c33d36;
      --ok: #158656;
      --shadow-soft: 0 2px 12px rgba(23, 43, 77, 0.07);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    .shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0 48px; }
    .product-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 10px 0 22px; }
    .brand-lockup { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .brand-avatar { width: 56px; height: 56px; border-radius: 16px; object-fit: cover; box-shadow: var(--shadow-soft); border: 1px solid rgba(23, 43, 77, 0.08); background: #fff; flex: 0 0 auto; }
    .eyebrow { margin: 0 0 6px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 30px; line-height: 1.12; max-width: 820px; }
    h2 { font-size: 18px; line-height: 1.25; }
    h3 { margin: 0; font-size: 14px; line-height: 1.3; }
    .muted { color: var(--muted); margin: 6px 0 0; }
    .panel-copy { color: var(--muted); margin: 8px 0 2px; font-size: 13px; line-height: 1.55; }
    .grid { display: grid; gap: 16px; align-items: start; }
    .setup-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-soft); padding: 18px; }
    .wide { grid-column: span 2; }
    .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    label { display: grid; gap: 6px; margin-top: 14px; color: var(--muted); font-size: 13px; }
    input, select, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 10px 11px; color: var(--text); background: #fff; font: inherit; min-width: 0; }
    input:focus, select:focus, textarea:focus { outline: 2px solid rgba(18, 107, 196, 0.14); border-color: var(--blue); }
    textarea { resize: vertical; }
    button, .link-button, .nav a { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: 6px; padding: 10px 12px; font: inherit; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; min-height: 40px; }
    button:hover, .link-button:hover, .nav a:hover { filter: brightness(0.96); }
    button[type="button"] { background: #fff; color: var(--accent); }
    form > button, .panel > button { margin-top: 16px; }
    .button-row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .button-row button { margin-top: 0; }
    .nav { display: flex; gap: 8px; align-items: center; }
    .step { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 8px; border-radius: 999px; background: #ecf6f2; color: var(--accent); font-size: 12px; font-weight: 800; margin-bottom: 10px; }
    .agent-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
    .agent-choice { margin: 0; display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 12px; color: var(--text); background: #fff; cursor: pointer; }
    .agent-choice input { width: auto; }
    .agent-choice:has(input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: #f5fbf8; }
    .check { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
    .check input { width: auto; }
    .result { min-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
    .result.ok { color: var(--ok); }
    .result.error { color: var(--danger); }
    .detect-status { margin-top: 14px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); background: #fbfcfa; overflow-wrap: anywhere; }
    .detect-status.ok { color: var(--ok); border-color: #9bc7a7; background: #f2faf4; }
    .detect-status.warn { color: #98611b; border-color: #dfbc9c; background: #fff8f1; }
    .commands { background: #132033; color: #eef3f7; border-radius: 8px; padding: 14px; overflow-x: auto; white-space: pre-wrap; }
    .quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
    .quick-block { min-width: 0; }
    .command-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .command-head button { min-height: 32px; padding: 6px 10px; }
    .advanced { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 12px; }
    .advanced summary { color: var(--accent); cursor: pointer; font-weight: 600; }
    .checks { margin: 10px 0 0; padding-left: 20px; color: var(--muted); }
    .checks li { margin: 6px 0; overflow-wrap: anywhere; }
    .permission-list { margin-top: 14px; }
    .kv { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 8px 12px; margin: 14px 0 0; }
    .kv dt { color: var(--muted); }
    .kv dd { margin: 0; overflow-wrap: anywhere; }
    .hidden { display: none !important; }
    @media (max-width: 820px) {
      .setup-grid, .row, .agent-choices, .quick-grid { grid-template-columns: 1fr; }
      .wide { grid-column: span 1; }
      .product-header { align-items: flex-start; flex-direction: column; }
      .brand-lockup { align-items: flex-start; }
    }
  </style>`;
}
