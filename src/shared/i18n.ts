export const uiLanguages = ["en", "ko"] as const;

export type UiLanguage = (typeof uiLanguages)[number];

export const defaultUiLanguage: UiLanguage = "en";

export const uiLanguageLabels: Record<UiLanguage, string> = {
  en: "English",
  ko: "한국어"
};

export const uiLanguageStorageKey = "atm_ui_language";

const ko: Record<string, string> = {
  "Agent Task Manager": "에이전트 태스크 매니저",
  "Task Console": "태스크 콘솔",
  "Setup Console": "설정 콘솔",
  "Connect local agents, public access, and team policies from one guided flow.": "로컬 에이전트, 공개 접근, 팀 정책을 하나의 안내 흐름에서 연결합니다.",
  "Admin": "관리자",
  "Sign in": "로그인",
  "Email": "이메일",
  "Password": "비밀번호",
  "Login": "로그인",
  "Language": "언어",
  "Setup": "설정",
  "Dashboard": "대시보드",
  "Tasks": "태스크",
  "Agents": "에이전트",
  "Integrations": "연동",
  "Settings": "설정",
  "Logout": "로그아웃",
  "Workspace": "워크스페이스",
  "Focus queue": "집중 큐",
  "Open work, highest risk first.": "열린 작업을 위험도 순으로 봅니다.",
  "Context": "맥락",
  "Recent activity and priority mix": "최근 활동과 우선순위 분포",
  "Search tasks...": "태스크 검색...",
  "Search all tasks...": "전체 태스크 검색...",
  "Search agents...": "에이전트 검색...",
  "Search integrations...": "연동 검색...",
  "Search settings...": "설정 검색...",
  "Refresh": "새로고침",
  "Task metrics": "태스크 지표",
  "Done": "완료",
  "Blocked": "막힘",
  "In Progress": "진행 중",
  "Open": "열림",
  "stored locally": "로컬 저장",
  "completed": "완료됨",
  "waiting": "대기 중",
  "active": "활성",
  "active queue": "활성 큐",
  "Markdown index": "마크다운 인덱스",
  "New Task": "새 태스크",
  "New": "새로 만들기",
  "Title": "제목",
  "Assignee": "담당자",
  "Priority": "우선순위",
  "Status": "상태",
  "Reporter": "보고자",
  "GitHub ref": "GitHub 참조",
  "Description": "설명",
  "Next action": "다음 액션",
  "Concrete next step": "구체적인 다음 단계",
  "Create Task": "태스크 생성",
  "Recent activity": "최근 활동",
  "All tasks": "전체 태스크",
  "Search, create, and edit Markdown-backed tasks.": "마크다운 기반 태스크를 검색, 생성, 수정합니다.",
  "Markdown-backed task index": "마크다운 기반 태스크 인덱스",
  "No tasks match this view.": "이 화면에 맞는 태스크가 없습니다.",
  "Unassigned": "미지정",
  "No assignee": "담당자 없음",
  "No reporter": "보고자 없음",
  "Add Slack users in Settings first": "먼저 설정에서 Slack 사용자를 추가하세요",
  "Issue": "이슈",
  "Agent": "에이전트",
  "Manual": "수동",
  "Task completed": "태스크 완료",
  "Task blocked": "태스크 막힘",
  "Task in progress": "태스크 진행 중",
  "Task proposed": "태스크 제안됨",
  "Task updated": "태스크 업데이트됨",
  "now": "방금",
  "proposed": "제안됨",
  "confirmed": "확정됨",
  "assigning": "배정 중",
  "in progress": "진행 중",
  "blocked": "막힘",
  "review needed": "리뷰 필요",
  "done": "완료",
  "cancelled": "취소됨",
  "Priority breakdown": "우선순위 분포",
  "ID": "ID",
  "Slack": "Slack",
  "Markdown": "마크다운",
  "Initiative": "이니셔티브",
  "Save Changes": "변경 저장",
  "Save": "저장",
  "Agent name": "에이전트 이름",
  "Installed agent plugins and API credentials.": "설치된 에이전트 플러그인과 API 자격 증명입니다.",
  "Install plugin": "플러그인 설치",
  "Type": "유형",
  "Name": "이름",
  "CLI path": "CLI 경로",
  "Config path": "설정 경로",
  "Workspace path": "워크스페이스 경로",
  "Regenerate token": "토큰 재발급",
  "Save Agent": "에이전트 저장",
  "Clear": "초기화",
  "No agents match this view.": "이 화면에 맞는 에이전트가 없습니다.",
  "Token": "토큰",
  "Updated": "업데이트",
  "not generated": "미생성",
  "not set": "미설정",
  "Edit": "수정",
  "Uninstall": "제거",
  "GitHub sync and external entry points.": "GitHub 동기화와 외부 진입점입니다.",
  "Enabled": "활성",
  "Disabled": "비활성",
  "GitHub token": "GitHub 토큰",
  "Configured": "설정됨",
  "Missing": "누락",
  "Auto-create issues": "이슈 자동 생성",
  "Rules": "규칙",
  "Labels": "라벨",
  "None": "없음",
  "Enable GitHub sync": "GitHub 동기화 활성화",
  "Update task status from GitHub": "GitHub에서 태스크 상태 업데이트",
  "Complete closed issues": "닫힌 이슈 완료 처리",
  "Assignees by owner": "소유자별 담당자",
  "Save GitHub Settings": "GitHub 설정 저장",
  "Run Sync": "동기화 실행",
  "Runtime": "런타임",
  "Local storage and setup state.": "로컬 저장소와 설정 상태입니다.",
  "Open setup": "설정 열기",
  "Setup locked": "설정 잠김",
  "Data dir": "데이터 디렉터리",
  "Tasks dir": "태스크 디렉터리",
  "SQLite": "SQLite",
  "Policies": "정책",
  "Check Storage": "저장소 확인",
  "Slack Permissions": "Slack 권한",
  "Not reviewed yet.": "아직 검토되지 않았습니다.",
  "Mark Reviewed": "검토 완료",
  "Clear Review": "검토 해제",
  "Public Access": "공개 접근",
  "Cloudflare Tunnel access for the local dashboard.": "로컬 대시보드를 위한 Cloudflare Tunnel 접근입니다.",
  "Not configured": "미설정",
  "Provider": "제공자",
  "Mode": "모드",
  "Access": "접근",
  "Protected": "보호됨",
  "Needs Access": "Access 필요",
  "Tunnel token": "터널 토큰",
  "Public URL": "공개 URL",
  "Not set": "미설정",
  "Quick Tunnel preview": "Quick Tunnel 미리보기",
  "Production tunnel token": "운영 터널 토큰",
  "Local service URL": "로컬 서비스 URL",
  "Tunnel name": "터널 이름",
  "Cloudflare Access protects this hostname": "Cloudflare Access가 이 호스트명을 보호합니다",
  "Clear token status": "토큰 상태 초기화",
  "Cloudflare install command or tunnel token": "Cloudflare 설치 명령 또는 터널 토큰",
  "Save Public Access": "공개 접근 저장",
  "Check Public URL": "공개 URL 확인",
  "Quick Tunnel": "Quick Tunnel",
  "Production Run": "운영 실행",
  "Install Service": "서비스 설치",
  "Owners": "소유자",
  "Map human owners to Slack users and aliases.": "사람 소유자를 Slack 사용자와 별칭에 매핑합니다.",
  "Owner name": "소유자 이름",
  "Slack user ID": "Slack 사용자 ID",
  "Aliases": "별칭",
  "Active": "활성",
  "Save Owner": "소유자 저장",
  "No owners match this view.": "이 화면에 맞는 소유자가 없습니다.",
  "Channel Policies": "채널 정책",
  "Manual by default; suggestions only where expected.": "기본은 수동이며, 필요한 채널에서만 제안을 켭니다.",
  "Slack channel ID": "Slack 채널 ID",
  "Save Policy": "정책 저장",
  "No channel policies match this view.": "이 화면에 맞는 채널 정책이 없습니다.",
  "inactive": "비활성",
  "no Slack user": "Slack 사용자 없음",
  "no aliases": "별칭 없음",
  "Progress": "진행률",
  "Readiness": "준비 상태",
  "0% ready": "0% 준비됨",
  "Required step": "필수 단계",
  "Optional step": "선택 단계",
  "Back": "뒤로",
  "Next": "다음",
  "Finish": "마침",
  "Step details": "단계 세부정보",
  "Open only when diagnostics are needed.": "진단이 필요할 때만 엽니다.",
  "Show": "보기",
  "Hide": "숨기기",
  "Current blockers": "현재 블로커",
  "No blockers for this step.": "이 단계의 블로커가 없습니다.",
  "Required": "필수",
  "Optional": "선택",
  "Ready": "준비됨",
  "Needed": "필요",
  "Fix": "수정",
  "Need": "필요",
  "Opt": "선택",
  "Admin created": "관리자 생성됨",
  "Create the local administrator.": "로컬 관리자를 생성합니다.",
  "Create the local administrator. After this, setup is locked.": "로컬 관리자를 생성합니다. 이후 설정은 잠깁니다.",
  "A valid admin email is required, for example admin@example.com": "유효한 관리자 이메일이 필요합니다. 예: admin@example.com",
  "Use a full email address, for example admin@example.com": "전체 이메일 주소를 사용하세요. 예: admin@example.com",
  "Create Admin": "관리자 생성",
  "Confirm writable local paths.": "쓰기 가능한 로컬 경로를 확인합니다.",
  "Verify writable task, event, audit, and SQLite paths.": "태스크, 이벤트, 감사 로그, SQLite 경로가 쓰기 가능한지 확인합니다.",
  "Agent Plugin": "에이전트 플러그인",
  "Install Hermes or OpenClaw integration.": "Hermes 또는 OpenClaw 연동을 설치합니다.",
  "Install Agent Plugin": "에이전트 플러그인 설치",
  "ATM auto-detects local or mounted agent workspaces, installs the plugin, and runs a credential smoke test.": "ATM이 로컬 또는 마운트된 에이전트 워크스페이스를 감지하고 플러그인을 설치한 뒤 자격 증명 스모크 테스트를 실행합니다.",
  "Hermes Agent": "Hermes 에이전트",
  "OpenClaw": "OpenClaw",
  "Create admin first, then workspace detection will run.": "먼저 관리자를 생성하면 워크스페이스 감지가 실행됩니다.",
  "Detected workspace": "감지된 워크스페이스",
  "Run reload command after install": "설치 후 reload 명령 실행",
  "Advanced diagnostics": "고급 진단",
  "Manual workspace path": "수동 워크스페이스 경로",
  "Install Plugin": "플러그인 설치",
  "Uninstall Plugin": "플러그인 제거",
  "Environment": "환경",
  "Install": "설치",
  "Smoke Test": "스모크 테스트",
  "Checks": "확인 항목",
  "Expose the dashboard through Cloudflare.": "Cloudflare를 통해 대시보드를 공개합니다.",
  "Expose this local dashboard through Cloudflare Tunnel without a VPN. Use Quick Tunnel for preview and remotely-managed tunnel tokens for production.": "VPN 없이 Cloudflare Tunnel로 이 로컬 대시보드를 공개합니다. 미리보기에는 Quick Tunnel을, 운영에는 원격 관리 터널 토큰을 사용합니다.",
  "Paste a Cloudflare tunnel token or install command, then save.": "Cloudflare 터널 토큰 또는 설치 명령을 붙여넣고 저장하세요.",
  "Review the existing agent bot scopes. ATM does not need a second Slack app.": "기존 에이전트 봇 scope를 검토합니다. ATM은 두 번째 Slack 앱이 필요하지 않습니다.",
  "Existing agent bot can read target channels and thread context.": "기존 에이전트 봇이 대상 채널과 스레드 컨텍스트를 읽을 수 있습니다.",
  "Existing agent bot can post thread replies.": "기존 에이전트 봇이 스레드 답글을 게시할 수 있습니다.",
  "Existing agent bot can DM assignees if assignment prompts use DM.": "배정 프롬프트가 DM을 쓰는 경우 기존 에이전트 봇이 담당자에게 DM할 수 있습니다.",
  "Existing agent ignores bot-origin messages to prevent loops.": "루프 방지를 위해 기존 에이전트가 봇 발신 메시지를 무시합니다.",
  "Existing agent command/mention gating is enabled for manual channels.": "수동 채널에서 기존 에이전트 명령/멘션 게이트가 활성화되어 있습니다.",
  "Slack Review": "Slack 검토",
  "Confirm the existing bot permissions.": "기존 봇 권한을 확인합니다.",
  "Automation": "자동화",
  "Optional channel suggestion mode.": "선택적 채널 제안 모드입니다.",
  "Automation Mode": "자동화 모드",
  "Keep channels manual by default. Enable suggestions only where the team expects proposals.": "기본적으로 채널은 수동으로 두고, 팀이 제안을 기대하는 곳에서만 제안을 켭니다.",
  "manual_only - explicit commands only": "manual_only - 명시적 명령만",
  "suggest_only - propose with confirmation": "suggest_only - 확인 후 제안",
  "Save Automation Mode": "자동화 모드 저장",
  "Ready for team use": "팀 사용 준비 완료",
  "Review the final state, then open the dashboard for day-to-day work.": "최종 상태를 검토한 뒤 일상 작업용 대시보드를 엽니다.",
  "Open Dashboard": "대시보드 열기",
  "Refresh Status": "상태 새로고침",
  "Storage": "저장소",
  "Slack review": "Slack 검토",
  "OK": "정상",
  "Needs check": "확인 필요",
  "Not reviewed": "미검토",
  "None installed": "설치 없음",
  "Setup status could not be loaded.": "설정 상태를 불러오지 못했습니다.",
  "Admin is created.": "관리자가 생성되었습니다.",
  "Create a local admin account to unlock protected setup actions.": "보호된 설정 작업을 열려면 로컬 관리자 계정을 생성하세요.",
  "Storage is ready.": "저장소가 준비되었습니다.",
  "Run storage check and confirm the data directory is writable.": "저장소 확인을 실행하고 데이터 디렉터리가 쓰기 가능한지 확인하세요.",
  "Log in as admin before installing agent plugins.": "에이전트 플러그인을 설치하기 전에 관리자로 로그인하세요.",
  "Install at least one Hermes or OpenClaw plugin.": "Hermes 또는 OpenClaw 플러그인을 하나 이상 설치하세요.",
  "Agent plugin is installed.": "에이전트 플러그인이 설치되었습니다.",
  "Add the Cloudflare public hostname.": "Cloudflare 공개 호스트명을 추가하세요.",
  "Mark the hostname as protected by Cloudflare Access before sharing it.": "공유하기 전에 Cloudflare Access가 호스트명을 보호하도록 표시하세요.",
  "Paste a tunnel token or Cloudflare install command to generate service commands.": "서비스 명령을 생성하려면 터널 토큰 또는 Cloudflare 설치 명령을 붙여넣으세요.",
  "Public access is ready.": "공개 접근이 준비되었습니다.",
  "Slack permissions have been reviewed.": "Slack 권한이 검토되었습니다.",
  "Review the existing agent bot scopes and mark the checklist reviewed.": "기존 에이전트 봇 scope를 검토하고 체크리스트를 검토 완료로 표시하세요.",
  "At least one channel policy is configured.": "채널 정책이 하나 이상 설정되었습니다.",
  "Optional: leave manual-only globally or add channel-specific suggestion mode.": "선택: 전체 기본값을 수동으로 두거나 채널별 제안 모드를 추가하세요.",
  "All required setup steps are complete.": "모든 필수 설정 단계가 완료되었습니다.",
  "Finish the required steps before using the dashboard with the team.": "팀과 대시보드를 사용하기 전에 필수 단계를 완료하세요.",
  "Health status": "헬스 상태",
  "Add a public URL first.": "먼저 공개 URL을 추가하세요.",
  "Public access settings saved.": "공개 접근 설정이 저장되었습니다.",
  "Settings saved. Add the public hostname after Cloudflare creates it.": "설정이 저장되었습니다. Cloudflare가 생성한 공개 호스트명을 추가하세요.",
  "Copied": "복사됨",
  "Copy": "복사",
  "Logged in.": "로그인했습니다.",
  "Task created.": "태스크가 생성되었습니다.",
  "Saved.": "저장되었습니다.",
  "Request failed": "요청 실패",
  "Assignee must be selected from active Slack users in Settings.": "담당자는 설정의 활성 Slack 사용자 중에서 선택해야 합니다.",
  "Reporter must be selected from active Slack users in Settings.": "보고자는 설정의 활성 Slack 사용자 중에서 선택해야 합니다."
};

