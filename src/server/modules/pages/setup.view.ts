import { translationCatalog, uiLanguageLabels, uiLanguages, uiLanguageStorageKey } from "../../../shared/i18n";

const setupLanguageOptions = uiLanguages
  .map((language) => `<option value="${language}">${uiLanguageLabels[language]}</option>`)
  .join("");

export function setupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ATM Setup</title>
  <link rel="icon" href="/assets/brand/atm-persona.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  ${styles()}
</head>
<body>
  <a class="skip-link" href="#setup-main">Skip to setup content</a>
  <main class="shell">
    <header class="product-header">
      <div class="brand-lockup">
        <img class="brand-avatar" src="/assets/brand/atm-persona.svg" alt="">
        <div>
          <p class="eyebrow">ATM · Agent Task Manager</p>
          <h1>Setup</h1>
        </div>
      </div>
      <div class="header-actions">
        <span id="setup-progress-label" class="progress-label">0% ready</span>
        <label class="language-control" aria-label="Language">
          <span class="sr-only">Language</span>
          <select id="setup-language" data-language-select aria-label="Language">
            ${setupLanguageOptions}
          </select>
        </label>
        <a class="link-button" href="/dashboard">Dashboard</a>
      </div>
    </header>

    <section class="setup-console">
      <aside class="setup-rail" aria-label="Setup progress">
        <div class="rail-head">
          <div>
            <p class="eyebrow">Progress</p>
            <h2>Readiness</h2>
          </div>
          <strong id="progress-percent">0%</strong>
        </div>
        <div class="progress-track" aria-hidden="true"><span id="progress-bar"></span></div>
        <nav id="setup-step-list" class="step-list"></nav>
      </aside>

      <section id="setup-main" class="setup-main" tabindex="-1">
        <header class="step-toolbar">
          <div>
            <p id="active-step-kicker" class="eyebrow">Step 1</p>
            <h2 id="active-step-title">Admin</h2>
          </div>
          <div class="step-controls">
            <button id="prev-step" type="button">Back</button>
            <button id="next-step" type="button">Next</button>
          </div>
        </header>

      <form id="admin-form" class="panel setup-panel active" data-step-id="admin">
        <h2>Admin</h2>
        <label>Email <input name="email" type="email" autocomplete="email" placeholder="admin@example.com" pattern="^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" title="Use a full email address, for example admin@example.com" required></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
        <button type="submit">Create Admin</button>
        <p id="admin-result" class="result"></p>
      </form>

      <section class="panel setup-panel hidden" data-step-id="storage">
        <h2>Storage</h2>
        <dl id="storage-list" class="kv"></dl>
        <button id="storage-check" type="button">Check Storage</button>
        <p id="storage-result" class="result"></p>
      </section>

      <form id="agent-form" class="panel setup-panel hidden" data-step-id="agent">
        <h2>OpenClaw Integration</h2>
        <input type="hidden" name="type" value="openclaw">
        <div id="workspace-status" class="detect-status">Create admin first, then workspace detection will run.</div>
        <label id="workspace-choice" class="hidden">Detected workspace
          <select id="workspace-select"></select>
        </label>
        <label class="check"><input name="runReload" type="checkbox" checked> Run reload command after install</label>
        <input name="regenerateToken" type="hidden" value="on">
        <details class="advanced">
          <summary>Advanced diagnostics</summary>
          <div class="row">
            <label>CLI path <input name="cliPath" placeholder="openclaw"></label>
            <label>Config path <input name="configPath" placeholder="/opt/openclaw/openclaw.yml"></label>
          </div>
          <label>Manual workspace path <input id="manual-workspace" placeholder="/opt/openclaw"></label>
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

      <form id="cloudflare-form" class="panel setup-panel hidden" data-step-id="public">
        <h2>Public Access</h2>
        <div class="row">
          <label>Mode
            <select name="mode">
              <option value="quick">Quick Tunnel preview</option>
              <option value="remote">Production tunnel token</option>
            </select>
          </label>
          <label>Local service URL <input name="localServiceUrl" placeholder="http://localhost:3011"></label>
        </div>
        <div class="row">
          <label>Public URL <input name="publicUrl" placeholder="https://tasks.example.com"></label>
          <label>Tunnel name <input name="tunnelName" placeholder="agent-task-manager"></label>
        </div>
        <label>Cloudflare install command or tunnel token <textarea name="tunnelToken" rows="3" autocomplete="off" spellcheck="false" placeholder="cloudflared service install ey..."></textarea></label>
        <label class="check"><input name="accessProtected" type="checkbox"> Cloudflare Access is protecting this hostname</label>
        <div class="button-row">
          <button type="submit">Save Public Access</button>
          <button id="cloudflare-test" type="button">Check Public URL</button>
        </div>
        <p id="cloudflare-result" class="result"></p>
        <section id="cloudflare-guide" class="quick-grid hidden">
          <div class="quick-block">
            <div class="command-head"><h3>Quick Tunnel</h3><button type="button" data-copy="quick-tunnel-command">Copy</button></div>
            <pre id="quick-tunnel-command" class="commands"></pre>
          </div>
          <div class="quick-block">
            <div class="command-head"><h3>Production Run</h3><button type="button" data-copy="remote-run-command">Copy</button></div>
            <pre id="remote-run-command" class="commands"></pre>
          </div>
          <div class="quick-block">
            <div class="command-head"><h3>Install Service</h3><button type="button" data-copy="service-install-command">Copy</button></div>
            <pre id="service-install-command" class="commands"></pre>
          </div>
          <div class="quick-block">
            <h3>Status</h3>
            <ul id="cloudflare-checks" class="checks"></ul>
          </div>
        </section>
      </form>

      <form id="permissions-form" class="panel setup-panel hidden" data-step-id="permissions">
        <h2>Slack Permissions</h2>
        <ul class="checks permission-list">
          <li>Read channels</li>
          <li>Reply in threads</li>
          <li>DM assignees</li>
          <li>Ignore bot messages</li>
          <li>Manual gate enabled</li>
        </ul>
        <button type="submit">Mark Reviewed</button>
        <p id="permissions-result" class="result"></p>
      </form>

      <form id="channel-form" class="panel setup-panel hidden" data-step-id="automation">
        <h2>Automation Mode</h2>
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

      <section class="panel setup-panel hidden" data-step-id="finish">
        <h2>Ready</h2>
        <dl id="finish-summary" class="kv"></dl>
        <div class="button-row">
          <a class="link-button" href="/dashboard">Open Dashboard</a>
          <button id="finish-refresh" type="button">Refresh Status</button>
        </div>
      </section>
      </section>

      <aside class="setup-inspector" aria-label="Setup diagnostics">
        <details class="inspector-disclosure">
          <summary>
            <span>
              <strong>Step details</strong>
              <small id="inspector-summary">Open only when diagnostics are needed.</small>
            </span>
          </summary>
          <div class="inspector-body">
            <section>
              <h2>Current blockers</h2>
              <ul id="setup-blockers" class="checks blocker-list"></ul>
            </section>
            <section>
              <h2>Readiness</h2>
              <div id="readiness-cards" class="readiness-cards"></div>
            </section>
          </div>
        </details>
      </aside>
    </section>
  </main>
  <script>
    const uiLanguageStorageKey = ${JSON.stringify(uiLanguageStorageKey)};
    const translationCatalog = ${JSON.stringify(translationCatalog)};
    const reverseCatalog = Object.fromEntries(Object.entries(translationCatalog).map(([language, catalog]) => [
      language,
      Object.fromEntries(Object.entries(catalog).map(([english, translated]) => [translated, english]))
    ]));
    const setupSteps = [
      { id: 'admin', label: 'Admin', summary: 'Create the local administrator.', required: true },
      { id: 'storage', label: 'Storage', summary: 'Confirm writable local paths.', required: true },
      { id: 'agent', label: 'OpenClaw', summary: 'Install the OpenClaw integration.', required: true },
      { id: 'public', label: 'Public Access', summary: 'Expose the dashboard through Cloudflare.', required: true },
      { id: 'permissions', label: 'Slack Review', summary: 'Confirm the existing bot permissions.', required: true },
      { id: 'automation', label: 'Automation', summary: 'Optional channel suggestion mode.', required: false },
      { id: 'finish', label: 'Finish', summary: 'Review readiness and open the dashboard.', required: false }
    ];
    const state = { token: localStorage.getItem('tm_admin_token') || '', activeStepId: 'admin', status: null, userSelectedStep: false, language: initialUiLanguage() };
    const $ = (id) => document.getElementById(id);

    function initialUiLanguage() {
      const storedLanguage = localStorage.getItem(uiLanguageStorageKey);
      return parseUiLanguage(storedLanguage || (navigator.language || '').split('-')[0]);
    }

    function parseUiLanguage(value) {
      return Object.prototype.hasOwnProperty.call(translationCatalog, value) ? value : 'en';
    }

    function toEnglish(value) {
      for (const catalog of Object.values(reverseCatalog)) {
        if (catalog[value]) return catalog[value];
      }
      return value;
    }

    function translateText(value) {
      if (!String(value).trim()) return value;
      const leading = String(value).match(/^\\s*/)?.[0] || '';
      const trailing = String(value).match(/\\s*$/)?.[0] || '';
      const english = toEnglish(String(value).trim());
      const translated = state.language === 'en' ? english : (translationCatalog[state.language][english] || english);
      return leading + translated + trailing;
    }

    function hasSkippedAncestor(node) {
      let current = node.parentElement;
      while (current) {
        if (current.hasAttribute('data-i18n-skip')) return true;
        if (['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEXTAREA'].includes(current.tagName)) return true;
        current = current.parentElement;
      }
      return false;
    }

    function translateDom(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      const textNodes = [];
      const elements = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
          if (!hasSkippedAncestor(node)) textNodes.push(node);
        } else if (node.nodeType === Node.ELEMENT_NODE && !['SCRIPT', 'STYLE', 'PRE', 'CODE', 'TEXTAREA'].includes(node.tagName)) {
          elements.push(node);
        }
      }
      textNodes.forEach((node) => { node.textContent = translateText(node.textContent || ''); });
      elements.forEach((element) => {
        ['placeholder', 'title', 'aria-label'].forEach((attr) => {
          const value = element.getAttribute(attr);
          if (value) element.setAttribute(attr, translateText(value));
        });
      });
    }

    function syncLanguageControls() {
      document.querySelectorAll('[data-language-select]').forEach((node) => {
        node.value = state.language;
      });
    }

    function localizePage() {
      document.documentElement.lang = state.language;
      syncLanguageControls();
      translateDom(document.body);
    }

    function bindLanguageControls() {
      document.querySelectorAll('[data-language-select]').forEach((node) => {
        node.addEventListener('change', () => {
          state.language = parseUiLanguage(node.value);
          localStorage.setItem(uiLanguageStorageKey, state.language);
          localizePage();
        });
      });
    }

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
      node.textContent = translateText(message);
      node.className = ok ? 'result ok' : 'result error';
      node.setAttribute('role', ok ? 'status' : 'alert');
      node.setAttribute('aria-live', 'polite');
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

    function isStepDone(id, status) {
      if (!status) return false;
      if (id === 'admin') return Boolean(status.setupLocked);
      if (id === 'storage') return Boolean(status.storage && status.storage.ok);
      if (id === 'agent') return Boolean(status.agents && status.agents.length);
      if (id === 'public') return Boolean(status.publicAccess && status.publicAccess.publicUrl && status.publicAccess.accessProtected);
      if (id === 'permissions') return Boolean(status.review && status.review.slackPermissionsReviewedAt);
      if (id === 'automation') return Boolean(status.channelPolicies && status.channelPolicies.length);
      if (id === 'finish') return requiredStepsComplete(status);
      return false;
    }

    function isStepBlocked(id, status) {
      if (!status) return true;
      if (id === 'admin') return false;
      if (id === 'storage') return false;
      if (id === 'finish') return !requiredStepsComplete(status);
      return !state.token && status.setupLocked;
    }

    function requiredStepsComplete(status) {
      return setupSteps
        .filter((step) => step.required)
        .every((step) => isStepDone(step.id, status));
    }

    function stepTone(id, status) {
      if (isStepDone(id, status)) return 'done';
      if (isStepBlocked(id, status)) return 'blocked';
      return 'todo';
    }

    function stepBlockers(id, status) {
      if (!status) return ['Setup status could not be loaded.'];
      if (id === 'admin') {
        return status.setupLocked ? ['Admin is created.'] : ['Create a local admin account to unlock protected setup actions.'];
      }
      if (id === 'storage') {
        return status.storage && status.storage.ok ? ['Storage is ready.'] : ['Run storage check and confirm the data directory is writable.'];
      }
      if (id === 'agent') {
        const items = [];
        if (!state.token && status.setupLocked) items.push('Log in as admin before installing agent plugins.');
        if (!(status.agents && status.agents.length)) items.push('Install OpenClaw before continuing.');
        return items.length ? items : ['OpenClaw integration is installed.'];
      }
      if (id === 'public') {
        const publicAccess = status.publicAccess || {};
        const items = [];
        if (!publicAccess.publicUrl) items.push('Add the Cloudflare public hostname.');
        if (!publicAccess.accessProtected) items.push('Mark the hostname as protected by Cloudflare Access before sharing it.');
        if (!publicAccess.tunnelTokenConfigured && publicAccess.mode === 'remote') items.push('Paste a tunnel token or Cloudflare install command to generate service commands.');
        return items.length ? items : ['Public access is ready.'];
      }
      if (id === 'permissions') {
        return isStepDone(id, status) ? ['Slack permissions have been reviewed.'] : ['Review the existing agent bot scopes and mark the checklist reviewed.'];
      }
      if (id === 'automation') {
        return isStepDone(id, status) ? ['At least one channel policy is configured.'] : ['Optional: leave manual-only globally or add channel-specific suggestion mode.'];
      }
      if (id === 'finish') {
        return requiredStepsComplete(status) ? ['All required setup steps are complete.'] : ['Finish the required steps before using the dashboard with the team.'];
      }
      return [];
    }

    function renderSetupState(status) {
      state.status = status;
      const requiredSteps = setupSteps.filter((step) => step.required);
      const doneRequired = requiredSteps.filter((step) => isStepDone(step.id, status)).length;
      const progress = Math.round((doneRequired / requiredSteps.length) * 100);
      $('progress-percent').textContent = progress + '%';
      $('setup-progress-label').textContent = progress + '% ready';
      $('progress-bar').style.width = progress + '%';

      if (!state.userSelectedStep) {
        state.activeStepId = firstActionStep(status).id;
      } else if (!setupSteps.some((step) => step.id === state.activeStepId)) {
        state.activeStepId = firstActionStep(status).id;
      }

      $('setup-step-list').innerHTML = setupSteps.map((step, index) => {
        const tone = stepTone(step.id, status);
        const active = step.id === state.activeStepId;
        const label = tone === 'done' ? 'Done' : tone === 'blocked' ? 'Blocked' : step.required ? 'Required' : 'Optional';
        return '<button type="button" class="step-nav ' + tone + (active ? ' active' : '') + '" data-step-target="' + step.id + '" aria-current="' + (active ? 'step' : 'false') + '">'
          + '<span class="step-index">' + (index + 1) + '</span>'
          + '<span class="step-copy"><strong>' + escapeHtml(step.label) + '</strong></span>'
          + '<em title="' + label + '">' + (tone === 'done' ? 'OK' : tone === 'blocked' ? 'Fix' : step.required ? 'Need' : 'Opt') + '</em>'
          + '</button>';
      }).join('');
      document.querySelectorAll('[data-step-target]').forEach((button) => {
        button.addEventListener('click', () => setActiveStep(button.getAttribute('data-step-target')));
      });

      document.querySelectorAll('[data-step-id]').forEach((panel) => {
        const active = panel.getAttribute('data-step-id') === state.activeStepId;
        panel.classList.toggle('active', active);
        panel.classList.toggle('hidden', !active);
      });

      const activeStep = setupSteps.find((step) => step.id === state.activeStepId) || setupSteps[0];
      const blockers = stepBlockers(activeStep.id, status);
      $('active-step-kicker').textContent = activeStep.required ? 'Required step' : 'Optional step';
      $('active-step-title').textContent = activeStep.label;
      $('inspector-summary').textContent = blockers.length ? blockers.length + ' item' + (blockers.length === 1 ? '' : 's') + ' to resolve for this step.' : 'This step is ready to continue.';
      $('setup-blockers').innerHTML = blockers
        .map((item) => '<li>' + escapeHtml(item) + '</li>')
        .join('');
      renderReadinessCards(status);
      renderFinishSummary(status);
      renderStepControls();
      localizePage();
    }

    function firstActionStep(status) {
      return setupSteps.find((step) => step.required && !isStepDone(step.id, status)) || setupSteps.find((step) => step.id === 'finish') || setupSteps[0];
    }

    function setActiveStep(id) {
      if (!id || !setupSteps.some((step) => step.id === id)) return;
      state.activeStepId = id;
      state.userSelectedStep = true;
      if (state.status) renderSetupState(state.status);
      $('setup-main').focus({ preventScroll: true });
    }

    function renderStepControls() {
      const index = setupSteps.findIndex((step) => step.id === state.activeStepId);
      $('prev-step').disabled = index <= 0;
      $('next-step').disabled = index >= setupSteps.length - 1;
      $('next-step').textContent = index >= setupSteps.length - 2 ? 'Finish' : 'Next';
    }

    function renderReadinessCards(status) {
      $('readiness-cards').innerHTML = setupSteps
        .filter((step) => step.id !== 'finish')
        .map((step) => {
          const tone = stepTone(step.id, status);
          const label = tone === 'done' ? 'Ready' : tone === 'blocked' ? 'Blocked' : step.required ? 'Needed' : 'Optional';
          return '<button type="button" class="readiness-card ' + tone + '" data-step-target="' + step.id + '">'
            + '<strong>' + escapeHtml(step.label) + '</strong>'
            + '<span>' + label + '</span>'
            + '</button>';
        })
        .join('');
      document.querySelectorAll('.readiness-card[data-step-target]').forEach((button) => {
        button.addEventListener('click', () => setActiveStep(button.getAttribute('data-step-target')));
      });
    }

    function renderFinishSummary(status) {
      const publicAccess = status.publicAccess || {};
      const agentNames = (status.agents || []).map((agent) => agent.name || agent.type).join(', ') || 'None installed';
      $('finish-summary').innerHTML = [
        ['Dashboard', window.location.origin + '/dashboard'],
        ['Public URL', publicAccess.publicUrl || 'Not configured'],
        ['Agents', agentNames],
        ['Storage', status.storage && status.storage.ok ? 'OK' : 'Needs check'],
        ['Slack review', status.review && status.review.slackPermissionsReviewedAt ? status.review.slackPermissionsReviewedAt : 'Not reviewed']
      ].map(([k, v]) => '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd>').join('');
    }

    function renderPublicAccess(publicAccess, guide, diagnostics) {
      const form = $('cloudflare-form');
      if (publicAccess) {
        form.elements.mode.value = publicAccess.mode || 'quick';
        form.elements.localServiceUrl.value = publicAccess.localServiceUrl || 'http://localhost:3011';
        form.elements.publicUrl.value = publicAccess.publicUrl || '';
        form.elements.tunnelName.value = publicAccess.tunnelName || '';
        form.elements.accessProtected.checked = Boolean(publicAccess.accessProtected);
      }

      if (!guide) return;
      $('quick-tunnel-command').textContent = guide.quickTunnelCommand || '';
      $('remote-run-command').textContent = guide.remoteRunCommand || 'Paste a Cloudflare tunnel token or install command, then save.';
      $('service-install-command').textContent = guide.serviceInstallCommand || 'Paste a Cloudflare tunnel token or install command, then save.';
      const checks = [
        diagnostics ? (diagnostics.installed ? 'OK ' : 'MISS ') + diagnostics.message : '',
        publicAccess && publicAccess.publicUrl ? 'OK Public URL saved: ' + publicAccess.publicUrl : 'MISS Public URL not saved yet.',
        publicAccess && publicAccess.tunnelTokenConfigured ? 'OK Tunnel token was provided.' : 'MISS Tunnel token not provided yet.',
        publicAccess && publicAccess.accessProtected ? 'OK Cloudflare Access marked protected.' : 'MISS Mark Access protected before sharing with the team.'
      ].filter(Boolean);
      $('cloudflare-checks').innerHTML = checks.map((item) => '<li>' + escapeHtml(item) + '</li>').join('');
      $('cloudflare-guide').classList.remove('hidden');
      localizePage();
    }

    function selectedAgentType() {
      return 'openclaw';
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
      if (status.review && status.review.slackPermissionsReviewedAt) {
        setResult('permissions-result', 'Permissions reviewed at ' + status.review.slackPermissionsReviewedAt + '.');
      }
      renderPublicAccess(status.publicAccess, {
        quickTunnelCommand: 'cloudflared tunnel --url ' + (status.publicAccess && status.publicAccess.localServiceUrl ? status.publicAccess.localServiceUrl : 'http://localhost:3011')
      }, null);
      renderSetupState(status);
      return status;
    }

    $('prev-step').addEventListener('click', () => {
      const index = setupSteps.findIndex((step) => step.id === state.activeStepId);
      if (index > 0) setActiveStep(setupSteps[index - 1].id);
    });

    $('next-step').addEventListener('click', () => {
      const index = setupSteps.findIndex((step) => step.id === state.activeStepId);
      if (index < setupSteps.length - 1) setActiveStep(setupSteps[index + 1].id);
    });

    $('finish-refresh').addEventListener('click', () => loadStatus());

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
        state.userSelectedStep = false;
        await loadStatus();
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
        state.userSelectedStep = false;
        await loadStatus();
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
        state.userSelectedStep = false;
        await loadStatus();
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
        state.userSelectedStep = false;
        await loadStatus();
        await detectWorkspace();
      } catch (error) {
        setResult('agent-result', error.message, false);
      }
    });

    $('permissions-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await api('/api/setup/review', {
          method: 'PATCH',
          body: JSON.stringify({ slackPermissionsReviewed: true })
        });
        setResult('permissions-result', 'Permissions reviewed at ' + data.review.slackPermissionsReviewedAt + '.');
        state.userSelectedStep = false;
        await loadStatus();
      } catch (error) {
        setResult('permissions-result', error.message, false);
      }
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
      const form = event.currentTarget;
      const body = formData(form);
      body.accessProtected = form.elements.accessProtected.checked;
      try {
        const data = await api('/api/setup/public-access', {
          method: 'PATCH',
          body: JSON.stringify(body)
        });
        state.userSelectedStep = false;
        await loadStatus();
        renderPublicAccess(data.publicAccess, data.guide, data.diagnostics);
        setResult('cloudflare-result', data.publicAccess.publicUrl ? 'Public access settings saved.' : 'Settings saved. Add the public hostname after Cloudflare creates it.');
      } catch (error) {
        setResult('cloudflare-result', error.message, false);
      }
    });

    $('cloudflare-test').addEventListener('click', async () => {
      const form = $('cloudflare-form');
      try {
        const data = await api('/api/setup/public-access/test', {
          method: 'POST',
          body: JSON.stringify({ publicUrl: form.elements.publicUrl.value })
        });
        setResult('cloudflare-result', data.skipped ? 'Add a public URL first.' : 'Health status: ' + data.status, data.ok);
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
        state.userSelectedStep = false;
        await loadStatus();
      } catch (error) {
        setResult('channel-result', error.message, false);
      }
    });

    bindLanguageControls();
    localizePage();
    loadStatus().then(detectWorkspace);
  </script>
