# Homebrew tap template.
# Replace the url and sha256 values in your tap release workflow.
class AgentTasksManager < Formula
  desc "Self-hosted task layer for existing Slack agents"
  homepage "https://github.com/your-org/agent-tasks-manager"
  url "https://github.com/your-org/agent-tasks-manager/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"
  depends_on "bun"

  def install
    libexec.install Dir["*"]
    bin.write_exec_script libexec/"bin/task-manager.js"
    bin.install_symlink "task-manager" => "atm"
  end

  service do
    run [opt_bin/"atm", "run", "--mode", "local", "--dir", var/"agent-tasks-manager"]
    keep_alive true
    log_path var/"log/agent-tasks-manager.log"
    error_log_path var/"log/agent-tasks-manager.err.log"
  end

  test do
    assert_match "ATM", shell_output("#{bin}/atm help")
  end
end