export const translationCatalog: Record<UiLanguage, Record<string, string>> = {
  en: {},
  ko
};

const reverseCatalog: Record<UiLanguage, Record<string, string>> = {
  en: {},
  ko: Object.fromEntries(Object.entries(ko).map(([english, translated]) => [translated, english]))
};

export function parseUiLanguage(value: unknown): UiLanguage {
  return uiLanguages.includes(value as UiLanguage) ? value as UiLanguage : defaultUiLanguage;
}

export function translateText(value: string, language: UiLanguage): string {
  if (!value.trim()) return value;
  const leading = value.match(/^\s*/)?.[0] ?? "";
  const trailing = value.match(/\s*$/)?.[0] ?? "";
  const trimmed = value.trim();
  const english = toEnglish(trimmed);
  const translated = language === "en" ? english : translationCatalog[language][english] ?? english;
  return `${leading}${translated}${trailing}`;
}

function toEnglish(value: string): string {
  for (const catalog of Object.values(reverseCatalog)) {
    if (catalog[value]) return catalog[value];
  }
  return value;
}

export function translateDom(root: ParentNode, language: UiLanguage): void {
  const documentRef = root.ownerDocument ?? document;
  const walker = documentRef.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const textNodes: Text[] = [];
  const elements: Element[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
      if (!hasSkippedAncestor(node)) textNodes.push(node as Text);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (!["SCRIPT", "STYLE", "PRE", "CODE", "TEXTAREA"].includes(element.tagName)) {
        elements.push(element);
      }
    }
  }

  for (const node of textNodes) {
    node.textContent = translateText(node.textContent ?? "", language);
  }

  for (const element of elements) {
    for (const attr of ["placeholder", "title", "aria-label"]) {
      const value = element.getAttribute(attr);
      if (value) element.setAttribute(attr, translateText(value, language));
    }
  }
}

function hasSkippedAncestor(node: Node): boolean {
  let current = node.parentElement;
  while (current) {
    if (current.hasAttribute("data-i18n-skip")) return true;
    if (["SCRIPT", "STYLE", "PRE", "CODE", "TEXTAREA"].includes(current.tagName)) return true;
    current = current.parentElement;
  }
  return false;
}