</body>
</html>`;
}

function styles(): string {
  return `<style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --surface: #ffffff;
      --surface-subtle: #f8fafc;
      --surface-strong: #101828;
      --surface-tint: #eef4ff;
      --text: #172033;
      --muted: #667085;
      --line: #e5eaf1;
      --line-strong: #d3dbea;
      --accent: #4f46e5;
      --accent-ink: #312e81;
      --accent-soft: #eef2ff;
      --blue: #2563eb;
      --danger: #d6455d;
      --ok: #0e9f6e;
      --amber: #b7791f;
      --control-height: 40px;
      --control-radius: 8px;
      --control-gap: 10px;
      --control-padding-x: 12px;
      --panel-padding: 16px;
      --shadow: 0 20px 48px rgba(16, 24, 40, 0.08);
      --shadow-soft: 0 1px 2px rgba(16, 24, 40, 0.05), 0 8px 22px rgba(16, 24, 40, 0.04);
      font-family: "Plus Jakarta Sans", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-size: 14px; font-feature-settings: "kern"; line-height: 1.5; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .skip-link { position: absolute; left: 14px; top: -48px; z-index: 20; background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; color: var(--accent); }
    .skip-link:focus { top: 12px; }
    .shell { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 18px 0 44px; }
    .product-header { display: flex; align-items: center; justify-content: space-between; gap: 18px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: var(--shadow); padding: 16px; margin-bottom: 16px; }
    .header-actions { display: flex; align-items: center; gap: var(--control-gap); flex-wrap: wrap; }
    .header-actions > * { flex: 0 0 auto; }
    .progress-label { display: inline-flex; align-items: center; min-height: 30px; border: 1px solid #c7d2fe; border-radius: 999px; background: var(--accent-soft); color: var(--accent-ink); padding: 4px 10px; font-size: 12px; font-weight: 700; }
    .language-control { min-width: 92px; height: var(--control-height); margin: 0; }
    .language-control select { height: var(--control-height); min-height: var(--control-height); padding: 8px 30px 8px 10px; border-color: var(--line-strong); background-color: #fff; font-size: 12px; font-weight: 800; }
    .brand-lockup { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-avatar { width: 46px; height: 46px; border-radius: 8px; object-fit: cover; box-shadow: var(--shadow-soft); border: 1px solid var(--line); background: #fff; flex: 0 0 auto; }
    .eyebrow { margin: 0 0 4px; color: var(--accent); font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
    h1, h2 { margin: 0; letter-spacing: 0; }
    h1 { font-size: 24px; font-weight: 800; line-height: 1.15; max-width: 760px; }
    h2 { font-size: 16px; font-weight: 700; line-height: 1.28; }
    h3 { margin: 0; font-size: 13px; font-weight: 700; line-height: 1.35; }
    .muted { color: var(--muted); margin: 4px 0 0; font-size: 12px; line-height: 1.5; }
    .setup-console { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 14px; align-items: start; }
    .setup-rail { position: sticky; top: 16px; display: grid; gap: 14px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: var(--shadow-soft); padding: 14px; }
    .setup-inspector { grid-column: 2; min-width: 0; }
    .rail-head { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    .rail-head strong { font-size: 22px; line-height: 1; color: var(--accent-ink); }
    .progress-track { height: 8px; overflow: hidden; border-radius: 999px; background: #edf1f6; }
    .progress-track span { display: block; width: 0%; height: 100%; border-radius: inherit; background: var(--accent); transition: width 180ms ease; }
    .step-list { display: grid; gap: 8px; }
    .step-nav { min-height: 48px; width: 100%; display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 9px; align-items: center; justify-content: stretch; border-color: var(--line); background: #fff; color: var(--text); text-align: left; padding: 9px; box-shadow: none; }
    .step-nav:hover, .step-nav.active { background: var(--accent-soft); border-color: #c7d2fe; color: var(--accent-ink); transform: none; box-shadow: inset 3px 0 0 var(--accent); }
    .step-nav.done { border-color: #b5dfcc; }
    .step-nav.blocked { border-color: #ead59a; }
    .step-index { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 999px; background: #edf1f6; color: var(--muted); font-size: 12px; font-weight: 700; }
    .step-nav.done .step-index { background: #e8f7ef; color: var(--ok); }
    .step-nav.blocked .step-index { background: #fff8e1; color: var(--amber); }
    .step-copy { min-width: 0; display: grid; gap: 2px; }
    .step-copy strong { font-size: 12px; font-weight: 700; }
    .step-copy small { color: var(--muted); font-size: 11px; line-height: 1.3; }
    .step-nav em { color: var(--muted); font-size: 10px; font-style: normal; font-weight: 700; text-transform: uppercase; }
    .setup-main { min-width: 0; display: grid; gap: 12px; }
    .step-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: var(--shadow-soft); padding: 16px; }
    .step-controls { display: flex; align-items: center; gap: var(--control-gap); flex-wrap: wrap; }
    .setup-panel { min-height: 0; }
    .setup-panel.active { display: block; }
    .inspector-disclosure { border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: var(--shadow-soft); }
    .inspector-disclosure summary { min-height: 52px; display: flex; align-items: center; cursor: pointer; list-style: none; padding: 12px 16px; }
    .inspector-disclosure summary::-webkit-details-marker { display: none; }
    .inspector-disclosure summary::after { content: "Show"; margin-left: auto; color: var(--accent); font-size: 12px; font-weight: 700; }
    .inspector-disclosure[open] summary { border-bottom: 1px solid var(--line); }
    .inspector-disclosure[open] summary::after { content: "Hide"; }
    html[lang="ko"] .inspector-disclosure summary::after { content: "보기"; }
    html[lang="ko"] .inspector-disclosure[open] summary::after { content: "숨기기"; }
    .inspector-disclosure strong { display: block; font-size: 13px; }
    .inspector-disclosure small { display: block; margin-top: 2px; color: var(--muted); font-size: 11px; }
    .inspector-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; padding: 16px; }
    .readiness-cards { display: grid; gap: 8px; margin-top: 12px; }
    .readiness-card { min-height: var(--control-height); width: 100%; display: flex; align-items: center; justify-content: space-between; gap: var(--control-gap); border-color: var(--line); background: #fff; color: var(--text); text-align: left; box-shadow: none; }
    .readiness-card:hover { background: var(--surface-subtle); border-color: var(--line-strong); color: var(--text); transform: none; box-shadow: none; }
    .readiness-card span { display: inline-flex; border-radius: 999px; background: #eef1f5; color: var(--muted); padding: 3px 8px; font-size: 10px; font-weight: 700; text-transform: uppercase; }
    .readiness-card.done span { background: #e8f7ef; color: var(--ok); }
    .readiness-card.blocked span { background: #fff8e1; color: var(--amber); }
    .blocker-list:empty::before { content: "No blockers for this step."; color: var(--muted); }
    .panel { background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow-soft); padding: var(--panel-padding); }
    .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    label { display: grid; gap: 6px; margin-top: 12px; color: var(--muted); font-size: 12px; font-weight: 700; }
    input, select, textarea { width: 100%; height: var(--control-height); min-height: var(--control-height); border: 1px solid var(--line-strong); border-radius: var(--control-radius); padding: 9px 11px; color: var(--text); background: #fcfdff; font: inherit; min-width: 0; }
    input:focus, select:focus, textarea:focus { outline: 3px solid rgba(79, 70, 229, 0.14); border-color: var(--accent); background: #fff; }
    textarea { height: auto; min-height: 96px; resize: vertical; line-height: 1.45; }
    button, .link-button { border: 1px solid var(--accent); background: var(--accent); color: #fff; border-radius: var(--control-radius); padding: 9px var(--control-padding-x); font: inherit; font-size: 13px; font-weight: 700; line-height: 1; white-space: nowrap; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; min-height: var(--control-height); box-shadow: 0 8px 18px rgba(79, 70, 229, 0.16); transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
    button:hover, .link-button:hover { background: var(--accent-ink); border-color: var(--accent-ink); box-shadow: 0 10px 22px rgba(49, 46, 129, 0.18); transform: translateY(-1px); }
    button:focus-visible, .link-button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid rgba(79, 70, 229, 0.2); outline-offset: 2px; }
    button:disabled { cursor: not-allowed; opacity: 0.52; }
    button:disabled:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
    button[type="button"] { background: #fff; color: var(--accent); box-shadow: none; }
    button[type="button"]:hover { background: var(--accent-soft); color: var(--accent-ink); border-color: #c7d2fe; box-shadow: none; }
    button[type="button"]:disabled:hover { background: #fff; color: var(--accent); border-color: var(--accent); }
    form > button, .panel > button { margin-top: 14px; }
    .button-row { display: flex; align-items: center; gap: var(--control-gap); flex-wrap: wrap; margin-top: 14px; }
    .button-row button, .button-row .link-button, .step-controls button { min-height: var(--control-height); margin-top: 0; }
    .agent-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--control-gap); margin-top: 12px; }
    .agent-choice { min-height: 48px; margin: 0; display: flex; align-items: center; gap: var(--control-gap); border: 1px solid var(--line); border-radius: var(--control-radius); padding: 12px; color: var(--text); background: #fff; cursor: pointer; }
    .agent-choice input { width: auto; height: auto; min-height: auto; }
    .agent-choice:has(input:checked) { border-color: #c7d2fe; box-shadow: inset 0 0 0 1px #c7d2fe; background: var(--accent-soft); }
    .check { display: flex; grid-template-columns: auto 1fr; align-items: center; gap: 8px; }
    .check input { width: auto; height: auto; min-height: auto; }
    .result { min-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); font-size: 12px; }
    .result.ok { color: var(--ok); }
    .result.error { color: var(--danger); }
    .detect-status { margin-top: 12px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface-subtle); overflow-wrap: anywhere; font-size: 12px; }
    .detect-status.ok { color: var(--ok); border-color: #b5dfcc; background: #e8f7ef; }
    .detect-status.warn { color: var(--amber); border-color: #ead59a; background: #fff8e1; }
    .commands { background: var(--surface-strong); color: #f2f4f7; border-radius: 8px; padding: 12px; overflow-x: auto; white-space: pre-wrap; font-size: 12px; line-height: 1.45; }
    .quick-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
    .quick-block { min-width: 0; }
    .command-head { min-height: var(--control-height); display: flex; align-items: center; justify-content: space-between; gap: var(--control-gap); margin-bottom: 8px; }
    .command-head button { min-height: var(--control-height); padding: 0 var(--control-padding-x); }
    .advanced { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
    .advanced summary { color: var(--accent); cursor: pointer; font-weight: 600; }
    .checks { margin: 10px 0 0; padding-left: 20px; color: var(--muted); font-size: 12px; }
    .checks li { margin: 5px 0; overflow-wrap: anywhere; }
    .permission-list { margin-top: 12px; }
    .kv { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 7px 10px; margin: 12px 0 0; font-size: 12px; }
    .kv dt { color: var(--muted); font-weight: 800; }
    .kv dd { margin: 0; overflow-wrap: anywhere; }
    .hidden { display: none !important; }
    @media (prefers-reduced-motion: reduce) {
      * { scroll-behavior: auto !important; transition: none !important; }
    }
    @media (max-width: 820px) {
      .setup-console, .row, .agent-choices, .quick-grid, .inspector-body { grid-template-columns: 1fr; }
      .setup-rail { position: static; }
      .setup-inspector { grid-column: auto; }
      .product-header { align-items: flex-start; flex-direction: column; }
      .header-actions { width: 100%; justify-content: flex-start; }
      .brand-lockup { align-items: flex-start; }
      .step-toolbar { align-items: flex-start; flex-direction: column; }
    }
  </style>`;
}
