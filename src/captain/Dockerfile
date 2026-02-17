FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Core tools + Nix
RUN apt-get update && apt-get install -y \
    curl \
    git \
    gh \
    tmux \
    ca-certificates \
    gnupg \
    lsb-release \
    sudo \
    jq \
    locales \
    nix-bin \
    && rm -rf /var/lib/apt/lists/*

# Generate UTF-8 locale (required for Unicode in tmux / Claude Code UI)
RUN locale-gen en_US.UTF-8

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    TERM=xterm-256color

# Configure nix for single-user mode (no daemon, no systemd in Docker)
RUN chown -R ubuntu:ubuntu /nix \
    && mkdir -p /etc/nix \
    && printf 'sandbox = false\nexperimental-features = nix-command flakes\n' > /etc/nix/nix.conf

ENV NIX_REMOTE="" \
    NIX_PATH="nixpkgs=channel:nixpkgs-unstable"

# Node.js (for claude code and codex)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Python + pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# uv (fast Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && mv /root/.local/bin/uvx /usr/local/bin/uvx

# Useful Python packages
RUN pip3 install --break-system-packages --no-cache-dir \
    requests \
    httpx \
    beautifulsoup4 \
    lxml \
    pyyaml \
    toml \
    python-dotenv \
    click \
    rich \
    pydantic \
    numpy \
    pandas \
    scipy \
    matplotlib \
    jinja2 \
    pytest \
    black \
    ruff \
    mypy \
    ipython

# Claude Code + Codex
RUN npm install -g @anthropic-ai/claude-code @openai/codex@0.98.0

# Set up ubuntu user (already exists in 24.04 base image)
RUN echo "ubuntu ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Tmux socket directories for cross-container sharing
RUN mkdir -p /run/captain-tmux /run/workspace-tmux \
    && chown ubuntu:ubuntu /run/captain-tmux /run/workspace-tmux

COPY entrypoint.sh /opt/squad/entrypoint-captain.sh
COPY restart-captain.sh /opt/squad/restart-captain.sh
RUN chmod +x /opt/squad/entrypoint-captain.sh /opt/squad/restart-captain.sh

COPY captain-CLAUDE.md /opt/squad/captain/CLAUDE.md
COPY skills/ /opt/squad/captain/.claude/skills/
RUN git init /opt/squad/captain \
    && chown -R ubuntu:ubuntu /opt/squad/captain

COPY speak /usr/local/bin/speak
COPY switch-account.sh /usr/local/bin/switch-account.sh
RUN chmod +x /usr/local/bin/speak /usr/local/bin/switch-account.sh

USER ubuntu

WORKDIR /home/ubuntu

ENTRYPOINT ["/opt/squad/entrypoint-captain.sh"]
