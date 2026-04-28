# Homebrew tap template.
# Replace the url and sha256 values in your tap release workflow.
class AgentTaskManager < Formula
  desc "Self-hosted task layer for existing Slack agents"
  homepage "https://github.com/json-choi/agent-task-manager"
  url "https://github.com/json-choi/agent-task-manager/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_SHA256"
  license "MIT"

  depends_on "node"
  depends_on "bun"

  def install
    libexec.install Dir["*"]
    bin.install libexec/"bin/task-manager.js" => "atm"
    bin.install_symlink "atm" => "agent-task-manager"
  end

  service do
    run [opt_bin/"atm", "run", "--dir", var/"agent-task-manager"]
    keep_alive true
    log_path var/"log/agent-task-manager.log"
    error_log_path var/"log/agent-task-manager.err.log"
  end

  test do
    assert_match "ATM", shell_output("#{bin}/atm help")
  end
end
