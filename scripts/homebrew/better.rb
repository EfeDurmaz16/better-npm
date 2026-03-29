class Better < Formula
  desc "Universal package manager — faster, smarter, secure"
  homepage "https://github.com/EfeDurmaz16/better-npm"
  license "MIT"
  version "0.2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/EfeDurmaz16/better-npm/releases/download/v#{version}/better-aarch64-apple-darwin.tar.gz"
      sha256 "PLACEHOLDER"
    else
      url "https://github.com/EfeDurmaz16/better-npm/releases/download/v#{version}/better-x86_64-apple-darwin.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  on_linux do
    url "https://github.com/EfeDurmaz16/better-npm/releases/download/v#{version}/better-x86_64-unknown-linux-gnu.tar.gz"
    sha256 "PLACEHOLDER"
  end

  def install
    bin.install "better-core" => "better"
  end

  test do
    assert_match "better", shell_output("#{bin}/better --version")
  end
end
